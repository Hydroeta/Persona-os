/**
 * test-report-format.mjs —— 四步法汇报格式验证
 *
 * 验证：
 *   1. renderReport 四段齐全、顺序固定
 *   2. 空小节写如实说明（「借力」= 没有参考外部方案），不留白
 *   3. parseSections 能拆回来
 *   4. checkReport 拦得住：缺小节 / 顺序错 / 借力留白
 *   5. saveProposal 会拒绝不合格式的提案
 *
 * 用法：node build.mjs && node test-report-format.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const fmt = await import(pathToFileURL(join(process.cwd(), 'lib', 'report-format.js')).href)
const idx = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href)

const { renderReport, parseSections, checkReport, SECTIONS, SECTION_TITLES, EMPTY_TEXT } = fmt

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---------- 1. 渲染：四段齐全、顺序固定 ----------
const md = renderReport({
  title: '把 painter 冷却改成按用户',
  dings: ['别人画完我就得等 30 秒'],
  shenkan: ['读 director.ts，冷却写在 DrawCooldown 里'],
  jieli: ['参考了 p-limit 的排队思路'],
  shijian: ['改成 Map<user, ts>', '补 3 条单测'],
})

check('四段标题全在', SECTIONS.every(s => md.includes(`## ${SECTION_TITLES[s]}`)))
const order = SECTIONS.map(s => md.indexOf(`## ${SECTION_TITLES[s]}`))
check('顺序是 定向→深挖→借力→实践', order.every((v, i) => i === 0 ? v >= 0 : v > order[i - 1]), order.join(','))
check('标题渲染为 H1', md.startsWith('# 把 painter 冷却改成按用户'))
check('内容点渲染成列表', md.includes('- 别人画完我就得等 30 秒'))
check('合格报告 checkReport 无问题', checkReport(md).length === 0, JSON.stringify(checkReport(md)))

// ---------- 2. 空小节必须如实说明 ----------
const empty = renderReport({ title: '空的' })
check('空「借力」写成"没有参考外部方案"', empty.includes(EMPTY_TEXT['借力']), EMPTY_TEXT['借力'])
check('空「定向」有占位说明', empty.includes(EMPTY_TEXT['定向']))
check('空报告也通过格式校验（占位不算缺）', checkReport(empty).length === 0, JSON.stringify(checkReport(empty)))

// ---------- 3. parseSections ----------
const parsed = parseSections(md)
check('能拆回四段', SECTIONS.every(s => parsed[s].length > 0))
check('拆回的「定向」含原文', parsed['定向'].includes('等 30 秒'))

// ---------- 4. checkReport 拦得住 ----------
const noJieli = renderReport({ title: 'x', dings: ['a'], shenkan: ['b'], shijian: ['c'] })
check('「借力」完全缺失会被拦', checkReport(noJieli.replace(`## ${SECTION_TITLES.借力}`, '')).length > 0)

const wrongOrder = [
  `# t`, '',
  `## ${SECTION_TITLES.深挖}`, 'b', '',
  `## ${SECTION_TITLES.定向}`, 'a', '',
  `## ${SECTION_TITLES.借力}`, 'c', '',
  `## ${SECTION_TITLES.实践}`, 'd', '',
].join('\n')
check('顺序错会被拦', checkReport(wrongOrder).some(p => p.includes('顺序')), JSON.stringify(checkReport(wrongOrder)))

const blankJieli = [
  `# t`, '',
  `## ${SECTION_TITLES.定向}`, 'a', '',
  `## ${SECTION_TITLES.深挖}`, 'b', '',
  `## ${SECTION_TITLES.借力}`, '无', '',
  `## ${SECTION_TITLES.实践}`, 'd', '',
].join('\n')
check('「借力」写"无"会被拦', checkReport(blankJieli).some(p => p.includes('借力')), JSON.stringify(checkReport(blankJieli)))

const missing = `# t\n\n## ${SECTION_TITLES.定向}\n只写了定向\n`
check('缺小节会被拦', checkReport(missing).length >= 3, JSON.stringify(checkReport(missing)))

// ---------- 5. saveProposal 会拒绝不合格式的提案 ----------
const dir = mkdtempSync(join(tmpdir(), 'report-test-'))
try {
  const bad = await idx.saveProposal({ root: dir, title: '不合格式', markdown_content: '随便写点什么内容够二十个字的长度就可以了' })
  check('不合格式的提案被拒', bad.ok === false && /四步法/.test(bad.error || ''), bad.error)

  const good = await idx.saveProposal({ root: dir, title: '合规提案', markdown_content: md })
  check('合格式的提案通过', good.ok === true, JSON.stringify(good))

  const tooShort = await idx.saveProposal({ root: dir, title: '短', markdown_content: '太短' })
  check('太短的仍被拒', tooShort.ok === false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
