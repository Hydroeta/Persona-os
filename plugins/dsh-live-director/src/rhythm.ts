/**
 * rhythm.ts —— 说话节奏：思考延迟、分段输出、四步思考链
 *
 * 为什么单独一个模块：
 *   直播里"秒回"和"深思"是冲突的——短弹幕必须秒回，复杂指令才值得停顿。
 *   所以这里只做两件事，都不碰 LLM 调用本身：
 *     1. 判定"这条算不算复杂"（纯规则，不用模型，不费 token）
 *     2. 把整段回复切成短句分批发出去，代替"一口气吐一大段"
 *
 * 诚实原则（用户 2026-11-15 明确要求）：
 *   四步思考链**只在 prompt 里组织回答**，不真的去调 web-agent / autopilot。
 *   所以 [借力] 的文案写"让我回忆一下"，不是"上网搜搜"——后者是假动作。
 */

const LOG_TAG = '[dsh-live-director/rhythm]'

/** 四步思考链的阶段（顺序固定） */
export const THINKING_STAGES = ['定向', '深挖', '借力', '实践'] as const
export type ThinkingStage = (typeof THINKING_STAGES)[number]

/** 每个阶段在前端状态条上显示的文案（必须如实反映真实动作） */
export const STAGE_TEXT: Record<ThinkingStage, string> = {
  定向: '正在理解你的意思…',
  深挖: '让我查查记忆…',
  借力: '让我回忆一下…',        // 真实动作 = 从本地记忆找相似经验，不是上网搜
  实践: '这就动手！',
}

/** 触发"复杂指令"的关键词（命中任一即算复杂） */
export const COMPLEX_KEYWORDS = [
  '画图', '画个', '画一个', '画像',
  '分析', '总结', '梳理', '整理一下',
  '查一下', '查查', '搜一下',
  '写个', '写一个', '帮我做', '帮我写',
  '为什么', '怎么做', '怎么办', '什么原理',
]

export interface ComplexityResult {
  complex: boolean
  /** 命中的原因，便于日志排查 */
  reason: string
}

/**
 * 判定一条弹幕是不是"复杂指令"。
 * 规则（按用户 2026-11-15 拍板）：
 *   · 长度 < 15 字且不含触发词  -> 简单（秒回）
 *   · 长度 >= 20 字            -> 复杂
 *   · 含任一触发词             -> 复杂
 */
export function isComplexInstruction(text: string): ComplexityResult {
  const s = String(text || '').trim()
  if (!s) return { complex: false, reason: '空文本' }

  const hit = COMPLEX_KEYWORDS.find((k) => s.includes(k))
  if (hit) return { complex: true, reason: `含触发词「${hit}」` }

  if (s.length >= 20) return { complex: true, reason: `长度 ${s.length} ≥ 20` }
  if (s.length < 15) return { complex: false, reason: `长度 ${s.length} < 15 且无触发词` }

  // 15~19 字：不算复杂，按短句处理（模糊区间保守选"秒回"）
  return { complex: false, reason: `长度 ${s.length} 在 15~19 之间，按短句处理` }
}

/**
 * 把一段回复切成"可以一句一句蹦出来"的短句。
 * 规则：按中文标点切，太短的并到下一段，太长的再按逗号兜底切。
 * 目的不是分镜，是让字幕一格一格出现，别一次性糊满屏。
 */
export function splitSentence(text: string, minLen = 6, maxLen = 40): string[] {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return []

  // 1) 按句末标点切（保留标点）
  const rough = s.match(/[^。！？!?…]+[。！？!?…]*/g) ?? [s]
  const out: string[] = []
  let buf = ''

  for (const piece of rough) {
    const p = piece.trim()
    if (!p) continue
    buf += p
    // 够长就单独成句；太短先攒着
    if (buf.length >= minLen) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) {
    if (out.length) out[out.length - 1] += buf
    else out.push(buf)
  }

  // 2) 仍有过长的一句，按逗号再兜底切
  const fin: string[] = []
  for (const seg of out) {
    if (seg.length <= maxLen) {
      fin.push(seg)
      continue
    }
    let rest = seg
    while (rest.length > maxLen) {
      const cut = rest.slice(0, maxLen)
      const idx = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf(','), cut.lastIndexOf('、'))
      const take = idx > maxLen * 0.4 ? idx + 1 : maxLen
      fin.push(rest.slice(0, take))
      rest = rest.slice(take)
    }
    if (rest) fin.push(rest)
  }
  return fin.length ? fin : [s]
}

/** 在 [lo, hi] 区间取一个随机毫秒数 */
export function randInt(lo: number, hi: number, rng: () => number = Math.random): number {
  const a = Math.ceil(lo)
  const b = Math.floor(hi)
  return Math.floor(a + rng() * (b - a + 1))
}

/**
 * 若判定为复杂指令，给这次的 user 消息补上一段"四步法"要求。
 * **只在 prompt 里组织回答，不接任何工具**——这是刻意的：直播里不能让一条弹幕触发代码推送。
 */
export function withThinkingChain(userText: string): string {
  return [
    userText,
    '',
    '——（以下是你自己的思考要求，不要念出来，也不要写进回答里）',
    '这条有点复杂，回答前在心里过四步：',
    '1. 定向：对方到底想要什么结果？',
    '2. 深挖：我记忆里有没有相关的背景或之前做过的事？',
    '3. 借力：有没有现成的经验、现成的说法可以借用？',
    '4. 实践：想清楚之后再开口，给一个能落地的回答。',
    '回答要口语、简短，像在直播间说话，不要分点列举，不要念出这四步。',
  ].join('\n')
}

export const __testing = { LOG_TAG }
