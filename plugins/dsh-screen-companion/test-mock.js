/**
 * test-mock.js —— 读屏陪伴的离线验证（不截屏、不连视觉模型、不打扰用户）
 * 运行：node build.mjs && node test-mock.js
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseVlmReply, decideCare, isLongFocus, careLine, MAX_CARE_PER_DAY } from './lib/analyze.js'
import { Companion, VLM_PROMPT } from './lib/index.js'

const HEARTBEAT = join(tmpdir(), 'dsh-screen-indicator.heartbeat')
const STATE = join(tmpdir(), 'dsh-screen-companion-state.json')

let pass = 0
let fail = 0
function assert(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

function touchHeartbeat() {
  writeFileSync(HEARTBEAT, String(Date.now()))
  const t = new Date()
  utimesSync(HEARTBEAT, t, t)
}

// ---------- 1) 解析视觉模型输出 ----------
const p1 = parseVlmReply('在干什么: 写代码\n情绪: 焦虑\n画面里有大段红色报错')
assert('解析出「在干什么」', p1.activity.includes('写代码'), p1.activity)
assert('解析出「情绪」', p1.mood.includes('焦虑'), p1.mood)
assert('识别出有报错', p1.hasError)

const p2 = parseVlmReply('写代码，专注')
assert('模型不按格式也能兜住', p2.activity.length > 0 && p2.mood.length > 0, `${p2.activity}/${p2.mood}`)

// ---------- 2) 要不要关心 ----------
const now = Date.now()
const anxious = [{ ts: now, activity: '写代码', mood: '焦虑', hasError: true }]
const d1 = decideCare({ observations: anxious, now, lastCareAt: 0, careCountToday: 0 })
assert('报错+焦虑 → 触发关心', d1.care && d1.kind === 'error_anxious', d1.reason)

const calm = [{ ts: now, activity: '看视频', mood: '轻松', hasError: false }]
assert('平静看视频 → 不打扰', !decideCare({ observations: calm, now, lastCareAt: 0, careCountToday: 0 }).care)

assert(
  '今天已满 3 次 → 不再关心',
  !decideCare({ observations: anxious, now, lastCareAt: 0, careCountToday: MAX_CARE_PER_DAY }).care,
)
assert(
  '距上次不足 45 分钟 → 不关心',
  !decideCare({ observations: anxious, now, lastCareAt: now - 10 * 60_000, careCountToday: 1 }).care,
)

// 连续 2 小时工作
const longFocus = [
  { ts: now - 130 * 60_000, activity: '写代码', mood: '专注', hasError: false },
  { ts: now - 60 * 60_000, activity: '写代码', mood: '专注', hasError: false },
  { ts: now, activity: '写文档', mood: '专注', hasError: false },
]
assert('连续 2 小时工作 → 触发', isLongFocus(longFocus, now))
assert('工作 2 小时 → 决定关心', decideCare({ observations: longFocus, now, lastCareAt: 0, careCountToday: 0 }).care)
assert('关心语不会为空', careLine('long_focus', 1).length > 5)

// ---------- 3) 绿眼睛没在跑 → 不截屏 ----------
if (existsSync(HEARTBEAT)) unlinkSync(HEARTBEAT)
if (existsSync(STATE)) unlinkSync(STATE)

let captured = 0
const c1 = new Companion({
  capture: async () => {
    captured++
    return Buffer.alloc(4096)
  },
  describe: async () => '在干什么: 写代码\n情绪: 焦虑',
})
const r1 = await c1.tick()
assert('没有绿眼睛心跳 → 跳过且不截屏', !!r1.skipped && captured === 0, r1.skipped || '')

// ---------- 4) 绿眼睛在跑 → 正常观察 ----------
touchHeartbeat()
const seen = []
const c2 = new Companion({
  capture: async () => Buffer.alloc(4096),
  describe: async () => '在干什么: 写代码\n情绪: 焦虑\n有报错',
  onCare: (line, d) => seen.push({ line, d }),
})
const r2 = await c2.tick()
assert('有心跳 → 真的去截屏并分析', r2.observation?.activity.includes('写代码'), JSON.stringify(r2.observation || {}))
assert('命中条件 → 主动关心一次', r2.cared === true && seen.length === 1, r2.line || '')
assert('关心回调拿到触发原因', String(seen[0]?.d?.kind) === 'error_anxious', JSON.stringify(seen[0]?.d || {}))

// 第二次立刻 tick：45 分钟内不再打扰
const r3 = await c2.tick()
assert('45 分钟内不重复打扰', r3.cared === false, String(r3.cared))

// ---------- 5) 游戏在跑 → 暂停 ----------
const c3 = new Companion({
  capture: async () => Buffer.alloc(4096),
  describe: async () => '在干什么: 打游戏\n情绪: 专注',
  shouldPause: async () => true,
})
const r4 = await c3.tick()
assert('有游戏在跑 → 跳过', !!r4.skipped && r4.skipped.includes('游戏'), r4.skipped || '')

// ---------- 6) 视觉失败 → 静默 ----------
const c4 = new Companion({
  capture: async () => Buffer.alloc(4096),
  describe: async () => {
    throw new Error('视觉接口 500')
  },
})
const r5 = await c4.tick()
assert('视觉失败不抛错、只记跳过', !!r5.skipped && r5.skipped.includes('失败'), r5.skipped || '')

assert('提示词里要求不描述截图具体内容（隐私）', VLM_PROMPT.includes('不要描述'))

if (existsSync(HEARTBEAT)) unlinkSync(HEARTBEAT)
if (existsSync(STATE)) unlinkSync(STATE)
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
