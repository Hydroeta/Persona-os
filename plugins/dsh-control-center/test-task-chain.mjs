/**
 * test-task-chain.mjs —— 任务链解析的离线验证
 *
 * 重点验证那个坑：session.v4.jsonl.zstd 是**上万个小 zstd 帧相接**，
 * 直接整体解压只能拿到 244 字节的 session 头，看起来像"没存工具调用"。
 *
 * 用法：node build.mjs && node test-task-chain.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const m = await import(pathToFileURL(join(process.cwd(), 'lib', 'task-chain.js')).href)
const { decodeZstdFrames, parseToolCalls, getTaskChain, findRecentSessions, __clearCache } = m

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---------- 造一个"多帧 zstd"文件 ----------
// 每行压成一个独立帧，首尾相接 —— 和真实 session 文件同构
const lines = [
  JSON.stringify({ type: 'session', version: 4, id: 'session-test-1' }),
  JSON.stringify({ type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } }),
  JSON.stringify({
    type: 'tool/call', seq: 2, time: 1100,
    data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"ls"}' },
  }),
  JSON.stringify({
    type: 'tool/result', seq: 3, time: 1200,
    data: { turn: 1, step: 1, toolCallId: 'c1', message: { role: 'tool' } },
  }),
  JSON.stringify({
    type: 'tool/call', seq: 4, time: 1300,
    data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"file_path":"a.ts"}' },
  }),
  JSON.stringify({ type: 'turn/end', seq: 5, time: 1400, data: { turn: 1 } }),
]

const dir = mkdtempSync(join(tmpdir(), 'taskchain-'))
const f = join(dir, 'session.v4.jsonl.zstd')
const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l + '\n', 'utf8')))
writeFileSync(f, Buffer.concat(frames))

// ---------- 1. 关键：整体解压只拿到第一帧 ----------
const raw = (await import('node:fs')).readFileSync(f)
const whole = zlib.zstdDecompressSync(raw).toString('utf8')
check('整体解压只有第一帧（复现那个坑）', whole.includes('"session"') && !whole.includes('tool/call'),
  `${whole.length} 字节`)

// ---------- 2. 逐帧解压能拿到全部 ----------
const text = decodeZstdFrames(raw)
check('逐帧解压拿到全部内容', text.includes('tool/call') && text.includes('tool/result'))
check('逐帧解压行数正确', text.split('\n').filter(Boolean).length === lines.length,
  `${text.split('\n').filter(Boolean).length} 行`)

// ---------- 3. parseToolCalls ----------
__clearCache()
const chain = getTaskChain({ sessionPath: f })
check('getTaskChain 成功', chain.ok === true, chain.error || '')
check('识别出 2 条 tool/call', chain.totalCalls === 2, String(chain.totalCalls))

const names = chain.calls.map((c) => c.name)
check('工具名解析正确', names[0] === 'pwsh' && names[1] === 'read', names.join(','))
check('参数原文保留', chain.calls[0].args.includes('ls'), chain.calls[0].args)
check('turn/step 解析正确', chain.calls[0].turn === 1 && chain.calls[1].step === 2)
check('有结果的调用标记了 hasResult', chain.calls[0].hasResult === true)
check('没有结果的调用 hasResult 为空', chain.calls[1].hasResult === undefined)

// ---------- 4. 过滤与 limit ----------
const onlyPwsh = getTaskChain({ sessionPath: f, tools: ['pwsh'] })
check('tools 过滤生效', onlyPwsh.totalCalls === 1 && onlyPwsh.calls[0].name === 'pwsh')

const lim = getTaskChain({ sessionPath: f, limit: 1 })
check('limit 取最后 N 条', lim.calls.length === 1 && lim.calls[0].name === 'read', lim.calls[0]?.name)

// ---------- 5. 缓存：同文件重复查结果一致 ----------
const again = getTaskChain({ sessionPath: f })
check('缓存后结果一致', again.totalCalls === chain.totalCalls)

// ---------- 6. 找不到文件时的错误 ----------
const missing = getTaskChain({ sessionPath: join(dir, '不存在.zstd') })
check('文件不存在返回 ok:false', missing.ok === false && /不存在/.test(missing.error || ''), missing.error)

// ---------- 7. 长参数会被截断 ----------
const longArg = 'x'.repeat(500)
const longLine = JSON.stringify({
  type: 'tool/call', seq: 9, time: 1,
  data: { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: longArg },
})
const parsed = parseToolCalls([longLine])
check('超长参数被截断到 300+省略号', parsed[0].args.length <= 302 && parsed[0].args.endsWith('…'),
  String(parsed[0].args.length))

// ---------- 8. 坏行不影响整体 ----------
const withBad = parseToolCalls(['{坏 json', ...lines])
check('坏 JSON 行被跳过', withBad.length === 2, String(withBad.length))

rmSync(dir, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
