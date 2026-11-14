/**
 * control-api.ts —— 服务控制接口（本机 :8010）
 *
 * 为什么要有这个东西：`dsh-service-manager` 原来只会"启动时把微服务拉起来"，
 * restart/stop 都是模块内私有函数，面板（另一个进程）根本够不着。
 * 这里把它暴露成一个**只监听 127.0.0.1** 的小 HTTP 服务，让总控面板能真按按钮。
 *
 * 路由（全部 POST，GET /health 除外）：
 *   GET  /health                {"ok":true,"services":["IndexTTS2",...]}
 *   POST /start-all             把没在跑的微服务拉起来
 *   POST /restart?name=Painter  杀进程树 → 等端口释放 → 重新拉起
 *   POST /stop?name=Painter     杀进程树，并且**不再自动拉起**
 *
 * 安全边界（很重要）：
 *   · 只监听回环地址，外部访问不进来
 *   · 可选 `SERVICE_CTL_TOKEN`，设了就必须带 `x-ctl-token` 头
 *   · **只允许操作 SERVICES 里列出的名字**，别让它变成任意进程杀手
 *   · `/stop` 之后该服务在 `stopped` 集合里，`start-all` 不会违背用户意愿把它拉回来
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const LOG_TAG = '[dsh-service-manager/ctl]'

export const CTL_PORT = Number(process.env.SERVICE_CTL_PORT) || 8010
export const CTL_TOKEN = process.env.SERVICE_CTL_TOKEN || ''

export interface ControlHooks {
  /** 允许操作的服务名（白名单） */
  names: string[]
  /** 该服务当前是否在跑（按端口探测实现） */
  isRunning: (name: string) => Promise<boolean>
  /** 杀掉该服务的进程（按名字） */
  stop: (name: string) => Promise<{ ok: boolean; detail: string }>
  /** 拉起该服务 */
  start: (name: string) => Promise<{ ok: boolean; detail: string }>
}

function json(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
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

export interface ControlApiServer {
  port: number
  close(): Promise<void>
}

export function startControlApi(hooks: ControlHooks, opts: { port?: number; token?: string } = {}): Promise<ControlApiServer> {
  const port = opts.port ?? CTL_PORT
  const token = opts.token ?? CTL_TOKEN
  /** 用户主动 stop 掉的服务；start-all 不会自动把它们拉回来 */
  const stopped = new Set<string>()

  const allowed = (name: string) => hooks.names.includes(name)

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET' && u.pathname === '/health') {
        return json(res, 200, { ok: true, services: hooks.names })
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'only POST' })
      if (token && req.headers['x-ctl-token'] !== token) return json(res, 401, { ok: false, error: 'token 不匹配' })
      await readBody(req).catch(() => '')

      if (u.pathname === '/start-all') {
        const out: Array<{ name: string; ok: boolean; detail: string }> = []
        for (const name of hooks.names) {
          if (stopped.has(name)) {
            out.push({ name, ok: false, detail: '被手动停止，跳过（可先 /start?name=）' })
            continue
          }
          if (await hooks.isRunning(name)) {
            out.push({ name, ok: true, detail: '已在运行' })
            continue
          }
          const r = await hooks.start(name)
          out.push({ name, ...r })
        }
        return json(res, 200, { ok: out.every((o) => o.ok), results: out })
      }

      const name = u.pathname === '/restart' || u.pathname === '/stop' || u.pathname === '/start'
        ? String(u.searchParams.get('name') || '')
        : ''
      if (!name) return json(res, 400, { ok: false, error: '缺少 name 参数' })
      if (!allowed(name)) return json(res, 400, { ok: false, error: `未知服务：${name}（可用：${hooks.names.join('/')}）` })

      if (u.pathname === '/restart') {
        const k = await hooks.stop(name)
        stopped.delete(name)
        const s = await hooks.start(name)
        return json(res, k.ok && s.ok ? 200 : 500, { ok: k.ok && s.ok, stop: k, start: s })
      }
      if (u.pathname === '/stop') {
        const k = await hooks.stop(name)
        if (k.ok) stopped.add(name)
        return json(res, k.ok ? 200 : 500, { ok: k.ok, stop: k })
      }
      // /start
      stopped.delete(name)
      const s = await hooks.start(name)
      return json(res, s.ok ? 200 : 500, { ok: s.ok, start: s })
    } catch (e) {
      console.error(`${LOG_TAG} 处理失败：${(e as Error).message}`)
      return json(res, 500, { ok: false, error: (e as Error).message })
    }
  })

  return new Promise<ControlApiServer>((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port
      console.log(`${LOG_TAG} 控制接口已监听 http://127.0.0.1:${actual}`)
      resolve({ port: actual, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}
