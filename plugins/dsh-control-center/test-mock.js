/**
 * test-mock.js —— 总控面板离线验证
 *
 * 覆盖：
 *   1. 端口探测：自己起一个服务 → 判 up；连不上的端口 → 判 down
 *   2. HTTP 探活：/health 200 → up；404 → down；慢服务 → 2s 超时变红但不拖累别人
 *   3. allSettled 并发：一个卡死不会让整批变慢
 *   4. nvidia-smi 输出解析
 *   5. 面板服务：/health、/、/api/status 结构
 *   6. 指挥官测试台：起一个假 9001 WS 服务，POST /api/danmaku → 拿到服务端回包
 *
 * 用法：node build.mjs && node test-mock.js
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { probeTcp, probeHttp, probeAll, parseNvidiaSmi, readHostInfo } from './lib/probe.js'
import { startControlCenter } from './lib/server.js'
import { sendTestDanmaku } from './lib/danmaku.js'

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---------- 1) 端口/HTTP 探测 ----------
const okSrv = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, model_loaded: true }))
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => okSrv.listen(0, '127.0.0.1', r))
const okPort = okSrv.address().port

const tcpUp = await probeTcp(okPort)
check('TCP 探测：有服务 → up', tcpUp.up === true, `${tcpUp.ms}ms`)

const httpUp = await probeHttp(okPort, '/health')
check('HTTP /health 200 → up', httpUp.up === true, httpUp.detail || '')
check('解析出 model_loaded', (httpUp.detail || '').includes('model=已加载'), httpUp.detail || '')

const http404 = await probeHttp(okPort, '/nope')
check('HTTP 404 → down', http404.up === false)

// 找一个确定没人监听的端口
const closedSrv = createServer()
await new Promise((r) => closedSrv.listen(0, '127.0.0.1', r))
const closedPort = closedSrv.address().port
await new Promise((r) => closedSrv.close(r))
const tcpDown = await probeTcp(closedPort)
check('TCP 探测：没人监听 → down', tcpDown.up === false, tcpDown.error || '')

// ---------- 2) 慢服务超时 ----------
const slowSrv = createServer(() => {
  /* 收下不响应 */
})
await new Promise((r) => slowSrv.listen(0, '127.0.0.1', r))
const slowPort = slowSrv.address().port
const t0 = Date.now()
const slowRes = await probeHttp(slowPort, '/health', 600)
const slowMs = Date.now() - t0
check('慢服务在超时后判 down', slowRes.up === false, slowRes.error || '')
check('超时确实在设定时间附近返回（不卡死）', slowMs >= 550 && slowMs < 2500, `${slowMs}ms`)
await new Promise((r) => slowSrv.close(r))

// ---------- 3) allSettled：坏的一个不拖累整批 ----------
const mixed = await probeAll(
  [
    { key: 'good', label: 'good', port: okPort, healthPath: '/health', kind: 'http' },
    { key: 'dead', label: 'dead', port: closedPort, kind: 'tcp' },
  ],
  800,
)
check('批量探测返回两条', mixed.length === 2)
check('好的判 up、死的判 down', mixed[0].up === true && mixed[1].up === false, JSON.stringify(mixed.map((m) => [m.key, m.up])))

// ---------- 4) nvidia-smi 解析 ----------
const gpus = parseNvidiaSmi('NVIDIA GeForce RTX 3050 Laptop GPU, 3069, 4096, 47\n')
check('解析 GPU 名称/显存/占用', gpus.length === 1 && gpus[0].memUsedMb === 3069 && gpus[0].memTotalMb === 4096 && gpus[0].utilPct === 47, JSON.stringify(gpus))
check('空输出解析为空数组', parseNvidiaSmi('\n\n').length === 0)
const host = await readHostInfo()
check('本机资源可读（内存字段合理）', host.memTotalMb > 0 && host.memPct >= 0 && host.memPct <= 100, `${host.memUsedMb}/${host.memTotalMb} ${host.memPct}%`)

// ---------- 5) 面板服务 ----------
const panel = await startControlCenter({ port: 0, page: () => '<!doctype html><title>t</title>' })
const base = `http://127.0.0.1:${panel.port}`
const h = await fetch(`${base}/health`).then((r) => r.json())
check('面板 /health 正常', h.ok === true, JSON.stringify(h))
const html = await fetch(`${base}/`).then((r) => r.text())
check('面板 / 返回 HTML', html.includes('<!doctype html>'))
const snap = await fetch(`${base}/api/status`).then((r) => r.json())
check('/api/status 结构完整', Array.isArray(snap.services) && snap.services.length === 6 && !!snap.host, `services=${snap.services?.length}`)
check('/api/status 每个服务带 up 字段', snap.services.every((s) => typeof s.up === 'boolean'))

// ---------- 6) 指挥官测试台（假 9001 WS） ----------
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
await new Promise((r) => wss.once('listening', r))
const wsPort = wss.address().port
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    ws.send(JSON.stringify({ ok: true, reason: `回显：${msg.text}`, priority: 2, queueSize: 1, text: msg.text, user: msg.user }))
  })
})

const reply = await sendTestDanmaku('!画 像素风的猫', '面板指挥官', { url: `ws://127.0.0.1:${wsPort}`, timeoutMs: 3000 })
check('WS 测试弹幕拿到回包', reply.ok === true, JSON.stringify(reply.reply))
check('回包内容带着我们发的那句', JSON.stringify(reply.reply || '').includes('像素风的猫'))

const deadReply = await sendTestDanmaku('x', 'u', { url: `ws://127.0.0.1:${closedPort}`, timeoutMs: 1200 })
check('WS 连不上时优雅失败', deadReply.ok === false && !!deadReply.error, deadReply.error || '')

// 面板的 /api/danmaku 走默认 9001，这里用环境变量指向假服务
process.env.DANMAKU_WS_URL = `ws://127.0.0.1:${wsPort}`
const viaPanel = await fetch(`${base}/api/danmaku`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '!画 一只猫' }),
}).then((r) => r.json())
check('/api/danmaku 转发成功', viaPanel.ok === true, JSON.stringify(viaPanel.reply || viaPanel.error))
const empty = await fetch(`${base}/api/danmaku`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":""}' })
check('空弹幕被拒 400', empty.status === 400)

await new Promise((r) => wss.close(r))
await panel.close()
await new Promise((r) => okSrv.close(r))

console.log(`\n=== 测试完成：${pass} 通过 / ${fail} 失败 ===`)
if (fail > 0) process.exit(1)
