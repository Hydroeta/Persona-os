/**
 * report-format.ts —— 四步法汇报格式（定向 / 深挖 / 借力 / 实践）
 *
 * 用途：自进化提案、每日复盘统一按这个骨架写，便于人审批。
 *
 * 为什么单独一个模块而不是在 index.ts 里拼字符串：
 *   模板要能被测试（断言四段齐全、顺序固定、"借力"为空时必须如实说明
 *   而不是留白或编一个假来源）。
 */

export const SECTIONS = ['定向', '深挖', '借力', '实践'] as const
export type Section = (typeof SECTIONS)[number]

export const SECTION_TITLES: Record<Section, string> = {
  定向: '【定向】要解决什么问题',
  深挖: '【深挖】查到了什么',
  借力: '【借力】参考了什么',
  实践: '【实践】打算怎么做',
}

/** 空小节必须如实说明——不许留白，也不许编造 */
export const EMPTY_TEXT: Record<Section, string> = {
  定向: '（还没想清楚要解决什么）',
  深挖: '（没有查阅代码或日志）',
  借力: '没有参考外部方案',
  实践: '（还没决定怎么做）',
}

export interface ReportInput {
  title: string
  dings?: string[]
  shenkan?: string[]
  jieli?: string[]
  shijian?: string[]
}

function bullets(items?: string[]): string {
  const lines = (items ?? []).map((x) => String(x).trim()).filter(Boolean)
  return lines.length ? lines.map((x) => `- ${x}`).join('\n') : ''
}

/** 按四步法渲染一份 Markdown 报告。空的小节写 EMPTY_TEXT 里的如实说明。 */
export function renderReport(input: ReportInput): string {
  const groups: Record<Section, string[] | undefined> = {
    定向: input.dings,
    深挖: input.shenkan,
    借力: input.jieli,
    实践: input.shijian,
  }
  const out: string[] = [`# ${(input.title || '').trim() || '（无标题）'}`, '']
  for (const key of SECTIONS) {
    out.push(`## ${SECTION_TITLES[key]}`)
    const body = bullets(groups[key])
    out.push(body || EMPTY_TEXT[key])
    out.push('')
  }
  return out.join('\n').replace(/\s+$/, '') + '\n'
}

/** 把一份报告拆回四段（用于校验或二次加工）。缺失的小节返回空串。 */
export function parseSections(markdown: string): Record<Section, string> {
  const text = markdown || ''
  const marks: Array<{ idx: number; key: Section }> = []
  for (const key of SECTIONS) {
    const idx = text.indexOf(`## ${SECTION_TITLES[key]}`)
    if (idx >= 0) marks.push({ idx, key })
  }
  marks.sort((a, b) => a.idx - b.idx)

  const found = {} as Record<Section, string>
  for (let i = 0; i < marks.length; i++) {
    const { idx, key } = marks[i]
    const start = idx + `## ${SECTION_TITLES[key]}`.length
    const end = i + 1 < marks.length ? marks[i + 1].idx : text.length
    found[key] = text.slice(start, end).trim()
  }
  for (const key of SECTIONS) {
    if (!(key in found)) found[key] = ''
  }
  return found
}

/** 校验一份报告是否合规，返回问题列表（空数组 = 合格）。 */
export function checkReport(markdown: string): string[] {
  const problems: string[] = []
  const secs = parseSections(markdown)

  for (const key of SECTIONS) {
    if (!secs[key]) problems.push(`缺少「${key}」小节`)
  }

  // 顺序必须固定：定向 → 深挖 → 借力 → 实践
  const present = SECTIONS.filter((k) => (markdown || '').includes(`## ${SECTION_TITLES[k]}`))
  const indices = present.map((k) => ({ k, i: markdown.indexOf(`## ${SECTION_TITLES[k]}`) }))
  indices.sort((a, b) => a.i - b.i)
  const actual = indices.map((x) => x.k)
  if (actual.join(',') !== present.join(',')) {
    problems.push(`小节顺序不对：实际 ${actual.join('→')}，要求 ${present.join('→')}`)
  }

  // 借力为空时必须写明"没有参考"，不许留白或编造
  if (['', '（空）', '无'].includes(secs['借力'])) {
    problems.push('「借力」为空时必须如实写「没有参考外部方案」')
  }

  return problems
}
