/**
 * 把 dsh-painter 暴露成一个本机 HTTP 服务，供 dsh-live-director 的 draw.ts 调用。
 *
 * 为什么不直接 import：两个插件各自有自己的 node_modules，sharp 是原生模块，
 * 跨包 import 很容易踩 ABI 不一致。走 HTTP 最省事，也天然隔离崩溃。
 *
 * 用法：
 *   node plugins/dsh-live-director/painter-bridge.mjs
 * 环境变量：
 *   PAINTER_BRIDGE_PORT   默认 9011
 *   PAINTER_BRIDGE_TOKEN  可选共享口令
 *   PAINTER_LOCAL_IMAGE   设了就跳过生图 API、直接读这张本地图（离线演示）
 */
import { startPainterBridge } from './lib/painter-bridge.js'
import { generatePaintProcess } from '../../plugins/dsh-painter/lib/index.js'

const { port, close } = await startPainterBridge(async (req) => {
  const res = await generatePaintProcess({
    prompt: req.prompt,
    obs_output_path: req.obs_output_path,
    mode: req.mode,
    grid_size: req.grid_size,
    aspect: req.aspect,
    duration_ms: req.duration_ms ?? 8000,
    fps: req.fps ?? 12,
  })
  return {
    ok: res.ok,
    path: res.path,
    frames: res.frames,
    elapsed_ms: res.elapsed_ms,
    mode: res.mode,
    width: res.width,
    height: res.height,
    error: res.error,
  }
})

console.log(`[painter-bridge] 就绪 http://127.0.0.1:${port}/paint`)

process.on('SIGINT', async () => {
  await close()
  process.exit(0)
})
