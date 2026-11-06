/**
 * dsh-self-play · DSH 插件入口
 *
 * 注册工具 run_self_play_test（默认 dry_run=true 安全预览；传 false 才备份+写入），
 * 并用 node-cron 每天 03:00 自动跑一次 dry_run:false 的全量自进化。
 *
 * 命名导出 runSelfPlay / extractStringArray 等供 test-mock.js 脱离 DSH 单测。
 *
 * 环境变量：
 *   MEMORY_BUS_URL       Memory 微服务（默认 http://127.0.0.1:8001）
 *   OLLAMA_BASE_URL      Ollama（默认 http://127.0.0.1:11434）
 *   OLLAMA_MODEL         审查模型（默认 qwen2.5:7b）
 *   SELF_PLAY_CRON_DISABLED  设为 1 则不注册 03:00 定时任务（多实例/测试时用）
 */

import cron from 'node-cron'
import { runSelfPlay } from './selfplay'

// 供测试直接导入纯逻辑（DSH 加载时无副作用：cron 仅在 apply 内注册）
export { runSelfPlay, extractStringArray, auditWithOllama, fetchRecentSamples, loadRules, mergeNegativeRules, backupAndWriteRules, resolvePersonasRoot } from './selfplay'

const LOG_TAG = '[dsh-self-play]'

// ---------------------------------------------------------------------------
// DSH 工具类型（最小子集，参照 dsh-memory-bus / dsh-persona-core 实测结构）
// ---------------------------------------------------------------------------

interface DshTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown>; render: (args: any, value: any) => any[] }
  execute: (args: any, exec: any) => Promise<any>
  presentCall?: (args: any) => any
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const tool: DshTool = {
  name: 'run_self_play_test',
  description:
    '复盘当前角色近期回复，用本地 Ollama 审查其中的 AI 味 / 客服腔，' +
    '把提炼出的负向指令追加到 config/personas/<id>/rules.json 的 negative_rules。' +
    '默认 dry_run=true：只返回审查结果，不写文件（安全预览）；' +
    '传 dry_run=false 才会先备份 rules.json 为 rules_backup.json，再写入。' +
    '系统每天 03:00 会自动以 dry_run=false 跑一次。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dry_run: {
        type: 'boolean',
        default: true,
        description: 'true=只预览不写文件（默认）；false=备份后写入 negative_rules',
      },
      persona_id: {
        type: 'string',
        description: '指定审查哪个角色；默认读 active.json 的当前激活角色',
      },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        reason: { type: 'string' },
        persona_id: { type: 'string' },
        samples_count: { type: 'integer' },
        negative_rules: { type: 'array' },
        written: { type: 'boolean' },
        backup_written: { type: 'boolean' },
        rules_path: { type: 'string' },
      },
    },
    render: (_args: any, value: any) => {
      const lines: string[] = []
      if (value?.ok) {
        lines.push(`🧠 自进化完成：${value.reason ?? ''}`)
        if (Array.isArray(value.negative_rules) && value.negative_rules.length) {
          lines.push('提炼到的负向指令：')
          value.negative_rules.forEach((r: string, i: number) => lines.push(`  ${i + 1}. ${r}`))
        }
        if (value.written) lines.push(`✅ 已写入 ${value.rules_path ?? 'rules.json'}（已备份 rules_backup.json）`)
        else if (value.dry_run) lines.push('（dry_run：未写入文件）')
      } else {
        lines.push(`⚠️ 自进化未执行：${value?.reason ?? '未知'}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args: any) {
    return await runSelfPlay({
      dry_run: args?.dry_run !== false,
      persona_id: typeof args?.persona_id === 'string' ? args.persona_id : undefined,
    })
  },
  presentCall(args: any) {
    const write = args?.dry_run === false
    return { card: 'generic', title: `run_self_play_test${write ? '（写入）' : '（预览）'}`, kind: write ? 'write' : 'read' }
  },
}

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-self-play',
  apply(ctx: any) {
    console.log(`${LOG_TAG} apply`)
    const disposers: Array<() => void> = []
    try {
      const d = ctx.tools.register(tool)
      if (typeof d === 'function') disposers.push(d)
      console.log(`${LOG_TAG} 已注册工具 run_self_play_test`)
    } catch (e) {
      console.error(`${LOG_TAG} 注册工具 run_self_play_test 失败：`, e)
    }

    // ---- 定时任务：每天 03:00 全量自进化（dry_run:false）----
    let scheduledTask: { stop?: () => void } | null = null
    let running = false
    if (process.env.SELF_PLAY_CRON_DISABLED === '1') {
      console.log(`${LOG_TAG} SELF_PLAY_CRON_DISABLED=1，03:00 定时任务未启用`)
    } else {
      try {
        scheduledTask = cron.schedule('0 3 * * *', async () => {
          if (running) {
            console.log(`${LOG_TAG} 上一轮自进化仍在进行，跳过本次 03:00 触发`)
            return
          }
          running = true
          const t0 = Date.now()
          try {
            const res = await runSelfPlay({ dry_run: false })
            console.log(
              `${LOG_TAG} 03:00 自进化完成（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）：` +
                JSON.stringify({ ok: res.ok, reason: res.reason, persona_id: res.persona_id, written: res.written }),
            )
          } catch (e) {
            // 任何异常都吞掉：自进化是后台优化，绝不能影响 DSH 主流程
            console.error(`${LOG_TAG} 03:00 自进化异常（已降级，不影响主流程）：${(e as Error).message}`)
          } finally {
            running = false
          }
        }) as unknown as { stop?: () => void }
        console.log(`${LOG_TAG} 已注册定时任务：每天 03:00 自进化（cron '0 3 * * *'）`)
      } catch (e) {
        console.error(`${LOG_TAG} 注册 cron 失败（工具仍可用，只是没有定时触发）：`, (e as Error).message)
      }
    }

    ctx.on('dispose', () => {
      try { scheduledTask?.stop?.() } catch { /* ignore */ }
      for (const d of disposers) {
        try { d() } catch { /* ignore */ }
      }
      console.log(`${LOG_TAG} disposed`)
    })
  },
}
