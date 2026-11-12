/**
 * strokes.ts —— 一笔一笔作画的几何引擎（从验证脚本 _svg3.ts 正式收进插件）
 *
 * 输入一张图（通常是涂色本线稿），输出一连串「逐渐变长」的 SVG 帧：
 *   二值化 → 形态学开运算（抹掉排线）→ 连通域面积过滤 → Zhang-Suen 细化
 *   → 沿骨架追踪（交叉点按方向穿过）→ RDP 简化 → Chaikin 平滑
 *   → 两轮端点拼接 → 按条带排序 → 逐帧 dashoffset 推进
 *
 * 颜色：band 模式按笔画重心落在哪条纵带取色；不传 palette 就是单色。
 * 设计原则：纯函数式、不碰文件系统、不依赖其它包（只要 sharp）。
 */
import sharp from 'sharp'

export type Pt = [number, number]

export interface StrokeOptions {
  /** 输出宽度（高度按比例）；默认 768 */
  width?: number
  /** 二值化阈值，越小越只留黑线；铅笔软线可用 200~238 */
  binThreshold?: number
  /** 开运算半径（0 = 不处理）；粗线稿用 1，细线稿用 0 */
  openRadius?: number
  /** 连通域最小面积 */
  minArea?: number
  /** 最短笔画（像素），用于丢掉碎渣 */
  minLen?: number
  /** RDP 简化阈值 */
  rdpEpsilon?: number
  /** Chaikin 平滑迭代次数（0~3） */
  smooth?: number
  /** 底部裁掉的画面比例（去水印），0~0.3 */
  cropBottom?: number
  /** 笔顺：'band' 横向条带 + 组内长笔画优先（默认） | 'length' 纯按长度 */
  order?: 'band' | 'length'
  /** 颜色数组，按笔画重心所在纵带取；只有一个元素 = 单色 */
  palette?: string[]
  /** 线条粗细下限/上限（px，按输出宽度缩放） */
  minWidth?: number
  maxWidth?: number
}

export interface StrokeResult {
  width: number
  height: number
  strokes: Array<{ d: string; len: number; color: string; cy: number }>
  totalLen: number
  /** 渲染第 index 帧所需的信息（0..frameCount-1） */
  frameCount: number
}

/** 把任意图片转成灰度数组 */
async function loadGray(buf: Buffer, width: number): Promise<{ gray: Uint8Array; w: number; h: number }> {
  const meta = await sharp(buf).metadata()
  const iw = meta.width || 512
  const ih = meta.height || 512
  const w = Math.max(64, Math.round(width))
  const h = Math.max(64, Math.round((ih / iw) * w))
  const { data } = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .resize(w, h, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { gray: new Uint8Array(data), w, h }
}

function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  if (r <= 0) return src
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1
      for (let dy = -r; dy <= r && v !== (dilate ? 1 : 0); dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy))
          const xx = Math.min(w - 1, Math.max(0, x + dx))
          if (dilate) {
            if (src[yy * w + xx]) { v = 1; break }
          } else if (!src[yy * w + xx]) { v = 0; break }
        }
      }
      out[y * w + x] = v
    }
  }
  return out
}

/** Zhang-Suen 细化 */
function thin(src: Uint8Array, w: number, h: number): Uint8Array {
  const img = Uint8Array.from(src)
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x])
  let changed = true
  let pass = 0
  while (changed && pass < 40) {
    changed = false
    for (let step = 0; step < 2; step++) {
      const del: number[] = []
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!img[y * w + x]) continue
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1)
          const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1)
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (b < 2 || b > 6) continue
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
          let a = 0
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++
          if (a !== 1) continue
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue
          } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue
          del.push(y * w + x)
        }
      }
      for (const i of del) {
        img[i] = 0
        changed = true
      }
    }
    pass++
  }
  return img
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts
  const a = pts[0]
  const b = pts[pts.length - 1]
  let idx = -1
  let maxD = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    const d = Math.abs(dy * px - dx * py + b[0] * a[1] - b[1] * a[0]) / len
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD <= eps || idx < 0) return [a, b]
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)]
}

function chaikin(pts: Pt[], iter: number): Pt[] {
  let cur = pts
  for (let k = 0; k < iter; k++) {
    if (cur.length < 3) break
    const out: Pt[] = [cur[0]]
    for (let i = 0; i < cur.length - 1; i++) {
      const [x0, y0] = cur[i]
      const [x1, y1] = cur[i + 1]
      out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25])
      out.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75])
    }
    out.push(cur[cur.length - 1])
    cur = out
  }
  return cur
}

const lenOf = (pts: Pt[]) => {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return L
}

const norm = (v: Pt): Pt => {
  const m = Math.hypot(v[0], v[1]) || 1
  return [v[0] / m, v[1] / m]
}

/** 两轮端点拼接：第一轮近且顺着笔势，第二轮允许大缺口但要求两端都朝对方走 */
function stitch(polys: Pt[][]): Pt[][] {
  const d2 = (a: Pt, b: Pt) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
  const used = new Array(polys.length).fill(false)
  const out: Pt[][] = []
  const seeds = polys.map((_, i) => i).sort((a, b) => lenOf(polys[b]) - lenOf(polys[a]))
  for (const seed of seeds) {
    if (used[seed]) continue
    used[seed] = true
    const chain = [...polys[seed]]
    let grown = true
    while (grown) {
      grown = false
      const tail = chain[chain.length - 1]
      const prev = chain[chain.length - 2] || tail
      const tdir = norm([tail[0] - prev[0], tail[1] - prev[1]])
      let best = -1
      let bestD = 12 * 12
      let flip = false
      for (let i = 0; i < polys.length; i++) {
        if (used[i]) continue
        const s = polys[i]
        for (const f of [false, true]) {
          const seg = f ? [...s].reverse() : s
          const head = seg[0]
          const nxt = seg[1] || head
          const dir = norm([nxt[0] - head[0], nxt[1] - head[1]])
          if (tdir[0] * dir[0] + tdir[1] * dir[1] < 0.2) continue
          const dd = d2(tail, head)
          if (dd < bestD) { bestD = dd; best = i; flip = f }
        }
      }
      if (best >= 0) {
        used[best] = true
        const s = flip ? [...polys[best]].reverse() : polys[best]
        chain.push(...s.slice(1))
        grown = true
      }
    }
    out.push(chain)
  }
  // 第二轮
  let more = true
  while (more) {
    more = false
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]
        const b = out[j]
        const ends = [
          { p: a[0], d: norm([a[0][0] - a[1][0], a[0][1] - a[1][1]]), rev: true },
          { p: a[a.length - 1], d: norm([a[a.length - 1][0] - a[a.length - 2][0], a[a.length - 1][1] - a[a.length - 2][1]]), rev: false },
        ]
        const starts = [
          { p: b[0], d: norm([b[1][0] - b[0][0], b[1][1] - b[0][1]]), rev: false },
          { p: b[b.length - 1], d: norm([b[b.length - 2][0] - b[b.length - 1][0], b[b.length - 2][1] - b[b.length - 1][1]]), rev: true },
        ]
        let merged: Pt[] | null = null
        for (const e of ends) {
          for (const s of starts) {
            const gx = s.p[0] - e.p[0]
            const gy = s.p[1] - e.p[1]
            const gLen = Math.hypot(gx, gy)
            if (gLen > 40) continue
            const g = norm([gx, gy])
            if (e.d[0] * g[0] + e.d[1] * g[1] < 0.5) continue
            if (s.d[0] * g[0] + s.d[1] * g[1] < 0.5) continue
            const A = e.rev ? [...a].reverse() : a
            const B = s.rev ? [...b].reverse() : b
            merged = [...A, ...B.slice(1)]
            break
          }
          if (merged) break
        }
        if (merged) {
          out[i] = merged
          out.splice(j, 1)
          more = true
          break outer
        }
      }
    }
  }
  return out
}

function subPath(pts: Pt[], frac: number): Pt[] {
  if (frac >= 1) return pts
  const total = lenOf(pts)
  const target = total * frac
  let acc = 0
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (acc + seg >= target) {
      const k = (target - acc) / (seg || 1)
      out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k])
      return out
    }
    acc += seg
    out.push(pts[i])
  }
  return out
}

/** 分析图片，产出可逐帧渲染的笔画表 */
export async function analyzeStrokes(buf: Buffer, opts: StrokeOptions = {}): Promise<StrokeResult & { H: number }> {
  const W = opts.width ?? 768
  const binT = opts.binThreshold ?? 0
  const openR = opts.openRadius ?? 1
  const minArea = opts.minArea ?? 150
  const minLen = opts.minLen ?? 0
  const eps = opts.rdpEpsilon ?? 1.8
  const smooth = opts.smooth ?? 1
  const cropBottom = opts.cropBottom ?? 0
  const orderMode = opts.order ?? 'band'
  const palette = opts.palette && opts.palette.length ? opts.palette : ['#22384f']

  const { gray, w, h } = await loadGray(buf, W)
  if (cropBottom > 0) {
    const cut = Math.round(h * (1 - cropBottom))
    for (let y = cut; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = 255
  }
  // 阈值：没给就自己算（Otsu）——不同模型出的线稿深浅差很多，固定阈值必然一半失败
  let thr = binT
  if (!thr) {
    const hist = new Array(256).fill(0)
    for (let i = 0; i < w * h; i++) hist[gray[i]]++
    const total = w * h
    let sum = 0
    for (let i = 0; i < 256; i++) sum += i * hist[i]
    let sumB = 0, wB = 0, best = 0, bestVar = -1
    for (let i = 0; i < 256; i++) {
      wB += hist[i]
      if (!wB) continue
      const wF = total - wB
      if (!wF) break
      sumB += i * hist[i]
      const mB = sumB / wB
      const mF = (sum - sumB) / wF
      const between = wB * wF * (mB - mF) ** 2
      if (between > bestVar) { bestVar = between; best = i }
    }
    thr = Math.max(50, Math.min(220, best || 128))
  }
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bin[i] = gray[i] < thr ? 1 : 0
  const opened = morph(morph(bin, w, h, openR, false), w, h, openR, true)

  // 连通域面积过滤
  const label = new Int32Array(w * h).fill(-1)
  const keep = new Uint8Array(w * h)
  let comp = 0
  for (let start = 0; start < w * h; start++) {
    if (!opened[start] || label[start] >= 0) continue
    const stack = [start]
    label[start] = comp
    const px: number[] = []
    while (stack.length) {
      const i = stack.pop() as number
      px.push(i)
      const x = i % w
      const y = (i / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy
          const xx = x + dx
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue
          const j = yy * w + xx
          if (opened[j] && label[j] < 0) { label[j] = comp; stack.push(j) }
        }
      }
    }
    if (px.length >= minArea) for (const i of px) keep[i] = 1
    comp++
  }

  const skel = thin(keep, w, h)
  const visited = new Uint8Array(w * h)
  const NB = [-1, -w - 1, -w, -w + 1, 1, w + 1, w, w - 1]
  const neighbours = (i: number): number[] => {
    const x = i % w
    const out: number[] = []
    for (const d of NB) {
      const j = i + d
      if (j < 0 || j >= w * h) continue
      if (Math.abs((j % w) - x) > 1) continue
      if (skel[j]) out.push(j)
    }
    return out
  }
  const raw: Pt[][] = []
  const walk = (start: number) => {
    let cur = start
    let prev = -1
    const line: Pt[] = []
    while (cur >= 0 && !visited[cur]) {
      visited[cur] = 1
      line.push([cur % w, (cur / w) | 0])
      const nbs = neighbours(cur).filter((j) => !visited[j])
      if (!nbs.length) break
      if (nbs.length === 1) { prev = cur; cur = nbs[0]; continue }
      const cx = cur % w
      const cy = (cur / w) | 0
      const dx = prev >= 0 ? cx - (prev % w) : 0
      const dy = prev >= 0 ? cy - ((prev / w) | 0) : 0
      let best = -1
      let bestScore = -Infinity
      for (const j of nbs) {
        const vx = (j % w) - cx
        const vy = ((j / w) | 0) - cy
        const score = prev >= 0 ? vx * dx + vy * dy : vx * 0.4 - vy * 0.9
        if (score > bestScore) { bestScore = score; best = j }
      }
      prev = cur
      cur = best
    }
    if (line.length >= 8) raw.push(line)
  }
  for (let i = 0; i < w * h; i++) if (skel[i] && !visited[i] && neighbours(i).length === 1) walk(i)
  for (let i = 0; i < w * h; i++) if (skel[i] && !visited[i]) walk(i)

  const polys = raw
    .map((s) => rdp(s, eps))
    .map((s) => (smooth > 0 ? chaikin(s, smooth) : s))
    .filter((s) => s.length >= 2 && lenOf(s) >= minLen)

  const merged = stitch(polys)

  const paths = merged.map((s) => {
    const ys = s.map((p) => p[1])
    const xs = s.map((p) => p[0])
    const cy = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length)
    const band = Math.min(palette.length - 1, Math.max(0, Math.floor((cy / h) * palette.length)))
    return {
      d: 'M' + s.map((p) => `${p[0]},${p[1]}`).join('L'),
      len: lenOf(s),
      color: palette[band],
      cy,
      top: Math.min(...ys),
    }
  })

  if (orderMode === 'length') paths.sort((a, b) => b.len - a.len)
  else {
    paths.sort((a, b) => {
      const ba = Math.round(a.top / 110)
      const bb = Math.round(b.top / 110)
      return ba !== bb ? ba - bb : b.len - a.len
    })
  }

  const totalLen = paths.reduce((a, p) => a + p.len, 0)
  return { width: w, height: h, strokes: paths.map(({ d, len, color, cy }) => ({ d, len, color, cy })), totalLen, frameCount: 0, H: h }
}

/** 渲染某一帧（p ∈ (0,1]）：按累计长度推进每条笔画的 dashoffset */
export async function renderStrokeFrame(
  res: StrokeResult & { H: number },
  p: number,
  quality = 88,
  opts: { lineWidth?: number; width?: number } = {},
): Promise<Buffer> {
  const W = res.width
  const H = res.height
  const budget = p * res.totalLen
  let acc = 0
  const els: string[] = []
  const lw = opts.lineWidth ?? Math.max(2, Math.round((opts.width ?? W) / 220))
  for (const s of res.strokes) {
    if (acc >= budget) break
    const want = Math.min(s.len, budget - acc)
    acc += s.len
    if (want < 0.5) continue
    els.push(
      `<path d="${s.d}" fill="none" stroke="${s.color}" stroke-width="${lw}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${s.len.toFixed(1)}" stroke-dashoffset="${(s.len - want).toFixed(1)}"/>`,
    )
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/>${els.join('')}</svg>`
  return sharp(Buffer.from(svg)).jpeg({ quality }).toBuffer()
}
