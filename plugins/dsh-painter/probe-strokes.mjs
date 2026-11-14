// probe-strokes.mjs —— 实测笔画抽取在真实立绘上能抽出多少条
// 通过 lib/index.js 暴露的 generatePaintProcess 走 strokes 模式，
// 用返回的 strokes 字段判断是否发生了静默降级。
// 用法：node probe-strokes.mjs <图片路径>
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const src = process.argv[2]
if (!src) {
  console.error('用法: node probe-strokes.mjs <图片路径>')
  process.exit(1)
}

const buf = readFileSync(src)
console.log('输入:', src, `(${Math.round(buf.length / 1024)} KB)`)

// 环境：本地图当底图，帧写到临时目录
const dir = mkdtempSync(join(tmpdir(), 'probe-strokes-'))
process.env.PAINTER_LOCAL_IMAGE = src
process.env.PAINTER_FRAMES_DIR = dir
process.env.PAINTER_TEST_MODE = '1'

const mod = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)
const gen = mod.generatePaintProcess || (mod.default && mod.default.generatePaintProcess)
if (!gen) {
  console.error('lib/index.js 里没有 generatePaintProcess，导出:', Object.keys(mod))
  process.exit(1)
}

const res = await gen({ mode: 'strokes', prompt: 'probe', duration_ms: 1000, fps: 12, aspect: '1:1' })
console.log('返回:', {
  ok: res.ok,
  mode: res.mode,
  strokes: res.strokes,
  frames: res.frames,
  message: res.message,
})

const files = readdirSync(dir)
console.log('帧数:', files.length)

if (res.mode !== 'strokes') {
  console.log('\n⚠️ 静默降级：请求 strokes，实际走的是', res.mode)
} else {
  console.log('\n✅ 确实走的 strokes，笔画数 =', res.strokes)
}

rmSync(dir, { recursive: true, force: true })
