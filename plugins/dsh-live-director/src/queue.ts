/**
 * dsh-live-director · 模块 1：弹幕接入与优先级队列
 *
 * 职责（严格对照架构指令）：
 *   1. 用 `ws` 启动 WebSocket 服务监听 :9001，接收 { user, text, gift }
 *   2. 维护内存 PriorityQueue：优先级 礼物(3) > 画图指令(2) > 普通对话(1)
 *   3. 防刷屏冷却：全局画图冷却 30s，单用户交互冷却 10s（Map 记用户上次互动时间戳）
 *
 * 设计：本模块纯逻辑 + 网络，不依赖 DSH ctx，可被 test-mock.js 直接 import 单测，
 *      也可被 index.ts 在 apply 时启动、dispose 时关闭。
 */
import { WebSocketServer, WebSocket } from 'ws'

export const LOG_TAG = '[dsh-live-director:queue]'

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/** 一条弹幕（WS 入站 → 服务端补齐 ts） */
export interface DanmakuMessage {
  user: string
  text: string
  gift: number // 礼物价值，0 表示纯弹幕
  ts: number // 服务端接收时间戳（ms）
}

/** 优先级：数字越大越优先 */
export enum Priority {
  CHAT = 1, // 普通对话
  DRAW = 2, // 画图指令
  GIFT = 3, // 礼物
}

/** 入队后的条目 */
export interface QueuedItem {
  id: string
  msg: DanmakuMessage
  priority: Priority
  reason: string // 判定理由（调试用）
  enqueuedAt: number
}

// ---------------------------------------------------------------------------
// 优先级判定
// ---------------------------------------------------------------------------

/** 画图指令关键词（命中则 priority = DRAW） */
const DRAW_KEYWORDS = ['画个', '画一张', '画张', '绘制', '来一张', '画幅', '画一画', '画画', '画']

export interface ClassifyResult {
  priority: Priority
  reason: string
}

/** 判定一条弹幕的优先级：礼物 > 画图指令 > 普通对话 */
export function classifyPriority(msg: DanmakuMessage): ClassifyResult {
  if ((msg.gift || 0) > 0) return { priority: Priority.GIFT, reason: '礼物' }
  for (const kw of DRAW_KEYWORDS) {
    if (msg.text.includes(kw)) return { priority: Priority.DRAW, reason: `命中画图关键词「${kw}」` }
  }
  return { priority: Priority.CHAT, reason: '普通对话' }
}

// ---------------------------------------------------------------------------
// 冷却控制（防刷屏）
// ---------------------------------------------------------------------------

export interface CooldownConfig {
  globalDrawCooldownMs: number // 全局画图冷却，默认 30s
  perUserCooldownMs: number // 单用户交互冷却，默认 10s
}

export const DEFAULT_COOLDOWN: CooldownConfig = {
  globalDrawCooldownMs: 30_000,
  perUserCooldownMs: 10_000,
}

export interface CooldownVerdict {
  allowed: boolean
  reason: string
}

/**
 * 冷却限制器：
 *   - 单用户冷却：任意用户两次交互间隔不得小于 perUserCooldownMs（防单用户刷屏）
 *   - 全局画图冷却：两次画图指令间隔不得小于 globalDrawCooldownMs（防画图指令刷屏）
 * 严格按规范：所有交互（含礼物）都走单用户冷却；若需豁免可在调用层调整。
 */
export class RateLimiter {
  private lastUserTs = new Map<string, number>()
  private lastGlobalDrawTs = 0

  constructor(private cfg: CooldownConfig = DEFAULT_COOLDOWN) {}

  check(user: string, priority: Priority, now: number = Date.now()): CooldownVerdict {
    const lastUser = this.lastUserTs.get(user) || 0
    if (now - lastUser < this.cfg.perUserCooldownMs) {
      const remain = Math.ceil((this.cfg.perUserCooldownMs - (now - lastUser)) / 1000)
      return { allowed: false, reason: `用户「${user}」交互冷却中（剩余 ${remain}s）` }
    }
    if (priority === Priority.DRAW && now - this.lastGlobalDrawTs < this.cfg.globalDrawCooldownMs) {
      const remain = Math.ceil((this.cfg.globalDrawCooldownMs - (now - this.lastGlobalDrawTs)) / 1000)
      return { allowed: false, reason: `全局画图冷却中（剩余 ${remain}s）` }
    }
    return { allowed: true, reason: 'ok' }
  }

  /** 放行后记录时间戳（必须在 check 通过后调用） */
  record(user: string, priority: Priority, now: number = Date.now()): void {
    this.lastUserTs.set(user, now)
    if (priority === Priority.DRAW) this.lastGlobalDrawTs = now
  }

  /** 测试用：清空所有冷却状态 */
  reset(): void {
    this.lastUserTs.clear()
    this.lastGlobalDrawTs = 0
  }
}

// ---------------------------------------------------------------------------
// 优先级队列
// ---------------------------------------------------------------------------

/**
 * 优先级队列：高优先级在前；同优先级按入队时间 FIFO。
 * 用数组 + sort 实现（弹幕量级 QPS 低，够用且简单可审计）。
 */
export class PriorityQueue {
  private items: QueuedItem[] = []
  private seq = 0

  push(input: { msg: DanmakuMessage; priority: Priority; reason: string }): QueuedItem {
    const item: QueuedItem = {
      id: `q${++this.seq}`,
      msg: input.msg,
      priority: input.priority,
      reason: input.reason,
      enqueuedAt: Date.now(),
    }
    this.items.push(item)
    this.items.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt)
    return item
  }

  pop(): QueuedItem | undefined {
    return this.items.shift()
  }

  peek(): QueuedItem | undefined {
    return this.items[0]
  }

  get size(): number {
    return this.items.length
  }

  toArray(): readonly QueuedItem[] {
    return this.items
  }

  clear(): void {
    this.items.length = 0
  }

  /**
   * 启动消费者：按 intervalMs 轮询队列，有 item 就 pop 出来交给 handler 处理。
   * 串行（busy 锁）：上一条处理完才取下一条，避免 TTS 重叠播放。
   * 返回 stop 函数，dispose 时必须调用以清理定时器。
   */
  consume(
    handler: (item: QueuedItem) => Promise<void> | void,
    opts: { intervalMs?: number } = {},
  ): () => void {
    const intervalMs = opts.intervalMs ?? 100
    let busy = false
    const timer = setInterval(async () => {
      if (busy) return
      const item = this.pop()
      if (!item) return
      busy = true
      try {
        await handler(item)
      } catch (e) {
        console.error(`${LOG_TAG} 消费者处理异常：`, e)
      } finally {
        busy = false
      }
    }, intervalMs)
    // 允许事件循环退出（测试/进程结束时不挂起）
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }
}

// ---------------------------------------------------------------------------
// 弹幕 → 入队 的串联处理（判定 → 冷却 → 记录 → 入队）
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  item: QueuedItem | null // null 表示被冷却拦截
  verdict: CooldownVerdict
  msg: DanmakuMessage
}

/** 处理一条原始弹幕：清洗字段 → 判优先级 → 冷却校验 → 入队 */
export function classifyAndEnqueue(
  raw: { user: string; text: string; gift?: number },
  queue: PriorityQueue,
  limiter: RateLimiter,
): EnqueueResult {
  const msg: DanmakuMessage = {
    user: String(raw.user ?? '').trim().slice(0, 64) || '匿名',
    text: String(raw.text ?? '').slice(0, 500),
    gift: Number(raw.gift) || 0,
    ts: Date.now(),
  }
  const { priority, reason } = classifyPriority(msg)
  const verdict = limiter.check(msg.user, priority, msg.ts)
  if (!verdict.allowed) return { item: null, verdict, msg }
  limiter.record(msg.user, priority, msg.ts)
  const item = queue.push({ msg, priority, reason })
  return { item, verdict, msg }
}

// ---------------------------------------------------------------------------
// WebSocket 弹幕服务
// ---------------------------------------------------------------------------

export interface DanmakuServerOptions {
  port?: number // 默认 9001
  cooldown?: CooldownConfig
  /** 每条弹幕处理完的回调（放行或拦截都会触发），供上层 director 消费 */
  onMessage?: (item: QueuedItem | null, msg: DanmakuMessage, verdict: CooldownVerdict) => void
}

export interface DanmakuServer {
  wss: WebSocketServer
  queue: PriorityQueue
  limiter: RateLimiter
  port: number
  close(): Promise<void>
}

/** 启动 WebSocket 弹幕服务，监听 :port，收到 {user,text,gift} 后走 classifyAndEnqueue */
export function startDanmakuServer(opts: DanmakuServerOptions = {}): Promise<DanmakuServer> {
  const port = opts.port ?? 9001
  const queue = new PriorityQueue()
  const limiter = new RateLimiter(opts.cooldown)
  const wss = new WebSocketServer({ port })

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data) => {
      let raw: any
      try {
        raw = JSON.parse(data.toString())
      } catch {
        ws.send(JSON.stringify({ ok: false, error: 'invalid JSON' }))
        return
      }
      if (!raw || typeof raw !== 'object') {
        ws.send(JSON.stringify({ ok: false, error: 'expected object {user,text,gift}' }))
        return
      }
      const { item, verdict, msg } = classifyAndEnqueue(raw, queue, limiter)
      if (opts.onMessage) opts.onMessage(item, msg, verdict)
      ws.send(
        JSON.stringify({
          ok: !!item,
          reason: verdict.reason,
          priority: item?.priority ?? null,
          queueSize: queue.size,
          text: msg.text,
          user: msg.user,
        }),
      )
    })
    ws.on('error', (err) => console.error(`${LOG_TAG} 连接错误：`, err))
  })

  wss.on('error', (err) => console.error(`${LOG_TAG} 服务错误：`, err))

  return new Promise((resolve, reject) => {
    wss.once('listening', () => {
      console.log(`${LOG_TAG} WebSocket 弹幕服务已启动 ws://127.0.0.1:${port}`)
      const server: DanmakuServer = {
        wss,
        queue,
        limiter,
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.close()
            wss.close(() => res())
          }),
      }
      resolve(server)
    })
    wss.once('error', reject)
  })
}
