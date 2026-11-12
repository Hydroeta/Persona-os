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
import { analyzeStrokes, renderStrokeFrame } from './strokes.js'

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
  // 三阶段派生作画（勾线→铺色→细节）；设 PAINTER_THREE_STAGE=0 可退回单图扫描线
  threeStage: process.env.PAINTER_THREE_STAGE !== '0',
  stageLong: clampInt(process.env.PAINTER_STAGE_LONG, 256, 1536, 768),
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
  /** 微服务 X-Painter-Msg（已 percent-decode）：生图侧给的人类可读说明，如「画好啦！」 */
  message?: string
}

/**
 * 读 HTTP 响应头里的 X-Painter-* 字段。
 * painter 微服务用 `urllib.parse.quote` 转义过（HTTP 头只能 latin-1，中文写进去会让服务器 500），
 * 所以这里必须 percent-decode，直接拿来展示会看到 `%E7%94%BB...` 这种乱码串。
 */
/**
 * 安全 decodeURIComponent：并非所有 percent 序列都合法（比如别人塞了个裸 %），
 * 坏一个字段不该让整条作画链路报错，解不开就原样返回。
 */
function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

function readPainterHeaders(headers: Record<string, any>): { msg?: string; outPath?: string; provider?: string } {
  const get = (k: string): string => {
    const v = headers?.[k]
    return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')
  }
  const decode = (v: string): string => {
    if (!v) return ''
    try {
      return decodeURIComponent(v)
    } catch {
      return v // 不是合法 percent 编码就原样返回，不让一个坏头把整条链路搞崩
    }
  }
  return {
    msg: decode(get('x-painter-msg')),
    outPath: decode(get('x-painter-path')),
    provider: get('x-painter-provider'),
  }
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
      const hdr = readPainterHeaders(resp.headers as Record<string, any>)
      return {
        buffer: buf,
        width: meta.width,
        height: meta.height,
        source: hdr.provider ? `remote:${hdr.provider}` : `remote:${url}`,
        message: hdr.msg || undefined,
      }
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
// 三阶段派生作画（2026-11-11 新增）
//
// 为什么不是「并发调 3 次生图」：同一 prompt 生 3 次会得到 3 张构图不同的画，
// 阶段之间会跳画。这里只生 1 张成品，再在本地派生：
//   ① 线稿 —— 灰度 → 反相模糊 → 颜色减淡，抬对比把背景推成纯白
//   ② 铺色 —— 先模糊再按通道量化成 4 档色块（大色块没有线）
//   ③ 成品 —— 原图
// 三张图**像素级对齐**，所以「先勾线 → 再从线往里铺色 → 最后补细节」看起来是同一只手在画。
// ---------------------------------------------------------------------------

const STAGE_P1 = 0.46 // 0 ~ 0.46：勾线
const STAGE_P2 = 0.82 // 0.46 ~ 0.82：铺色；之后到 1：补细节

function boxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    let sum = 0
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = (sum / win) | 0
      sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = (sum / win) | 0
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

/** 线稿：灰度 + 反相模糊做颜色减淡，再抬对比把纸推白 */
function sketchFromRgb(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h
  const gray = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    gray[i] = (rgb[j] * 0.299 + rgb[j + 1] * 0.587 + rgb[j + 2] * 0.114) | 0
  }
  const blur = boxBlur(gray, w, h, Math.max(2, Math.round(w / 220)))
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    const inv = 255 - blur[i]
    let v = inv >= 255 ? 255 : Math.min(255, (gray[i] * 255) / Math.max(1, 255 - inv))
    v = Math.max(0, Math.min(255, (v - 150) * (255 / 105)))
    out[i * 3] = v
    out[i * 3 + 1] = v
    out[i * 3 + 2] = v
  }
  return out
}

/** 铺色：模糊后按每通道 4 档量化，接近白的推成纸白 */
function flatFromRgb(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h
  const ch = [0, 1, 2].map((c) => {
    const one = new Uint8Array(n)
    for (let i = 0; i < n; i++) one[i] = rgb[i * 3 + c]
    return boxBlur(one, w, h, 2)
  })
  const q = (v: number): number => (v > 232 ? 250 : Math.max(0, Math.min(255, Math.round(v / 40) * 40)))
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    out[i * 3] = q(ch[0][i])
    out[i * 3 + 1] = q(ch[1][i])
    out[i * 3 + 2] = q(ch[2][i])
  }
  return out
}

/** 线稿像素 → 到最近墨线的距离场（BFS，小图算，用的时候按最近邻采样放大） */
function inkDistanceField(sketch: Uint8Array, w: number, h: number, sw: number, sh: number) {
  const small = new Uint8Array(sw * sh)
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) / sh) * h))
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) / sw) * w))
      const v = sketch[(sy * w + sx) * 3]
      if (v < 205) small[y * sw + x] = 1 // 有墨
    }
  }
  const dist = new Float32Array(sw * sh)
  const INF = 1e6
  for (let i = 0; i < sw * sh; i++) dist[i] = small[i] ? 0 : INF
  // 两遍 chamfer 距离变换（8 邻域、对角 1.414）≈ 欧氏距离。
  // 第一次用 4 邻域 BFS，填色前沿是菱形轮廓（马赛克感就是这么来的），换成 chamfer 才是圆的。
  const D1 = 1
  const D2 = 1.4142
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x
      let d = dist[i]
      if (d === 0) continue
      if (x > 0) d = Math.min(d, dist[i - 1] + D1)
      if (y > 0) {
        d = Math.min(d, dist[i - sw] + D1)
        if (x > 0) d = Math.min(d, dist[i - sw - 1] + D2)
        if (x < sw - 1) d = Math.min(d, dist[i - sw + 1] + D2)
      }
      dist[i] = d
    }
  }
  let maxDist = 0
  for (let y = sh - 1; y >= 0; y--) {
    for (let x = sw - 1; x >= 0; x--) {
      const i = y * sw + x
      let d = dist[i]
      if (x < sw - 1) d = Math.min(d, dist[i + 1] + D1)
      if (y < sh - 1) {
        d = Math.min(d, dist[i + sw] + D1)
        if (x < sw - 1) d = Math.min(d, dist[i + sw + 1] + D2)
        if (x > 0) d = Math.min(d, dist[i + sw - 1] + D2)
      }
      dist[i] = d
      if (d > maxDist && d < INF) maxDist = d
    }
  }
  // 给距离场加一点抖动：填色前沿是完美等距线的话像"渐变圆环"，
  // 抖一下才像笔刷铺开（确定性伪随机，同一张图每次都一样）。
  let s = 0x2545f491
  for (let i = 0; i < sw * sh; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    if (dist[i] > 0) dist[i] += ((s >>> 16) / 65535 - 0.5) * 1.8
  }
  return { dist, sw, sh, maxDist: Math.max(1, maxDist) }
}

interface Stages {
  w: number
  h: number
  sketch: Uint8Array
  flat: Uint8Array
  final: Uint8Array
  dist: Float32Array
  sw: number
  sh: number
  maxDist: number
  dither: Uint8Array
  dw: number
  dh: number
  /** 预先算好的采样索引/权重：逐帧再算 60 万次除法会把帧时间顶到 120ms，直播会掉帧 */
  sx0: Int32Array
  sx1: Int32Array
  stx: Float32Array
  sy0: Int32Array
  sy1: Int32Array
  sty: Float32Array
  xf: Float32Array
}

async function prepareStages(finalBuf: Buffer, targetLong: number): Promise<Stages> {
  const meta = await sharp(finalBuf).metadata()
  const iw = meta.width || 1024
  const ih = meta.height || 1024
  const scale = Math.min(1, targetLong / Math.max(iw, ih))
  const w = Math.max(64, Math.round(iw * scale))
  const h = Math.max(64, Math.round(ih * scale))
  const { data: rgb } = await sharp(finalBuf)
    .flatten({ background: '#ffffff' })
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const final = new Uint8Array(rgb)
  const sketch = sketchFromRgb(final, w, h)
  const flat = flatFromRgb(final, w, h)
  const sw = Math.min(200, w)
  const sh = Math.max(1, Math.round((h / w) * sw))
  const field = inkDistanceField(sketch, w, h, sw, sh)
  // 细节浮现按 4×4 小格推进（逐像素抖动会看起来像雪花噪点，成块才像"补笔")
  const dw = Math.ceil(w / 4)
  const dh = Math.ceil(h / 4)
  const dither = new Uint8Array(dw * dh)
  let seed = 0x9e3779b9
  for (let i = 0; i < dither.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    dither[i] = seed >>> 24
  }
  const sx0 = new Int32Array(w)
  const sx1 = new Int32Array(w)
  const stx = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const fx = (x * sw) / w - 0.5
    const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)))
    sx0[x] = x0
    sx1[x] = Math.max(0, Math.min(sw - 1, x0 + 1))
    stx[x] = Math.max(0, Math.min(1, fx - x0))
  }
  const sy0 = new Int32Array(h)
  const sy1 = new Int32Array(h)
  const sty = new Float32Array(h)
  for (let y = 0; y < h; y++) {
    const fy = (y * sh) / h - 0.5
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)))
    sy0[y] = y0
    sy1[y] = Math.max(0, Math.min(sh - 1, y0 + 1))
    sty[y] = Math.max(0, Math.min(1, fy - y0))
  }
  const xf = new Float32Array(w)
  for (let x = 0; x < w; x++) xf[x] = x / w
  return {
    w, h, sketch, flat, final, dist: field.dist, sw: field.sw, sh: field.sh,
    maxDist: field.maxDist, dither, dw, dh, sx0, sx1, stx, sy0, sy1, sty, xf,
  }
}

/** 生成某一进度（0~1] 的画面：勾线（斜向扫）→ 从墨线往里铺色 → 细节浮现 */
async function renderStageFrame(st: Stages, p: number, quality: number): Promise<Buffer> {
  const { w, h, sketch, flat, final, dist, sw, sh, maxDist, dither, dw, dh, sx0, sx1, stx, sy0, sy1, sty, xf } = st
  const n = w * h
  const out = Buffer.alloc(n * 3)
  if (p <= STAGE_P1) {
    const prog = p / STAGE_P1
    // 斜向扫描（左→右为主，略带自上而下的倾斜），比按行扫描更像"手在画"
    const diag = 1.35
    const lim = prog * diag
    for (let y = 0; y < h; y++) {
      const ry = (y / h) * 0.35
      const row = y * w * 3
      for (let x = 0; x < w; x++) {
        const k = row + x * 3
        if (xf[x] + ry <= lim) {
          out[k] = sketch[k]
          out[k + 1] = sketch[k + 1]
          out[k + 2] = sketch[k + 2]
        } else {
          out[k] = out[k + 1] = out[k + 2] = 255
        }
      }
    }
  } else if (p <= STAGE_P2) {
    // 铺色：从墨线往区域内部推进。距离场双线性采样 + 软边过渡，
    // 否则小图上按最近邻取距离会顶出一块块方块（第一次试就踩了，像马赛克填色）。
    const grow = ((p - STAGE_P1) / (STAGE_P2 - STAGE_P1)) * maxDist
    const band = 1.6 // 软化带宽（小图像素）
    for (let y = 0; y < h; y++) {
      const y0 = sy0[y]
      const y1 = sy1[y]
      const ty = sty[y]
      const rowA = y0 * sw
      const rowB = y1 * sw
      const row = y * w * 3
      for (let x = 0; x < w; x++) {
        const x0 = sx0[x]
        const x1 = sx1[x]
        const tx = stx[x]
        const d =
          dist[rowA + x0] * (1 - tx) * (1 - ty) +
          dist[rowA + x1] * tx * (1 - ty) +
          dist[rowB + x0] * (1 - tx) * ty +
          dist[rowB + x1] * tx * ty
        let a = (grow + band - d) / (2 * band)
        a = a <= 0 ? 0 : a >= 1 ? 1 : a
        const k = row + x * 3
        out[k] = (sketch[k] + (flat[k] - sketch[k]) * a) | 0
        out[k + 1] = (sketch[k + 1] + (flat[k + 1] - sketch[k + 1]) * a) | 0
        out[k + 2] = (sketch[k + 2] + (flat[k + 2] - sketch[k + 2]) * a) | 0
      }
    }
  } else {
    const thr = ((p - STAGE_P2) / (1 - STAGE_P2)) * 260
    for (let y = 0; y < h; y++) {
      const by = Math.min(dh - 1, y >> 2)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const src = dither[by * dw + Math.min(dw - 1, x >> 2)] < thr ? final : flat
        out[i * 3] = src[i * 3]
        out[i * 3 + 1] = src[i * 3 + 1]
        out[i * 3 + 2] = src[i * 3 + 2]
      }
    }
  }
  return sharp(Buffer.from(out), { raw: { width: w, height: h, channels: 3 } })
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
  /** 作画方式：'stages'（三阶段派生，默认）| 'strokes'（真逐笔勾线，需要干净线稿底图） */
  mode?: 'stages' | 'strokes'
  /** strokes 模式的配色，按笔画重心纵带取；只有一个值 = 单色 */
  palette?: string[]
}

export interface PaintResult {
  ok: boolean
  path?: string
  error?: string
  frames?: number
  elapsed_ms?: number
  source?: string
  cancelled?: boolean
  /** strokes 模式：实际笔画数（给调用方一个可解释的量） */
  strokes?: number
  mode?: string
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
  let painterMsg = ''

  try {
    // 步骤一：获取底图
    let base: Buffer
    let w: number
    let h: number
    try {
      // strokes 模式要的是线稿：点单说「画个电饭煲」时自动补线稿风格词，避免拿到彩色图去追轮廓
      const genPrompt =
        args.mode === 'strokes' && !/lineart|coloring book|线稿/i.test(prompt)
          ? `${prompt}，simple lineart, clean thick strokes, coloring book page, black ink on white background, no shading`
          : prompt
      const got = await getBaseImage(genPrompt)
      base = got.buffer
      w = got.width
      h = got.height
      source = got.source
      painterMsg = got.message ? decodeURIComponentSafe(got.message) : ''    } catch (e) {
      return { ok: false, error: `获取底图失败：${(e as Error).message}`, elapsed_ms: Math.round(performance.now() - t0) }
    }
    if (job.abort.signal.aborted) {
      return { ok: false, cancelled: true, error: '已取消', elapsed_ms: Math.round(performance.now() - t0), source }
    }

    // 步骤二：派生三阶段（勾线 / 铺色 / 细节）。派生失败就退回单图扫描线，不让链路整体挂掉。
    let stages: Stages | null = null
    let strokeRes: (Awaited<ReturnType<typeof analyzeStrokes>>) | null = null
    if (args.mode === 'strokes') {
      // 真逐笔：把底图当线稿，追踪成笔画；笔画太少（<5 条）说明这张图不适合，退回三阶段
      try {
        const res = await analyzeStrokes(base, {
          width: env.stageLong,
          binThreshold: process.env.PAINTER_BIN_THRESH ? clampInt(process.env.PAINTER_BIN_THRESH, 40, 254, 128) : undefined,
          openRadius: clampInt(process.env.PAINTER_OPEN_R, 0, 4, 1),
          minArea: clampInt(process.env.PAINTER_MIN_AREA, 20, 5000, 150),
          minLen: clampInt(process.env.PAINTER_MIN_LEN, 0, 400, 0),
          smooth: clampInt(process.env.PAINTER_SMOOTH, 0, 3, 1),
          cropBottom: Number(process.env.PAINTER_CROP_BOTTOM || 0.06),
          palette: args.palette && args.palette.length ? args.palette : ['#22384f'],
        })
        if (res.strokes.length >= 5) strokeRes = res
        else console.error(`${LOG_TAG} 笔画只有 ${res.strokes.length} 条，退回三阶段`)
      } catch (e) {
        console.error(`${LOG_TAG} 笔画追踪失败，退回三阶段：${(e as Error).message}`)
      }
    }
    if (!strokeRes && env.threeStage) {
      try {
        stages = await prepareStages(base, env.stageLong)
      } catch (e) {
        console.error(`${LOG_TAG} 三阶段派生失败，退回扫描线：${(e as Error).message}`)
        stages = null
      }
    }

    // 测试模式：准备中间帧保存目录
    let framesDir = ''
    if (env.testMode) {
      framesDir = env.framesDir || join(process.cwd(), 'temp_paint_frames')
      mkdirSync(framesDir, { recursive: true })
    }
    const padLen = Math.max(3, String(totalFrames).length)

    // 步骤三：逐帧显影
    const mask = new RevealMask(w, h)

    const writeFrame = async (i: number): Promise<void> => {
      if (job.abort.signal.aborted) return
      const p = (i + 1) / totalFrames // (0, 1]，最后一帧 = 1（完整底图）
      let buf: Buffer
      if (strokeRes) {
        buf = await renderStrokeFrame(strokeRes, p, env.jpegQuality)
      } else if (stages) {
        buf = await renderStageFrame(stages, p, env.jpegQuality)
      } else {
        if (env.revealMode === 'grid') mask.revealFractionGrid(p, env.grid)
        else mask.revealFraction(p)
        buf = await renderFrame(base, mask, env.jpegQuality)
      }
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
      mode: strokeRes ? 'strokes' : stages ? 'stages' : 'scanline',
      strokes: strokeRes ? strokeRes.strokes.length : undefined,
      message: painterMsg || undefined,
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
    '逐帧作画：根据 prompt 生成一张完整图片，再在本地派生「线稿 → 铺色 → 细节」三个阶段，逐帧显影并原子写入覆盖 obs_output_path（OBS 监听的图片绝对路径），模拟人类一笔一笔作画。duration_ms 默认 4000，fps 默认 10。新调用会自动中断上一次作画。返回 {ok, path, frames, elapsed_ms}。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['prompt', 'obs_output_path'],
    properties: {
      prompt: { type: 'string', description: '生图提示词，如「一只赛博朋克鲸鱼」' },
      obs_output_path: { type: 'string', description: 'OBS 监听的图片绝对路径，如 C:\\live_assets\\current_paint.jpg' },
      duration_ms: { type: 'number', description: '整个作画过程持续毫秒数，默认 4000' },
      fps: { type: 'number', description: '刷新频率（帧/秒），默认 10' },
      mode: { type: 'string', enum: ['stages', 'strokes'], description: 'stages=三阶段派生（默认）；strokes=真逐笔勾线，底图需是干净线稿' },
      palette: { type: 'array', items: { type: 'string' }, description: 'strokes 模式的配色（按笔画重心纵带取），如 ["#22384f","#5f9ea6"]，只给一个就是单色' },
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
        message: { type: 'string', description: '生图侧给的人类可读说明（已解码），如「画好啦！」' },
        error: { type: 'string' },
      },
    },
    render: (_args: any, value: any) => [
      {
        type: 'text',
        text: value?.ok
          ? `🎨 作画完成 → ${value.path ?? ''}\n帧数：${value.frames ?? 0}　耗时：${value.elapsed_ms ?? 0}ms　底图源：${value.source ?? ''}` +
            (value?.message ? `\n${value.message}` : '')
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
      mode: args?.mode,
      palette: args?.palette,
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
