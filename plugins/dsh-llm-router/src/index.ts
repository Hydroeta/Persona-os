/**
 * dsh-llm-router
 *
 * LLM 提供商路由层：
 *   - 主对话 → DeepSeek（DSH 默认 provider id: deepseek-official）
 *   - 长上下文 或 后台静默任务（subagent）→ 本地 Ollama（127.0.0.1:11434）
 *   - GeminiProvider 接口已预留，暂未实现
 *
 * 两种接入方式（满足「拦截底层 fetch 或提供统一 chat」）：
 *   1) 透明拦截：ctx.on('agent/request') 覆盖 DSH 请求的 provider/model。
 *      默认关闭——需设置 LLM_ROUTER_OLLAMA_PROVIDER 为你在 DSH 里注册的 Ollama provider id
 *      后才启用；任何异常都 fail-open（放行原始配置），绝不阻断对话。
 *   2) 统一 chat()：本插件暴露 llmRouter 服务（ctx.get('llmRouter')）并导出 Provider/Router，
 *      供其他插件直接调用，直连 HTTP，不依赖 DSH 是否已注册对应 provider。
 *
 * 环境变量（密钥一律从环境读，不落代码）：
 *   DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL(默认 https://api.deepseek.com) / DEEPSEEK_MODEL(默认 deepseek-chat)
 *   OLLAMA_BASE_URL(默认 http://127.0.0.1:11434) / OLLAMA_MODEL(默认 qwen2.5:7b)
 *   LLM_ROUTER_CONTEXT_THRESHOLD(字符数，默认 24000)  超过则路由到 Ollama
 *   LLM_ROUTER_OLLAMA_PROVIDER  DSH 中 Ollama 的 provider id；设置后启用 agent/request 透明拦截
 *   LLM_ROUTER_OLLAMA_MODEL      拦截时覆盖的 model（可选）
 *   LLM_ROUTER_DEEPSEEK_PROVIDER 默认 deepseek-official
 *
 * 注意：DSH 实测 provider id 为 deepseek-official（默认模型 deepseek-flash），
 * 见 profiles/web 中 @deepseek-ai/dsh-agent-default-model 配置。
 */

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
  model?: string
  signal?: AbortSignal
  /** auto=按启发式路由；其余强制指定 provider */
  prefer?: 'auto' | 'deepseek' | 'ollama' | 'gemini'
  /** 明确标记为后台静默任务 → Ollama */
  background?: boolean
}

export interface ChatResult {
  content: string
  provider: string
  model: string
  raw?: any
}

export interface Provider {
  readonly id: string
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>
}

// ---------------------------------------------------------------------------
// OpenAI 兼容 HTTP 调用（DeepSeek / Ollama 都走 /v1/chat/completions）
// ---------------------------------------------------------------------------

async function openAiCompatChat(
  baseUrl: string,
  apiKey: string | null,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const body: Record<string, unknown> = { model, messages, stream: false }
  if (opts.temperature != null) body.temperature = opts.temperature
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  const text = await r.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (!r.ok) {
    throw new Error(`LLM ${baseUrl} 返回 ${r.status}：${text.slice(0, 300)}`)
  }
  const content = data?.choices?.[0]?.message?.content ?? ''
  return { content, provider: baseUrl, model, raw: data }
}

// ---------------------------------------------------------------------------
// Provider 实现
// ---------------------------------------------------------------------------

export class DeepSeekProvider implements Provider {
  readonly id = 'deepseek'
  private readonly baseUrl: string
  private readonly apiKey: string | null
  private readonly model: string

  constructor(opts?: { baseUrl?: string; apiKey?: string; model?: string }) {
    this.baseUrl = opts?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
    this.apiKey = opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? null
    this.model = opts?.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    if (!this.apiKey) {
      throw new Error('DeepSeekProvider：未设置 DEEPSEEK_API_KEY（请在环境变量中配置，勿写入代码）')
    }
    const r = await openAiCompatChat(this.baseUrl, this.apiKey, opts.model ?? this.model, messages, opts)
    return { ...r, provider: 'deepseek' }
  }
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama'
  private readonly baseUrl: string
  private readonly model: string

  constructor(opts?: { baseUrl?: string; model?: string }) {
    this.baseUrl = opts?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
    this.model = opts?.model ?? process.env.OLLAMA_MODEL ?? 'qwen2.5:7b'
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    // Ollama 提供 OpenAI 兼容端点 /v1/chat/completions，无需鉴权
    const r = await openAiCompatChat(this.baseUrl, null, opts.model ?? this.model, messages, opts)
    return { ...r, provider: 'ollama' }
  }
}

/** 预留接口：实现后接 Gemini API（generateContent）。当前抛出未实现错误。 */
export class GeminiProvider implements Provider {
  readonly id = 'gemini'

  async chat(): Promise<ChatResult> {
    throw new Error('GeminiProvider 尚未实现（接口已预留，待后续接入）')
  }
}

// ---------------------------------------------------------------------------
// 路由器
// ---------------------------------------------------------------------------

export class LLMRouter {
  readonly providers: Record<string, Provider>
  readonly contextThreshold: number

  constructor(opts?: { providers?: Record<string, Provider>; contextThreshold?: number }) {
    this.providers = opts?.providers ?? {
      deepseek: new DeepSeekProvider(),
      ollama: new OllamaProvider(),
      gemini: new GeminiProvider(),
    }
    const envT = Number(process.env.LLM_ROUTER_CONTEXT_THRESHOLD)
    this.contextThreshold = opts?.contextThreshold ?? (Number.isFinite(envT) && envT > 0 ? envT : 24000)
  }

  estimateChars(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0)
  }

  /** 决定本轮走哪个 provider。 */
  route(messages: ChatMessage[], opts: ChatOptions = {}): string {
    if (opts.prefer && opts.prefer !== 'auto') return opts.prefer
    if (opts.background) return 'ollama'
    if (this.estimateChars(messages) >= this.contextThreshold) return 'ollama'
    return 'deepseek'
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const id = this.route(messages, opts)
    const p = this.providers[id]
    if (!p) throw new Error(`LLMRouter：未知 provider "${id}"`)
    return p.chat(messages, opts)
  }
}

/** 构造一个读取环境变量的默认路由器（供模块导入方直接使用）。 */
export function createDefaultRouter(): LLMRouter {
  return new LLMRouter()
}

// ---------------------------------------------------------------------------
// agent/request 拦截辅助：从 DSH payload/config 里尽力提取消息用于上下文长度估算
// ---------------------------------------------------------------------------

function msgContent(m: any): string {
  if (typeof m === 'string') return m
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
  }
  return ''
}

function extractMessages(objs: any[]): any[] {
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue
    for (const key of ['messages', 'input']) {
      if (Array.isArray(o[key])) return o[key]
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

const LOG_TAG = '[dsh-llm-router]'

export default {
  name: 'dsh-llm-router',
  apply(ctx: any) {
    const router = createDefaultRouter()

    // 1) 暴露统一 chat 服务（best-effort：ctx.set 在某些 cordis 版本可能不存在）
    const serviceApi = {
      chat: router.chat.bind(router),
      route: router.route.bind(router),
      estimateChars: router.estimateChars.bind(router),
      providers: router.providers,
      router,
    }
    try {
      if (typeof ctx.set === 'function') {
        ctx.set('llmRouter', serviceApi)
        console.log(`${LOG_TAG} 已暴露 llmRouter 服务（ctx.get('llmRouter')）`)
      } else {
        console.log(`${LOG_TAG} ctx.set 不可用，未暴露 llmRouter 服务；仍可通过模块导入使用`)
      }
    } catch (e) {
      console.error(`${LOG_TAG} 暴露 llmRouter 服务失败：${(e as Error).message}`)
    }

    // 2) 透明拦截 agent/request（仅当用户配置了 Ollama 的 DSH provider id 时启用）
    const ollamaProviderId = (process.env.LLM_ROUTER_OLLAMA_PROVIDER || '').trim()
    const ollamaModelOverride = (process.env.LLM_ROUTER_OLLAMA_MODEL || '').trim()
    const deepseekProviderId = (process.env.LLM_ROUTER_DEEPSEEK_PROVIDER || 'deepseek-official').trim()
    let loggedOriginal = false

    if (ollamaProviderId) {
      ctx.on('agent/request', async (payload: any, next: any) => {
        let cfg: any
        try {
          cfg = await next()
        } catch (e) {
          throw e // DSH 自身错误，原样抛出
        }
        try {
          if (!loggedOriginal) {
            loggedOriginal = true
            console.log(`${LOG_TAG} 观测原始请求 provider=${cfg?.provider} model=${cfg?.model}`)
          }
          const agent = payload?.agent
          const isSubagent = agent?.session?.header?.origin === 'subagent'
          const msgs = extractMessages([payload, cfg, payload?.agent])
          const chars = msgs.reduce((s: number, m: any) => s + msgContent(m).length, 0)
          const wantOllama = isSubagent || chars >= router.contextThreshold

          if (wantOllama) {
            const out: any = { ...cfg, provider: ollamaProviderId }
            if (ollamaModelOverride) out.model = ollamaModelOverride
            console.log(
              `${LOG_TAG} 路由 → ollama（origin=${isSubagent ? 'subagent' : 'main'}，est_chars=${chars}）`,
            )
            return out
          }
          // 主对话：若当前 provider 不是 deepseek，修正回默认主 provider
          if (cfg?.provider && cfg.provider !== deepseekProviderId) {
            console.log(`${LOG_TAG} 路由 → ${deepseekProviderId}（原 provider=${cfg.provider}）`)
            return { ...cfg, provider: deepseekProviderId }
          }
          return cfg
        } catch (e) {
          console.error(`${LOG_TAG} 路由拦截失败，fail-open 放行原始配置：${(e as Error).message}`)
          return cfg
        }
      })
      console.log(`${LOG_TAG} agent/request 透明拦截已启用（ollama provider=${ollamaProviderId}）`)
    } else {
      console.log(
        `${LOG_TAG} agent/request 透明拦截未启用（未设置 LLM_ROUTER_OLLAMA_PROVIDER）；` +
          `chat() 服务/模块导入仍可用。设置该环境变量为 DSH 中 Ollama 的 provider id 即可启用。`,
      )
    }

    ctx.on('dispose', () => {
      console.log(`${LOG_TAG} disposed`)
    })
  },
}
