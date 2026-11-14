/**
 * pixel.ts —— 像素画「砌砖」动画（纯 TS / sharp，不依赖 cv2，不逐帧调 Python）
 *
 * 输入：一张已经做完像素化处理的大图（N×N 个等大色块，由微服务 /pixel_art 生成，
 *       或本地用 pixelizeToGrid 处理）。
 * 输出：每一帧一张 PNG —— 逐渐把 N×N 个格子填满。
 *
 * 设计要点：
 *   · **顺序**：按亮度分档，先深色（轮廓）→ 中间色 → 浅色（高光）；同档内按「离质心的距离」
 *     从外到内推进，视觉上就像先勾轮廓再往里铺。
 *   · **帧数**：由 grid 自适应。格子少（N≤48）就一格一格铺、节奏慢；格子多（N≥64）
 *     就一批刷一片（batch 自适应），保证总时长落在同一档，观众不会等太久也不会一闪而过。
 *   · **随机延迟**：同批内部不是整块齐刷刷变，每格有一个 ±15% 的扰动，看起来像手在铺。
 */
import sharp from 'sharp'

export interface PixelGrid {
  /** 网格边长（格子数） */
  n: number
  /** 输出画幅边长（像素），保证 big % n === 0 */
  size: number
  /** 每格边长（像素） */
  cell: number
  /** 颜色矩阵 [row][col] = [r,g,b,a]，0..255 */
  colors: number[][][]
}

export interface PixelFrameOptions {
  /** 背景色（未填的格子），默认白 */
  background?: { r: number; g: number; b: number }
  /** 已填格子的覆盖率抖动，0 关闭，默认 0.15 */
  jitter?: number
  /** 随机种子，默认 1（同种子结果可复现） */
  seed?: number
}

/** 把任意大图读成 N×N 颜色矩阵（每格取中心像素；要求 size 能被 n 整除） */
export async function readPixelGrid(buffer: Buffer, n: number, size?: number): Promise<PixelGrid> {
  if (n < 2) throw new Error('n 至少为 2')
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height) throw new Error('图片尺寸无效')
  // 统一成正方形画幅，且边长能被 n 整除
  const want = size && size % n === 0 ? size : Math.round((meta.width / n) as number) * n
  const side = Math.max(n, want)
  const { data, info } = await sharp(buffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(side, side, { fit: 'cover', kernel: 'nearest' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const cell = side / n
  const colors: number[][][] = []
  for (let r = 0; r < n; r++) {
    const row: number[][] = []
    for (let c = 0; c < n; c++) {
      const x = Math.min(side - 1, Math.floor(c * cell + cell / 2))
      const y = Math.min(side - 1, Math.floor(r * cell + cell / 2))
      const i = (y * side + x) * channels
      row.push([data[i], data[i + 1], data[i + 2], 255])
    }
    colors.push(row)
  }
  return { n, size: side, cell, colors }
}

function luma(rgb: number[]): number {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
}

/** 简单的线性同余随机，保证同 seed 可复现 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/**
 * 计算铺砖顺序：[{r, c, t}]，t ∈ [0,1) 是这一格被填的进度位置。
 * 排序三段：
 *   1) 亮度分档：暗 → 中 → 亮（把 luma 归一后切成若干档，档内再按半径从外到内）
 *   2) 半径：离画面质心的距离，远的先填（先勾外轮廓）
 *   3) 抖动：每格 ±jitter，打散整齐感
 */
export function planBrickOrder(grid: PixelGrid, opts: PixelFrameOptions = {}): Array<{ r: number; c: number; t: number }> {
  const n = grid.n
  const jitter = opts.jitter ?? 0.15
  const rng = makeRng(opts.seed ?? 1)
  const cx = (n - 1) / 2
  const cy = (n - 1) / 2
  const maxR = Math.hypot(cx, cy) || 1

  // 亮度分 3 档：0=暗（轮廓）1=中 2=亮（高光）
  const cells: Array<{ r: number; c: number; band: number; radius: number; rnd: number }> = []
  const lumas: number[] = []
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) lumas.push(luma(grid.colors[r][c]))
  lumas.sort((a, b) => a - b)
  const lo = lumas[Math.floor(lumas.length * 0.15)]
  const hi = lumas[Math.floor(lumas.length * 0.85)]
  const span = Math.max(1, hi - lo)

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const L = luma(grid.colors[r][c])
      const norm = Math.min(1, Math.max(0, (L - lo) / span))
      const band = norm < 1 / 3 ? 0 : norm < 2 / 3 ? 1 : 2
      const radius = Math.hypot(c - cx, r - cy) / maxR
      cells.push({ r, c, band, radius, rnd: rng() })
    }
  }

  cells.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band
    if (Math.abs(a.radius - b.radius) > 0.02) return b.radius - a.radius
    return a.rnd - b.rnd
  })

  const total = cells.length
  return cells.map((cell, i) => {
    const base = (i + 0.5) / total
    const t = Math.min(0.999, Math.max(0, base + (cell.rnd - 0.5) * 2 * jitter * (1 / total) * total * 1.0))
    return { r: cell.r, c: cell.c, t }
  })
}

/** 渲染一帧：进度 p ∈ [0,1]，已填的格子画实色，未填画背景色 */
export async function renderPixelFrame(
  grid: PixelGrid,
  order: Array<{ r: number; c: number; t: number }>,
  p: number,
  opts: PixelFrameOptions = {},
): Promise<Buffer> {
  const bg = opts.background ?? { r: 255, g: 255, b: 255 }
  const { n, size, cell } = grid
  const buf = Buffer.alloc(size * size * 3)
  // 先铺满背景
  for (let i = 0; i < size * size; i++) {
    buf[i * 3] = bg.r
    buf[i * 3 + 1] = bg.g
    buf[i * 3 + 2] = bg.b
  }
  const filled = new Set<number>()
  for (const o of order) {
    if (o.t > p) continue
    const idx = o.r * n + o.c
    if (filled.has(idx)) continue
    filled.add(idx)
    const [r, g, b] = grid.colors[o.r][o.c]
    const x0 = o.c * cell
    const y0 = o.r * cell
    for (let y = y0; y < y0 + cell; y++) {
      const rowOff = y * size
      for (let x = x0; x < x0 + cell; x++) {
        const i = (rowOff + x) * 3
        buf[i] = r
        buf[i + 1] = g
        buf[i + 2] = b
      }
    }
  }
  return await sharp(buf, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer()
}

/**
 * 按 N 自适应的「一批刷几格」与「总帧数」。
 * 目标：不论 N 多大，整段动画步数落在 ~60~110 步，观众感觉"一直有东西在长出来"。
 */
export function planBrickBatches(n: number): { batch: number; steps: number } {
  const cells = n * n
  // 每步刷的格数：格子多就多刷几格
  const batch = cells <= 2500 ? 1 : cells <= 6400 ? 4 : Math.max(4, Math.round(cells / 1600))
  const steps = Math.max(50, Math.min(120, Math.round(cells / batch / 60) * 60 || 60))
  return { batch, steps: Math.max(60, Math.min(140, steps)) }
}

/** 把「已填比例」按批次量化：一批一批跳，不要每帧只多一格 */
export function quantizeProgress(p: number, batch: number, total: number): number {
  const stepCells = batch / total
  const k = Math.floor(p / stepCells)
  return Math.min(1, (k * batch + (k > 0 ? batch : 0)) / total)
}
