/**
 * dsh-live-director · 模块 4：多模态画面感知
 *
 * 职责（严格对照架构指令）：
 *   1. captureScreenContext()：截取主屏幕 → 压缩(JPEG) + Base64 → 调视觉大模型描述画面。
 *   2. 截屏必须有 2 秒超时 / 失败降级，绝对不能卡死直播主流程。
 *   3. shouldCaptureScreen(text)：弹幕命中“看/在干嘛/画了什么”等关键词时才触发截屏。
 *
 * 设计：captureFn 与 visionClient 均可注入（测试 mock），默认实现带超时降级；
 *      node-screenshots 用动态 import（native 模块），esbuild 标记 external，
 *      加载失败/截屏失败一律返回 ''，直播链路不受影响。
 */

export const LOG_TAG = '[dsh-live-director:perception]'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 截屏函数：返回图片 Buffer（JPEG/PNG）。注入以便测试 mock。 */
export type CaptureFn = () => Promise<Buffer>

/** 视觉模型客户端：传入 base64 图片 + prompt，返回描述文本。注入以便测试 mock。 */
export interface VisionClient {
  describe(base64Img: string, prompt: string): Promise<string>
}

export interface PerceptionOptions {
  captureFn?: CaptureFn
  visionClient?: VisionClient
  /** 截屏阶段超时（ms），默认 2000 */
  captureTimeoutMs?: number
  /** 整体调用超时（ms），默认 10000，兜底防止视觉调用拖死直播 */
  overallTimeoutMs?: number
  /** 单张图片 base64 前的最大字节数，超限则跳过视觉（避免超大 payload） */
  maxImageBytes?: number
}

// ---------------------------------------------------------------------------
// 关键词判定
// ---------------------------------------------------------------------------

const VISION_KEYWORDS = ['在干嘛', '画了什么', '画的什么', '在画什么', '看一下', '看看', '画面', '屏幕', '你在干嘛', '在做什么']

/** 弹幕是否需要触发画面感知 */
export function shouldCaptureScreen(text: string): boolean {
  const t = String(text ?? '')
  if (!t) return false
  return VISION_KEYWORDS.some((kw) => t.includes(kw))
}

// ---------------------------------------------------------------------------
// 默认截屏实现（node-screenshots，2s 超时降级）
// ---------------------------------------------------------------------------

async function defaultCapture(timeoutMs: number): Promise<Buffer | null> {
  let mod: any
  try {
    mod = await import('node-screenshots')
  } catch (e) {
    console.warn(`${LOG_TAG} node-screenshots 加载失败（降级）：${(e as Error).message}`)
    return null
  }
  const Monitor = mod?.Monitor || mod?.default?.Monitor
  if (typeof Monitor?.all !== 'function') {
    console.warn(`${LOG_TAG} node-screenshots 导出异常（无 Monitor.all），降级`)
    return null
  }
  try {
    const monitors: any[] = Monitor.all()
    if (!Array.isArray(monitors) || monitors.length === 0) return null
    const primary = monitors.find((m) => typeof m?.isPrimary === 'function' && m.isPrimary()) || monitors[0]
    const image: any = await Promise.race([
      primary.captureImage(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('截屏超时')), timeoutMs),
      ),
    ])
    // JPEG 压缩：体积远小于 PNG，适合多模态上传
    const buf: Buffer = await image.toJpeg()
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  } catch (e) {
    console.warn(`${LOG_TAG} 截屏失败/降级：${(e as Error).message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// 默认视觉客户端（OpenAI 兼容多模态，GLM-4V 走 VISION_API_BASE/KEY/MODEL）
// ---------------------------------------------------------------------------

export function createVisionClient(
  opts: { apiBase?: string; apiKey?: string; model?: string; timeoutMs?: number } = {},
): VisionClient {
  const apiBase = (opts.apiBase ?? process.env.VISION_API_BASE ?? '').replace(/\/$/, '')
  const apiKey = opts.apiKey ?? process.env.VISION_API_KEY ?? ''
  const model = opts.model ?? process.env.VISION_MODEL ?? 'glm-4v'
  const timeoutMs = opts.timeoutMs ?? 8000

  return {
    async describe(base64Img: string, prompt: string): Promise<string> {
      if (!apiBase || !apiKey) {
        // 未配置视觉模型 → 不报错，返回空（测试会注入 mock；生产未配置时静默降级）
        return ''
      }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const r = await fetch(`${apiBase}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Img}` } },
                ],
              },
            ],
            max_tokens: 100,
          }),
          signal: ctrl.signal,
        })
        const data = await r.json().catch(() => ({}))
        return String((data as any)?.choices?.[0]?.message?.content ?? '').trim()
      } catch (e) {
        console.warn(`${LOG_TAG} 视觉调用失败（降级为空）：${(e as Error).message}`)
        return ''
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

export class Perception {
  private readonly captureFn: CaptureFn | null
  private readonly vision: VisionClient
  private readonly captureTimeoutMs: number
  private readonly overallTimeoutMs: number
  private readonly maxImageBytes: number

  constructor(opts: PerceptionOptions = {}) {
    this.captureTimeoutMs = opts.captureTimeoutMs ?? 2000
    this.overallTimeoutMs = opts.overallTimeoutMs ?? 10000
    this.maxImageBytes = opts.maxImageBytes ?? 2 * 1024 * 1024 // 2MB（JPEG 主屏通常远小于此）
    this.vision = opts.visionClient ?? createVisionClient()
    // 注入的 captureFn 直接用；未注入则用默认实现（带超时）
    this.captureFn = opts.captureFn ?? null
  }

  /**
   * 截取主屏幕 → 压缩 base64 → 视觉模型描述，返回 ≤20 字的画面描述。
   * 任何环节失败/超时都返回 ''，绝不抛错打断直播。
   */
  async captureScreenContext(): Promise<string> {
    const overall = new AbortController()
    const overallTimer = setTimeout(() => overall.abort(), this.overallTimeoutMs)
    try {
      // 1) 截屏（2s 超时降级）
      let buf: Buffer | null = null
      try {
        const cap = this.captureFn ? await this.captureFn() : await defaultCapture(this.captureTimeoutMs)
        buf = Buffer.isBuffer(cap) ? cap : null
      } catch {
        buf = null
      }
      if (!buf || buf.length === 0) return ''

      // 2) 体积超限 → 跳过（避免超大 base64 拖垮请求）
      if (buf.length > this.maxImageBytes) {
        console.warn(`${LOG_TAG} 截图过大（${buf.length}B > ${this.maxImageBytes}B），跳过视觉`)
        return ''
      }

      // 3) base64 + 视觉描述
      const b64 = buf.toString('base64')
      const desc = await this.vision.describe(b64, '用 20 字以内描述这张图里主播正在干嘛')
      return desc
    } catch (e) {
      console.warn(`${LOG_TAG} captureScreenContext 异常（降级为空）：${(e as Error).message}`)
      return ''
    } finally {
      clearTimeout(overallTimer)
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt 拼装（纯函数，便于测试）
// ---------------------------------------------------------------------------

/** 把画面描述拼到用户消息上下文里；空描述返回 '' */
export function buildScreenPrompt(desc: string): string {
  const d = String(desc ?? '').trim()
  return d ? `（当前直播画面：${d}）` : ''
}
