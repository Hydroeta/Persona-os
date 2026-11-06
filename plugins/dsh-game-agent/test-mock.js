/**
 * dsh-game-agent · test-mock.js
 *
 * 脱离 DSH 进程，直接验证游戏代理纯逻辑。运行：
 *   先 `node build.mjs` 生成 lib/index.js，再 `node test-mock.js`。
 *
 * 覆盖：
 *   1. extractJsonObject：模型把 JSON 包在 ```json / 前后加散文 / 多行嵌套 → 仍能正确提取；
 *      空输出、无括号、非法 JSON → null。
 *   2. normalizeAction：move/press/release/reset 合法校验；非法 direction/button/type → null；
 *      duration 钳制 0~10；大小写容忍。
 *   3. extractAction = 提取 + 校验 组合。
 *   4. buildGamePrompt 含 goal。
 *   5. 端到端（注入 captureFn + visionClient + forwardFn）：
 *      dry_run=false → forwardFn 收到正确动作；dry_run=true → forwardFn 不被调用。
 *   6. VLM 返回空（离线/未配置）→ ok:false，不抛错。
 *   7. 截屏失败（captureFn 返回 null）→ ok:false。
 *   8. VLM 返回不可解析 → ok:false。
 *   9. game-bot 离线（forward 抛错）→ ok:false reason 含 "game-bot 离线"。
 *  10. 真实 HTTP：起本地 fake VLM + fake game-bot，走 createVisionClient / forwardAction 真实 fetch 路径，
 *      断言 game-bot 收到的 POST body 就是 VLM 决策的动作。
 */

import http from 'node:http'
import {
  playGameStep,
  buildGamePrompt,
  extractAction,
  normalizeAction,
  extractJsonObject,
  createVisionClient,
  forwardAction,
} from './lib/index.js'

const results = []
let passCount = 0
let failCount = 0
function assert(name, cond, detail = '') {
  const ok = !!cond
  results.push({ name, pass: ok, detail })
  if (ok) passCount++
  else failCount++
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 一张假截图（不必是合法 JPEG：mock 视觉端不校验内容）
const FAKE_SCREEN = Buffer.alloc(120, 0xff)

// ---------------------------------------------------------------------------
// 本地 HTTP server 工具
// ---------------------------------------------------------------------------
function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => handler(req, res, body))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

async function main() {
  console.log('\n=== dsh-game-agent 测试 ===\n')

  // ==================================================================
  // 1. extractJsonObject 解析健壮性
  // ==================================================================
  console.log('--- 1. extractJsonObject 解析健壮性 ---')
  assert('plain object', extractJsonObject('{"type":"press","button":"A"}')?.button === 'A')
  assert(
    'wrapped in markdown json + prose',
    extractJsonObject('好的，分析如下：\n```json\n{"type":"move","direction":"forward","duration":1.0}\n```\n以上。')?.direction === 'forward',
  )
  assert(
    'multiline nested-safe',
    extractJsonObject('前缀\n{\n  "type": "press",\n  "button": "B",\n  "duration": 0.2\n}\n后缀')?.button === 'B',
  )
  assert('empty braces → {}', JSON.stringify(extractJsonObject('{}')) === '{}')
  assert('no braces → null', extractJsonObject('没有 JSON') === null)
  assert('array not object → null (首个 { 不存在)', extractJsonObject('[1,2,3]') === null)
  assert('invalid json → null', extractJsonObject('{type: press}') === null)

  // ==================================================================
  // 2. normalizeAction 校验
  // ==================================================================
  console.log('\n--- 2. normalizeAction 校验 ---')
  assert('move forward 合法', normalizeAction({ type: 'move', direction: 'forward' })?.direction === 'forward')
  assert('move 大写容忍', normalizeAction({ type: 'MOVE', direction: 'LEFT' })?.direction === 'left')
  assert('press A 合法', normalizeAction({ type: 'press', button: 'A' })?.button === 'a')
  assert('release LB 合法', normalizeAction({ type: 'release', button: 'lb' })?.button === 'lb')
  assert('reset 合法', normalizeAction({ type: 'reset' })?.type === 'reset')
  assert('非法 type → null', normalizeAction({ type: 'jump' }) === null)
  assert('move 缺 direction → null', normalizeAction({ type: 'move' }) === null)
  assert('move 非法 direction → null', normalizeAction({ type: 'move', direction: 'up' }) === null)
  assert('press 缺 button → null', normalizeAction({ type: 'press' }) === null)
  assert('press 非法 button → null', normalizeAction({ type: 'press', button: 'Z' }) === null)
  const dur = normalizeAction({ type: 'press', button: 'A', duration: 99 })
  assert('duration 钳制到 10', dur?.duration === 10, `got=${dur?.duration}`)
  const dur2 = normalizeAction({ type: 'move', direction: 'forward', duration: -5 })
  assert('负 duration 钳制到 0', dur2?.duration === 0, `got=${dur2?.duration}`)

  // ==================================================================
  // 3. extractAction 组合
  // ==================================================================
  console.log('\n--- 3. extractAction 组合 ---')
  assert('提取+校验 move', extractAction('{"type":"move","direction":"forward"}')?.type === 'move')
  assert('散文里提取 press', extractAction('我认为应该按 A：{"type":"press","button":"A"}')?.button === 'a')
  assert('非法动作 → null', extractAction('{"type":"fly"}') === null)

  // ==================================================================
  // 4. buildGamePrompt
  // ==================================================================
  console.log('\n--- 4. buildGamePrompt ---')
  const p = buildGamePrompt('走到传送阵')
  assert('prompt 含 goal', p.includes('走到传送阵'))
  assert('prompt 含 JSON 格式约束', p.includes('"type":"move"'))

  // ==================================================================
  // 5. 端到端：注入 capture + vision + forward
  // ==================================================================
  console.log('\n--- 5. 端到端（注入）：dry_run=false 执行 / dry_run=true 不执行 ---')
  let forwardCalls = 0
  let lastForwarded = null
  const fakeVision = { decide: async () => '{"type":"press","button":"A","duration":0.2}' }
  const resExec = await playGameStep({
    goal: '跳过去',
    dry_run: false,
    captureFn: async () => FAKE_SCREEN,
    visionClient: fakeVision,
    forwardFn: async (action) => { forwardCalls++; lastForwarded = action; return { ok: true } },
  })
  assert('执行返回 ok=true', resExec.ok === true, resExec.reason)
  assert('executed=true', resExec.executed === true)
  assert('forward 被调用 1 次', forwardCalls === 1, `calls=${forwardCalls}`)
  assert('转发动作正确 press a', lastForwarded?.type === 'press' && lastForwarded?.button === 'a', JSON.stringify(lastForwarded))
  assert('screenshot_bytes>0', (resExec.screenshot_bytes ?? 0) > 0)

  forwardCalls = 0
  const resDry = await playGameStep({
    goal: '跳过去',
    dry_run: true,
    captureFn: async () => FAKE_SCREEN,
    visionClient: fakeVision,
    forwardFn: async () => { forwardCalls++; return { ok: true } },
  })
  assert('dry_run 返回 ok=true', resDry.ok === true, resDry.reason)
  assert('dry_run executed=false', resDry.executed === false)
  assert('dry_run 不调用 forward', forwardCalls === 0, `calls=${forwardCalls}`)
  assert('dry_run 仍返回 action', resDry.action?.type === 'press')

  // ==================================================================
  // 6. VLM 离线（返回空）→ 降级
  // ==================================================================
  console.log('\n--- 6. VLM 离线降级 ---')
  const res6 = await playGameStep({
    goal: 'x', dry_run: false,
    captureFn: async () => FAKE_SCREEN,
    visionClient: { decide: async () => '' },
    forwardFn: async () => ({}),
  })
  assert('VLM 空 → ok=false', res6.ok === false, `reason=${res6.reason}`)
  assert('reason 含 VLM', /VLM|视觉/.test(res6.reason || ''), `reason=${res6.reason}`)

  // ==================================================================
  // 7. 截屏失败 → 降级
  // ==================================================================
  console.log('\n--- 7. 截屏失败降级 ---')
  const res7 = await playGameStep({
    goal: 'x', dry_run: false,
    captureFn: async () => null,
    visionClient: fakeVision,
    forwardFn: async () => ({}),
  })
  assert('截屏失败 → ok=false', res7.ok === false, `reason=${res7.reason}`)
  assert('screenshot_bytes=0', res7.screenshot_bytes === 0)
  assert('截屏失败不触发 forward', forwardCalls === 0)

  // ==================================================================
  // 8. VLM 不可解析 → 降级
  // ==================================================================
  console.log('\n--- 8. VLM 不可解析降级 ---')
  const res8 = await playGameStep({
    goal: 'x', dry_run: false,
    captureFn: async () => FAKE_SCREEN,
    visionClient: { decide: async () => '我觉得应该到处看看' },
    forwardFn: async () => ({}),
  })
  assert('不可解析 → ok=false', res8.ok === false, `reason=${res8.reason}`)
  assert('action=null', res8.action === null)
  assert('raw_vlm 保留', typeof res8.raw_vlm === 'string' && res8.raw_vlm.length > 0)

  // ==================================================================
  // 9. game-bot 离线 → 降级
  // ==================================================================
  console.log('\n--- 9. game-bot 离线降级 ---')
  const res9 = await playGameStep({
    goal: 'x', dry_run: false,
    captureFn: async () => FAKE_SCREEN,
    visionClient: fakeVision,
    forwardFn: async () => { throw new Error('fetch failed') },
  })
  assert('离线 → ok=false', res9.ok === false, `reason=${res9.reason}`)
  assert('reason 含 "game-bot 离线"', /game-bot 离线/.test(res9.reason || ''), `reason=${res9.reason}`)

  // ==================================================================
  // 10. 真实 HTTP：fake VLM + fake game-bot，走真实 fetch 路径
  // ==================================================================
  console.log('\n--- 10. 真实 HTTP：VLM 决策 → 转发 game-bot ---')
  // fake VLM：返回一个 move forward 动作（包在散文+markdown 里，考验解析）
  const vlmServer = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好的，下一步：\n```json\n{"type":"move","direction":"forward","duration":1.0}\n```' } }] }))
  })
  // fake game-bot：捕获 POST body
  let receivedBody = null
  let receivedPath = null
  const botServer = await startServer((req, res, body) => {
    receivedPath = req.url
    try { receivedBody = JSON.parse(body) } catch { receivedBody = body }
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ ok: true, executed: 'move' }))
  })

  const res10 = await playGameStep({
    goal: '向前跑',
    dry_run: false,
    game_bot_url: botServer.url,
    captureFn: async () => FAKE_SCREEN,
    visionClient: createVisionClient({ apiBase: vlmServer.url, apiKey: 'test-key', model: 'test-model', timeoutMs: 5000 }),
    // forward 用默认 forwardAction（真实 fetch）→ 不传 forwardFn
  })
  await vlmServer.close()
  await botServer.close()
  assert('真实 HTTP 返回 ok=true', res10.ok === true, `reason=${res10.reason}`)
  assert('game-bot 收到 POST /action', receivedPath === '/action', `path=${receivedPath}`)
  assert('game-bot 收到的动作 = VLM 决策', receivedBody?.type === 'move' && receivedBody?.direction === 'forward', JSON.stringify(receivedBody))
  assert('executed=true', res10.executed === true)

  // ---------------------------------------------------------------------------
  console.log(`\n=== 结果：${passCount} 通过 / ${failCount} 失败（共 ${results.length}）===\n`)
  // 清理 undici 全局 dispatcher 的 keep-alive 连接，避免 Windows 进程退出时触发
  // libuv "UV_HANDLE_CLOSING" 断言崩溃（exit -1073740791）。
  try {
    const undici = await import('undici')
    await undici.getGlobalDispatcher().destroy()
  } catch { /* undici 不可用或已销毁 → 忽略 */ }
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('测试未捕获异常：', e)
  process.exit(2)
})
