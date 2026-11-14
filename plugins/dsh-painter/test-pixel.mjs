/**
 * test-pixel.mjs —— 像素砌砖动画离线验证
 * 用一张现成的像素图跑「读格 → 排砖序 → 逐帧渲染」，导出 mp4 和若干关键帧。
 *
 * 用法：node build.mjs && node test-pixel.mjs <输入png> <n> <输出目录>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { readPixelGrid, planBrickOrder, renderPixelFrame, planBrickBatches } from './lib/pixel.js'

const src = process.argv[2]
const n = Number(process.argv[3] || 64)
const outDir = process.argv[4] || 'temp_pixel_test'
if (!src) {
  console.error('用法：node test-pixel.mjs <输入png> <n> <输出目录>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
mkdirSync(join(outDir, 'frames'), { recursive: true })

const buf = await readFile(src)
const grid = await readPixelGrid(buf, n)
console.log(`读格：${grid.n}×${grid.n}，每格 ${grid.cell}px，画幅 ${grid.size}`)

const order = planBrickOrder(grid, { jitter: 0.15, seed: 7 })
console.log(`排序：${order.length} 格，前三格 = ${JSON.stringify(order.slice(0, 3))}`)

const { batch } = planBrickBatches(n)
const FRAMES = 120 // 4 秒 @30fps（导片用）
for (let i = 0; i < FRAMES; i++) {
  const p = (i + 1) / FRAMES
  // 按批次量化：一批一批跳
  const stepCells = batch / order.length
  const k = Math.floor(p / stepCells)
  const q = Math.min(1, (k * batch) / order.length)
  const png = await renderPixelFrame(grid, order, q)
  const name = `f${String(i).padStart(3, '0')}.png`
  writeFileSync(join(outDir, 'frames', name), png)
}
console.log(`帧：${FRAMES} 张，每步刷 ${batch} 格`)

// 导出 mp4（ffmpeg 可用时）
const ffmpeg = process.env.FFMPEG || 'ffmpeg'
try {
  execFileSync(ffmpeg, [
    '-y', '-framerate', '30', '-i', join(outDir, 'frames', 'f%03d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
    join(outDir, 'pixel_brick.mp4'),
  ], { stdio: 'pipe' })
  console.log(`mp4 -> ${join(outDir, 'pixel_brick.mp4')}`)
} catch (e) {
  console.error(`ffmpeg 失败（帧已存，可手动合成）：${e.message.slice(0, 200)}`)
}
