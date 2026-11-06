/**
 * dsh-game-agent · 核心纯逻辑（与 DSH 进程解耦，可脱离宿主单测）
 *
 * 混合架构（任务 6）：
 *   TS 大脑（本模块）: 截屏 → 多模态 VLM 决策 → 解析动作 JSON → HTTP 转发给 Python 微服务
 *   Python 手（game-bot :8003）: 接收动作 → 调 vgamepad → 虚拟 Xbox 手柄信号 → 游戏
 *
 * 流程：captureScreen（node-screenshots，2s 超时降级）→ callVision（OpenAI 兼容多模态）→
 *       extractAction（括号深度扫描解析 JSON，容忍 markdown/散文）→ forwardAction（POST :8003/action）
 *
 * 安全契约（必须遵守，不可破坏）：
 *   - 截屏失败 / VLM 离线或未配置 / 解析失败 / game-bot 离线 → 一律返回 {ok:false, reason}，绝不抛错。
 *   - 默认 dry_run=true：只返回 VLM 决策的动作，不实际转发给 game-bot（安全预览，不会乱按手柄）。
 *   - 每次调用只走"一步"：截屏 → VLM → 一个动作，不自动循环（避免失控；用户显式连点才连续执行）。
 *   - game-bot 端另有 2s 看门狗：TS 崩溃/断网后自动松摇杆松按键，双保险。
 *
 * 所有外部依赖（captureFn / visionClient / forwardFn）均可注入，便于脱离 DSH 单测。
 */

export const LOG_TAG = '[dsh-game-agent]'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ActionType = 'move' | 'press' | 'release' | 'reset'

export interface GameAction {
  type: ActionType
  direction?: string
  button?: string
  duration?: number
}

/** 截屏函数：返回图片 Buffer（JPEG）。注入以便测试 mock。 */
export type CaptureFn = () => Promise<Buffer>

/** 视觉模型客户端：传入 base64 图片 + 用户 prompt，返回原始文本。注入以便测试 mock。 */
export interface VisionClient {
  decide(base64Img: string, userPrompt: string): Promise<string>
}

/** 转发函数：把动作发给 game-bot，返回其 JSON 响应。注入以便测试 mock。 */
export type ForwardFn = (action: GameAction, url: string, timeoutMs: number) => Promise<any>

export interface PlayGameStepOptions {
  /** 游戏目标（会拼进 VLM prompt） */
  goal: string
  /** true=只预览 VLM 决策的动作，不转发给 game-bot（默认，安全）；false=实际执行 */
  dry_run?: boolean
  /** game-bot 微服务地址，默认 GAME_BOT_URL 或 http://127.0.0.1:8003 */
  game_bot_url?: string
  /** 注入截屏实现（测试用）；未注入用 node-screenshots 默认实现 */
  captureFn?: CaptureFn
  /** 注入视觉客户端（测试用）；未注入用默认 OpenAI 兼容实现 */
  visionClient?: VisionClient
  /** 注入转发实现（测试用）；未注入用默认 fetch 实现 */
  forwardFn?: ForwardFn
  /** 视觉 API base，默认 VISION_API_BASE */
  visionApiBase?: string
  /** 视觉 API key，默认 VISION_API_KEY */
  visionApiKey?: string
  /** 视觉模型，默认 VISION_MODEL 或 glm-4v */
  visionModel?: string
  /** 截屏超时 ms，默认 2000 */
  captureTimeoutMs?: number
  /** 视觉调用超时 ms，默认 15000 */
  visionTimeoutMs?: number
  /** 转发 game-bot 超时 ms，默认 4000 */
  forwardTimeoutMs?: number
}

export interface PlayGameStepResult {
  ok: boolean
  reason?: string
  goal?: string
  dry_run?: boolean
  /** VLM 决策并解析出的动作（解析失败为 null） */
  action?: GameAction | null
  /** VLM 原始输出（便于排查） */
  raw_vlm?: string
  /** 是否实际转发给了 game-bot 执行 */
  executed?: boolean
  /** game-bot 返回的响应 */
  game_bot_response?: any
  /** 截图字节数（0=截屏失败） */
  screenshot_bytes?: number
}

// ---------------------------------------------------------------------------
// 允许的动作值域（与 Python game-bot 对齐）
// ---------------------------------------------------------------------------

const ALLOWED_DIRECTIONS = new Set(['forward', 'backward', 'left', 'right'])
const ALLOWED_BUTTONS = new Set([
  'a', 'b', 'x', 'y', 'lb', 'rb', 'start', 'back', 'l3', 'r3',
  'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right', 'guide',
])
const ALLOWED_TYPES = new Set<ActionType>(['move', 'press', 'release', 'reset'])

function clampDuration(v: unknown): number | undefined {
  const n = typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' ? Number(v) : NaN)
  if (!isFinite(n)) return undefined
  return Math.min(10, Math.max(0, n))
}

// ---------------------------------------------------------------------------
// Prompt（用户给定原文 + JSON 格式约束，保证可解析）
// ---------------------------------------------------------------------------

export function buildGamePrompt(goal: string): string {
  const g = String(goal ?? '').trim()
  // 用户给定的核心 prompt 保持原文；追加 JSON 格式约束是为了让 VLM 返回可解析的结构化动作
  return (
    `你现在在玩 PC 游戏，你的目标是 ${g || '（未指定）'}。根据画面，你下一步应该做什么宏观动作？（如一直向前跑、按 A 跳跃、按 B 交互）\n\n` +
    `请只输出一个 JSON 对象，不要输出任何其他文字、解释或 markdown 代码块标记。可选格式：\n` +
    `- 移动摇杆：{"type":"move","direction":"forward","duration":1.0}\n` +
    `  direction 只能是 forward / backward / left / right；duration 为保持秒数（0~10，可不填）\n` +
    `- 按按键：{"type":"press","button":"A","duration":0.2}\n` +
    `  button 只能是 A / B / X / Y / LB / RB / start / back / L3 / R3 / dpad_up / dpad_down / dpad_left / dpad_right / guide\n` +
    `- 松开按键：{"type":"release","button":"A"}\n` +
    `- 复位：{"type":"reset"}\n` +
    `如果画面里暂时不需要操作，输出 {"type":"reset"}。`
  )
}

// ---------------------------------------------------------------------------
// 1. 截屏（node-screenshots，2s 超时降级；可注入）
// ---------------------------------------------------------------------------

export async function captureScreen(timeoutMs: number): Promise<Buffer | null> {
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
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('截屏超时')), timeoutMs)),
    ])
    const buf: Buffer = await image.toJpeg()
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  } catch (e) {
    console.warn(`${LOG_TAG} 截屏失败/降级：${(e as Error).message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// 2. 视觉决策（OpenAI 兼容多模态；可注入）
// ---------------------------------------------------------------------------

export function createVisionClient(opts: { apiBase?: string; apiKey?: string; model?: string; timeoutMs?: number } = {}): VisionClient {
  const apiBase = (opts.apiBase ?? process.env.VISION_API_BASE ?? '').replace(/\/$/, '')
  const apiKey = opts.apiKey ?? process.env.VISION_API_KEY ?? ''
  const model = opts.model ?? process.env.VISION_MODEL ?? 'glm-4v'
  const timeoutMs = opts.timeoutMs ?? 15000

  return {
    async decide(base64Img: string, userPrompt: string): Promise<string> {
      if (!apiBase || !apiKey) {
        // 未配置视觉模型 → 不报错，返回空（由上层给出"视觉未配置"降级）
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
                  { type: 'text', text: userPrompt },
                  { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Img}` } },
                ],
              },
            ],
            max_tokens: 200,
            temperature: 0.2,
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
// 3. 解析 VLM 输出 → 动作（括号深度扫描，容忍 markdown / 散文 / 多行）
// ---------------------------------------------------------------------------

/**
 * 从模型原始输出中提取第一个 JSON 对象。
 * 用括号深度扫描定位完整对象（经验：模型常把 JSON 包在 ```json 里或前后加散文，
 * 正则 /\{.*\}/ 会在嵌套/多行时贪婪误匹配）。
 */
export function extractJsonObject(raw: unknown): unknown | null {
  if (typeof raw !== 'string') return null
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 校验并归一化解析到的对象为合法 GameAction；非法返回 null。 */
export function normalizeAction(parsed: unknown): GameAction | null {
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  const t = String(o.type ?? '').trim().toLowerCase()
  if (!ALLOWED_TYPES.has(t as ActionType)) return null
  const type = t as ActionType
  if (type === 'reset') {
    return { type: 'reset' }
  }
  if (type === 'move') {
    const dir = String(o.direction ?? '').trim().toLowerCase()
    if (!ALLOWED_DIRECTIONS.has(dir)) return null
    const duration = clampDuration(o.duration)
    const out: GameAction = { type: 'move', direction: dir }
    if (duration !== undefined) out.duration = duration
    return out
  }
  // press / release
  const btn = String(o.button ?? '').trim().toLowerCase()
  if (!ALLOWED_BUTTONS.has(btn)) return null
  const out: GameAction = { type, button: btn }
  if (type === 'press') {
    const duration = clampDuration(o.duration)
    if (duration !== undefined) out.duration = duration
  }
  return out
}

/** 组合：原始文本 → 合法 GameAction（或 null）。 */
export function extractAction(raw: unknown): GameAction | null {
  return normalizeAction(extractJsonObject(raw))
}

// ---------------------------------------------------------------------------
// 4. 转发动作给 game-bot :8003/action（可注入）
// ---------------------------------------------------------------------------

export async function forwardAction(action: GameAction, url: string, timeoutMs: number): Promise<any> {
  const base = url.replace(/\/$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let r: Response
  try {
    r = await fetch(`${base}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  let data: any = null
  const text = await r.text().catch(() => '')
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!r.ok) {
    const err = data?.detail?.error || data?.error || `HTTP ${r.status}`
    throw new Error(`game-bot 拒绝执行：${err}`)
  }
  return data
}

// ---------------------------------------------------------------------------
// 5. 编排：playGameStep（一步决策）
// ---------------------------------------------------------------------------

function isOfflineError(msg: string): boolean {
  return /abort|timeout|fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|network|连接被拒绝|连接超时/i.test(msg)
}

export async function playGameStep(opts: PlayGameStepOptions): Promise<PlayGameStepResult> {
  const goal = String(opts.goal ?? '').trim()
  const dryRun = opts.dry_run !== false // 默认 true：安全预览
  const gameBotUrl = opts.game_bot_url || process.env.GAME_BOT_URL || 'http://127.0.0.1:8003'
  const captureTimeoutMs = opts.captureTimeoutMs ?? 2000
  const visionTimeoutMs = opts.visionTimeoutMs ?? 15000
  const forwardTimeoutMs = opts.forwardTimeoutMs ?? 4000

  const captureFn = opts.captureFn ?? (() => captureScreen(captureTimeoutMs))
  const vision = opts.visionClient ?? createVisionClient({
    apiBase: opts.visionApiBase,
    apiKey: opts.visionApiKey,
    model: opts.visionModel,
    timeoutMs: visionTimeoutMs,
  })
  const forward = opts.forwardFn ?? forwardAction

  // ---- 1. 截屏（失败/超时 → 降级，绝不抛错）----
  let buf: Buffer | null = null
  try {
    const cap = await captureFn()
    buf = Buffer.isBuffer(cap) ? cap : null
  } catch {
    buf = null
  }
  if (!buf || buf.length === 0) {
    return { ok: false, reason: '截屏失败（node-screenshots 未安装或截屏超时）', goal, dry_run: dryRun, screenshot_bytes: 0 }
  }

  // ---- 2. VLM 决策（离线/未配置/超时 → 降级）----
  let rawVlm = ''
  try {
    rawVlm = await vision.decide(buf.toString('base64'), buildGamePrompt(goal))
  } catch (e) {
    return {
      ok: false,
      reason: `视觉调用异常：${(e as Error).message}`,
      goal,
      dry_run: dryRun,
      screenshot_bytes: buf.length,
    }
  }
  if (!rawVlm) {
    const configured = !!(opts.visionApiBase ?? process.env.VISION_API_BASE) && !!(opts.visionApiKey ?? process.env.VISION_API_KEY)
    return {
      ok: false,
      reason: configured ? 'VLM 未返回内容（离线或超时）' : '视觉模型未配置（请设置 VISION_API_BASE / VISION_API_KEY）',
      goal,
      dry_run: dryRun,
      screenshot_bytes: buf.length,
      raw_vlm: '',
    }
  }

  // ---- 3. 解析动作（解析失败 → 降级）----
  const action = extractAction(rawVlm)
  if (!action) {
    return {
      ok: false,
      reason: 'VLM 返回内容无法解析为合法动作 JSON',
      goal,
      dry_run: dryRun,
      screenshot_bytes: buf.length,
      raw_vlm: rawVlm,
      action: null,
    }
  }

  // ---- 4. dry_run 预览：不转发 ----
  if (dryRun) {
    return {
      ok: true,
      reason: 'dry_run：仅返回决策动作，未转发给 game-bot',
      goal,
      dry_run: true,
      action,
      raw_vlm: rawVlm,
      executed: false,
      screenshot_bytes: buf.length,
    }
  }

  // ---- 5. 转发执行（game-bot 离线/拒绝 → 降级）----
  try {
    const resp = await forward(action, gameBotUrl, forwardTimeoutMs)
    return {
      ok: true,
      reason: '动作已转发 game-bot 执行',
      goal,
      dry_run: false,
      action,
      raw_vlm: rawVlm,
      executed: true,
      game_bot_response: resp,
      screenshot_bytes: buf.length,
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    return {
      ok: false,
      reason: isOfflineError(msg) ? 'game-bot 离线' : `game-bot 执行失败：${msg}`,
      goal,
      dry_run: false,
      action,
      raw_vlm: rawVlm,
      executed: false,
      screenshot_bytes: buf.length,
    }
  }
}
