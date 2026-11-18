/**
 * test-mood.mjs —— PAD 情绪引擎离线验证
 *
 * 验的是"规则对不对"，不是"感觉像不像"：
 *   默认值 / 时间衰减（白天恢复、深夜扣减）/ 生气惯性 / 亲密度加权 /
 *   情绪标签与表情映射 / prompt 注入文案 / 手写 JSON 的容错
 *
 * 用法：node build.mjs && node test-mood.mjs
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const m = await import(pathToFileURL(join(process.cwd(), 'lib', 'mood.js')).href)
const {
  defaultMood, normalizeMood, applyDecay, applyEvent, detectEvent,
  moodLabel, moodExpression, moodPrompt, isLateNight,
} = m

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps

// ---------- 1. 默认值 ----------
const d = defaultMood(1000)
check('默认 PAD 全 0', d.pleasure === 0 && d.arousal === 0 && d.dominance === 0)
check('默认精力 100', d.energy === 100)
check('默认亲密度 50', d.affection === 50)
check('默认无生气惯性', d.angryTurns === 0)

// ---------- 2. 容错：手写 JSON 乱来也要能读 ----------
const messy = normalizeMood({ pleasure: '0.5', energy: 999, affection: -20, angryTurns: -3 }, 1000)
check('字符串数字能转', near(messy.pleasure, 0.5))
check('精力超界被夹到 100', messy.energy === 100)
check('亲密度负数被夹到 0', messy.affection === 0)
check('负的生气轮数归零', messy.angryTurns === 0)
check('null 输入回落默认', normalizeMood(null, 1000).energy === 100)

// ---------- 3. 时间衰减：白天 vs 深夜 ----------
const HOUR = 3600_000
const noon = new Date(2026, 10, 18, 12, 0, 0).getTime()
const night = new Date(2026, 10, 18, 2, 0, 0).getTime()

check('12 点不算深夜', isLateNight(noon) === false)
check('2 点算深夜', isLateNight(night) === true)

const day = applyDecay({ ...defaultMood(noon - 2 * HOUR), energy: 50 }, noon)
check('白天 2 小时精力 +10', near(day.energy, 60, 0.5), String(day.energy))

const nightDecay = applyDecay({ ...defaultMood(night - 2 * HOUR), energy: 50 }, night)
check('深夜 2 小时精力 -16', near(nightDecay.energy, 34, 0.5), String(nightDecay.energy))

const capped = applyDecay({ ...defaultMood(noon - 100 * HOUR), energy: 90 }, noon)
check('精力上限 100', capped.energy === 100)

// PAD 回归 0：默认 0.25/小时，1 小时回 25%，4 小时全平（情绪不隔夜）
const regress1h = applyDecay({ ...defaultMood(noon - HOUR), pleasure: 1 }, noon)
check('PAD 1 小时回归到约 0.75', near(regress1h.pleasure, 0.75, 0.02), String(regress1h.pleasure))

const regress4h = applyDecay({ ...defaultMood(noon - 4 * HOUR), pleasure: 1 }, noon)
check('PAD 4 小时后归零（情绪不隔夜）', regress4h.pleasure === 0, String(regress4h.pleasure))

// 生气时精力恢复打半折
const angryRecover = applyDecay({ ...defaultMood(noon - 2 * HOUR), energy: 50, angryTurns: 2 }, noon)
check('生气时精力恢复减半（+5 而非 +10）', near(angryRecover.energy, 55, 0.5), String(angryRecover.energy))

// ---------- 4. 情绪事件 ----------
check('识别"谢谢"为正向', detectEvent('谢谢你啊') === 'praise')
check('识别"对不起"为正向', detectEvent('对不起嘛我错了') === 'praise')
check('识别"笨蛋"为负向', detectEvent('你这个笨蛋') === 'insult')
check('识别空串为忽略', detectEvent('') === 'ignore')
check('普通句子为 neutral', detectEvent('今天天气怎么样') === 'neutral')

const base = defaultMood(noon)
const insulted = applyEvent(base, 'insult', noon)
check('被骂愉悦度下降', insulted.pleasure < 0, String(insulted.pleasure))
check('被骂进入 3 轮生气惯性', insulted.angryTurns === 3)
check('被骂亲密度下降', insulted.affection < 50)

const praised = applyEvent(base, 'praise', noon)
check('被夸愉悦度上升', praised.pleasure > 0)
check('被夸亲密度上升', praised.affection > 50)

// 生气惯性：被夸一次只减 1 轮，不会立刻清零
const oneSooth = applyEvent(insulted, 'praise', noon)
check('哄一次只减 1 轮惯性', oneSooth.angryTurns === 2, String(oneSooth.angryTurns))
check('哄一次后仍在生气', oneSooth.pleasure < 0 || oneSooth.angryTurns > 0)

let s = insulted
for (let i = 0; i < 3; i++) s = applyEvent(s, 'praise', noon)
check('哄三次后惯性清零', s.angryTurns === 0)

// 亲密度加权：低亲密度更玻璃心
const lowAff = applyEvent({ ...base, affection: 0 }, 'insult', noon)
const highAff = applyEvent({ ...base, affection: 100 }, 'insult', noon)
check('亲密度低时被骂掉更多愉悦', lowAff.pleasure < highAff.pleasure,
  `${lowAff.pleasure.toFixed(2)} vs ${highAff.pleasure.toFixed(2)}`)

// 每轮掉一点精力
check('每轮对话消耗精力', applyEvent(base, 'neutral', noon).energy < base.energy)

// ---------- 5. 标签与表情映射 ----------
check('精力<20 → 困倦', moodLabel({ ...base, energy: 10 }) === '困倦')
check('困倦 → sleepy 表情', moodExpression({ ...base, energy: 10 }) === 'sleepy')
check('愉悦<-0.35 → 生气', moodLabel({ ...base, pleasure: -0.5 }) === '生气')
check('生气 → pout 表情', moodExpression({ ...base, pleasure: -0.5 }) === 'pout')
check('高亲密+愉悦 → 害羞', moodLabel({ ...base, pleasure: 0.3, affection: 90 }) === '害羞')
check('害羞 → blush 表情', moodExpression({ ...base, pleasure: 0.3, affection: 90 }) === 'blush')
check('高愉悦高唤醒 → 兴奋', moodLabel({ ...base, pleasure: 0.6, arousal: 0.5 }) === '兴奋')
check('平静 → smile 表情', moodExpression({ ...base, pleasure: 0 }) === 'smile')

// 优先级：困倦压过生气（没力气生气）
check('困倦优先于生气', moodLabel({ ...base, energy: 5, pleasure: -0.8 }) === '困倦')

// ---------- 6. prompt 注入 ----------
const p = moodPrompt({ ...base, energy: 10 })
check('prompt 含精力数字', p.includes('精力 10%'))
check('困倦时要求极短回复', p.includes('极短'))
check('prompt 提醒不要念数字', p.includes('不要直接念'))

const pAngry = moodPrompt({ ...base, pleasure: -0.6, angryTurns: 2 })
check('生气时 prompt 要求别立刻原谅', pAngry.includes('不要立刻原谅'))
check('prompt 含剩余轮数', pAngry.includes('还剩 2 轮'))

const pCold = moodPrompt({ ...base, affection: 10 })
check('低亲密度要求客气', pCold.includes('客气'))
const pWarm = moodPrompt({ ...base, affection: 90 })
check('高亲密度允许撒娇', pWarm.includes('撒娇'))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
