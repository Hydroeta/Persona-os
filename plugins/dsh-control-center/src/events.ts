/**
 * events.ts —— 面板的事件通道（HTTP POST /api/event + SSE 广播）
 *
 * 为什么用 SSE 而不是再加一个 WebSocket：浏览器原生 EventSource 只用几行，
 * 不需要额外依赖，断了会自动重连；而推事件的 `dsh-live-director` 用普通 fetch 就能发。
 *
 * 事件形状（全部宽松，未知 type 直接忽略）：
 *   { type: 'chat_reply', text: string, user?: string, at?: number }
 *   { type: 'tts_start' } / { type: 'tts_end' }
 *   { type: 'paint_start', prompt?: string } / { type: 'paint_end', ok?: boolean }
 */
import type { ServerResponse } from 'node:http'

export interface PanelEvent {
  type: string
  text?: string
  user?: string
  prompt?: string
  ok?: boolean
  at?: number
}

export class EventHub {
  private clients = new Set<ServerResponse>()
  /** 最近若干条事件，供新连接的页面补历史（/api/event/recent） */
  private recent: PanelEvent[] = []

  /** 新客户端接入 SSE */
  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    // 先发一条 hello，浏览器 EventSource 才会认为连接成功
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`)
    this.clients.add(res)
    res.on('close', () => {
      this.clients.delete(res)
    })
  }

  get clientCount(): number {
    return this.clients.size
  }

  /** 广播一条事件；失败静默（页面刷新时连接会短暂失效） */
  publish(ev: PanelEvent): void {
    const e: PanelEvent = { ...ev, at: ev.at ?? Date.now() }
    this.recent.push(e)
    if (this.recent.length > 50) this.recent.shift()
    const payload = `event: panel\ndata: ${JSON.stringify(e)}\n\n`
    for (const c of this.clients) {
      try {
        c.write(payload)
      } catch {
        this.clients.delete(c)
      }
    }
  }

  recentEvents(): PanelEvent[] {
    return this.recent.slice()
  }

  closeAll(): void {
    for (const c of this.clients) {
      try {
        c.end()
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
  }
}
