/**
 * dsh-live-director · 模块 3：观众记忆注入
 *
 * 职责（严格对照架构指令）：
 *   1. 封装对本地 memory 微服务（默认 http://127.0.0.1:8001，由 dsh-service-manager 拉起）的 HTTP 调用。
 *   2. getUserContext(user)：按用户名 recall，过滤出真正相关的记忆，拼成一句上下文；查不到/服务不可用返回 ''。
 *   3. saveUserInteraction(user, text)：异步 fire-and-forget 存入记忆库，绝不阻塞直播主流程。
 *
 * 设计：transport 可注入（测试用 mock），默认走 HTTP，所有调用带超时 + 失败降级，
 *      保证 memory 服务挂了直播也照常运行。
 */

export const LOG_TAG = '[dsh-live-director:memory]'

const DEFAULT_BASE_URL = (process.env.MEMORY_BUS_URL || 'http://127.0.0.1:8001').replace(/\/$/, '')

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface RecallResult {
  id?: string
  level?: string
  title?: string
  snippet?: string
  content?: string
  tags?: string[]
}

/** 可注入的传输层：测试用 mock，默认用 HTTP */
export interface MemoryTransport {
  recall(query: string, limit?: number): Promise<RecallResult[]>
  remember(text: string, tags?: string[], level?: string): Promise<void>
}

export interface MemoryClientOptions {
  transport?: MemoryTransport
  baseUrl?: string
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// 默认 HTTP transport（带超时 + 失败降级）
// ---------------------------------------------------------------------------

export function createHttpMemoryTransport(
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): MemoryTransport {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const timeoutMs = opts.timeoutMs ?? 3000

  return {
    async recall(query, limit = 10): Promise<RecallResult[]> {
      const q = String(query ?? '').trim()
      if (!q) return []
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const r = await fetch(`${baseUrl}/recall?query=${encodeURIComponent(q)}&limit=${limit}`, {
          signal: ctrl.signal,
        })
        const data = await r.json().catch(() => ({}))
        return Array.isArray((data as any)?.results) ? (data as any).results : []
      } catch (e) {
        // 服务不可用 / 超时 → 静默降级，不抛错打断直播
        console.warn(`${LOG_TAG} recall 失败（降级为空）：${(e as Error).message}`)
        return []
      } finally {
        clearTimeout(timer)
      }
    },
    async remember(text, tags = [], level = 'user'): Promise<void> {
      const payload = String(text ?? '').trim()
      if (!payload) return
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        await fetch(`${baseUrl}/remember`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: payload, tags, level }),
          signal: ctrl.signal,
        })
      } catch (e) {
        console.warn(`${LOG_TAG} remember 失败（已忽略，不阻塞直播）：${(e as Error).message}`)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// MemoryClient
// ---------------------------------------------------------------------------

export class MemoryClient {
  private transport: MemoryTransport

  constructor(opts: MemoryClientOptions = {}) {
    this.transport = opts.transport ?? createHttpMemoryTransport({ baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs })
  }

  /**
   * 查询某用户的历史互动上下文。
   * recall 以用户名为关键词，再过滤 title/snippet/content/tags 确实包含该用户名的条目，
   * 避免无关记忆串台。查不到或服务不可用返回 ''。
   */
  async getUserContext(user: string): Promise<string> {
    const u = String(user ?? '').trim()
    if (!u) return ''
    const results = await this.transport.recall(u, 10)
    const relevant = results.filter((r) => {
      const hay = [r.title, r.snippet, r.content, ...(r.tags ?? [])]
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
        .join(' ')
      return hay.includes(u)
    })
    if (!relevant.length) return ''
    const snippets = relevant
      .slice(0, 5)
      .map((r) => (r.snippet || r.content || r.title || '').trim())
      .filter((s) => s.length > 0)
    return snippets.join('；')
  }

  /**
   * 异步保存当前互动（fire-and-forget，不阻塞主线程）。
   * 用 level='user' 写入记忆库的 user 层，tags 带用户名便于下次 recall 命中。
   */
  saveUserInteraction(user: string, text: string): void {
    const u = String(user ?? '').trim()
    const t = String(text ?? '').trim()
    if (!u || !t) return
    const payload = `观众「${u}」互动：${t}`
    // 不 await：存入失败也不影响直播响应
    void this.transport.remember(payload, [u, 'live-director'], 'user')
  }
}

// ---------------------------------------------------------------------------
// Prompt 拼装（纯函数，便于测试验证注入是否生效）
// ---------------------------------------------------------------------------

/**
 * 把用户记忆上下文拼成 System Prompt 片段。
 * 空上下文返回 ''（不注入），避免给 LLM 塞入空指令。
 */
export function buildMemoryPrompt(user: string, userContext: string): string {
  const ctx = String(userContext ?? '').trim()
  if (!ctx) return ''
  return `注意：当前观众「${user}」是老熟人，历史记忆档案——${ctx}。请像对待熟人一样自然、热情地呼应，但不要机械复述档案。`
}
