/**
 * dsh-screen-companion —— 读屏陪伴（V2）
 *
 * 设计原则（克制第一）：
 *   - 有「绿眼睛」悬浮窗在跑才截屏，关掉就立刻停
 *   - 每 60 秒才截一次，只用来看「在干什么 / 什么情绪」，不读正文
 *   - 每天最多主动关心 3 次，两次之间至少 45 分钟
 *   - 有游戏在跑就暂停（避免吃性能、也别打扰）
 *   - 任何一步失败都静默，绝不弹错打扰用户
 *
 * 本模块不直接播报，只把决定交给 onCare 回调（接 TTS / 直播由宿主决定）。
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideCare, parseVlmReply, careLine, type Observation } from './analyze.js'

export const LOG_TAG = '[dsh-screen-companion]'

const HEARTBEAT = join(tmpdir(), 'dsh-screen-indicator.heartbeat')
const STATE_FILE = join(tmpdir(), 'dsh-screen-companion-state.json')
const DEFAULT_GAME_PROCS = 'Windose.exe,Stardew Valley.exe,BlackSouls.exe,steam.exe'

export interface CompanionOptions {
  /** 截屏（返回 JPEG Buffer；失败返回 null） */
  capture?: () => Promise<Buffer | null>
  /** 视觉模型（入参 base64，返回原始描述文本） */
  describe?: (base64: string, prompt: string) => Promise<string>
  /** 是否要暂停（如游戏在跑） */
  shouldPause?: () => Promise<boolean>
  /** 关心回调（宿主接 TTS / 直播；不传就只打日志） */
  onCare?: (line: string, decision: { kind?: string; reason: string; activity: string; mood: string }) => void
  /** 间隔（默认 60s；测试可改小） */
  intervalMs?: number
  /** 绿眼睛心跳过期阈值（默认 12s） */
  heartbeatStaleMs?: number
  /** 当前时间函数（测试注入） */
  now?: () => number
}

export const VLM_PROMPT =
  '看这张屏幕截图，用两行回答：第一行「在干什么:」后面写 4~10 个字（如 写代码/看视频/打游戏/看文档）；' +
  '第二行「情绪:」后面写 2~4 个字（如 专注/焦虑/轻松/无聊）。顺便判断画面里有没有大量红色报错。不要描述截图里的具体内容。'

/**
 * 核心循环（可独立测试）：跑一次 tick，返回这次发生了什么。
 */
export class Companion {
  private observations: Observation[] = []
  private lastCareAt = 0
  private careCountToday = 0
  private dayKey = ''
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private readonly opts: CompanionOptions = {}) {
    this.loadState()
  }

  get state() {
    return {
      observations: this.observations.length,
      careCountToday: this.careCountToday,
      lastCareAt: this.lastCareAt,
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private dayString(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10)
  }

  private loadState(): void {
    try {
      if (!existsSync(STATE_FILE)) return
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      this.dayKey = s.dayKey || ''
      this.lastCareAt = s.lastCareAt || 0
      this.careCountToday = this.dayKey === this.dayString(this.now()) ? s.careCountToday || 0 : 0
    } catch {
      /* 状态文件坏了就当没有 */
    }
  }

  private saveState(): void {
    try {
      writeFileSync(STATE_FILE, JSON.stringify({ dayKey: this.dayKey, lastCareAt: this.lastCareAt, careCountToday: this.careCountToday }))
    } catch {
      /* 存不下也不影响运行 */
    }
  }

  /** 绿眼睛还活着吗（心跳文件新鲜度） */
  indicatorAlive(): boolean {
    try {
      if (!existsSync(HEARTBEAT)) return false
      const age = Date.now() - statSync(HEARTBEAT).mtimeMs
      return age <= (this.opts.heartbeatStaleMs ?? 12_000)
    } catch {
      return false
    }
  }

  /** 一次观察：截屏 → 视觉 → 记一条 Observation → 决定是否关心 */
  async tick(): Promise<{ skipped?: string; observation?: Observation; cared?: boolean; line?: string }> {
    if (this.stopped) return { skipped: '已停止' }
    if (!this.indicatorAlive()) return { skipped: '绿眼睛没在跑，不截屏' }
    if (this.opts.shouldPause && (await this.opts.shouldPause().catch(() => false))) {
      return { skipped: '有游戏在跑，暂停' }
    }
    const capture = this.opts.capture ?? defaultCapture
    const describe = this.opts.describe ?? defaultDescribe
    try {
      const buf = await capture()
      if (!buf || buf.length < 1024) return { skipped: '截屏失败或空白' }
      const raw = await describe(buf.toString('base64'), VLM_PROMPT)
      const parsed = parseVlmReply(raw)
      const obs: Observation = { ts: this.now(), ...parsed }
      this.observations.push(obs)
      if (this.observations.length > 240) this.observations.shift() // 只留最近几小时

      // 跨天重置
      const today = this.dayString(obs.ts)
      if (this.dayKey !== today) {
        this.dayKey = today
        this.careCountToday = 0
      }

      const d = decideCare({
        observations: this.observations,
        now: obs.ts,
        lastCareAt: this.lastCareAt,
        careCountToday: this.careCountToday,
      })
      console.log(`${LOG_TAG} 观察：${obs.activity} / ${obs.mood}${obs.hasError ? '（有报错）' : ''} → ${d.care ? '打扰' : '不打扰'}：${d.reason}`)
      if (!d.care) return { observation: obs, cared: false }

      const line = careLine(d.kind, obs.ts)
      this.lastCareAt = obs.ts
      this.careCountToday++
      this.saveState()
      console.log(`${LOG_TAG} 💬 关心（第 ${this.careCountToday} 次/今天）：${line}`)
      this.opts.onCare?.(line, { kind: d.kind, reason: d.reason, activity: obs.activity, mood: obs.mood })
      return { observation: obs, cared: true, line }
    } catch (e) {
      // 静默：读屏陪伴不能因为一次失败就吵
      console.warn(`${LOG_TAG} 本次观察失败（已忽略）：${(e as Error).message}`)
      return { skipped: `失败：${(e as Error).message}` }
    }
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    const interval = this.opts.intervalMs ?? 60_000
    this.timer = setInterval(() => void this.tick(), interval)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    console.log(`${LOG_TAG} 已启动：每 ${Math.round(interval / 1000)}s 观察一次；绿眼睛心跳 ${HEARTBEAT}`)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.log(`${LOG_TAG} 已停止`)
  }

  get running(): boolean {
    return this.timer !== null
  }
}

// ---------------------------------------------------------------------------
// 默认实现（真实截屏 / 真实视觉 / 真实进程检查）
// ---------------------------------------------------------------------------

async function defaultCapture(): Promise<Buffer | null> {
  try {
    const mod: any = await import('node-screenshots')
    const Monitor = mod.Monitor ?? mod.default?.Monitor
    if (!Monitor?.all || typeof Monitor.all !== 'function') return null
    const monitors = Monitor.all()
    if (!monitors?.length) return null
    const img = await monitors[0].captureImage()
    return await img.toJpeg()
  } catch (e) {
    console.warn(`${LOG_TAG} node-screenshots 不可用：${(e as Error).message}`)
    return null
  }
}

async function defaultDescribe(base64: string, prompt: string): Promise<string> {
  const apiBase = (process.env.VISION_API_BASE || '').replace(/\/$/, '')
  const apiKey = process.env.VISION_API_KEY || ''
  if (!apiBase || !apiKey) throw new Error('没有配置 VISION_API_BASE / VISION_API_KEY')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const r = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.VISION_MODEL || 'glm-4v-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 120,
      }),
    })
    if (!r.ok) throw new Error(`视觉接口 ${r.status}`)
    const j: any = await r.json()
    return j?.choices?.[0]?.message?.content || ''
  } finally {
    clearTimeout(timer)
  }
}

/** 有游戏在跑就不观察（省性能、也别打扰） */
export function makeGameProbe(list = process.env.DSH_SCREEN_GAME_PROCS || DEFAULT_GAME_PROCS) {
  const procs = list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return () =>
    new Promise<boolean>((resolve) => {
      execFile('tasklist', ['/fo', 'csv', '/nh'], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout) return resolve(false)
        const lower = stdout.toLowerCase()
        resolve(procs.some((p) => p && lower.includes(p)))
      })
    })
}
