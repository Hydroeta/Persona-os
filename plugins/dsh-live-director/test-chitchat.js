/**
 * test-chitchat.js —— 杂谈能力（话题池 / 话题链 / 弹幕缝合 / 反说教）离线验证
 * 不连 LLM、不连 TTS，只校验提示词与状态机的行为。
 * 运行：node build.mjs && node test-chitchat.js
 */
import { Director } from './lib/director.js'
import { buildChitchatPrompt, noteDanmaku, recentDanmakuWords } from './lib/index.js'

let pass = 0
let fail = 0
function assert(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---------- 1) 弹幕关键词抽取 ----------
noteDanmaku('主播你会画原神吗')
noteDanmaku('原神好玩吗')
noteDanmaku('端午节吃粽子了吗')
const words = recentDanmakuWords(3)
assert('从弹幕抽高频词（原神 应排第一）', words[0] === '原神', words.join(','))
assert('抽词数量不超过 limit', words.length <= 3, String(words.length))

// ---------- 2) 杂谈提示词 ----------
const p1 = buildChitchatPrompt({ topic: '今天天气' })
assert('提示词要求长度 60~120 字', p1.includes('60~120'))
assert('提示词要求抛出问题', p1.includes('抛一个问题'))
assert('提示词禁止总结陈词（反说教）', p1.includes('禁止总结陈词') || p1.includes('综上所述'))
assert('提示词要求口语语气词', p1.includes('其实吧'))

const p2 = buildChitchatPrompt({
  topic: '端午',
  envLines: ['上海 17 度小雨'],
  memoryLines: ['昨天被大头怪虐了半小时'],
  danmakuWords: ['原神', '粽子'],
})
assert('环境行注入', p2.includes('上海 17 度小雨'))
assert('记忆行注入', p2.includes('大头怪'))
assert('弹幕词注入', p2.includes('原神') && p2.includes('粽子'))
assert('有弹幕词时要求缝合句式', p2.includes('刚好说到这个'))

// ---------- 3) 冷场话题来自动态源、且不连续重复 ----------
const breaks = []
let envCalls = 0
const director = new Director({
  durationOverrideMs: 60 * 60 * 1000, // 不让状态切换干扰
  coldThresholdMs: 1000,
  tickIntervalMs: 200,
  sources: {
    env: () => {
      envCalls++
      return ['外面在下雨，你带伞了吗']
    },
    memory: () => ['主人刚才把代码又写崩了'],
    danmaku: () => recentDanmakuWords(2).map((w) => `有人在聊「${w}」`),
  },
  onActionNeeded: (a) => {
    if (a.type === 'cold_break') breaks.push(a.topic)
  },
})

// 模拟 3 分钟冷场：tick 每 1s 一次（冷场阈值 1s，所以每次都会开口）
let t = Date.now()
for (let i = 0; i < 180; i++) {
  t += 1000
  director.tick(t)
}
assert('3 分钟冷场能持续自己开口（≥3 次）', breaks.length >= 3, `${breaks.length} 次`)
assert('话题来自动态源（环境/记忆/弹幕）', breaks.some((b) => b.includes('下雨') || b.includes('代码') || b.includes('有人聊')), breaks[0] || '(空)')
assert('不连续重复同一话题', breaks.every((b, i) => i === 0 || b !== breaks[i - 1]))
assert('环境源被真正调用', envCalls > 0, `env 调用 ${envCalls} 次`)
director.stop()

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
