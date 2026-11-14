/**
 * e2e-pixel.mjs —— 端到端跑通 pixel 模式并导出 mp4
 *
 * 链路：底图（本地 PNG，不经生图 API）→ generatePaintProcess(mode:'pixel') 逐帧写 OBS 路径
 *       → 收集 PAINTER_FRAMES_DIR 里的帧 → ffmpeg 合成 mp4。
 *
 * 用法：
 *   set PAINTER_USE_LOCAL_IMAGE=1  （跳过 IMAGE_GEN_URL，用本地底图）
 *   node e2e-pixel.mjs <底图png> <输出目录> [grid_size]
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const src = process.argv[2]
const outDir = resolve(process.argv[3] || 'temp_pixel_e2e')
const gridSize = Number(process.argv[4] || 64)
if (!src) {
  console.error('用法：node e2e-pixel.mjs <底图png> <输出目录> [grid_size]')
  process.exit(2)
}

const framesDir = join(outDir, 'frames')
mkdirSync(framesDir, { recursive: true })
const obsPath = join(outDir, 'canvas.png')

// 让插件直接读本地底图（而不是调生图 API）
process.env.PAINTER_LOCAL_IMAGE = src
process.env.PAINTER_FRAMES_DIR = framesDir

const { generatePaintProcess } = await import('./lib/index.js')
const res = await generatePaintProcess({
  prompt: '像素风测试',
  obs_output_path: obsPath,
  duration_ms: 4000,
  fps: 30,
  mode: 'pixel',
  grid_size: gridSize,
})
console.log('结果：', JSON.stringify({ ok: res.ok, mode: res.mode, grid_size: res.grid_size, frames: res.frames, error: res.error, elapsed_ms: res.elapsed_ms }, null, 2))
if (!res.ok) process.exit(1)

const files = readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort()
console.log(`帧目录：${files.length} 张`)
if (files.length) {
  try {
    execFileSync('ffmpeg', [
      '-y', '-framerate', '30', '-i', join(framesDir, 'frame_%03d.jpg'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
      join(outDir, 'pixel_end_to_end.mp4'),
    ], { stdio: 'pipe' })
    console.log(`mp4 -> ${join(outDir, 'pixel_end_to_end.mp4')}`)
  } catch (e) {
    console.error(`ffmpeg 失败：${e.message.slice(0, 200)}`)
  }
}
writeFileSync(join(outDir, 'result.json'), JSON.stringify(res, null, 2))
