import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/director.ts
var LOG_TAG = "[dsh-live-director:director]";
var RundownState = /* @__PURE__ */ ((RundownState2) => {
  RundownState2["CHITCHAT"] = "CHITCHAT";
  RundownState2["GUESSING"] = "GUESSING";
  RundownState2["FREE_STYLE"] = "FREE_STYLE";
  return RundownState2;
})(RundownState || {});
var STATE_DURATIONS_MS = {
  ["CHITCHAT" /* CHITCHAT */]: 3 * 6e4,
  // 3 分钟
  ["GUESSING" /* GUESSING */]: 5 * 6e4,
  // 5 分钟
  ["FREE_STYLE" /* FREE_STYLE */]: 5 * 6e4
  // 5 分钟
};
var STATE_ORDER = [
  "CHITCHAT" /* CHITCHAT */,
  "GUESSING" /* GUESSING */,
  "FREE_STYLE" /* FREE_STYLE */
];
var STATE_LABEL = {
  ["CHITCHAT" /* CHITCHAT */]: "\u95F2\u804A",
  ["GUESSING" /* GUESSING */]: "\u4F60\u753B\u6211\u731C",
  ["FREE_STYLE" /* FREE_STYLE */]: "\u81EA\u7531\u70B9\u5355"
};
var DEFAULT_TOPICS = [
  "\u4ECA\u5929\u5929\u6C14\u771F\u4E0D\u9519\uFF0C\u5927\u5BB6\u90A3\u8FB9\u600E\u4E48\u6837\uFF1F",
  "\u4F60\u4EEC\u5E73\u65F6\u559C\u6B22\u73A9\u4EC0\u4E48\u6E38\u620F\uFF1F",
  "\u6700\u8FD1\u6709\u6CA1\u6709\u5728\u8FFD\u4EC0\u4E48\u5267\u6216\u8005\u756A\uFF1F",
  "\u6765\u804A\u804A\u4F60\u4EEC\u6700\u559C\u6B22\u7684\u4E00\u9996\u6B4C\u5427\uFF5E",
  "\u5927\u5BB6\u4ECA\u5929\u90FD\u5403\u4E86\u4EC0\u4E48\u597D\u5403\u7684\uFF1F",
  "\u6709\u6CA1\u6709\u4EC0\u4E48\u60F3\u8BA9\u6211\u753B\u7684\u9898\u6750\uFF1F",
  "\u6700\u8FD1\u6709\u6CA1\u6709\u9047\u5230\u4EC0\u4E48\u6709\u8DA3\u7684\u4E8B\uFF1F",
  "\u6765\u4E2A\u4EBA\u8DDF\u6211\u804A\u804A\u5929\u5440\uFF0C\u522B\u8BA9\u6211\u4E00\u4E2A\u4EBA\u5C2C\u4F4F\uFF5E"
];
var DEFAULT_COLD_THRESHOLD_MS = 12e4;
var DEFAULT_TICK_INTERVAL_MS = 2e4;
var Director = class {
  constructor(opts = {}) {
    this.opts = opts;
    const now = Date.now();
    this.stateStartedAt = now;
    this.lastInteractionTime = now;
  }
  /** 当前 Rundown 状态（只读展示用，切换走内部逻辑） */
  currentState = "CHITCHAT" /* CHITCHAT */;
  stateStartedAt;
  lastInteractionTime;
  timer = null;
  topicIndex = 0;
  recentTopics = [];
  /** 启动心跳定时器（每 tickIntervalMs 跑一次 tick）。重复调用安全。 */
  start() {
    if (this.timer) return;
    const intervalMs = this.opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.timer = setInterval(() => this.tick(), intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    console.log(
      `${LOG_TAG} \u5FC3\u8DF3\u5DF2\u542F\u52A8\uFF1A\u72B6\u6001=${this.currentState}\uFF08${STATE_LABEL[this.currentState]}\uFF09\uFF0Ctick=${intervalMs}ms\uFF0C\u51B7\u573A\u9608\u503C=${this.opts.coldThresholdMs ?? DEFAULT_COLD_THRESHOLD_MS}ms`
    );
  }
  /** 停止心跳定时器。dispose 时必须调用，否则定时器泄漏。 */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log(`${LOG_TAG} \u5FC3\u8DF3\u5DF2\u505C\u6B62`);
    }
  }
  /** 是否正在运行 */
  get running() {
    return this.timer !== null;
  }
  /**
   * 外部刷新“最近互动时间”：
   *   - 收到弹幕（无论是否入队）时调用
   *   - 主动发言（LLM 生成并播报 / 心跳搭话）后调用
   * 避免刚互动完又立刻触发冷场。
   */
  markInteraction(now = Date.now()) {
    this.lastInteractionTime = now;
  }
  /** 当前状态已运行时长（ms） */
  stateAgeMs(now = Date.now()) {
    return now - this.stateStartedAt;
  }
  /** 距上次互动的空闲时长（ms） */
  idleMs(now = Date.now()) {
    return now - this.lastInteractionTime;
  }
  /**
   * 一次心跳：先检查状态切换，再检查冷场。
   * 注意：切换状态会重置 stateStartedAt 与 lastInteractionTime，
   *       避免新环节刚开场就被判定冷场。
   */
  tick(now = Date.now()) {
    const maxDuration = this.opts.durationOverrideMs ?? STATE_DURATIONS_MS[this.currentState];
    const age = now - this.stateStartedAt;
    if (age >= maxDuration) {
      const idx = STATE_ORDER.indexOf(this.currentState);
      const next = STATE_ORDER[(idx + 1) % STATE_ORDER.length];
      const from = this.currentState;
      this.currentState = next;
      this.stateStartedAt = now;
      this.lastInteractionTime = now;
      console.log(
        `${LOG_TAG} \u72B6\u6001\u5207\u6362\uFF1A${from}\uFF08${STATE_LABEL[from]}\uFF09\u2192 ${next}\uFF08${STATE_LABEL[next]}\uFF09\uFF08\u8FD0\u884C ${age}ms \u8FBE\u5230\u9608\u503C ${maxDuration}ms\uFF09`
      );
      this.opts.onActionNeeded?.({ type: "switch_state", from, to: next });
      return;
    }
    const coldThreshold = this.opts.coldThresholdMs ?? DEFAULT_COLD_THRESHOLD_MS;
    const idle = now - this.lastInteractionTime;
    if (idle >= coldThreshold) {
      const topic = this.pickTopic();
      this.lastInteractionTime = now;
      console.log(`${LOG_TAG} \u51B7\u573A\u642D\u8BDD\uFF1Aidle=${idle}ms \u2265 ${coldThreshold}ms\uFF0C\u8BDD\u9898\u300C${topic}\u300D`);
      this.opts.onActionNeeded?.({ type: "cold_break", topic });
    }
  }
  /** 取下一条话题：动态源优先（环境→记忆→弹幕），再轮询默认池，且避开最近用过的 */
  pickTopic() {
    const pool = [];
    const safe = (fn) => {
      if (!fn) return [];
      try {
        return (fn() || []).filter((s) => typeof s === "string" && s.trim().length > 0);
      } catch {
        return [];
      }
    };
    pool.push(...safe(this.opts.sources?.env));
    pool.push(...safe(this.opts.sources?.memory));
    pool.push(...safe(this.opts.sources?.danmaku));
    const dynamicCount = pool.length;
    pool.push(...this.opts.topics && this.opts.topics.length > 0 ? this.opts.topics : DEFAULT_TOPICS);
    const fresh = pool.filter((t) => !this.recentTopics.includes(t));
    const candidates = fresh.length > 0 ? fresh : pool;
    const topic = candidates[this.topicIndex % candidates.length];
    this.topicIndex++;
    this.recentTopics.push(topic);
    if (this.recentTopics.length > 3) this.recentTopics.shift();
    if (dynamicCount > 0) {
      console.log(`${LOG_TAG} \u8BDD\u9898\u6E90\uFF1A\u52A8\u6001 ${dynamicCount} \u6761\uFF08\u73AF\u5883/\u8BB0\u5FC6/\u5F39\u5E55\uFF09\uFF0C\u5019\u9009\u6C60 ${pool.length} \u6761`);
    }
    return topic;
  }
  /** 最近说过的话题（测试用） */
  get lastTopics() {
    return [...this.recentTopics];
  }
};
export {
  Director,
  LOG_TAG,
  RundownState,
  STATE_DURATIONS_MS,
  STATE_LABEL,
  STATE_ORDER
};
//# sourceMappingURL=director.js.map
