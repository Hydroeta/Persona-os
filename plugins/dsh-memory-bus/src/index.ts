/**
 * dsh-memory-bus
 *
 * 把 Memory 微服务（core-services/memory，默认 http://127.0.0.1:8001）暴露为
 * DSH 工具：save_memory / recall_memory。
 *
 * 设计原则：TS 管调度与注入，Python 管存储。本插件只做 HTTP 转发，不持有数据。
 *
 * 工具注册 API（对照 DSH 0.2.0-rc.2 的 meow-memory 实测）：
 *   const dispose = ctx.tools.register({
 *     name, description,
 *     parameters: { type:'object', properties:{...}, required:[...] },
 *     output: { schema, render: (args, value) => [{type:'text', text}] },
 *     execute: async (args, exec) => ({...}),
 *     presentCall: (args) => ({card, title, kind}),
 *   })
 *   ctx.on('dispose', () => dispose())
 *
 * 环境变量：
 *   MEMORY_BUS_URL  Memory 微服务地址（默认 http://127.0.0.1:8001）
 */

const LOG_TAG = '[dsh-memory-bus]'
// 自动连本地记忆微服务：dsh-service-manager 会在 8001 拉起 memory 微服务。
// 未显式设置 MEMORY_BUS_URL 时写默认值，保证本进程内所有消费者（含 dsh-memory-map）都能拿到。
if (!process.env.MEMORY_BUS_URL) process.env.MEMORY_BUS_URL = 'http://127.0.0.1:8001'
const BASE_URL = (process.env.MEMORY_BUS_URL || 'http://127.0.0.1:8001').replace(/\/$/, '')

// ---------------------------------------------------------------------------
// DSH 工具类型（最小子集，参照 meow-memory 实测结构）
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
// HTTP 辅助（Node 22 内置 fetch）
// ---------------------------------------------------------------------------

async function postJson<T = any>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!r.ok) throw new Error(`memory 服务 ${url} 返回 ${r.status}: ${text || r.statusText}`)
  return data as T
}

async function getJson<T = any>(url: string): Promise<T> {
  const r = await fetch(url)
  const text = await r.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!r.ok) throw new Error(`memory 服务 ${url} 返回 ${r.status}: ${text || r.statusText}`)
  return data as T
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const tools: DshTool[] = [
  {
    name: 'save_memory',
    description:
      '把一段文本存入长期记忆（写入底层 SQLite 记忆库，meow-memory 也能检索到）。' +
      '适合记录：用户偏好、事实、约定、待办提醒。tags 为可选关键词列表。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '要记住的内容，尽量完整具体' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选关键词标签，便于 recall 检索' },
        level: {
          type: 'string',
          enum: ['fact', 'lesson', 'topic', 'user', 'project', 'rules', 'soul'],
          default: 'fact',
          description: '记忆层，默认 fact',
        },
      },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, level: { type: 'string' } } },
      render: (_args: any, value: any) => [
        { type: 'text', text: `✅ 已存入记忆（id=${String(value?.id ?? '').slice(0, 8)}，level=${value?.level ?? 'fact'}）` },
      ],
    },
    async execute(args: any) {
      const text = typeof args?.text === 'string' ? args.text : ''
      if (!text.trim()) throw new Error('save_memory: text 不能为空')
      const tags = Array.isArray(args?.tags) ? args.tags.filter((x: unknown) => typeof x === 'string') : []
      const level = typeof args?.level === 'string' ? args.level : 'fact'
      const res = await postJson<{ id: string; level: string }>(`${BASE_URL}/remember`, { text, tags, level })
      return { ok: true, id: res.id, level: res.level ?? level }
    },
    presentCall(args: any) {
      return { card: 'generic', title: `save_memory: ${String(args?.text ?? '').slice(0, 40)}`, kind: 'write' }
    },
  },
  {
    name: 'recall_memory',
    description:
      '按关键词从长期记忆中检索相关条目（LIKE 匹配标题 / 内容 / 标签），' +
      '返回最相关的若干条。需要回忆用户说过的话、过往事实时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '检索关键词' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'integer' }, results: { type: 'array' } } },
      render: (_args: any, value: any) => [
        { type: 'text', text: `🔍 找到 ${value?.count ?? 0} 条相关记忆。` },
      ],
    },
    async execute(args: any) {
      const query = typeof args?.query === 'string' ? args.query : ''
      if (!query.trim()) throw new Error('recall_memory: query 不能为空')
      const limit = Number.isInteger(args?.limit) ? args.limit : 20
      const url = `${BASE_URL}/recall?query=${encodeURIComponent(query)}&limit=${limit}`
      const res = await getJson<{ results: any[] }>(url)
      const results = Array.isArray(res.results) ? res.results : []
      return { ok: true, count: results.length, results }
    },
    presentCall(args: any) {
      return { card: 'generic', title: `recall_memory: ${String(args?.query ?? '').slice(0, 40)}`, kind: 'read' }
    },
  },
]

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-memory-bus',
  apply(ctx: any) {
    console.log(`${LOG_TAG} apply (base=${BASE_URL})`)
    const disposers: Array<() => void> = []
    for (const t of tools) {
      try {
        const d = ctx.tools.register(t)
        if (typeof d === 'function') disposers.push(d)
        console.log(`${LOG_TAG} 已注册工具 ${t.name}`)
      } catch (e) {
        console.error(`${LOG_TAG} 注册工具 ${t.name} 失败：`, e)
      }
    }
    console.log(`${LOG_TAG} 共注册 ${disposers.length} 个工具`)

    ctx.on('dispose', () => {
      console.log(`${LOG_TAG} dispose：注销 ${disposers.length} 个工具`)
      for (const d of disposers) {
        try { d() } catch { /* ignore */ }
      }
    })
  },
}
