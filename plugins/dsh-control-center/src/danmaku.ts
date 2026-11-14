/**
 * danmaku.ts —— 指挥官测试台：往 :9001 发一条假弹幕
 *
 * 契约来自 live-director 的 queue.ts：
 *   客户端连 ws://127.0.0.1:9001
 *   发 {user, text, gift}(次数可省，默认 0)
 *   服务端回 {ok, reason, priority, queueSize, text, user}
 *
 * 只发一条、等一条回包、带超时。失败返回 {ok:false,error}，不抛。
 */
import WebSocket from 'ws'

export const DEFAULT_DANMAKU_WS = process.env.DANMAKU_WS_URL || 'ws://127.0.0.1:9001'

/** 每次调用时再读一次 env（模块常量只在加载时读一次，测试里改 env 不会生效） */
export function resolveDanmakuWsUrl(): string {
  return process.env.DANMAKU_WS_URL || DEFAULT_DANMAKU_WS
}

export interface DanmakuReply {
  ok: boolean
  /** 服务端原始回包（原样给面板展示） */
  reply?: unknown
  error?: string
  ms?: number
}

/** 发一条模拟弹幕，等第一条回包 */
export function sendTestDanmaku(
  text: string,
  user = '面板指挥官',
  opts: { url?: string; timeoutMs?: number } = {},
): Promise<DanmakuReply> {
  const url = opts.url || resolveDanmakuWsUrl()
  const timeoutMs = opts.timeoutMs ?? 5000
  const t0 = Date.now()
  return new Promise((resolve) => {
    let done = false
    const finish = (r: DanmakuReply) => {
      if (done) return
      done = true
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      resolve({ ...r, ms: Date.now() - t0 })
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      return resolve({ ok: false, error: (e as Error).message, ms: Date.now() - t0 })
    }
    const timer = setTimeout(() => finish({ ok: false, error: `等待回包超时（${timeoutMs}ms）` }), timeoutMs)
    ws.on('open', () => {
      ws.send(JSON.stringify({ user, text, gift: 0 }))
    })
    ws.on('message', (raw) => {
      clearTimeout(timer)
      let parsed: unknown = String(raw)
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        /* 保留原始字符串 */
      }
      finish({ ok: true, reply: parsed })
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, error: (e as Error).message })
    })
    ws.on('close', () => {
      clearTimeout(timer)
      finish({ ok: false, error: '连接被关闭，没收到回包' })
    })
  })
}
