/**
 * dsh-control-center —— persona-os 插件/微服务总控面板
 *
 * 在 :8088 起一个本地 Web 服务，提供：
 *   · **服务状态看板**：8001/8002/8003/8005 打 /health，9001/9881 只测 TCP；
 *     并发探测 + 2s 超时，谁卡死只影响它自己。另外显示内存与 GPU 显存。
 *   · **指挥官测试台**：输入一句弹幕，经 WebSocket 发到 :9001，把服务端回包打在面板上。
 *
 * 界面是单文件 HTML（src/page.html，构建时内联成字符串），不依赖任何前端框架。
 *
 * 环境变量：
 *   CONTROL_CENTER_PORT   监听端口（默认 8088）
 *   DANMAKU_WS_URL        弹幕 WS 地址（默认 ws://127.0.0.1:9001）
 *
 * 工具：open_dashboard —— 返回面板地址（顺带确保服务已启动）
 */
import { startControlCenter, type ControlCenterServer } from './server.js'
import { PAGE_HTML } from './page.generated.js'
import { getTaskChain } from './task-chain.js'

const LOG_TAG = '[dsh-control-center]'

let server: ControlCenterServer | null = null
let starting: Promise<ControlCenterServer> | null = null

/** 幂等启动：已经起了就复用 */
async function ensureServer(): Promise<ControlCenterServer> {
  if (server) return server
  if (!starting) {
    starting = startControlCenter({ page: () => PAGE_HTML })
      .then((s) => {
        server = s
        return s
      })
      .catch((e) => {
        starting = null
        throw e
      })
  }
  return starting
}

export interface DshTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown>; render: (args: any, value: any) => any[] }
  execute: (args: any, exec: any) => Promise<any>
  presentCall?: (args: any) => any
}

/** 取任务链：解析会话记录里的 tool/call，看她刚才为了某个任务查了什么 */
const taskChainTool: DshTool = {
  name: 'get_task_chain',
  description:
    '从 DSH 会话记录（~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd）里还原"任务链"：' +
    '最近调用了哪些工具、参数是什么。' +
    '注意：这类记录是多帧 zstd（约 2.7 万帧），必须逐帧解压，直接整体解压只会得到 244 字节的 session 头。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      workspace: { type: 'string', description: '只看工作区名包含该子串的会话（可空）' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: '只保留这些工具名（如 ["pwsh","read"]），可空',
      },
      limit: { type: 'integer', description: '返回最后 N 条，默认 40' },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        sessionId: { type: 'string' },
        totalCalls: { type: 'integer' },
        calls: { type: 'array' },
        error: { type: 'string' },
      },
    },
    render: (_a: any, v: any) => {
      if (!v?.ok) return [{ type: 'text', text: `❌ 取任务链失败：${v?.error ?? '未知'}` }]
      const lines = (v.calls ?? []).map((c: any, i: number) =>
        `${i + 1}. T${c.turn}/S${c.step} ${c.name}(${String(c.args ?? '').slice(0, 80)})`)
      return [{
        type: 'text',
        text: `🧭 任务链（${v.sessionId}，共 ${v.totalCalls} 条，显示最后 ${lines.length} 条）\n${lines.join('\n')}`,
      }]
    },
  },
  async execute(args: any) {
    return getTaskChain({
      workspace: args?.workspace,
      tools: Array.isArray(args?.tools) ? args.tools : undefined,
      limit: typeof args?.limit === 'number' ? args.limit : 40,
    })
  },
  presentCall() {
    return { card: 'generic', title: 'get_task_chain', kind: 'read' }
  },
}

const openDashboardTool: DshTool = {
  name: 'open_dashboard',
  description:
    '启动并返回 persona-os 总控面板地址（默认 http://127.0.0.1:8088）。' +
    '面板里有：各微服务/插件的死活（绿灯/红灯实时刷新）、内存与 GPU 显存、以及一个发送模拟弹幕到 :9001 的测试台。',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  output: {
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, url: { type: 'string' }, error: { type: 'string' } },
    },
    render: (_a: any, v: any) => [
      { type: 'text', text: v?.ok ? `🖥️ 总控面板：${v.url}` : `❌ 面板启动失败：${v?.error ?? '未知'}` },
    ],
  },
  async execute() {
    try {
      const s = await ensureServer()
      return { ok: true, url: `http://127.0.0.1:${s.port}` }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
  presentCall() {
    return { card: 'generic', title: 'open_dashboard', kind: 'read' }
  },
}

export default {
  name: 'dsh-control-center',
  async apply(ctx: any) {
    try {
      const s = await ensureServer()
      console.log(`${LOG_TAG} 已启动：http://127.0.0.1:${s.port}`)
    } catch (e) {
      console.error(`${LOG_TAG} 启动失败（不影响其他插件）：${(e as Error).message}`)
    }
    try {
      ctx.tools.register(openDashboardTool)
      ctx.tools.register(taskChainTool)
    } catch (e) {
      console.error(`${LOG_TAG} 注册工具失败：`, e)
    }
    ctx.on('dispose', () => {
      if (server) {
        void server.close()
        server = null
        starting = null
      }
      console.log(`${LOG_TAG} disposed`)
    })
  },
}

export { startControlCenter, ensureServer }
