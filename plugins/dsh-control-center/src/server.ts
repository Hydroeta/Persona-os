/**
 * server.ts —— 总控面板的 HTTP 服务（:8088）
 *
 * 路由：
 *   GET  /                 单文件 HTML 面板
 *   GET  /api/status       全部服务状态 + 本机资源（并发探测，2s 超时）
 *   POST /api/danmaku      { text, user } → 往 :9001 发一条假弹幕，返回服务端回包
 *   GET  /health           {"ok":true}
 *
 * 设计取舍：
 *   · 面板本身不做轮询缓存 —— 前端每秒拉一次 /api/status 足够，服务端每次现探
 *   · 探测全程 allSettled + 超时，任何一个服务卡死都只会让它自己变红
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { probeAll, readHostInfo, type ServiceStatus, type HostInfo } from './probe.js'
import { sendTestDanmaku, resolveDanmakuWsUrl, type DanmakuReply } from './danmaku.js'
import { EventHub, type PanelEvent } from './events.js'

const LOG_TAG = '[dsh-control-center]'

/** 面板事件总线（SSE）：live-director 推回复/播放状态，面板广播给浏览器 */
export const hub = new EventHub()

/** 服务控制接口（dsh-service-manager 起的 :8010） */
export const CONTROL_API = (process.env.SERVICE_CTL_URL || 'http://127.0.0.1:8010').replace(/\/+$/, '')
/** 画板图片路径（OBS 图片源监听的那张）。没配就没画板 */
export const PAINT_BOARD_PATH = String(process.env.PAINT_BOARD_PATH || '').trim()
/** 静态资源根（web/assets），默认插件目录下的 web/assets */
export const ASSETS_DIR = resolve(process.env.CONTROL_ASSETS_DIR || join(process.cwd(), 'web', 'assets'))

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

export interface Snapshot {
  at: number
  services: ServiceStatus[]
  host: HostInfo
}

export const DEFAULT_PORT = Number(process.env.CONTROL_CENTER_PORT) || 8088

/** 一次性拿全量快照（服务状态与资源并发取） */
export async function collectSnapshot(): Promise<Snapshot> {
  const [services, host] = await Promise.all([probeAll(), readHostInfo()])
  return { at: Date.now(), services, host }
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req: IncomingMessage, limit = 65536): Promise<string> {
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

export interface ControlCenterServer {
  port: number
  close(): Promise<void>
}

export async function startControlCenter(opts: { port?: number; page?: () => string } = {}): Promise<ControlCenterServer> {
  const port = opts.port ?? DEFAULT_PORT
  const page = opts.page ?? (() => '<!doctype html><title>dsh-control-center</title><h1>page not provided</h1>')

  const server = createServer(async (req, res) => {
    try {
      const url = req.url || '/'
      if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
        const html = page()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(html)
      }
      if (req.method === 'GET' && url === '/health') return json(res, 200, { ok: true, service: 'dsh-control-center' })

      if (req.method === 'GET' && url.startsWith('/api/event/stream')) {
        return hub.addClient(res)
      }
      if (req.method === 'GET' && url.startsWith('/api/event/recent')) {
        return json(res, 200, { ok: true, events: hub.recentEvents() })
      }
      if (req.method === 'POST' && url === '/api/event') {
        const raw = await readBody(req)
        let ev: PanelEvent
        try {
          ev = JSON.parse(raw || '{}')
        } catch {
          return json(res, 400, { ok: false, error: 'JSON 解析失败' })
        }
        if (!ev || typeof ev.type !== 'string') return json(res, 400, { ok: false, error: '缺少 type' })
        hub.publish(ev)
        return json(res, 200, { ok: true, listeners: hub.clientCount })
      }

      if (req.method === 'GET' && url.startsWith('/api/latest-paint')) {
        if (!PAINT_BOARD_PATH) return json(res, 404, { ok: false, error: '未配置 PAINT_BOARD_PATH' })
        try {
          const st = await stat(PAINT_BOARD_PATH)
          if (!st.isFile()) return json(res, 404, { ok: false, error: '不是文件' })
          const buf = await readFile(PAINT_BOARD_PATH)
          res.writeHead(200, {
            'content-type': MIME[extname(PAINT_BOARD_PATH).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-store',
            'x-paint-mtime': String(Math.round(st.mtimeMs)),
          })
          return res.end(buf)
        } catch {
          return json(res, 404, { ok: false, error: '画板文件不存在' })
        }
      }

      // 服务控制：原样转发给 :8010，面板自己不做任何判断
      if (url.startsWith('/api/control')) {
        const sub = url.slice('/api/control'.length) || '/health'
        try {
          const r = await fetch(`${CONTROL_API}${sub}`, { method: req.method === 'POST' ? 'POST' : 'GET', signal: AbortSignal.timeout(20000) })
          const body = await r.text()
          res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(body)
        } catch (e) {
          return json(res, 502, { ok: false, error: `控制接口不可用（${CONTROL_API}）：${(e as Error).message}` })
        }
      }

      // 静态资源
      if (req.method === 'GET' && url.startsWith('/assets/')) {
        const rel = decodeURIComponent(url.slice('/assets/'.length).split('?')[0])
        const abs = resolve(join(ASSETS_DIR, normalize(rel)))
        if (!abs.startsWith(ASSETS_DIR)) return json(res, 403, { ok: false, error: 'forbidden' })
        try {
          const buf = await readFile(abs)
          res.writeHead(200, { 'content-type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream' })
          return res.end(buf)
        } catch {
          return json(res, 404, { ok: false, error: 'not found' })
        }
      }

      if (req.method === 'GET' && url.startsWith('/api/status')) {
        const snap = await collectSnapshot()
        return json(res, 200, snap)
      }

      if (req.method === 'POST' && url === '/api/danmaku') {
        const raw = await readBody(req)
        let body: { text?: string; user?: string } = {}
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          return json(res, 400, { ok: false, error: 'JSON 解析失败' })
        }
        const text = String(body.text || '').trim()
        if (!text) return json(res, 400, { ok: false, error: 'text 不能为空' })
        const reply: DanmakuReply = await sendTestDanmaku(text, String(body.user || '面板指挥官'))
        return json(res, reply.ok ? 200 : 502, { ...reply, target: resolveDanmakuWsUrl() })
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      console.error(`${LOG_TAG} 处理失败：${(e as Error).message}`)
      return json(res, 500, { ok: false, error: (e as Error).message })
    }
  })

  return new Promise<ControlCenterServer>((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      // 传 0 时由系统分配，从 address() 取真实端口（别回显入参）
      const actual = (server.address() as AddressInfo).port
      console.log(`${LOG_TAG} 面板已启动 http://127.0.0.1:${actual}`)
      resolve({
        port: actual,
        close: () =>
          new Promise<void>((r) => {
            hub.closeAll()
            server.close(() => r())
          }),
      })
    })
  })
}
