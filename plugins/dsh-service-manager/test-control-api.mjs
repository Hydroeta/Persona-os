/**
 * test-control-api.mjs —— 服务控制接口离线验证
 *
 * 用假的 hooks（不真去杀进程）验证：
 *   1. 白名单：未知服务名直接 400，不会变成"任意进程杀手"
 *   2. /stop 之后再 /start-all 不会把它拉回来（尊重用户意图）
 *   3. /restart = stop + start，两步都成功才 200
 *   4. token 鉴权
 *
 * 用法：node build.mjs && node test-control-api.mjs
 */
import { startControlApi } from './lib/control-api.js'

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

const running = new Set(['Memory'])
const calls = []
const hooks = {
  names: ['Memory', 'Painter', 'IndexTTS2'],
  async isRunning(name) {
    return running.has(name)
  },
  async stop(name) {
    calls.push(`stop:${name}`)
    running.delete(name)
    return { ok: true, detail: `停了 ${name}` }
  },
  async start(name) {
    calls.push(`start:${name}`)
    running.add(name)
    return { ok: true, detail: `起了 ${name}` }
  },
}

const srv = await startControlApi(hooks, { port: 0 })
const base = `http://127.0.0.1:${srv.port}`
const post = (p) => fetch(`${base}${p}`, { method: 'POST' })
const j = async (r) => ({ status: r.status, body: await r.json() })

check('GET /health 返回服务名清单', (await fetch(`${base}/health`).then((r) => r.json())).services.length === 3)

// 1) 白名单
const bad = await j(await post('/stop?name=explorer.exe'))
check('未知服务名被拒（400）', bad.status === 400 && /未知服务/.test(bad.body.error), JSON.stringify(bad.body))
check('被拒时没有触发 stop', !calls.includes('stop:explorer.exe'))

// 2) 缺参数
const noName = await j(await post('/restart'))
check('缺 name 参数被拒（400）', noName.status === 400, JSON.stringify(noName.body))

// 3) 停一个
const stop1 = await j(await post('/stop?name=Painter'))
check('/stop 成功', stop1.status === 200 && stop1.body.ok === true, JSON.stringify(stop1.body))
check('Painter 确实不在跑了', running.has('Painter') === false)

// 4) start-all 不把用户停掉的服务拉回来
calls.length = 0
const all = await j(await post('/start-all'))
const painterRow = all.body.results.find((r) => r.name === 'Painter')
check('start-all 跳过被手动停止的 Painter', painterRow?.ok === false && /手动停止/.test(painterRow.detail), JSON.stringify(painterRow))
check('start-all 没对 Painter 调 start', !calls.includes('start:Painter'), JSON.stringify(calls))
check('start-all 把 IndexTTS2 拉起来了', running.has('IndexTTS2') === true)

// 5) 手动 start 清掉"已停止"标记
await post('/start?name=Painter')
check('/start 后 Painter 在跑', running.has('Painter') === true)

// 6) restart
calls.length = 0
const rs = await j(await post('/restart?name=Memory'))
check('/restart = stop + start 都调了', calls.join(',') === 'stop:Memory,start:Memory', calls.join(','))
check('/restart 返回 200', rs.status === 200 && rs.body.ok === true, JSON.stringify(rs.body.ok))

// 7) token 鉴权
const srv2 = await startControlApi(hooks, { port: 0, token: 'secret' })
const base2 = `http://127.0.0.1:${srv2.port}`
const noTok = await fetch(`${base2}/stop?name=Memory`, { method: 'POST' })
check('无 token 被拒（401）', noTok.status === 401)
const withTok = await fetch(`${base2}/stop?name=Memory`, { method: 'POST', headers: { 'x-ctl-token': 'secret' } })
check('带正确 token 放行', withTok.status === 200)
await srv2.close()

// 8) 非 POST
const getStop = await fetch(`${base}/stop?name=Memory`)
check('GET 调 /stop 被拒（405）', getStop.status === 405)

await srv.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
