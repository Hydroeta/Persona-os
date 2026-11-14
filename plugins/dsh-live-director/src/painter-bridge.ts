/**
 * painter-bridge.ts —— 直播侧调用 dsh-painter 的桥
 *
 * 为什么走 HTTP 而不是 import：
 *   dsh-live-director 和 dsh-painter 是两个独立插件包，各自有自己的 node_modules
 *   （sharp 是原生模块，跨包 import 很容易踩到"版本/ABI 不一致"）。所以这里起一个
 *   **本进程内的极简 HTTP 服务**（默认 9011），由"画师进程"去 POST 调用 —— 画还是不画
 *   由调用方决定，本文件只负责把请求转成 generatePaintProcess。
 *
 * 启动方式（由 dsh-painter 侧的一个小脚本承担）：
 *   node plugins/dsh-live-director/painter-bridge.mjs
 * 环境变量：
 *   PAINTER_BRIDGE_PORT  监听端口，默认 9011
 *   PAINTER_BRIDGE_TOKEN 可选共享口令（请求头 x-bridge-token 必须一致）
 *
 * 直播侧的调用方见 draw.ts 的 requestPaint()。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface PaintRequest {
  prompt: string
  obs_output_path: string
  frames_dir?: string
  mode?: 'stages' | 'strokes' | 'pixel'
  grid_size?: number
  aspect?: string
  duration_ms?: number
  fps?: number
}

export interface PaintResponse {
  ok: boolean
  path?: string
  frames?: number
  elapsed_ms?: number
  mode?: string
  width?: number
  height?: number
  error?: string
}

const LOG_TAG = '[dsh-live-director/painter-bridge]'

export const BRIDGE_PORT = Number(process.env.PAINTER_BRIDGE_PORT) || 9011
export const BRIDGE_TOKEN = process.env.PAINTER_BRIDGE_TOKEN || ''
export const BRIDGE_URL = (process.env.PAINTER_BRIDGE_URL || `http://127.0.0.1:${BRIDGE_PORT}`).replace(/\/$/, '')

/** 读请求体（带 1MB 上限，防止被塞爆） */
function readBody(req: IncomingMessage, limit = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/**
 * 启动桥。paint 由调用方注入（dsh-painter 的 generatePaintProcess），
 * 这样本文件不依赖 dsh-painter 的包结构。
 */
export function startPainterBridge(
  paint: (req: PaintRequest) => Promise<PaintResponse>,
  opts: { port?: number; token?: string } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const port = opts.port ?? BRIDGE_PORT
  const token = opts.token ?? BRIDGE_TOKEN
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'painter-bridge' })
        if (req.method !== 'POST' || req.url !== '/paint') return send(res, 404, { ok: false, error: 'not found' })
        if (token && req.headers['x-bridge-token'] !== token) return send(res, 401, { ok: false, error: 'token 不匹配' })
        const raw = await readBody(req)
        let body: PaintRequest
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          return send(res, 400, { ok: false, error: 'JSON 解析失败' })
        }
        if (!body.prompt || !body.obs_output_path) return send(res, 400, { ok: false, error: 'prompt 与 obs_output_path 必填' })
        const r = await paint(body)
        return send(res, r.ok ? 200 : 500, r)
      } catch (e) {
        console.error(`${LOG_TAG} 处理失败：${(e as Error).message}`)
        return send(res, 500, { ok: false, error: (e as Error).message })
      }
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      // 传 port=0 时由系统分配：必须从 address() 取回真实端口，不能回显入参
      const addr = server.address()
      const actual = typeof addr === 'object' && addr ? addr.port : port
      console.log(`${LOG_TAG} 已监听 http://127.0.0.1:${actual}/paint`)
      resolve({
        port: actual,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

/**
 * 调用方（直播侧）：POST 一次作画请求。超时默认 120s（含生图 + 逐帧渲染）。
 * 失败一律返回 { ok:false, error }，不抛异常 —— 直播主循环永远不能被作画拖崩。
 */
export async function requestPaint(req: PaintRequest, opts: { timeoutMs?: number; url?: string } = {}): Promise<PaintResponse> {
  const url = `${(opts.url || BRIDGE_URL)}/paint`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(BRIDGE_TOKEN ? { 'x-bridge-token': BRIDGE_TOKEN } : {}) },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    })
    const j: any = await r.json().catch(() => ({}))
    return { ok: !!j.ok, ...j }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    clearTimeout(timer)
  }
}
