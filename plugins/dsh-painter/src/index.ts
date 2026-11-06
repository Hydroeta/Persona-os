/**
 * dsh-painter —— 逐帧作画引擎
 *
 * 拿到一张完整底图后，在后台用「扫描线 / 网格遮罩」逐帧显影，持续覆盖 OBS 监听的图片文件，
 * 模拟人类一笔一笔作画的过程。
 *
 * 设计要点（踩坑总结，全部已处理）：
 *   1. 原子写入：绝不直接覆盖 obs_output_path。先写 *.tmp，再 fs.rename 瞬间替换——
 *      OBS 读取监听文件时若遇到「写了一半」会黑屏/闪烁，rename 保证它永远只读到完整图。
 *      rename 带短重试，应对 Windows 文件共享的偶发 EBUSY。
 *   2. 并发取消：JobManager 单例持有当前任务的 AbortController + 定时器。新任务到来先
 *      abort 上一个，防止多个定时器同时写同一个 OBS 路径（画面诡异跳变）。
 *   3. 遮罩累积层（经验 100016180）：维护一个只增不减的 revealed 像素计数作为真源，
 *      每帧在「全新输出缓冲」上合成（base 经 mask 裁出已显影区 → 铺到白底），绝不对
 *      累积真源做破坏性合成，保证进度单调增长、历史痕迹不丢。
 *   4. 逐帧定时用 setTimeout 链（非 setInterval），取消即清，干净不残留。
 *   5. 底图源可配置：IMAGE_GEN_URL 指向生图微服务 / CogView 代理（POST {prompt} 返回图片字节，
 *      带超时 + 重试）；未配置时用 sharp 内置测试图（渐变 + 文字），保证无 key 也能验证管线。
 *   6. 测试模式：PAINTER_TEST_MODE=1 或 PAINTER_FRAMES_DIR=<dir> 时，每帧另存为
 *      frame_NNN.jpg，便于核对遮罩效果与帧数。
 *   7. dispose：abort 当前任务、清定时器、删残留 *.tmp。
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import sharp from 'sharp'
import axios from 'axios'

const LOG_TAG = '[dsh-painter]'

// 自动连本地生图微服务：dsh-service-manager 会在 8002 拉起 painter 微服务。
// 未显式设置 IMAGE_GEN_URL 且未开启本地测试图模式时，默认指向本地，插件一加载即可作画；
// 设 PAINTER_USE_LOCAL_IMAGE=1 可强制走内置测试图（冒烟用），此时不写默认 URL。
if (!process.env.IMAGE_GEN_URL && process.env.PAINTER_USE_LOCAL_IMAGE !== '1') {
  process.env.IMAGE_GEN_URL = 'http://127.0.0.1:8002/generate'
}

// ---------------------------------------------------------------------------
// 环境配置（全部可选，带默认值）
// ---------------------------------------------------------------------------
const env = {
  imageGenUrl: (process.env.IMAGE_GEN_URL || '').trim(),
  imageGenTimeoutMs: clampInt(process.env.IMAGE_GEN_TIMEOUT_MS, 1000, 600000, 30000),
  imageGenRetries: clampInt(process.env.IMAGE_GEN_RETRIES, 0, 10, 2),
  revealMode: (process.env.PAINTER_REVEAL_MODE || 'scanline').toLowerCase() === 'grid' ? 'grid' : 'scanline',
  grid: clampInt(process.env.PAINTER_GRID, 2, 64, 20),
  testMode: process.env.PAINTER_TEST_MODE === '1' || !!process.env.PAINTER_FRAMES_DIR,
  framesDir: (process.env.PAINTER_FRAMES_DIR || '').trim(),
  jpegQuality: clampInt(process.env.PAINTER_JPEG_QUALITY, 1, 100, 88),
  baseImageSize: clampInt(process.env.PAINTER_BASE_IMAGE_SIZE, 64, 4096, 1024),
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

// ---------------------------------------------------------------------------
// 底图获取（ImageProvider）
// ---------------------------------------------------------------------------

interface BaseImage {
  buffer: Buffer
  width: number
  height: number
  source: string
}

/** 从 IMAGE_GEN_URL 拉取底图：POST {prompt}，期望返回图片字节；若返回 JSON 含 url 则再下载。带超时 + 重试。 */
async function fetchRemoteImage(prompt: string): Promise<BaseImage> {
  const url = env.imageGenUrl
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= env.imageGenRetries; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), env.imageGenTimeoutMs)
      const resp = await axios.post(url, { prompt, scene: 'live' }, {
        responseType: 'arraybuffer',
        signal: controller.signal,
        timeout: env.imageGenTimeoutMs,
        validateStatus: (s) => s >= 200 && s < 300,
      })
      clearTimeout(timer)

      const ct = String(resp.headers['content-type'] || '').toLowerCase()
      let buf = Buffer.from(resp.data)
      // 端点返回 JSON {url} 时，二次下载图片
      if (ct.includes('json') || (buf.length && buf[0] === 0x7b /* { */)) {
        try {
          const j = JSON.parse(buf.toString('utf8'))
          const imgUrl: string = j?.url || j?.data?.[0]?.url || j?.image_url || ''
          if (imgUrl) {
            const r2 = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: env.imageGenTimeoutMs })
            buf = Buffer.from(r2.data)
          }
        } catch {
          /* 不是 JSON，按图片字节处理 */
        }
      }
      const meta = await sharp(buf).metadata()
      if (!meta.width || !meta.height) throw new Error('图片尺寸无效')
      return { buffer: buf, width: meta.width, height: meta.height, source: `remote:${url}` }
    } catch (e) {
      lastErr = e
      if (attempt < env.imageGenRetries) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 内置测试底图：SVG（渐变 + prompt 文字）→ sharp 光栅化；SVG 不可用时回退纯渐变。无 key 也能验证显影管线。 */
async function generateLocalTestImage(prompt: string): Promise<BaseImage> {
  const size = env.baseImageSize
  try {
    const svg = makeTestSvg(prompt, size)
    const buf = await sharp(svg)
      .resize(size, size)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: env.jpegQuality })
      .toBuffer()
    return { buffer: buf, width: size, height: size, source: 'local-test' }
  } catch {
    const buf = await sharp(makeGradientBuffer(size, size), { raw: { width: size, height: size, channels: 4 } })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: env.jpegQuality })
      .toBuffer()
    return { buffer: buf, width: size, height: size, source: 'local-test-gradient' }
  }
}

function svgEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function makeTestSvg(prompt: string, size: number): Buffer {
  const text = svgEscape(prompt.slice(0, 40))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#0f0c29"/><stop offset="50%" stop-color="#302b63"/><stop offset="100%" stop-color="#24243e"/>
</linearGradient>
<linearGradient id="txt" x1="0" y1="0" x2="1" y2="0">
<stop offset="0%" stop-color="#f7971e"/><stop offset="100%" stop-color="#ffd200"/>
</linearGradient>
</defs>
<rect width="100%" height="100%" fill="url(#bg)"/>
<circle cx="${Math.round(size * 0.82)}" cy="${Math.round(size * 0.18)}" r="${Math.round(size * 0.1)}" fill="#ffd200" opacity="0.85"/>
<text x="50%" y="46%" font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif" font-size="${Math.round(size * 0.075)}" font-weight="700" fill="url(#txt)" text-anchor="middle" dominant-baseline="middle">${text}</text>
<text x="50%" y="58%" font-family="Segoe UI, Arial, sans-serif" font-size="${Math.round(size * 0.032)}" fill="#ffffff" text-anchor="middle" opacity="0.8">dsh-painter test image</text>
</svg>`
  return Buffer.from(svg, 'utf8')
}

function makeGradientBuffer(w: number, h: number): Buffer {
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h)
      const i = (y * w + x) * 4
      buf[i] = Math.round(15 + t * 48)
      buf[i + 1] = Math.round(12 + t * 43)
      buf[i + 2] = Math.round(41 + t * 62)
      buf[i + 3] = 255
    }
  }
  return buf
}

async function getBaseImage(prompt: string): Promise<BaseImage> {
  if (env.imageGenUrl) return fetchRemoteImage(prompt)
  return generateLocalTestImage(prompt)
}

// ---------------------------------------------------------------------------
// 遮罩累积层（只增不减的真源 —— 经验 100016180）
// ---------------------------------------------------------------------------

class RevealMask {
  readonly width: number
  readonly height: number
  private readonly data: Uint8Array
  private revealed = 0

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.data = new Uint8Array(width * height)
  }

  /** 扫描线：按光栅序（左→右、上→下）显影前 p 比例像素。只增不减。 */
  revealFraction(p: number): void {
    const total = this.width * this.height
    const target = Math.min(total, Math.max(this.revealed, Math.round(p * total)))
    if (target > this.revealed) {
      this.data.fill(255, this.revealed, target)
      this.revealed = target
    }
  }

  /** 网格：按光栅序整块显影，前 p 比例的格子整块点亮。只增不减。 */
  revealFractionGrid(p: number, grid: number): void {
    const cols = grid
    const rows = grid
    const blockW = Math.ceil(this.width / cols)
    const blockH = Math.ceil(this.height / rows)
    const total = cols * rows
    const targetBlocks = Math.min(total, Math.max(0, Math.round(p * total)))
    for (let b = 0; b < targetBlocks; b++) {
      const br = Math.floor(b / cols)
      const bc = b % cols
      const x0 = bc * blockW
      const y0 = br * blockH
      const x1 = Math.min(this.width, x0 + blockW)
      const y1 = Math.min(this.height, y0 + blockH)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = y * this.width + x
          if (this.data[idx] === 0) {
            this.data[idx] = 255
            this.revealed++
          }
        }
      }
    }
  }

  toBuffer(): Buffer {
    return Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength)
  }
}

/** 渲染一帧：把单通道遮罩作为 alpha 通道挂到底图（joinChannel）→ 已显影区不透明、其余透明，
 *  再铺到白底上合成，输出 JPEG。每帧全新合成，遮罩真源（mask）只增不减，绝不被破坏性合成污染。 */
async function renderFrame(base: Buffer, mask: RevealMask, quality: number): Promise<Buffer> {
  const w = mask.width
  const h = mask.height
  const withAlpha = await sharp(base)
    .joinChannel(mask.toBuffer(), { raw: { width: w, height: h, channels: 1 } })
    .toBuffer()
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: withAlpha, blend: 'over' }])
    .jpeg({ quality })
    .toBuffer()
}

// ---------------------------------------------------------------------------
// 原子写入（防 OBS 读半文件）
// ---------------------------------------------------------------------------

async function atomicWrite(target: string, buf: Buffer, tmpSuffix: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${tmpSuffix}`
  await writeFile(tmp, buf)
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tmp, target)
      return
    } catch (e) {
      lastErr = e
      // Windows 下偶发文件共享占用，短退避重试
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
    }
  }
  // 最后兜底：直接写（极端情况，至少不留半文件状态）
  try {
    await writeFile(target, buf)
  } catch {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}

// ---------------------------------------------------------------------------
// JobManager：单例当前任务，新任务打断旧任务
// ---------------------------------------------------------------------------

interface Job {
  id: number
  abort: AbortController
  timer: ReturnType<typeof setTimeout> | null
  obsPath: string
}

let currentJob: Job | null = null
let jobSeq = 0
let lastObsPath = ''

/** 清理某 OBS 路径目录下所有残留的 *.tmp.* 临时文件（best-effort，dispose 时兜底）。 */
function cleanupStrayTmps(obsPath: string): void {
  try {
    const dir = dirname(obsPath)
    const base = basename(obsPath)
    for (const e of readdirSync(dir)) {
      if (e.startsWith(base + '.tmp')) {
        unlink(join(dir, e)).catch(() => {})
      }
    }
  } catch {
    /* 目录不存在等，忽略 */
  }
}

function abortCurrentJob(): void {
  if (!currentJob) return
  const job = currentJob
  currentJob = null
  try {
    job.abort.abort()
  } catch {
    /* ignore */
  }
  if (job.timer) {
    clearTimeout(job.timer)
    job.timer = null
  }
  // 只清理本任务自己的临时文件（jobId 后缀），避免误删并发新任务正在写的 tmp
  unlink(`${job.obsPath}.tmp.${job.id}`).catch(() => {})
}

export function cancelPaint(): void {
  abortCurrentJob()
}

// ---------------------------------------------------------------------------
// 主流程：逐帧作画
// ---------------------------------------------------------------------------

export interface PaintArgs {
  prompt: string
  obs_output_path: string
  duration_ms?: number
  fps?: number
}

export interface PaintResult {
  ok: boolean
  path?: string
  error?: string
  frames?: number
  elapsed_ms?: number
  source?: string
  cancelled?: boolean
}

export async function generatePaintProcess(args: PaintArgs): Promise<PaintResult> {
  const prompt = (args.prompt || '').trim()
  const obsPath = (args.obs_output_path || '').trim()
  if (!prompt) return { ok: false, error: 'prompt 不能为空' }
  if (!obsPath) return { ok: false, error: 'obs_output_path 不能为空（OBS 监听的图片绝对路径）' }

  const durationMs = clampInt(String(args.duration_ms), 500, 600000, 4000)
  const fps = clampInt(String(args.fps), 1, 60, 10)
  const totalFrames = Math.max(1, Math.round(durationMs / (1000 / fps)))
  const interval = 1000 / fps

  lastObsPath = obsPath
  // 打断上一个任务（防多定时器同写一个 OBS 路径）
  abortCurrentJob()
  const jobId = ++jobSeq
  const job: Job = { id: jobId, abort: new AbortController(), timer: null, obsPath }
  currentJob = job

  const t0 = performance.now()
  let framesWritten = 0
  let source = 'unknown'

  try {
    // 步骤一：获取底图
    let base: Buffer
    let w: number
    let h: number
    try {
      const got = await getBaseImage(prompt)
      base = got.buffer
      w = got.width
      h = got.height
      source = got.source
    } catch (e) {
      return { ok: false, error: `获取底图失败：${(e as Error).message}`, elapsed_ms: Math.round(performance.now() - t0) }
    }
    if (job.abort.signal.aborted) {
      return { ok: false, cancelled: true, error: '已取消', elapsed_ms: Math.round(performance.now() - t0), source }
    }

    // 测试模式：准备中间帧保存目录
    let framesDir = ''
    if (env.testMode) {
      framesDir = env.framesDir || join(process.cwd(), 'temp_paint_frames')
      mkdirSync(framesDir, { recursive: true })
    }
    const padLen = Math.max(3, String(totalFrames).length)

    // 步骤二/三：遮罩 + 逐帧显影
    const mask = new RevealMask(w, h)

    const writeFrame = async (i: number): Promise<void> => {
      if (job.abort.signal.aborted) return
      const p = (i + 1) / totalFrames // (0, 1]，最后一帧 = 1（完整底图）
      if (env.revealMode === 'grid') mask.revealFractionGrid(p, env.grid)
      else mask.revealFraction(p)
      const buf = await renderFrame(base, mask, env.jpegQuality)
      // 步骤四：原子写入 OBS 监听文件（tmp 带 jobId 后缀，并发任务互不干扰）
      await atomicWrite(obsPath, buf, String(jobId))
      framesWritten++
      if (framesDir) {
        const name = `frame_${String(i + 1).padStart(padLen, '0')}.jpg`
        await writeFile(join(framesDir, name), buf).catch(() => {})
      }
    }

    // setTimeout 链逐帧推进（非 setInterval，取消即清）
    for (let i = 0; i < totalFrames; i++) {
      if (job.abort.signal.aborted) break
      const frameStart = performance.now()
      await writeFrame(i)
      if (job.abort.signal.aborted) break
      if (i < totalFrames - 1) {
        const elapsed = performance.now() - frameStart
        const wait = Math.max(0, interval - elapsed)
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => resolve(), wait)
          job.timer = t
          job.abort.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              resolve()
            },
            { once: true },
          )
        })
      }
    }

    if (job.abort.signal.aborted) {
      return {
        ok: false,
        cancelled: true,
        error: '作画被新任务打断',
        frames: framesWritten,
        elapsed_ms: Math.round(performance.now() - t0),
        source,
      }
    }

    // 步骤五：收尾——最终文件必须是完整底图（兜底，即使最后一帧已是 p=1）
    const finalBuf = await sharp(base)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: env.jpegQuality })
      .toBuffer()
    await atomicWrite(obsPath, finalBuf, String(jobId))

    return {
      ok: true,
      path: obsPath,
      frames: framesWritten,
      elapsed_ms: Math.round(performance.now() - t0),
      source,
    }
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      frames: framesWritten,
      elapsed_ms: Math.round(performance.now() - t0),
      source,
    }
  } finally {
    if (currentJob === job) {
      if (job.timer) clearTimeout(job.timer)
      job.timer = null
      currentJob = null
    }
    unlink(`${obsPath}.tmp.${jobId}`).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// DSH 工具类型（最小子集，参照 dsh-web-agent / dsh-memory-bus 实测结构）
// ---------------------------------------------------------------------------

interface DshTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown>; render: (args: any, value: any) => any[] }
  execute: (args: any, exec: any) => Promise<any>
  presentCall?: (args: any) => any
}

const paintTool: DshTool = {
  name: 'generate_paint_process',
  description:
    '逐帧作画：根据 prompt 生成一张完整图片，然后用扫描线遮罩逐帧显影，原子写入覆盖 obs_output_path（OBS 监听的图片绝对路径），模拟人类作画过程。duration_ms 默认 4000，fps 默认 10。新调用会自动中断上一次作画。返回 {ok, path, frames, elapsed_ms}。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['prompt', 'obs_output_path'],
    properties: {
      prompt: { type: 'string', description: '生图提示词，如「一只赛博朋克鲸鱼」' },
      obs_output_path: { type: 'string', description: 'OBS 监听的图片绝对路径，如 C:\\live_assets\\current_paint.jpg' },
      duration_ms: { type: 'number', description: '整个作画过程持续毫秒数，默认 4000' },
      fps: { type: 'number', description: '刷新频率（帧/秒），默认 10' },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        path: { type: 'string' },
        frames: { type: 'number' },
        elapsed_ms: { type: 'number' },
        source: { type: 'string' },
        error: { type: 'string' },
      },
    },
    render: (_args: any, value: any) => [
      {
        type: 'text',
        text: value?.ok
          ? `🎨 作画完成 → ${value.path ?? ''}\n帧数：${value.frames ?? 0}　耗时：${value.elapsed_ms ?? 0}ms　底图源：${value.source ?? ''}`
          : `❌ 作画失败：${value?.error ?? '未知'}${value?.cancelled ? '（已被新任务打断）' : ''}`,
      },
    ],
  },
  async execute(args: any) {
    return generatePaintProcess({
      prompt: args?.prompt,
      obs_output_path: args?.obs_output_path,
      duration_ms: args?.duration_ms,
      fps: args?.fps,
    })
  },
  presentCall(args: any) {
    return {
      card: 'generic',
      title: `🎨 painter → ${String(args?.prompt ?? '').slice(0, 40)}`,
      kind: 'write',
    }
  },
}

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-painter',
  apply(ctx: any) {
    // 暴露服务供其他插件调用（best-effort，ctx.set 不存在时静默跳过）
    try {
      if (typeof ctx.set === 'function') {
        ctx.set('painter', { generate: generatePaintProcess, cancel: cancelPaint })
        console.log(`${LOG_TAG} 已暴露 painter 服务（ctx.get('painter')）`)
      }
    } catch (e) {
      console.error(`${LOG_TAG} 暴露 painter 服务失败：${(e as Error).message}`)
    }

    let toolDispose: (() => void) | null = null
    try {
      const d = ctx.tools.register(paintTool)
      if (typeof d === 'function') toolDispose = d
      console.log(`${LOG_TAG} 已注册工具 generate_paint_process`)
    } catch (e) {
      console.error(`${LOG_TAG} 注册 generate_paint_process 失败：`, e)
    }

    ctx.on('dispose', () => {
      if (toolDispose) {
        try {
          toolDispose()
        } catch {
          /* ignore */
        }
      }
      abortCurrentJob()
      if (lastObsPath) cleanupStrayTmps(lastObsPath)
      console.log(`${LOG_TAG} disposed`)
    })
  },
}
