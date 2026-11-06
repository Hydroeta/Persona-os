/**
 * dsh-live-director · 模块 2：Rundown 状态机与主动心跳
 *
 * 职责（严格对照架构指令，本模块只产生“意图”，不直接调 LLM/TTS）：
 *   1. 维护 Rundown 状态机：CHITCHAT(闲聊 3min) → GUESSING(你画我猜 5min) → FREE_STYLE(自由点单 5min) → 循环
 *   2. start() 启动 setInterval 每 20s 跑一次 tick()；stop() 必须 clearInterval（dispose 时调用）
 *   3. tick() 两种触发：
 *        - 状态超时 → 切下一状态，回调 onActionNeeded({ type:'switch_state', from, to })
 *        - 冷场（Date.now() - lastInteractionTime > 120s）→ 抽话题，回调 onActionNeeded({ type:'cold_break', topic })
 *   4. 暴露 markInteraction()，供外部在“收到弹幕 / 主动发言”时刷新 lastInteractionTime
 *
 * 解耦：具体生成什么文案、用哪个模型，由 index.ts 在 onActionNeeded 回调里调 LLM 决定。
 * 测试提速：构造参数支持 durationOverrideMs / coldThresholdMs / tickIntervalMs 覆盖，让原本 3 分钟的切换几秒跑完。
 */

export const LOG_TAG = '[dsh-live-director:director]'

// ---------------------------------------------------------------------------
// 状态定义
// ---------------------------------------------------------------------------

export enum RundownState {
  CHITCHAT = 'CHITCHAT', // 闲聊
  GUESSING = 'GUESSING', // 你画我猜
  FREE_STYLE = 'FREE_STYLE', // 自由点单
}

/** 各状态的最大运行时长（ms），超时自动流转 */
export const STATE_DURATIONS_MS: Record<RundownState, number> = {
  [RundownState.CHITCHAT]: 3 * 60_000, // 3 分钟
  [RundownState.GUESSING]: 5 * 60_000, // 5 分钟
  [RundownState.FREE_STYLE]: 5 * 60_000, // 5 分钟
}

/** 状态流转顺序（到末尾后循环回开头） */
export const STATE_ORDER: RundownState[] = [
  RundownState.CHITCHAT,
  RundownState.GUESSING,
  RundownState.FREE_STYLE,
]

/** 中文展示名（日志/状态工具用） */
export const STATE_LABEL: Record<RundownState, string> = {
  [RundownState.CHITCHAT]: '闲聊',
  [RundownState.GUESSING]: '你画我猜',
  [RundownState.FREE_STYLE]: '自由点单',
}

// ---------------------------------------------------------------------------
// sys_action 意图（director 只产出意图，文案由 index.ts 的 LLM 生成）
// ---------------------------------------------------------------------------

export interface SysActionSwitchState {
  type: 'switch_state'
  from: RundownState
  to: RundownState
}

export interface SysActionColdBreak {
  type: 'cold_break'
  topic: string
}

export type SysAction = SysActionSwitchState | SysActionColdBreak

// ---------------------------------------------------------------------------
// 话题池（冷场搭话时随机抽一条）
// ---------------------------------------------------------------------------

const DEFAULT_TOPICS = [
  '今天天气真不错，大家那边怎么样？',
  '你们平时喜欢玩什么游戏？',
  '最近有没有在追什么剧或者番？',
  '来聊聊你们最喜欢的一首歌吧～',
  '大家今天都吃了什么好吃的？',
  '有没有什么想让我画的题材？',
  '最近有没有遇到什么有趣的事？',
  '来个人跟我聊聊天呀，别让我一个人尬住～',
]

// ---------------------------------------------------------------------------
// Director 选项
// ---------------------------------------------------------------------------

export interface DirectorOptions {
  /** director 产生 sys_action 时的回调（index.ts 里调 LLM 生成文案 + TTS 播报） */
  onActionNeeded?: (action: SysAction) => void
  /** 测试提速：覆盖所有状态的 maxDurationMs（如 1500 让切换 1.5s 发生） */
  durationOverrideMs?: number
  /** 冷场阈值，默认 120000（2 分钟）；测试可传 1200 */
  coldThresholdMs?: number
  /** tick 间隔，默认 20000（20s）；测试可传 300 */
  tickIntervalMs?: number
  /** 自定义话题池（不传用内置） */
  topics?: string[]
}

const DEFAULT_COLD_THRESHOLD_MS = 120_000
const DEFAULT_TICK_INTERVAL_MS = 20_000

// ---------------------------------------------------------------------------
// Director
// ---------------------------------------------------------------------------

export class Director {
  /** 当前 Rundown 状态（只读展示用，切换走内部逻辑） */
  currentState: RundownState = RundownState.CHITCHAT

  private stateStartedAt: number
  private lastInteractionTime: number
  private timer: NodeJS.Timeout | null = null
  private topicIndex = 0

  constructor(private readonly opts: DirectorOptions = {}) {
    const now = Date.now()
    this.stateStartedAt = now
    this.lastInteractionTime = now
  }

  /** 启动心跳定时器（每 tickIntervalMs 跑一次 tick）。重复调用安全。 */
  start(): void {
    if (this.timer) return
    const intervalMs = this.opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.timer = setInterval(() => this.tick(), intervalMs)
    // unref：不阻塞事件循环退出（测试结束 / 进程关闭时不挂起）
    if (typeof this.timer.unref === 'function') this.timer.unref()
    console.log(
      `${LOG_TAG} 心跳已启动：状态=${this.currentState}（${STATE_LABEL[this.currentState]}）` +
        `，tick=${intervalMs}ms，冷场阈值=${this.opts.coldThresholdMs ?? DEFAULT_COLD_THRESHOLD_MS}ms`,
    )
  }

  /** 停止心跳定时器。dispose 时必须调用，否则定时器泄漏。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      console.log(`${LOG_TAG} 心跳已停止`)
    }
  }

  /** 是否正在运行 */
  get running(): boolean {
    return this.timer !== null
  }

  /**
   * 外部刷新“最近互动时间”：
   *   - 收到弹幕（无论是否入队）时调用
   *   - 主动发言（LLM 生成并播报 / 心跳搭话）后调用
   * 避免刚互动完又立刻触发冷场。
   */
  markInteraction(now: number = Date.now()): void {
    this.lastInteractionTime = now
  }

  /** 当前状态已运行时长（ms） */
  stateAgeMs(now: number = Date.now()): number {
    return now - this.stateStartedAt
  }

  /** 距上次互动的空闲时长（ms） */
  idleMs(now: number = Date.now()): number {
    return now - this.lastInteractionTime
  }

  /**
   * 一次心跳：先检查状态切换，再检查冷场。
   * 注意：切换状态会重置 stateStartedAt 与 lastInteractionTime，
   *       避免新环节刚开场就被判定冷场。
   */
  tick(now: number = Date.now()): void {
    // 1) 状态超时 → 切下一状态
    const maxDuration = this.opts.durationOverrideMs ?? STATE_DURATIONS_MS[this.currentState]
    const age = now - this.stateStartedAt
    if (age >= maxDuration) {
      const idx = STATE_ORDER.indexOf(this.currentState)
      const next = STATE_ORDER[(idx + 1) % STATE_ORDER.length]
      const from = this.currentState
      this.currentState = next
      this.stateStartedAt = now
      this.lastInteractionTime = now // 新环节开场，重置冷场计时
      console.log(
        `${LOG_TAG} 状态切换：${from}（${STATE_LABEL[from]}）→ ${next}（${STATE_LABEL[next]}）` +
          `（运行 ${age}ms 达到阈值 ${maxDuration}ms）`,
      )
      this.opts.onActionNeeded?.({ type: 'switch_state', from, to: next })
      // 切换后本 tick 不再判定冷场（已重置 idle=0）
      return
    }

    // 2) 冷场 → 抽话题搭话
    const coldThreshold = this.opts.coldThresholdMs ?? DEFAULT_COLD_THRESHOLD_MS
    const idle = now - this.lastInteractionTime
    if (idle >= coldThreshold) {
      const topic = this.pickTopic()
      this.lastInteractionTime = now // 避免下个 tick 重复触发
      console.log(`${LOG_TAG} 冷场搭话：idle=${idle}ms ≥ ${coldThreshold}ms，话题「${topic}」`)
      this.opts.onActionNeeded?.({ type: 'cold_break', topic })
    }
  }

  /** 取下一条话题（轮询，保证不连续重复同一句） */
  private pickTopic(): string {
    const pool = this.opts.topics && this.opts.topics.length > 0 ? this.opts.topics : DEFAULT_TOPICS
    const topic = pool[this.topicIndex % pool.length]
    this.topicIndex++
    return topic
  }
}
