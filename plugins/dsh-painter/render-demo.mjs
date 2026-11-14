// render-demo.mjs —— 各画一次 stages / strokes / pixel，导出全部帧 + 拼对比图
// ⚠️ 关键：painter 的 env 在**模块加载时**读取（PAINTER_TEST_MODE / PAINTER_FRAMES_DIR），
//    所以必须**先设 process.env 再 import**，否则帧目录不生效（只渲染不落盘）。
// 用法: node render-demo.mjs <源图> <输出根目录>
import { mkdirSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const src = process.argv[2]
const root = process.argv[3]
if (!src || !root) {
  console.error('用法: node render-demo.mjs <源图> <输出根目录>')
  process.exit(1)
}

rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

const MODES = ['stages', 'strokes', 'pixel']
const results = {}

// 每种模式：先设环境变量 -> 独立 import（带 query 绕开 ESM 缓存），保证 env 重新求值
for (const mode of MODES) {
  const dir = join(root, mode)
  mkdirSync(dir, { recursive: true })
  process.env.PAINTER_LOCAL_IMAGE = src
  process.env.PAINTER_TEST_MODE = '1'
  process.env.PAINTER_FRAMES_DIR = dir
  const obs = join(dir, 'obs.png')

  const url = pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href + `?v=${mode}`
  const mod = await import(url)
  const gen = mod.generatePaintProcess

  const t0 = Date.now()
  const res = await gen({ mode, prompt: 'demo', duration_ms: 6000, fps: 20, aspect: '1:1', obs_output_path: obs })
  const files = readdirSync(dir).filter(f => /^frame_/.test(f)).sort()
  results[mode] = { files, res, ms: Date.now() - t0, dir }
  console.log(`${mode.padEnd(8)} ok=${res.ok} mode=${res.mode} strokes=${res.strokes ?? '-'} frames=${res.frames ?? 0} 落盘帧=${files.length} 耗时=${Date.now() - t0}ms`)
  if (!res.ok) console.log('   错误:', res.error)
}

// 拼对比图：每种模式取 第1帧 / 1/3 / 2/3 / 末帧
const { default: sharp } = await import('sharp')
const picks = []
for (const mode of MODES) {
  const fs = results[mode].files
  if (!fs.length) continue
  const idx = [0, Math.floor(fs.length / 3), Math.floor(fs.length * 2 / 3), fs.length - 1]
  for (const i of idx) picks.push({ mode, file: join(results[mode].dir, fs[i]), label: `${mode} ${i + 1}/${fs.length}` })
}

if (picks.length) {
  const CELL = 260
  const tiles = []
  for (const p of picks) {
    const buf = await sharp(p.file).resize(CELL, CELL, { fit: 'cover' }).toBuffer()
    tiles.push(buf)
  }
  const cols = 4
  const rows = Math.ceil(tiles.length / cols)
  const composites = []
  for (let i = 0; i < tiles.length; i++) {
    composites.push({ input: tiles[i], left: (i % cols) * CELL, top: Math.floor(i / cols) * CELL })
  }
  await sharp({ create: { width: cols * CELL, height: rows * CELL, channels: 3, background: '#0A1128' } })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toFile(join(root, 'compare.jpg'))
  console.log('\n对比图: ' + join(root, 'compare.jpg'))
  console.log('取材: ' + picks.map(p => p.label).join(' | '))
}

writeFileSync(join(root, 'result.json'), JSON.stringify(
  Object.fromEntries(Object.entries(results).map(([k, v]) => [k, {
    ok: v.res.ok, mode: v.res.mode, strokes: v.res.strokes, frames: v.res.frames,
    frameFiles: v.files.length, ms: v.ms,
  }])), null, 2))
