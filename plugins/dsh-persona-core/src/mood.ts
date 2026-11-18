/**
 * mood.ts —— PAD 情绪引擎（轻量版，纯本地 JSON，不建微服务）
 *
 * 为什么轻量：
 *   情绪不需要高频更新，一个 JSON + 几条衰减曲线就够；建微服务反而多一个进程要启停。
 *
 * 模型：
 *   PAD 三维（愉悦/唤醒/支配，各 -1~1）+ energy（精力 0~100）+ affection（亲密度 0~100）
 *   · 精力按时间自然恢复；深夜（0~5 点）反过来扣
 *   · 情绪有**惯性**：被惹毛后 3 轮内不会立刻变开心，且精力恢复打半折
 *   · 亲密度决定「被夸/被骂」的影响幅度（亲密度低时更玻璃心，高时更能扛）
 *
 * 持久化：`<插件数据目录>/mood_state.json`
 */

const LOG_TAG = '[dsh-persona-core/mood]'

export interface MoodState {
  /** 愉悦度 -1~1 */
  pleasure: number
  /** 唤醒度 -1~1 */
  arousal: number
  /** 支配度 -1~1 */
  dominance: number
  /** 精力 0~100 */
  energy: number
  /** 亲密度 0~100 */
  affection: number
  /** 最后一次更新时间（ms） */
  updatedAt: number
  /** 生气惯性剩余轮数（>0 表示还在闹脾气） */
  angryTurns: number
  /** 累计对话轮数（用于衰减与统计） */
  turns: number
}

export function defaultMood(now = Date.now()): MoodState {
  return {
    pleasure: 0, arousal: 0, dominance: 0,
    energy: 100, affection: 50,
    updatedAt: now, angryTurns: 0, turns: 0,
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 把任意输入（可能来自手写 JSON）规整成合法状态 */
export function normalizeMood(raw: any, now = Date.now()): MoodState {
  const d = defaultMood(now)
  if (!raw || typeof raw !== 'object') return d
  const num = (v: any, fb: number) => (Number.isFinite(Number(v)) ? Number(v) : fb)
  return {
    pleasure: clamp(num(raw.pleasure, d.pleasure), -1, 1),
    arousal: clamp(num(raw.arousal, d.arousal), -1, 1),
    dominance: clamp(num(raw.dominance, d.dominance), -1, 1),
    energy: clamp(num(raw.energy, d.energy), 0, 100),
    affection: clamp(num(raw.affection, d.affection), 0, 100),
    updatedAt: num(raw.updatedAt, now),
    angryTurns: Math.max(0, Math.floor(num(raw.angryTurns, 0))),
    turns: Math.max(0, Math.floor(num(raw.turns, 0))),
  }
}

// ---------------- 时间衰减 ----------------

/** 深夜（0~5 点）对话会掉精力，白天会恢复 */
export function isLateNight(ts = Date.now()): boolean {
  const h = new Date(ts).getHours()
  return h >= 0 && h < 5
}

export interface DecayOptions {
  /** 每小时精力恢复量（默认 5） */
  energyPerHour?: number
  /** 深夜每小时精力扣减量（默认 8） */
  lateNightPenaltyPerHour?: number
  /** PAD 每小时向 0 回归的比例（默认 0.25） */
  padRegressPerHour?: number
}

/**
 * 按经过的时间推进状态（幂等：可以反复调用，只按 updatedAt 到现在算一次）。
 * 返回新状态，不改原对象。
 */
export function applyDecay(s: MoodState, now = Date.now(), opts: DecayOptions = {}): MoodState {
  const energyPerHour = opts.energyPerHour ?? 5
  const latePerHour = opts.lateNightPenaltyPerHour ?? 8
  const regress = opts.padRegressPerHour ?? 0.25

  const hours = Math.max(0, (now - s.updatedAt) / 3_600_000)
  if (hours < 1e-6) return { ...s, updatedAt: now }

  // 精力：白天恢复、深夜扣减；有生气惯性时恢复打半折
  let energyDelta: number
  if (isLateNight(now)) {
    energyDelta = -latePerHour * hours
  } else {
    energyDelta = energyPerHour * hours
    if (s.angryTurns > 0) energyDelta *= 0.5
  }

  // PAD 向 0 缓慢回归（情绪会淡）
  const k = Math.min(1, regress * hours)
  return {
    ...s,
    energy: clamp(s.energy + energyDelta, 0, 100),
    pleasure: clamp(s.pleasure * (1 - k), -1, 1),
    arousal: clamp(s.arousal * (1 - k), -1, 1),
    dominance: clamp(s.dominance * (1 - k), -1, 1),
    updatedAt: now,
  }
}

// ---------------- 情绪事件 ----------------

export type MoodEvent = 'praise' | 'insult' | 'neutral' | 'ignore' | 'thanks'

/** 从一句话里粗判情绪事件（纯关键词，不用模型；判不准就 neutral） */
export function detectEvent(text: string): MoodEvent {
  const s = String(text || '')
  if (!s.trim()) return 'ignore'
  if (/(对不起|抱歉|我错|别生气|原谅|sorry)/i.test(s)) return 'praise'
  if (/(谢谢|感谢|多谢|爱你|喜欢你|好可爱|真棒|厉害|牛|赞)/i.test(s)) return 'praise'
  if (/(笨蛋|傻|蠢|废物|闭嘴|滚|垃圾|讨厌你|恶心|没用|差劲)/i.test(s)) return 'insult'
  if (/(在吗|在么|喂|嗯|哦|啊)\s*$/.test(s.trim()) && s.trim().length <= 3) return 'ignore'
  return 'neutral'
}

/**
 * 施加一次情绪事件。
 * 亲密度加权：亲密度低时对夸奖/贬低更敏感（玻璃心），高时更能扛。
 */
export function applyEvent(s: MoodState, event: MoodEvent, now = Date.now()): MoodState {
  const out = { ...s, updatedAt: now, turns: s.turns + 1 }
  // 敏感度：亲密度 0 → 1.6 倍；50 → 1.0；100 → 0.6
  const sensitivity = 1.6 - (s.affection / 100) * 1.0

  switch (event) {
    case 'praise':
      out.pleasure = clamp(s.pleasure + 0.25 * (2 - sensitivity), -1, 1)
      out.arousal = clamp(s.arousal + 0.08, -1, 1)
      out.affection = clamp(s.affection + 3, 0, 100)
      // 被夸能缩短生气惯性（哄一次减一轮）
      if (out.angryTurns > 0) out.angryTurns -= 1
      break
    case 'insult':
      out.pleasure = clamp(s.pleasure - 0.45 * sensitivity, -1, 1)
      out.dominance = clamp(s.dominance + 0.15, -1, 1)   // 被骂会硬起来
      out.arousal = clamp(s.arousal + 0.2, -1, 1)
      out.affection = clamp(s.affection - 4 * sensitivity, 0, 100)
      out.angryTurns = 3                                  // 情绪惯性：接下来的 3 轮
      break
    case 'thanks':
      out.pleasure = clamp(s.pleasure + 0.2, -1, 1)
      out.affection = clamp(s.affection + 2, 0, 100)
      if (out.angryTurns > 0) out.angryTurns -= 1
      break
    case 'ignore':
      out.pleasure = clamp(s.pleasure - 0.05, -1, 1)
      break
    default:
      // neutral：只是消耗一点精力的小波动
      out.arousal = clamp(s.arousal * 0.95, -1, 1)
      break
  }

  // 每轮固定掉一点精力（聊天是耗神的）
  out.energy = clamp(out.energy - 0.6, 0, 100)
  return out
}

// ---------------- 状态描述 ----------------

export type MoodLabel = '开心' | '生气' | '困倦' | '害羞' | '平静' | '低落' | '兴奋'

/** 把 PAD + energy 归纳成一个可读的情绪标签 */
export function moodLabel(s: MoodState): MoodLabel {
  if (s.energy < 20) return '困倦'
  if (s.pleasure < -0.35) return '生气'
  if (s.pleasure < -0.1) return '低落'
  if (s.affection > 80 && s.pleasure > 0.2) return '害羞'
  if (s.pleasure > 0.45 && s.arousal > 0.3) return '兴奋'
  if (s.pleasure > 0.2) return '开心'
  return '平静'
}

/** 对应到表情差分文件名（不含 pixel_ 前缀与 .png） */
export function moodExpression(s: MoodState): string {
  if (s.energy < 20) return 'sleepy'
  if (s.pleasure < -0.35) return 'pout'
  if (s.affection > 80 && s.pleasure > 0.2) return 'blush'
  if (s.pleasure > 0.45) return 'joy'
  if (s.pleasure > 0.2) return 'smile'
  return 'smile'
}

/** 注入 system prompt 的那段话 */
export function moodPrompt(s: MoodState): string {
  const label = moodLabel(s)
  const lines: string[] = []
  lines.push('【生理心理状态】（这是你此刻真实的身体与心情，用它调整语气，不要直接念这些数字）')
  lines.push(`- 精力 ${Math.round(s.energy)}%（${s.energy < 20 ? '极度困倦，说不动话' : s.energy < 50 ? '有点累' : '精神还行'}）`)
  lines.push(`- 心情：${label}（愉悦 ${s.pleasure.toFixed(2)} / 唤醒 ${s.arousal.toFixed(2)} / 支配 ${s.dominance.toFixed(2)}）`)
  lines.push(`- 和对方亲密度 ${Math.round(s.affection)}%`)

  if (s.energy < 20) {
    lines.push('- 你困得睁不开眼：回复要**极短**，可以带困意、想睡觉，别长篇大论。')
  }
  if (s.angryTurns > 0) {
    lines.push(`- 你还在生气（还剩 ${s.angryTurns} 轮）：**不要立刻原谅对方**，语气可以冷淡、别扭，但别骂人。`)
  }
  if (s.affection > 80) {
    lines.push('- 你和对方已经很熟了：可以放松、撒娇、偶尔害羞。')
  } else if (s.affection < 25) {
    lines.push('- 你对他还不熟：客气一点，别太热络。')
  }
  return lines.join('\n')
}

export const __testing = { LOG_TAG }
