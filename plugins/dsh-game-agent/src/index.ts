/**
 * dsh-game-agent · DSH 插件入口
 *
 * 注册工具 play_game_step(goal)：截屏 → 多模态 VLM 决策一个宏观动作 →
 * 转发给 game-bot 微服务（:8003）执行虚拟手柄信号。
 *
 * 安全设计：
 *   - 默认 dry_run=true：只预览 VLM 决策的动作，不实际转发（不会乱按手柄）。
 *   - 每次调用只走一步（截屏 → VLM → 一个动作），不自动循环，避免失控。
 *   - game-bot 端另有 2s 看门狗，TS 崩溃/断网后自动松摇杆松按键，双保险。
 *   - 截屏失败 / VLM 离线 / game-bot 离线 → 一律返回 ok:false，不阻断 DSH。
 *
 * 命名导出 playGameStep / extractAction / buildGamePrompt 等供 test-mock.js 脱离 DSH 单测。
 *
 * 环境变量：
 *   GAME_BOT_URL      game-bot 微服务（默认 http://127.0.0.1:8003）
 *   VISION_API_BASE   多模态模型 base（如 https://open.bigmodel.cn/api/paas/v4）
 *   VISION_API_KEY    多模态模型 key
 *   VISION_MODEL      模型名（默认 glm-4v）
 */

import { playGameStep, type PlayGameStepResult } from './game'

// 供测试直接导入纯逻辑（DSH 加载时无副作用：工具仅在 apply 内注册）
export {
  playGameStep,
  buildGamePrompt,
  extractAction,
  normalizeAction,
  extractJsonObject,
  captureScreen,
  forwardAction,
  createVisionClient,
} from './game'

const LOG_TAG = '[dsh-game-agent]'

// ---------------------------------------------------------------------------
// DSH 工具类型（最小子集，参照 dsh-self-play 实测结构）
// ---------------------------------------------------------------------------

interface DshTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown>; render: (args: any, value: any) => any[] }
  execute: (args: any, exec: any) => Promise<any>
  presentCall?: (args: any) => any
}

function actionSummary(value: PlayGameStepResult): string {
  const a = value.action
  if (!a) return '（无合法动作）'
  if (a.type === 'move') return `move ${a.direction}${a.duration != null ? ` ${a.duration}s` : ''}`
  if (a.type === 'press') return `press ${a.button}${a.duration != null ? ` ${a.duration}s` : ''}`
  if (a.type === 'release') return `release ${a.button}`
  return 'reset'
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const tool: DshTool = {
  name: 'play_game_step',
  description:
    '通用游戏代理：截取当前屏幕 → 多模态 VLM 根据目标决策下一步宏观动作 → ' +
    '转发给 game-bot 虚拟手柄微服务（:8003）执行。' +
    '默认 dry_run=true：只返回决策动作预览，不实际操作手柄（安全）；' +
    '传 dry_run=false 才真正执行一步。每次调用只执行一步，不会自动循环。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['goal'],
    properties: {
      goal: {
        type: 'string',
        description: '游戏目标，例如"向前走到传送阵"、"跳上平台"、"和 NPC 对话"',
      },
      dry_run: {
        type: 'boolean',
        default: true,
        description: 'true=只预览决策动作不操作手柄（默认，安全）；false=实际执行一步',
      },
      game_bot_url: {
        type: 'string',
        description: '覆盖 game-bot 地址，默认 http://127.0.0.1:8003',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        reason: { type: 'string' },
        goal: { type: 'string' },
        dry_run: { type: 'boolean' },
        executed: { type: 'boolean' },
        action: { type: 'object' },
        raw_vlm: { type: 'string' },
        screenshot_bytes: { type: 'integer' },
      },
    },
    render: (_args: any, value: any) => {
      const v = (value ?? {}) as PlayGameStepResult
      const lines: string[] = []
      if (v.ok) {
        lines.push(`🎮 游戏代理：${v.reason ?? ''}`)
        lines.push(`目标：${v.goal ?? ''}`)
        lines.push(`决策动作：${actionSummary(v)}`)
        if (v.executed) lines.push('✅ 已转发 game-bot 执行')
        else if (v.dry_run) lines.push('（dry_run：未实际执行）')
      } else {
        lines.push(`⚠️ 游戏代理未执行：${v.reason ?? '未知'}`)
        if (v.goal) lines.push(`目标：${v.goal}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args: any) {
    return await playGameStep({
      goal: typeof args?.goal === 'string' ? args.goal : '',
      dry_run: args?.dry_run !== false,
      game_bot_url: typeof args?.game_bot_url === 'string' ? args.game_bot_url : undefined,
    })
  },
  presentCall(args: any) {
    const exec = args?.dry_run === false
    return {
      card: 'generic',
      title: `play_game_step${exec ? '（执行）' : '（预览）'}`,
      kind: exec ? 'write' : 'read',
    }
  },
}

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-game-agent',
  apply(ctx: any) {
    console.log(`${LOG_TAG} apply`)
    const disposers: Array<() => void> = []
    try {
      const d = ctx.tools.register(tool)
      if (typeof d === 'function') disposers.push(d)
      console.log(`${LOG_TAG} 已注册工具 play_game_step`)
    } catch (e) {
      console.error(`${LOG_TAG} 注册工具 play_game_step 失败：`, e)
    }

    ctx.on('dispose', () => {
      for (const d of disposers) {
        try { d() } catch { /* ignore */ }
      }
      console.log(`${LOG_TAG} disposed`)
    })
  },
}
