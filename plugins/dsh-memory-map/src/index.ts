/**
 * dsh-memory-map —— 每日记忆星图后端（任务 3 / 后端数据聚合）
 *
 * 把 8001 端口 Memory 微服务最近 N 天的记忆，聚合成一张「星座快照」：
 *   - Cluster（星系）= 按「最高频代表 tag」聚合（碎片化 tag 组合合并），总数封顶 15；无 tags 按 level 兜底
 *   - Star（星星） = 每条记忆，带扁平螺旋盘 3D 偏移坐标 (x,y,z) + size + color
 * 输出 data/memory_constellation.json，供 Three.js 3D 星云前端读取（web/index.html + app.bundle.js）。
 *
 * 设计要点：
 *   1. 确定性坐标：cluster_id 由 tags/level 哈希生成，永远稳定；星系中心与星星偏移都
 *      由 id 哈希派生 → 同一记忆在多次运行里坐标不变（前端动画不跳变）。
 *   2. 增量追加：默认加载已有快照，只为「尚未分配坐标的新记忆」补坐标并 append，
 *      既有坐标原样保留；rebuild=true 才全量重算。
 *   3. 每日定时：apply 后调度到下一个 03:00 本地时间跑一次增量，之后每 24h 一次；
 *      dispose 清定时器。宿主休眠导致 setTimeout 漂移时只影响触发时刻，不破坏数据。
 *   4. 原子写入：先写 *.tmp 再 rename，前端永远只读到完整 JSON（不读到半写文件）。
 *
 * 环境变量（全部可选）：
 *   MEMORY_BUS_URL     Memory 微服务地址（默认 http://127.0.0.1:8001，dsh-memory-bus 也会设默认）
 *   MEMORY_MAP_OUT     快照输出绝对路径（默认 <发布版根>/data/memory_constellation.json）
 *   MEMORY_MAP_CRON    设为 0 可关闭每日增量定时
 */

import { mkdirSync, existsSync, renameSync, readFileSync, statSync } from 'node:fs'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG_TAG = '[dsh-memory-map]'
const HERE = path.dirname(fileURLToPath(import.meta.url))

if (!process.env.MEMORY_BUS_URL) process.env.MEMORY_BUS_URL = 'http://127.0.0.1:8001'
const MEMORY_BUS_URL = process.env.MEMORY_BUS_URL.replace(/\/$/, '')

const LOCAL_FALLBACK_ROOTS = ['c:\\Users\\user\\Desktop\\projects (2)']

// ---------------------------------------------------------------------------
// 路径与工具
// ---------------------------------------------------------------------------

function hash32(s: string): number {
  // djb2，>>> 0 转无符号 32 位，保证非负
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}
function hash01(s: string): number {
  // djb2 对末位单字符差是线性的：hash('…ox')、hash('…oy')、hash('…oz') 恰好差 1/2，
  // 无论 %100000 还是 /2^32 都会让 gx≈gy≈gz → 归一化后方向恒为 ±(1,1,1)/√3 → 星
  // 系内所有星共线（"贪吃蛇"）。这里加 fmix32 雪崩混合，把 1 bit 差扩散到 ~16 bit，
  // 使 ox/oy/oz 得到互不相关的 [0,1) 值，星星才能在球内真正散开。
  let h = hash32(s)
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

function walkUpForMarker(marker: string, maxUp = 8): string | null {
  let cur = path.resolve(HERE, '..', '..', '..')
  for (let i = 0; i < maxUp; i++) {
    if (existsSync(path.join(cur, marker))) return cur
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function findReleaseRoot(): string | null {
  const marker = path.join('core-services', 'memory', 'main.py')
  const envRoot = process.env.PERSONA_OS_ROOT
  if (envRoot && existsSync(path.join(envRoot, marker))) return path.resolve(envRoot)
  const found = walkUpForMarker(marker)
  if (found) return found
  for (const root of LOCAL_FALLBACK_ROOTS) {
    if (existsSync(path.join(root, marker))) return path.resolve(root)
    const inRelease = path.join(root, 'github-release', 'persona-os')
    if (existsSync(path.join(inRelease, marker))) return inRelease
  }
  return null
}

function resolveOutPath(): string {
  if (process.env.MEMORY_MAP_OUT) return path.resolve(process.env.MEMORY_MAP_OUT)
  const root = findReleaseRoot()
  const base = root || LOCAL_FALLBACK_ROOTS[0]
  return path.join(base, 'data', 'memory_constellation.json')
}

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: string
  level: string
  title: string
  content: string
  tags: string[]
  importance: number
  created_at: number
  updated_at: number
  hit_count: number
}

interface Cluster {
  cluster_id: string
  label: string
  tags: string[]
  count: number
  center: { x: number; y: number; z: number }
}

interface Star {
  memory_id: string
  cluster_id: string
  x: number
  y: number
  z: number
  size: number
  color: string
  title: string
  text: string
  level: string
  importance: number
  created_at: number
}

/** 记忆正文摘要：截前 N 字，供前端悬停 tooltip 展示（避免前端再发详情请求）。 */
function excerpt(content: string, n = 120): string {
  const s = (content || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

interface Snapshot {
  schema_version: number
  generated_at: number
  days: number
  limit: number
  total_memories: number
  clusters: Cluster[]
  stars: Star[]
}

// ---------------------------------------------------------------------------
// 聚类与坐标
// ---------------------------------------------------------------------------

function normTags(m: MemoryRow): string[] {
  const tags = Array.isArray(m.tags) ? m.tags : []
  return tags
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** HSL → 十六进制（#rrggbb）。h 为角度 0..360，s/l 为百分数 0..100。 */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
    return Math.max(0, Math.min(255, Math.round(255 * c))).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** 星系稳定色相：由 cluster_id 哈希派生。 */
function clusterHue(clusterId: string): number {
  return hash32('hue|' + clusterId) % 360
}

/** 星星颜色：重要度≥4 → 金色；否则取星系色相。 */
function starColor(m: MemoryRow, clusterId: string): string {
  const importance = Number.isFinite(m.importance) ? m.importance : 1
  if (importance >= 4) return '#ffd87a'
  return hslToHex(clusterHue(clusterId), 78, 62)
}

function clusterIdOf(key: string): string {
  return 'c_' + hash32('cluster:' + key).toString(16).padStart(8, '0')
}

/** 单条记忆的代表 tag：取其 tags 中全局频次最高者（并列取排序最前者）；无 tags 按 level 兜底。 */
function representativeTag(m: MemoryRow, freq: Map<string, number>): { key: string; tags: string[]; label: string } {
  const tags = Array.from(new Set(normTags(m))).sort()
  if (tags.length > 0) {
    let best = tags[0]
    let bestF = freq.get(tags[0]) || 0
    for (let i = 1; i < tags.length; i++) {
      const f = freq.get(tags[i]) || 0
      if (f > bestF) { bestF = f; best = tags[i] }
    }
    return { key: best, tags: [best], label: best }
  }
  const level = m.level || 'fact'
  return { key: `__level__:${level}`, tags: [], label: `未分类·${level}` }
}

/**
 * 把 rows 聚成星系，星系总数封顶 15：
 * 1) 每条记忆取「全局最高频代表 tag」作为星系键 → 把碎片化 tag 组合聚合到一起；
 * 2) 若 distinct key > 15，保留频次最高的 14 个，其余合并进「其他记忆」。
 * 返回 memory_id → { cid, key, label, tags }。
 */
function assignClusters(rows: MemoryRow[]): Map<string, { cid: string; key: string; label: string; tags: string[] }> {
  const freq = new Map<string, number>()
  for (const m of rows) for (const t of normTags(m)) freq.set(t, (freq.get(t) || 0) + 1)

  const counts = new Map<string, number>()
  const base = new Map<string, { key: string; tags: string[]; label: string }>()
  for (const m of rows) {
    const r = representativeTag(m, freq)
    base.set(m.id, r)
    counts.set(r.key, (counts.get(r.key) || 0) + 1)
  }

  const MERGE_KEY = '__other__'
  const finalKey = new Map<string, string>()
  if (counts.size > 15) {
    const keep = new Set(
      [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k]) => k),
    )
    for (const k of counts.keys()) finalKey.set(k, keep.has(k) ? k : MERGE_KEY)
  } else {
    for (const k of counts.keys()) finalKey.set(k, k)
  }

  const out = new Map<string, { cid: string; key: string; label: string; tags: string[] }>()
  for (const m of rows) {
    const b = base.get(m.id)!
    const fk = finalKey.get(b.key) || b.key
    out.set(m.id, {
      cid: clusterIdOf(fk),
      key: fk,
      label: fk === MERGE_KEY ? '其他记忆' : b.label,
      tags: fk === MERGE_KEY ? [] : b.tags,
    })
  }
  return out
}

/**
 * 星系中心（3D）：铺在水平面（XZ 平面）上的扁平螺旋分布，相机斜俯视 → 横向铺开。
 *   - 关键：不再铺在 XY 平面 + 绕 Y 自转（那会周期性 edge-on 塌缩成一条竖线）。
 *   - 星系群躺在水平 XZ 面，y 方向小幅起伏制造纵深层次；绕 Y 自转永远保持水平展开。
 * 半径随星系数增大外推；角向加轻微螺旋扰动，整体呈银河感的扁平星盘。跨运行稳定。
 */
function centerFor(clusterId: string, count: number): { x: number; y: number; z: number } {
  const u = hash01(clusterId + '|cu')   // 角向
  const t = hash01(clusterId + '|ct')   // 径向分数 [0,1)
  const baseR = 300 + Math.sqrt(Math.max(1, count)) * 26
  const r = baseR * (0.45 + 0.55 * Math.sqrt(t))   // 避免堆在中心
  const phi = u * Math.PI * 2 + Math.sqrt(t) * 1.6   // 螺旋臂
  const y = (hash01(clusterId + '|cy') * 2 - 1) * 55  // 水平面上方/下方的小幅起伏 → 纵深
  return {
    x: +(Math.cos(phi) * r).toFixed(2),
    y: +y.toFixed(2),
    z: +(Math.sin(phi) * r).toFixed(2),
  }
}

/**
 * 星系内单星的本地偏移：扁平螺旋盘（银河系式），在局部 xy 平面内散开。
 *   - 3 条旋臂 + 半径面积均匀采样（核心稀疏、外缘不堆）+ 极薄盘厚度；
 *   - 前端会把星系 Group 的盘面法线统一对齐到 +Z（正对默认镜头），每个星系都呈清晰的螺旋盘。
 * 全部由 memory_id 哈希派生 → 同一记忆跨运行坐标稳定（前端动画不跳变）。
 */
function diskOffset(memoryId: string, clusterR: number): { lx: number; ly: number; lz: number } {
  const t = hash01(memoryId + '|t')                       // [0,1) 半径分数
  const arm = Math.floor(hash01(memoryId + '|arm') * 3)   // 3 条旋臂
  const armOffset = (arm / 3) * Math.PI * 2
  const radius = clusterR * Math.sqrt(t)                  // sqrt → 面积均匀
  const angle = armOffset + 4.5 * t + hash01(memoryId + '|j') * 0.6
  const lx = radius * Math.cos(angle)
  const ly = radius * Math.sin(angle)
  const lz = (hash01(memoryId + '|z') * 2 - 1) * clusterR * 0.32  // 厚盘/扁球：有体积感，不再是薄纸片
  return { lx, ly, lz }
}

/** 星星（3D）：中心 + 扁平螺旋盘偏移；size/color 由重要度与星系派生。均哈希稳定。 */
function starFor(m: MemoryRow, clusterId: string, center: { x: number; y: number; z: number }, clusterCount: number): Star {
  // 盘面半径收紧：同类星高度聚拢成星系团，靠空间靠近 + 光晕叠加体现聚集感
  const clusterR = 16 + Math.sqrt(Math.max(1, clusterCount)) * 6.5
  const { lx, ly, lz } = diskOffset(m.id, clusterR)
  const clen = (m.content || '').length
  const importance = Number.isFinite(m.importance) ? m.importance : 1
  const size = Math.min(20, Math.max(3, 3 + importance * 1.5 + Math.log10(1 + clen) * 1.2))
  return {
    memory_id: m.id,
    cluster_id: clusterId,
    x: +(center.x + lx).toFixed(2),
    y: +(center.y + ly).toFixed(2),
    z: +(center.z + lz).toFixed(2),
    size: +size.toFixed(2),
    color: starColor(m, clusterId),
    title: (m.title || '').slice(0, 60),
    text: excerpt(m.content, 120),
    level: m.level || 'fact',
    importance,
    created_at: m.created_at || 0,
  }
}

// ---------------------------------------------------------------------------
// 抓取 + 生成快照
// ---------------------------------------------------------------------------

async function fetchRecent(days: number, limit: number): Promise<MemoryRow[]> {
  const url = `${MEMORY_BUS_URL}/recent?days=${days}&limit=${limit}`
  const r = await fetch(url)
  const text = await r.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!r.ok) throw new Error(`memory /recent 返回 ${r.status}: ${text || r.statusText}`)
  const results = Array.isArray(data?.results) ? data.results : []
  return results as MemoryRow[]
}

async function loadSnapshot(p: string): Promise<Snapshot | null> {
  if (!existsSync(p)) return null
  try {
    const raw = await readFile(p, 'utf8')
    const obj = JSON.parse(raw) as Snapshot
    if (!obj || !Array.isArray(obj.stars) || !Array.isArray(obj.clusters)) return null
    return obj
  } catch {
    return null
  }
}

async function atomicWriteJson(p: string, obj: unknown): Promise<void> {
  mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8')
  // Windows 下 rename 覆盖已存在文件可行；加一次重试应对偶发 EBUSY
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmp, p)
      return
    } catch (e: any) {
      if (attempt === 2) throw e
      await new Promise((r) => setTimeout(r, 120))
    }
  }
}

interface RunOpts {
  days: number
  limit: number
  rebuild: boolean
}

async function runSnapshot(opts: RunOpts): Promise<{
  ok: boolean
  path: string
  total_memories: number
  stars: number
  clusters: number
  new_count: number
  rebuild: boolean
  generated_at: number
}> {
  const outPath = resolveOutPath()
  const rows = await fetchRecent(opts.days, opts.limit)

  const loaded = opts.rebuild ? null : await loadSnapshot(outPath)
  // 旧版快照（2D / 无 schema_version）强制全量重建为 3D
  const existing = loaded && (loaded as any).schema_version === 3 ? loaded : null
  const stars: Star[] = existing ? [...existing.stars] : []
  const assigned = new Set(stars.map((s) => s.memory_id))
  const centers = new Map<string, { x: number; y: number; z: number }>()
  if (existing) for (const c of existing.clusters) centers.set(c.cluster_id, c.center)

  // 本次窗口内记忆的星系分配（代表 tag 聚合 + 封顶 15）
  const assignment = assignClusters(rows)
  const clusterCount = new Map<string, number>()
  for (const a of assignment.values()) clusterCount.set(a.cid, (clusterCount.get(a.cid) || 0) + 1)

  let newCount = 0
  for (const m of rows) {
    if (!m || typeof m.id !== 'string') continue
    if (assigned.has(m.id)) continue
    const a = assignment.get(m.id)
    if (!a) continue
    const cid = a.cid
    if (!centers.has(cid)) centers.set(cid, centerFor(cid, clusterCount.get(cid) || 1))
    const center = centers.get(cid)!
    stars.push(starFor(m, cid, center, clusterCount.get(cid) || 1))
    assigned.add(m.id)
    newCount++
  }

  // 按最终 count 重算星系中心（3D 球面，半径随 count）
  const counts = new Map<string, number>()
  const meta = new Map<string, { label: string; tags: string[] }>()
  for (const s of stars) counts.set(s.cluster_id, (counts.get(s.cluster_id) || 0) + 1)
  for (const a of assignment.values()) {
    if (!meta.has(a.cid)) meta.set(a.cid, { label: a.label, tags: a.tags })
  }
  if (existing) {
    for (const c of existing.clusters) {
      if (!meta.has(c.cluster_id)) meta.set(c.cluster_id, { label: c.label, tags: c.tags || [] })
    }
  }

  const clusters: Cluster[] = []
  for (const [cid, cnt] of counts) {
    const freshCenter = centerFor(cid, cnt)
    centers.set(cid, freshCenter)
    const m = meta.get(cid) || { label: cid, tags: [] }
    clusters.push({ cluster_id: cid, label: m.label, tags: m.tags, count: cnt, center: freshCenter })
  }
  clusters.sort((a, b) => b.count - a.count)

  // 同步刷新所有 star 的 3D 坐标 + 颜色（中心可能因 count 变化移动；旧 star 一并补 z/color）
  const rowById = new Map<string, MemoryRow>()
  for (const m of rows) if (m && typeof m.id === 'string') rowById.set(m.id, m)
  const clusterById = new Map(clusters.map((c) => [c.cluster_id, c]))
  for (const s of stars) {
    const m = rowById.get(s.memory_id)
    const c = clusterById.get(s.cluster_id)
    if (!m || !c) continue
    const clusterR = 16 + Math.sqrt(Math.max(1, c.count)) * 6.5
    const { lx, ly, lz } = diskOffset(m.id, clusterR)
    s.x = +(c.center.x + lx).toFixed(2)
    s.y = +(c.center.y + ly).toFixed(2)
    s.z = +(c.center.z + lz).toFixed(2)
    s.color = starColor(m, c.cluster_id)
    s.title = (m.title || '').slice(0, 60)
    s.text = excerpt(m.content, 120)
  }
  stars.sort((a, b) => b.created_at - a.created_at)

  const generatedAt = Date.now()
  const snapshot: Snapshot = {
    schema_version: 3,
    generated_at: generatedAt,
    days: opts.days,
    limit: opts.limit,
    total_memories: rows.length,
    clusters,
    stars,
  }
  await atomicWriteJson(outPath, snapshot)

  return {
    ok: true,
    path: outPath,
    total_memories: rows.length,
    stars: stars.length,
    clusters: clusters.length,
    new_count: newCount,
    rebuild: opts.rebuild,
    generated_at: generatedAt,
  }
}

// ---------------------------------------------------------------------------
// 每日增量定时（下一个 03:00 本地时间）
// ---------------------------------------------------------------------------

let cronTimer: ReturnType<typeof setTimeout> | null = null

function msUntilNext3am(): number {
  const now = new Date()
  const next = new Date(now)
  next.setHours(3, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

function scheduleCron(): void {
  if (process.env.MEMORY_MAP_CRON === '0') return
  const ms = msUntilNext3am()
  const at = new Date(Date.now() + ms)
  console.log(`${LOG_TAG} 每日增量已调度：下一次 ${at.toLocaleString()}（${Math.round(ms / 60000)} 分钟后）`)
  cronTimer = setTimeout(async () => {
    try {
      const res = await runSnapshot({ days: 90, limit: 500, rebuild: false })
      console.log(`${LOG_TAG} 每日增量完成：新增 ${res.new_count} 星，共 ${res.stars} 星 / ${res.clusters} 星系`)
    } catch (e) {
      console.error(`${LOG_TAG} 每日增量失败：`, e)
    }
    scheduleCron()
  }, ms)
}

// ---------------------------------------------------------------------------
// Web 路由：把星图数据 + Three.js 3D 前端页面挂到 DSH 自带的 Web 服务器（默认端口 3080）
// ---------------------------------------------------------------------------
//
// 复用 dsh-whale-widget 同款机制：ctx.inject(['webServer'], cb) 拿到 ctx.webServer，
// 调用 register({ kind:'exact', path, handler }) 注册精确路由，dispose 时调用返回的
// disposer。handler 用 Node 原生 res.writeHead / res.end。
//
// 暴露三个只读路由（全部 GET、回环 Host 校验防 DNS 重绑定）：
//   GET /api/constellation   → data/memory_constellation.json（前端 fetch 数据源）
//   GET /memory-map/              → web/index.html（Three.js 3D 星图页面）
//   GET /memory-map/app.bundle.js → web/app.bundle.js（含 three + 应用的单文件打包）

const WEB_DIR = path.resolve(HERE, '..', 'web')
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

let webPort = 3080
let webRegistered = false
const webDisposers: Array<() => void> = []

function isLoopbackHostname(hn: string): boolean {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

/** 通过 → null；否则返回应拒绝的状态码（fail-closed）。 */
function selfRejection(req: any): number | null {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl: URL
    try { hostUrl = new URL('http://' + String(headers.host || '')) } catch { return 403 }
    if (!isLoopbackHostname(hostUrl.hostname)) return 403
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      try {
        if (new URL(origin).host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
      } catch { return 403 }
    }
    return null
  } catch { return 403 }
}

function rejected(req: any, res: any, fence: any): boolean {
  const deny = (code: number) => { try { res.statusCode = code; res.end() } catch {}; return true }
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method !== 'GET') return deny(405) // 只暴露只读接口
  const self = selfRejection(req)
  if (self !== null) return deny(self)
  if (fence) {
    let code: any
    try { code = fence.requestRejection(req) } catch { return deny(403) }
    if (code === undefined || code === null || code === false) return false
    return deny(typeof code === 'number' ? code : 403)
  }
  return false
}

function registerRoute(ws: any, fence: any, route: any) {
  const inner = route && route.handler
  const wrapped = {
    ...route,
    handler: async (req: any, res: any) => {
      if (rejected(req, res, fence)) return
      return inner(req, res)
    },
  }
  return ws.register(wrapped)
}

const webCache = new Map<string, { text: string; mtimeMs: number }>()
function serveWeb(rel: string, contentType: string, res: any) {
  const p = path.join(WEB_DIR, rel)
  let mtimeMs = 0
  try { mtimeMs = statSync(p).mtimeMs } catch { /* 缺失，下面 readFileSync 会兜底 */ }
  const cached = webCache.get(rel)
  if (!cached || cached.mtimeMs !== mtimeMs) {
    let text: string
    try { text = readFileSync(p, 'utf8') } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`memory-map asset not found: ${rel}`)
      return
    }
    webCache.set(rel, { text, mtimeMs })
  }
  const c = webCache.get(rel)!
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
  res.end(c.text)
}

function serveSnapshot(res: any) {
  const p = resolveOutPath()
  if (!existsSync(p)) {
    res.writeHead(404, JSON_HEADERS)
    res.end(JSON.stringify({ ok: false, error: 'snapshot not generated yet', hint: '先调用 generate_constellation_snapshot' }))
    return
  }
  try {
    const raw = readFileSync(p, 'utf8')
    res.writeHead(200, JSON_HEADERS)
    res.end(raw)
  } catch (e: any) {
    res.writeHead(500, JSON_HEADERS)
    res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 200) }))
  }
}

function registerWebRoutes(ctx: any) {
  if (webRegistered) return
  const run = (inner: any) => {
    if (webRegistered) return
    webRegistered = true
    const ws = inner?.webServer || inner?.get?.('webServer')
    if (!ws || typeof ws.register !== 'function') {
      console.warn(`${LOG_TAG} webServer.register 不可用，跳过前端路由注册（仍可手动用静态服务器打开 web/）`)
      return
    }
    try {
      const addr = ws.server?.address?.()
      if (addr && typeof addr.port === 'number') webPort = addr.port
    } catch { /* 保持默认 3080 */ }
    const fence = (() => {
      try {
        const c = inner?.get?.('connection') || inner?.connection
        return c && typeof c.requestRejection === 'function' ? c : null
      } catch { return null }
    })()
    try {
      webDisposers.push(registerRoute(ws, fence, {
        kind: 'exact', path: '/api/constellation',
        handler: (_req: any, res: any) => serveSnapshot(res),
      }))
      for (const p of ['/memory-map', '/memory-map/', '/memory-map/index.html']) {
        webDisposers.push(registerRoute(ws, fence, {
          kind: 'exact', path: p,
          handler: (_req: any, res: any) => serveWeb('index.html', 'text/html; charset=utf-8', res),
        }))
      }
      webDisposers.push(registerRoute(ws, fence, {
        kind: 'exact', path: '/memory-map/app.bundle.js',
        handler: (_req: any, res: any) => serveWeb('app.bundle.js', 'application/javascript; charset=utf-8', res),
      }))
      console.log(`${LOG_TAG} 已注册前端路由：/memory-map/ (页面) + /api/constellation (数据)，端口 ${webPort}`)
    } catch (e) {
      console.error(`${LOG_TAG} 注册前端路由失败：`, e)
    }
  }
  if (typeof ctx.inject === 'function') {
    try { ctx.inject(['webServer'], run); return } catch { /* 回退到直接探测 */ }
  }
  const ws = ctx?.webServer || ctx?.get?.('webServer')
  if (ws) run(ctx)
}

// ---------------------------------------------------------------------------
// DSH 工具注册
// ---------------------------------------------------------------------------

interface DshTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown>; render: (args: any, value: any) => any[] }
  execute: (args: any, exec: any) => Promise<any>
  presentCall?: (args: any) => any
}

const tool: DshTool = {
  name: 'generate_constellation_snapshot',
  description:
    '生成（或增量更新）记忆星座快照 data/memory_constellation.json：从 Memory 微服务拉取最近记忆，' +
    '按最高频代表 tag 聚成星系（总数封顶 15），为每条记忆生成稳定的 3D 坐标 (x,y,z)、size 与 color。' +
    '默认增量（只补新记忆，保留旧坐标）；rebuild=true 全量重算。Three.js 3D 前端读取该 JSON。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 3650, default: 90, description: '拉取最近多少天的记忆' },
      limit: { type: 'integer', minimum: 1, maximum: 5000, default: 500, description: '最多拉取条数' },
      rebuild: { type: 'boolean', default: false, description: 'true=全量重算（丢弃旧坐标）；false=增量追加' },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        path: { type: 'string' },
        total_memories: { type: 'integer' },
        stars: { type: 'integer' },
        clusters: { type: 'integer' },
        new_count: { type: 'integer' },
      },
    },
    render: (_args: any, value: any) => [
      {
        type: 'text',
        text:
          `🌌 星座快照已生成 → ${value?.path ?? ''}\n` +
          `记忆 ${value?.total_memories ?? 0} 条 → ${value?.stars ?? 0} 颗星 / ${value?.clusters ?? 0} 个星系` +
          (value?.rebuild ? '（全量重算）' : `（本次新增 ${value?.new_count ?? 0}）`),
      },
    ],
  },
  async execute(args: any) {
    const days = Number.isInteger(args?.days) ? Math.min(3650, Math.max(1, args.days)) : 90
    const limit = Number.isInteger(args?.limit) ? Math.min(5000, Math.max(1, args.limit)) : 500
    const rebuild = args?.rebuild === true
    return runSnapshot({ days, limit, rebuild })
  },
  presentCall(_args: any) {
    return { card: 'generic', title: 'generate_constellation_snapshot', kind: 'read' }
  },
}

const uiTool: DshTool = {
  name: 'get_constellation_ui_url',
  description:
    '返回「每日记忆星图」3D 星云可视化界面的本地访问地址。该页面由 dsh-memory-map 插件挂在 DSH Web 服务器上，' +
    '展示记忆星系（聚类包络 + 星座连线 + 力导向布局），支持悬停查看记忆摘要、滚轮缩放、点击星系聚焦。' +
    '若返回 ready=false，说明快照尚未生成，请先调用 generate_constellation_snapshot。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ready: { type: 'boolean' },
        url: { type: 'string' },
        api: { type: 'string' },
        port: { type: 'integer' },
        snapshot_exists: { type: 'boolean' },
      },
    },
    render: (_args: any, value: any) => [
      {
        type: 'text',
        text: value?.ready
          ? `🌌 记忆星图界面已就绪：${value.url}\n（数据源 ${value.api}，快照存在：${value.snapshot_exists}）`
          : `⚠️ 记忆星图尚未就绪：${value?.url ?? ''}\n请先调用 generate_constellation_snapshot 生成快照。`,
      },
    ],
  },
  async execute() {
    const snapshotExists = existsSync(resolveOutPath())
    return {
      ready: snapshotExists,
      url: `http://127.0.0.1:${webPort}/memory-map/`,
      api: `http://127.0.0.1:${webPort}/api/constellation`,
      port: webPort,
      snapshot_exists: snapshotExists,
    }
  },
  presentCall(_args: any) {
    return { card: 'generic', title: 'get_constellation_ui_url', kind: 'read' }
  },
}

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-memory-map',
  apply(ctx: any) {
    console.log(`${LOG_TAG} apply (memory=${MEMORY_BUS_URL})`)
    const disposers: Array<() => void> = []
    try {
      const d = ctx.tools.register(tool)
      if (typeof d === 'function') disposers.push(d)
      const d2 = ctx.tools.register(uiTool)
      if (typeof d2 === 'function') disposers.push(d2)
      console.log(`${LOG_TAG} 已注册工具 generate_constellation_snapshot + get_constellation_ui_url`)
    } catch (e) {
      console.error(`${LOG_TAG} 注册工具失败：`, e)
    }

    // 注册前端可视化路由（挂到 DSH 自带 Web 服务器，等 webServer 就绪后执行）
    try { registerWebRoutes(ctx) } catch (e) { console.error(`${LOG_TAG} 注册前端路由异常：`, e) }

    // 暴露服务（best-effort），便于同进程其它组件主动触发
    try {
      if (typeof ctx.set === 'function') {
        ctx.set('memoryMap', {
          generate: (opts?: Partial<RunOpts>) =>
            runSnapshot({ days: opts?.days ?? 90, limit: opts?.limit ?? 500, rebuild: opts?.rebuild ?? false }),
          getSnapshotPath: resolveOutPath,
        })
      }
    } catch { /* ignore */ }

    scheduleCron()

    ctx.on('dispose', () => {
      console.log(`${LOG_TAG} dispose：注销工具 + 清制定时器 + 注销前端路由`)
      if (cronTimer) { clearTimeout(cronTimer); cronTimer = null }
      for (const d of webDisposers) { try { d() } catch { /* ignore */ } }
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
      webRegistered = false
    })
  },
}

// ---------------------------------------------------------------------------
// CLI 直接运行入口（仅当本文件被直接 node 执行时触发，DSH import 时不会）
// ---------------------------------------------------------------------------
// 用法：node lib/index.js --regen [--days 90] [--limit 500] [--rebuild]
// 用途：不重启 DSH 也能手动重生成快照（例如升级后补齐 text 字段、或本地冒烟）。
const __main = path.resolve(process.argv[1] || '')
if (__main === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const pick = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const days = pick('--days') ? Math.min(3650, Math.max(1, parseInt(pick('--days')!, 10) || 90)) : 90
  const limit = pick('--limit') ? Math.min(5000, Math.max(1, parseInt(pick('--limit')!, 10) || 500)) : 500
  const rebuild = args.includes('--rebuild')
  if (args.includes('--regen')) {
    runSnapshot({ days, limit, rebuild })
      .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1) })
      .catch((e) => { console.error(e); process.exit(1) })
  } else {
    console.log('dsh-memory-map CLI：使用 --regen [--days N] [--limit N] [--rebuild] 生成快照')
  }
}
