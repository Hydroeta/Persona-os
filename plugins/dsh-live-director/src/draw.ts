/**
 * draw.ts —— 直播「赛博画师接单」指令（dsh-live-director 侧）
 *
 * 拦截两种弹幕：
 *   !画 [内容]        普通点单，画在直播间（16:9）
 *   !画头像 [内容]    粉丝定制头像（1:1），落盘 data/fan_art/
 *
 * 设计约束（都很硬）：
 *   · **绝不阻塞主循环**：画图是异步 fire-and-forget，cosume 里 await 一下指令解析就够了，
 *     真正的作画在后台跑；任何异常都吞掉并打日志。
 *   · **冷却**：全局 30s / 单用户 60s。冷却中只回一句话，不开工。
 *   · **模式智能匹配**：像素/8-bit/pixel → pixel；排线/素描/线稿 → strokes；其余 → stages。
 *   · **落盘**：普通点单存 <outDir>/live_<时间戳>.png，头像存 <fanArtDir>/<日期>_<粉丝名>.png。
 *
 * 这里只做「解析 + 调度 + 落盘」，不碰 OBS / TTS —— 那两样由调用方决定怎么接。
 */
import { mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { requestPaint, type PaintResponse } from './painter-bridge.js'

const LOG_TAG = '[dsh-live-director/draw]'

export type PaintModeName = 'pixel' | 'strokes' | 'stages'

export interface DrawCommand {
  kind: 'art' | 'avatar'
  content: string
  mode: PaintModeName
  gridSize?: number
  aspect: '16:9' | '1:1'
}

/** 命中冷却时给用户的话 */
export const COOLDOWN_REPLY = '别急，画笔还没干呢'

/** 从文本里猜作画模式（纯函数，供测试） */
export function pickMode(text: string): PaintModeName {
  const t = String(text || '').toLowerCase()
  if (/像素|8-?bit|pixel|马赛克|复古游戏/.test(t)) return 'pixel'
  if (/排线|素描|线稿|铅笔|速写|lineart|sketch/.test(t)) return 'strokes'
  return 'stages'
}

/** 像素模式按内容复杂度给个默认格子数：说了具体数字就用数字 */
export function pickGridSize(text: string, mode: PaintModeName): number | undefined {
  if (mode !== 'pixel') return undefined
  const m = /(\d{2,3})\s*(?:×|x|p|格|像素)/i.exec(String(text || ''))
  if (m) {
    const n = Number(m[1])
    if (n >= 8 && n <= 256) return n
  }
  return 64
}

/**
 * 解析一条弹幕是不是画图指令。
 * 支持 `!画` / `！画`，`!画头像` 与 `!画 头像 ...` 都算头像单。
 */
export function parseDrawCommand(text: string): DrawCommand | null {
  const raw = String(text || '').trim()
  const m = /^[!！]画\s*(.*)$/.exec(raw)
  if (!m) return null
  let rest = (m[1] || '').trim()

  let kind: 'art' | 'avatar' = 'art'
  if (/^头像\s*(.*)$/s.test(rest)) {
    kind = 'avatar'
    rest = (rest.replace(/^头像\s*/s, '') || '').trim()
  } else if (/^头像$/.test(rest)) {
    kind = 'avatar'
    rest = ''
  }
  if (!rest) return null // 空指令不接

  const mode = pickMode(rest)
  return {
    kind,
    content: rest,
    mode,
    gridSize: pickGridSize(rest, mode),
    aspect: kind === 'avatar' ? '1:1' : '16:9',
  }
}

/** 播报文案：开工 / 完成 / 冷却 */
export function announceStart(cmd: DrawCommand, user: string): string {
  if (cmd.kind === 'avatar') return `给 ${user} 画个头像，等着哦`
  return `好嘞，这就画个${cmd.content}`
}

export function announceDone(cmd: DrawCommand, user: string, ok: boolean): string {
  if (!ok) return `这张没画成，${user} 再点一次吧`
  if (cmd.kind === 'avatar') return `${user} 的头像画好啦，已经保存在专属相册里啦！`
  return `画好啦，挂在墙上大家看好看吗？`
}

export function announceDoneFor(cmd: DrawCommand, user: string, ok: boolean): string {
  return announceDone(cmd, user, ok)
}

// ---------------------------------------------------------------------------
// 冷却（全局 30s / 单用户 60s）
// ---------------------------------------------------------------------------

export interface DrawCooldownConfig {
  globalMs: number
  perUserMs: number
}

export const DEFAULT_DRAW_COOLDOWN: DrawCooldownConfig = {
  globalMs: 30_000,
  perUserMs: 60_000,
}

export class DrawCooldown {
  private lastGlobal = 0
  private lastUser = new Map<string, number>()

  constructor(private cfg: DrawCooldownConfig = DEFAULT_DRAW_COOLDOWN) {}

  /** 只检查不记录 */
  check(user: string, now: number = Date.now()): { allowed: boolean; remainMs: number } {
    const ug = now - this.lastGlobal
    const uu = now - (this.lastUser.get(user) || 0)
    const remain = Math.max(this.cfg.globalMs - ug, this.cfg.perUserMs - uu, 0)
    return { allowed: remain <= 0, remainMs: remain }
  }

  /** 检查通过后调用，记录时间戳 */
  mark(user: string, now: number = Date.now()): void {
    this.lastGlobal = now
    this.lastUser.set(user, now)
  }
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 粉丝名里不能做文件名的字符一律换下划线 */
export function safeName(name: string): string {
  return String(name || 'anon').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'anon'
}

/** 计算落盘路径：头像进 fanArtDir，普通点单进 outDir */
export function targetPath(cmd: DrawCommand, user: string, dirs: { outDir: string; fanArtDir: string }, now: Date = new Date()): string {
  if (cmd.kind === 'avatar') {
    const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    return join(resolve(dirs.fanArtDir), `${d}_${safeName(user)}.png`)
  }
  const ts = now.getTime()
  return join(resolve(dirs.outDir), `live_${ts}.png`)
}

/** 帧目录：每次作画一个新目录，避免上一张的残留帧混进来 */
export function framesDirFor(root: string, now: Date = new Date()): string {
  const p = join(resolve(root), `draw_${now.getTime()}`)
  mkdirSync(p, { recursive: true })
  return p
}

/** 目录里最新的若干张画（给"刚才画的那张"用） */
export function latestArt(dir: string, limit = 5): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => /\.png$/i.test(f))
      .sort()
      .slice(-limit)
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

export { LOG_TAG, today }

// ---------------------------------------------------------------------------
// 接单：解析 → 冷却 → 后台作画 → 落盘。全程不抛异常。
// ---------------------------------------------------------------------------

export interface DrawRunnerDeps {
  /** 拼生图提示词（可以有风格后缀） */
  buildPrompt?: (cmd: DrawCommand) => string
  /** 落盘：把最终图复制到目标路径 */
  dirs: { outDir: string; fanArtDir: string; framesRoot: string }
  cooldown?: DrawCooldown
  /** 播报（TTS 占位，由调用方注入） */
  speak?: (text: string) => void
  /** 桥地址覆盖（默认读 PAINTER_BRIDGE_URL 环境变量，测试时直接传） */
  bridgeUrl?: string
  /** 画布显隐（OBS）；不传 = 不做显隐 */
  panel?: { showArt: (ms?: number) => Promise<unknown>; hideArt: () => Promise<void> }
}

export interface DrawHandleResult {
  /** 不是画图指令 → null */
  handled: boolean
  /** 立即回给观众的话（开工 / 冷却 / 失败） */
  reply?: string
}

/**
 * 处理一条弹幕是不是画图单。返回 handled=false 表示"不是画图指令，继续走 LLM"。
 * 真正的作画在**后台**跑，函数立刻返回，绝不阻塞弹幕队列。
 */
export function handleDrawCommand(text: string, user: string, deps: DrawRunnerDeps): DrawHandleResult {
  const cmd = parseDrawCommand(text)
  if (!cmd) return { handled: false }

  const cd = deps.cooldown ?? new DrawCooldown()
  const verdict = cd.check(user)
  if (!verdict.allowed) {
    return { handled: true, reply: COOLDOWN_REPLY }
  }
  cd.mark(user)

  const start = announceStart(cmd, user)
  deps.speak?.(start)

  // OBS 画布：作画开始就亮起来（失败只是 no-op，不影响接单）
  if (deps.panel) {
    void deps.panel.showArt().catch((e) => console.error(`${LOG_TAG} OBS 显示异常：${(e as Error).message}`))
  }

  // fire-and-forget：任何异常都在内部吞掉，只打日志
  void runDraw(cmd, user, deps).catch((e) => {
    console.error(`${LOG_TAG} 作画任务异常：${(e as Error).message}`)
  })

  return { handled: true, reply: start }
}

async function runDraw(cmd: DrawCommand, user: string, deps: DrawRunnerDeps): Promise<void> {
  const png = targetPath(cmd, user, deps.dirs)
  mkdirSync(resolve(deps.dirs.fanArtDir), { recursive: true })
  mkdirSync(resolve(deps.dirs.outDir), { recursive: true })
  mkdirSync(resolve(deps.dirs.framesRoot), { recursive: true })
  const framesDir = framesDirFor(deps.dirs.framesRoot)

  const prompt = deps.buildPrompt ? deps.buildPrompt(cmd) : cmd.content
  try {
    const { reportEventNoWait } = await import('./report.js')
    reportEventNoWait({ type: 'paint_start', prompt })
  } catch {
    /* 面板没接也无所谓 */
  }
  const res: PaintResponse = await requestPaint({
    prompt,
    obs_output_path: png,
    frames_dir: framesDir,
    mode: cmd.mode,
    grid_size: cmd.gridSize,
    aspect: cmd.aspect,
    duration_ms: 8000,
    fps: 12,
  }, { url: deps.bridgeUrl })

  if (res.ok && res.path) {
    try {
      copyFileSync(res.path, png)
    } catch (e) {
      console.error(`${LOG_TAG} 落盘失败（仍在原路径）：${(e as Error).message}`)
    }
  } else {
    console.error(`${LOG_TAG} 作画失败：${res.error || '未知'}`)
  }
  const done = announceDone(cmd, user, !!res.ok)
  deps.speak?.(done)

  // 头像单：画成了才交付（QQ hook 现在是占位，内部永不抛异常）
  if (res.ok && cmd.kind === 'avatar') {
    try {
      const { sendFanArtToQQ } = await import('./fan-art.js')
      await sendFanArtToQQ(user, png)
    } catch (e) {
      console.error(`${LOG_TAG} 头像交付异常（不影响作画）：${(e as Error).message}`)
    }
  }

  try {
    const { reportEventNoWait } = await import('./report.js')
    reportEventNoWait({ type: 'paint_end', ok: !!res.ok })
  } catch {
    /* ignore */
  }

  console.log(`${LOG_TAG} ${cmd.kind} 完成 user=${user} mode=${cmd.mode} aspect=${cmd.aspect} ok=${res.ok} -> ${png}`)
}

