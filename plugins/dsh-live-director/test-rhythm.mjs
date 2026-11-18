/**
 * test-rhythm.mjs —— 节奏模块的离线验证
 *
 * 验证四件事：
 *   1. 复杂度判定：短句秒回、长句/触发词走 CoT
 *   2. 切句：按标点切开、太短的并入、太长的按逗号兜底
 *   3. 四步链 prompt：只组织回答，不出现任何工具调用字样
 *   4. 阶段文案：必须是"回忆"不是"上网搜"（诚实原则）
 *
 * 用法：node build.mjs && node test-rhythm.mjs
 */
import {
  isComplexInstruction, splitSentence, randInt, withThinkingChain,
  THINKING_STAGES, STAGE_TEXT,
} from './lib/rhythm.js'

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---------- 1. 复杂度判定 ----------
check('短句「主播好可爱」判为简单', isComplexInstruction('主播好可爱').complex === false)
check('短句「哈哈哈」判为简单', isComplexInstruction('哈哈哈').complex === false)
check('含「画个」判为复杂', isComplexInstruction('画个猫').complex === true)
check('含「画图」判为复杂', isComplexInstruction('帮我画图').complex === true)
check('含「总结」判为复杂', isComplexInstruction('总结一下今天').complex === true)
check('含「为什么」判为复杂', isComplexInstruction('为什么会这样').complex === true)
check('含「查一下」判为复杂', isComplexInstruction('查一下显卡温度').complex === true)
check('长句（≥20字）判为复杂',
  isComplexInstruction('今天天气不错我想问问你最近过得怎么样开心吗').complex === true)
check('空文本判为简单', isComplexInstruction('').complex === false)
check('复杂度返回了原因', isComplexInstruction('画个猫').reason.includes('画个'))

// ---------- 2. 切句 ----------
const s1 = splitSentence('我觉得今天天气挺好的。你呢？要不要出去走走')
check('按句末标点切句', s1.length >= 2, JSON.stringify(s1))
check('每段都不为空', s1.every((x) => x.trim().length > 0))

const s2 = splitSentence('嗯。对。好的')
check('连串短句不会切得太碎', s2.length <= 2, JSON.stringify(s2))

const long = '这是一段很长很长的回复需要被切开否则会一次性糊满整个屏幕所以要按照逗号兜底把它切成若干尽量短的小块方便一句一句蹦出来'
const s3 = splitSentence(long, 6, 30)
check('超长句按逗号兜底切', s3.length >= 2, `切成 ${s3.length} 段`)
check('每段长度不超过上限留余量', s3.every((x) => x.length <= 34), JSON.stringify(s3.map((x) => x.length)))

check('空字符串切句返回空数组', splitSentence('').length === 0)

// ---------- 3. 四步链 prompt ----------
const p = withThinkingChain('帮我总结一下今天')
check('prompt 含四步标题', ['定向', '深挖', '借力', '实践'].every((k) => p.includes(k)))
check('prompt 明确"不要念出来"', p.includes('不要念出来'))
check('prompt 不含工具调用字样', !/autopilot|web-agent|调用工具/.test(p), p.slice(0, 60))
check('prompt 保留原问题', p.startsWith('帮我总结一下今天'))

// ---------- 4. 阶段文案诚实性 ----------
check('四个阶段齐全', THINKING_STAGES.length === 4)
check('借力文案是"回忆"不是"搜索"',
  STAGE_TEXT['借力'].includes('回忆') && !/搜|上网|查资料/.test(STAGE_TEXT['借力']),
  STAGE_TEXT['借力'])
check('每个阶段都有文案', THINKING_STAGES.every((s) => !!STAGE_TEXT[s]))

// ---------- 5. 随机延迟区间 ----------
const samples = Array.from({ length: 200 }, () => randInt(1500, 4000))
check('思考延迟在 1500~4000ms 内', samples.every((v) => v >= 1500 && v <= 4000),
  `min=${Math.min(...samples)} max=${Math.max(...samples)}`)
const seg = Array.from({ length: 200 }, () => randInt(500, 1500))
check('分段间隔在 500~1500ms 内', seg.every((v) => v >= 500 && v <= 1500),
  `min=${Math.min(...seg)} max=${Math.max(...seg)}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
