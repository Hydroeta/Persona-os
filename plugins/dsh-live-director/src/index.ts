/**
 * dsh-live-director —— 终极直播交互引擎
 *
 * 模块拆分（src/）：
 *   index.ts      插件生命周期与工具注册（本文件）
 *   queue.ts      弹幕接入与优先级队列（模块 1）
 *   director.ts   Rundown 状态机与主动心跳（模块 2）
 *   memory.ts     观众记忆注入（模块 3，待实现）
 *   perception.ts 多模态画面截取与解析（模块 4，待实现）
 *
 * 本轮（模块 2）：把 director 接入 index.ts，形成闭环
 *   弹幕到达 → markInteraction（刷新冷场计时）+ 入队
 *   队列消费 → LLM 生成回复 → speak（TTS 占位）→ markInteraction
 *   director 心跳 → sys_action（切状态/冷场搭话）→ LLM 生成文案 → speak
 *
 * 解耦原则：director.ts 只产生“意图”，LLM 调用与文案生成全部在本文件。
 * 无 LLM 环境（测试 / 未装 dsh-llm-router）时降级 mock 文案，保证链路不崩。
 */
import { startDanmakuServer, type DanmakuServer, type QueuedItem, Priority } from './queue'
import { Director, RundownState, type SysAction, STATE_LABEL } from './director'
import { MemoryClient, buildMemoryPrompt } from './memory'
import { Perception, shouldCaptureScreen, buildScreenPrompt } from './perception'
import { playBgm, stopBgm } from './bgm'
import { reportEventNoWait } from './report'

const LOG_TAG = '[dsh-live-director]'
const DANMAKU_PORT = Number(process.env.DSH_LIVE_DIRECTOR_PORT) || 9001

// ---------------------------------------------------------------------------
// DSH 工具类型（最小子集，参照 dsh-memory-bus 实测结构）
// ---------------------------------------------------------------------------

interface DshTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown>; render: (args: any, value: any) => any[] }
  execute: (args: any, exec: any) => Promise<any>
  presentCall?: (args: any) => any
}

// ---------------------------------------------------------------------------
// 运行时单例（apply 时创建，dispose 时销毁）
// ---------------------------------------------------------------------------

let danmakuServer: DanmakuServer | null = null
let director: Director | null = null
let stopConsume: (() => void) | null = null
let memoryClient: MemoryClient | null = null
let perception: Perception | null = null

/** 测试/运行时注入：允许覆盖默认 memory 与 perception（默认走真实 HTTP + 截屏） */
let memoryClientOverride: MemoryClient | null = null
let perceptionOverride: Perception | null = null
export function __injectForTest(opts: { memory?: MemoryClient; perception?: Perception }): void {
  memoryClientOverride = opts.memory ?? null
  perceptionOverride = opts.perception ?? null
}

// ---------------------------------------------------------------------------
// LLM 接入：优先 ctx.get('llmRouter')，取不到则降级 mock（保证无 LLM 环境不崩）
// ---------------------------------------------------------------------------

/** 调 LLM 生成一句回复；失败或无 router 时返回 fallback */
async function generateReply(
  ctx: any,
  prompt: string,
  fallback: string,
): Promise<string> {
  let router: any = null
  try {
    router = typeof ctx?.get === 'function' ? ctx.get('llmRouter') : null
  } catch {
    router = null
  }
  if (router && typeof router.chat === 'function') {
    try {
      const res = await router.chat(
        [{ role: 'user', content: prompt }],
        { background: true },
      )
      const content = res?.content
      if (typeof content === 'string' && content.trim()) return content
    } catch (e) {
      console.error(`${LOG_TAG} LLM 调用失败，降级 mock 文案：`, (e as Error).message)
    }
  }
  return fallback
}

/** 调 LLM（传完整 messages 数组）；失败或无 router 时返回 fallback */
async function chatWithMessages(
  ctx: any,
  messages: Array<{ role: string; content: string }>,
  fallback: string,
): Promise<string> {
  let router: any = null
  try {
    router = typeof ctx?.get === 'function' ? ctx.get('llmRouter') : null
  } catch {
    router = null
  }
  if (router && typeof router.chat === 'function') {
    try {
      const res = await router.chat(messages, { background: true })
      const content = res?.content
      if (typeof content === 'string' && content.trim()) return content
    } catch (e) {
      console.error(`${LOG_TAG} LLM 调用失败，降级 mock 文案：`, (e as Error).message)
    }
  }
  return fallback
}

/**
 * 纯函数：组装发给 LLM 的消息（System Prompt 注入记忆，User 消息注入画面上下文）。
 * 导出供 test-mock.js 验证“记忆/画面是否真的注入到了请求 Payload”。
 */
export function buildChatMessages(opts: {
  user: string
  text: string
  userContext?: string
  screenContext?: string
}): Array<{ role: 'system' | 'user'; content: string }> {
  const sysParts: string[] = [
    '你是直播间的 AI 主播，口语化、热情、有网感，回复简短（不超过 40 字），不要重复弹幕原文。',
  ]
  const memPrompt = buildMemoryPrompt(opts.user, opts.userContext ?? '')
  if (memPrompt) sysParts.push(memPrompt)

  const userParts: string[] = []
  const screenPrompt = buildScreenPrompt(opts.screenContext ?? '')
  if (screenPrompt) userParts.push(screenPrompt)
  userParts.push(`观众「${opts.user}」发弹幕：「${opts.text}」，请回复。`)

  return [
    { role: 'system', content: sysParts.join('\n') },
    { role: 'user', content: userParts.join(' ') },
  ]
}

/**
 * TTS 播报占位（模块 5 实现真实 TTS 时替换内部）。
 * 每次主动发言后刷新 director 冷场计时，避免刚说完又触发冷场。
 */
// ---------------------------------------------------------------------------
// 杂谈素材：弹幕关键词环 + 外部注入（环境 / 记忆）
// ---------------------------------------------------------------------------
const RECENT_DANMAKU: string[] = []
const ENV_LINES: string[] = []
const MEMORY_LINES: string[] = []

/** 宿主接线：把 persona-core:env 的天气/时间塞进来（没有就不塞，杂谈会退回默认话题） */
export function setEnvLines(lines: string[]): void {
  ENV_LINES.length = 0
  ENV_LINES.push(...lines.filter(Boolean).slice(0, 5))
}

/** 宿主接线：把内心戏 / 最近记忆塞进来当吐槽素材 */
export function setMemoryLines(lines: string[]): void {
  MEMORY_LINES.length = 0
  MEMORY_LINES.push(...lines.filter(Boolean).slice(0, 5))
}

/** 记一条弹幕原文，供"缝合流"取词 */
export function noteDanmaku(text: string): void {
  const s = (text || '').trim()
  if (!s) return
  RECENT_DANMAKU.push(s)
  if (RECENT_DANMAKU.length > 20) RECENT_DANMAKU.shift()
}

/**
 * 从最近弹幕里挑高频词：中文没做分词，用「2~4 字 n-gram 在几条不同弹幕里重复出现」来近似。
 * 只靠切标点会把「原神好玩吗」整句当成一个词，那样缝合就变成复读了。
 */
export function recentDanmakuWords(limit = 3): string[] {
  const seen = new Map<string, Set<number>>()
  RECENT_DANMAKU.forEach((text, idx) => {
    const runs = text.split(/[^\u4e00-\u9fa5A-Za-z0-9]+/).filter((r) => r.length >= 2)
    for (const run of runs) {
      for (let len = 2; len <= 4; len++) {
        for (let i = 0; i + len <= run.length; i++) {
          const gram = run.slice(i, i + len)
          if (/^[0-9]+$/.test(gram)) continue
          if (!seen.has(gram)) seen.set(gram, new Set())
          seen.get(gram)!.add(idx)
        }
      }
    }
  })
  const ranked = [...seen.entries()]
    .filter(([, ids]) => ids.size >= 2) // 至少在两条不同弹幕里出现过
    .sort((a, b) => b[1].size - a[1].size || b[0].length - a[0].length)
  const picked: string[] = []
  for (const [gram] of ranked) {
    if (picked.some((p) => p.includes(gram) || gram.includes(p))) continue // 去掉互相包含的
    picked.push(gram)
    if (picked.length >= limit) break
  }
  return picked
}

/**
 * 纯函数：组装杂谈提示词（导出供测试断言）。
 * 规则来自用户对直播的要求：像水友群聊天、能自己接话、别说教、别总结。
 */
export function buildChitchatPrompt(opts: {
  topic: string
  envLines?: string[]
  memoryLines?: string[]
  danmakuWords?: string[]
}): string {
  const parts: string[] = []
  parts.push(`你现在在直播间杂谈，没有任何人发弹幕。顺手抛出的由头是「${opts.topic}」。`)
  if (opts.envLines?.length) parts.push(`环境/时间：${opts.envLines.join('；')}`)
  if (opts.memoryLines?.length) parts.push(`你脑子里刚冒出来的事：${opts.memoryLines.join('；')}`)
  if (opts.danmakuWords?.length) parts.push(`刚才弹幕里出现过这些词：${opts.danmakuWords.join('、')}`)
  parts.push(
    '要求：' +
      '① 60~120 字，一口气说完，别只丢一句就停；' +
      '② 顺着上一句的末尾自然延展话题，最后抛一个问题给观众；' +
      '③ 口语，允许「其实吧」「然后呢」「你们知道吗」这类语气词，可以主观，甚至双标；' +
      '④ 禁止总结陈词（比如「所以综上所述」「总之」），你不是在开讲座，是在水友群聊天；' +
      '⑤ 弹幕里那词如果出现，用「诶，刚好说到这个」这种句式缝进来，不要生硬改口。',
  )
  return parts.join('\n')
}

function speak(text: string, meta: Record<string, unknown> = {}): void {
  console.log(`${LOG_TAG} 🔊 speak：${text}`, Object.keys(meta).length ? meta : '')
  director?.markInteraction()
  // 推给总控面板：让面板的弹幕流里出现她真实说的这句（面板没开时静默失败）
  reportEventNoWait({ type: 'chat_reply', text, user: String(meta?.user ?? ''), meta })
  // 拟声词前置判断：命中叹气/轻笑/哈欠时，TTS 接线后应在语音前插入气口（30ms 交叉淡化）
  void planVoiceFx(text)
  // TODO(模块 5)：调用真实 TTS 服务播放 audio
}

/** 问一次 audio-cover 的拟声词引擎：这句该配哪种气口（失败静默，绝不阻塞播报） */
async function planVoiceFx(text: string): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 500)
  try {
    const r = await fetch(`${AUDIO_COVER_URL}/voice_fx/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    })
    if (!r.ok) return
    const j: any = await r.json()
    if (j?.effect) console.log(`${LOG_TAG} 🎙️ 拟声词建议：${j.effect}（${j.reason}）`)
  } catch {
    /* 服务没起就算了 */
  } finally {
    clearTimeout(timer)
  }
}

/** 实时翻唱命令：`!翻唱 <歌名>` 开唱、`!停唱` 收工（调 audio-cover 微服务 :8005） */
const AUDIO_COVER_URL = (process.env.AUDIO_COVER_URL || 'http://127.0.0.1:8005').replace(/\/$/, '')

async function handleCoverCommand(text: string): Promise<string | null> {
  const t = String(text || '').trim()
  const start = /^[!！]翻唱\s*(.*)$/.exec(t)
  const stop = /^[!！]停唱\s*$/.exec(t)
  if (!start && !stop) return null
  try {
    if (stop) {
      await fetch(`${AUDIO_COVER_URL}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const bgm = await stopBgm()
      console.log(`${LOG_TAG} 🎤 收工，伴奏停止=${bgm.mode}`)
      return '收工！这首歌就唱到这，掌声呢？'
    }
    const song = (start?.[1] || '').trim()
    await fetch(`${AUDIO_COVER_URL}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'bypass', output_device: null }),
    })
    // 伴奏：OBS 可用就走 WebSocket 播媒体源，否则降级 mock 只打日志
    const bgm = await playBgm(song)
    console.log(`${LOG_TAG} 🎤 实时翻唱已开启，歌曲=${song || '未指定'}，伴奏=${bgm.mode}${bgm.file ? ` (${bgm.file})` : ''}${bgm.error ? ` err=${bgm.error}` : ''}`)
    if (song) {
      return bgm.ok ? `《${song}》是吧？来了，我可是练过的！` : `《${song}》伴奏没找到，我就清唱吧！`
    }
    return '开唱！想听什么随便点。'
  } catch (e: any) {
    console.error(`${LOG_TAG} 实时翻唱调用失败：`, e?.message || e)
    return '翻唱设备没连上，等我把它插好再说。'
  }
}

/** 处理 director 产生的 sys_action：按意图生成文案并播报 */
async function handleSysAction(ctx: any, action: SysAction): Promise<void> {
  if (action.type === 'switch_state') {
    const prompt =
      `直播 Rundown 切换环节：从「${STATE_LABEL[action.from]}」进入「${STATE_LABEL[action.to]}」，` +
      `请用一句热情的主播口播宣布进入新环节（不超过 40 字）。`
    const fallback = `好嘞，接下来进入「${STATE_LABEL[action.to]}」环节，大家多多互动哦！`
    const text = await generateReply(ctx, prompt, fallback)
    speak(text, { action: 'switch_state', from: action.from, to: action.to })
    return
  }
  // cold_break
  const prompt = buildChitchatPrompt({
    topic: action.topic,
    envLines: ENV_LINES,
    memoryLines: MEMORY_LINES,
    danmakuWords: recentDanmakuWords(),
  })
  const fallback = `${action.topic} 来聊聊天呀～别让我一个人尬住！`
  const text = await generateReply(ctx, prompt, fallback)
  speak(text, { action: 'cold_break', topic: action.topic })
}

/** 取当前生效的 memory（测试可注入覆盖） */
function getMemory(): MemoryClient | null {
  return memoryClientOverride ?? memoryClient
}
/** 取当前生效的 perception（测试可注入覆盖） */
function getPerception(): Perception | null {
  return perceptionOverride ?? perception
}

/** 队列消费：记忆注入 → 画面感知(按需) → 组装 messages → LLM 生成 → 播报 → 异步存记忆 */
async function consumeDanmaku(ctx: any, item: QueuedItem): Promise<void> {
  const { user, text } = item.msg

  // 0) 实时翻唱命令优先（命中即接管，不进 LLM）
  const coverReply = await handleCoverCommand(text)
  if (coverReply) {
    speak(coverReply, { action: 'audio_cover', user })
    return
  }

  const mem = getMemory()
  const perc = getPerception()

  // 1) 查观众记忆（3s 超时，失败降级为空，不阻塞）
  const userContext = mem ? await mem.getUserContext(user) : ''

  // 2) 命中画面关键词才截屏感知（2s 超时降级，绝不卡死）
  let screenContext = ''
  if (perc && shouldCaptureScreen(text)) {
    screenContext = await perc.captureScreenContext()
  }

  // 3) 组装 LLM 请求（记忆进 System Prompt，画面进 User 上下文）
  const messages = buildChatMessages({ user, text, userContext, screenContext })
  const fallback = `收到「${user}」的「${text}」啦，安排上！`
  const reply = await chatWithMessages(ctx, messages, fallback)

  speak(reply, { priority: item.priority, user, hasMemory: !!userContext, hasScreen: !!screenContext })

  // 4) 异步存入记忆库（fire-and-forget，不阻塞响应）
  mem?.saveUserInteraction(user, text)
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const tools: DshTool[] = [
  {
    name: 'live_director_status',
    description:
      '查询直播导演引擎当前运行状态：弹幕服务是否在跑、队列积压多少条、' +
      '当前 Rundown 状态（director 心跳状态机）。调试直播链路时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          running: { type: 'boolean' },
          port: { type: ['integer', 'null'] },
          queueSize: { type: 'integer' },
          topPriority: { type: ['integer', 'null'] },
          state: { type: 'string' },
          stateLabel: { type: 'string' },
          stateAgeMs: { type: 'integer' },
          idleMs: { type: 'integer' },
        },
      },
      render: (_args: any, value: any) => [
        {
          type: 'text',
          text: value?.running
            ? `🎙️ 直播导演运行中（端口 ${value.port}）｜环节：${value.stateLabel}｜队列积压 ${value.queueSize} 条`
            : `⚠️ 直播导演未在运行`,
        },
      ],
    },
    async execute() {
      const top = danmakuServer?.queue.peek()
      const state = director?.currentState ?? RundownState.CHITCHAT
      return {
        ok: true,
        running: !!danmakuServer,
        port: danmakuServer?.port ?? null,
        queueSize: danmakuServer?.queue.size ?? 0,
        topPriority: top ? top.priority : null,
        state,
        stateLabel: STATE_LABEL[state],
        stateAgeMs: director ? director.stateAgeMs() : 0,
        idleMs: director ? director.idleMs() : 0,
      }
    },
    presentCall() {
      return { card: 'generic', title: 'live_director_status', kind: 'read' }
    },
  },
]

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-live-director',
  async apply(ctx: any) {
    console.log(`${LOG_TAG} apply`)

    // 1) 注册工具
    const disposers: Array<() => void> = []
    for (const t of tools) {
      try {
        const d = ctx.tools.register(t)
        if (typeof d === 'function') disposers.push(d)
        console.log(`${LOG_TAG} 已注册工具 ${t.name}`)
      } catch (e) {
        console.error(`${LOG_TAG} 注册工具 ${t.name} 失败：`, e)
      }
    }

    // 1.5) 初始化记忆客户端（memory-bus :8001）与画面感知（node-screenshots + 视觉模型）
    //      默认走真实服务；测试可通过 __injectForTest 注入 mock。失败均降级，不影响启动。
    memoryClient = memoryClientOverride ?? new MemoryClient()
    perception = perceptionOverride ?? new Perception()

    // 2) 启动 Rundown 状态机 + 心跳（director 独立于弹幕服务，即使弹幕没起来也要跑）
    director = new Director({
      // 杂谈素材：环境/记忆/弹幕词动态拼进话题池（拿不到就是空，退回默认话题）
      sources: {
        env: () => ENV_LINES,
        memory: () => MEMORY_LINES,
        danmaku: () => recentDanmakuWords(3).map((w) => `弹幕里有人在聊「${w}」，你接一句你自己的想法？`),
      },
      onActionNeeded: (action) => {
        void handleSysAction(ctx, action)
      },
    })
    director.start()

    // 3) 启动弹幕 WebSocket 服务（模块 1）
    try {
      danmakuServer = await startDanmakuServer({
        port: DANMAKU_PORT,
        // 每条弹幕到达（放行或拦截）都刷新 director 冷场计时
        onMessage: (_item?: any, msg?: any) => {
          if (msg && typeof msg.text === 'string') noteDanmaku(msg.text)
          director?.markInteraction()
        },
      })
      console.log(
        `${LOG_TAG} 弹幕服务就绪（端口 ${DANMAKU_PORT}），优先级：礼物=${Priority.GIFT} 画图=${Priority.DRAW} 对话=${Priority.CHAT}`,
      )

      // 4) 启动队列消费循环：有弹幕就 LLM 生成 + 播报（串行，TTS 不重叠）
      stopConsume = danmakuServer.queue.consume(async (item) => {
        await consumeDanmaku(ctx, item)
      })
      console.log(`${LOG_TAG} 队列消费者已启动`)
    } catch (e) {
      console.error(`${LOG_TAG} 启动弹幕服务失败（端口 ${DANMAKU_PORT} 可能被占用）：`, e)
    }

    // 5) 清理：必须把所有定时器（director 心跳 + 队列消费）都清掉，避免泄漏
    ctx.on('dispose', () => {
      console.log(`${LOG_TAG} dispose：停止心跳、关闭队列消费、关闭弹幕服务、注销 ${disposers.length} 个工具`)
      director?.stop()
      director = null
      memoryClient = null
      perception = null
      if (stopConsume) {
        try {
          stopConsume()
        } catch {
          /* ignore */
        }
        stopConsume = null
      }
      if (danmakuServer) {
        danmakuServer.close().catch((e) => console.error(`${LOG_TAG} 关闭弹幕服务出错：`, e))
        danmakuServer = null
      }
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* ignore */
        }
      }
    })
  },
}
