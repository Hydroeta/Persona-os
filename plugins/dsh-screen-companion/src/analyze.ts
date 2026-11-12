/**
 * analyze.ts —— 读屏陪伴的纯逻辑（不碰屏幕、不碰网络，便于单测）
 *
 * 职责：
 *   1. 解析视觉模型返回的「在干什么 / 情绪」两行结果
 *   2. 根据最近若干次观察 + 当日已关心次数，决定「要不要开口」
 *   3. 生成一句关心的话（模板，避免每次都一样）
 */

export interface Observation {
  /** 观察时间（ms） */
  ts: number
  /** 用户在干什么，如「写代码」「看视频」「打游戏」 */
  activity: string
  /** 情绪，如「专注」「焦虑」「轻松」 */
  mood: string
  /** 画面里是否有报错（Error/Exception/Traceback 等） */
  hasError: boolean
}

export interface CareDecision {
  care: boolean
  reason: string
  /** 触发类型，便于测试与日志 */
  kind?: 'error_anxious' | 'long_focus' | 'none'
}

export const MAX_CARE_PER_DAY = 3

/** 从视觉模型原文里抠出 activity / mood / hasError（模型不一定严格照格式，尽量宽容） */
export function parseVlmReply(raw: string): { activity: string; mood: string; hasError: boolean } {
  const text = (raw || '').trim()
  const grab = (label: RegExp) => {
    const m = text.match(label)
    return m ? m[1].trim() : ''
  }
  let activity = grab(/(?:在干什么|做什么|activity)\s*[:：]\s*([^\n,，。;；]+)/i)
  let mood = grab(/(?:情绪|心情|mood)\s*[:：]\s*([^\n,，。;；]+)/i)
  if (!activity && !mood) {
    // 模型只回了一句话时：前半当活动、后半当情绪；至少把原文留住
    const seg = text.split(/[，,。;；\n]/).map((s) => s.trim()).filter(Boolean)
    activity = seg[0] || '未知'
    mood = seg[1] || '未知'
  }
  const hasError =
    /(error|exception|traceback|failed|报错|异常|错误)/i.test(text) ||
    /失败|崩了|无法/i.test(text)
  return { activity: activity.slice(0, 20), mood: mood.slice(0, 12), hasError }
}

/** 判定是否长时间（默认 2 小时）持续在工作类活动 */
export function isLongFocus(obs: Observation[], now: number, hours = 2): boolean {
  const windowMs = hours * 3600_000
  // 回看窗口要略大于 2 小时：正好卡在 2 小时前的那条观察不能被过滤掉，否则永远凑不满跨度
  const lookback = windowMs * 1.2
  const recent = obs.filter((o) => now - o.ts <= lookback)
  if (recent.length < 2) return false
  const span = now - recent[0].ts
  if (span < windowMs) return false // 观察窗口本身还没覆盖够长
  return recent.every((o) => /写代码|工作|文档|表格|编程|代码/.test(o.activity))
}

/**
 * 决定要不要关心。
 * 规则（刻意保守）：
 *   - 每天最多 3 次
 *   - 两次关心之间至少 45 分钟
 *   - 触发条件二选一：① 画面有报错且情绪焦虑；② 连续 2 小时都在工作类活动
 */
export function decideCare(opts: {
  observations: Observation[]
  now: number
  lastCareAt: number
  careCountToday: number
}): CareDecision {
  const { observations, now, lastCareAt, careCountToday } = opts
  if (careCountToday >= MAX_CARE_PER_DAY) return { care: false, reason: '今天已经关心过 3 次', kind: 'none' }
  if (lastCareAt && now - lastCareAt < 45 * 60_000) {
    return { care: false, reason: '距上次关心不足 45 分钟', kind: 'none' }
  }
  const last = observations[observations.length - 1]
  if (!last) return { care: false, reason: '还没有观察数据', kind: 'none' }

  if (last.hasError && /焦虑|烦躁|急|崩溃|emo/i.test(last.mood)) {
    return { care: true, reason: `画面有报错且情绪「${last.mood}」`, kind: 'error_anxious' }
  }
  if (isLongFocus(observations, now)) {
    return { care: true, reason: '连续 2 小时都在工作', kind: 'long_focus' }
  }
  return { care: false, reason: '没有触发条件', kind: 'none' }
}

const ERROR_LINES = [
  '这个报错我看了一会儿了，先喝口水再回来？',
  '卡这么久还盯着屏幕，眼睛先歇一下。',
  '那段报错红得比你脸还红，先别急。',
]
const LONG_LINES = [
  '两个钟头了，起来动动吧，我又不会跑。',
  '坐太久了，腰会抗议的。',
  '你已经写了很久了，歇十分钟不耽误事。',
]

/** 生成一句话（按触发类型 + 轮换，避免每次一样） */
export function careLine(kind: CareDecision['kind'], seed = Date.now()): string {
  const pool = kind === 'error_anxious' ? ERROR_LINES : LONG_LINES
  return pool[Math.abs(seed) % pool.length]
}
