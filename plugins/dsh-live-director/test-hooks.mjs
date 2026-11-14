/**
 * test-hooks.mjs —— OBS 显隐 / TTS / QQ hook 三块的离线验证
 *
 * 这些模块在**当前机器上没法真跑**（OBS 没开、4455 与 9881 都不通），
 * 所以这里验证的是"配置判定 + 降级不崩 + 参数拼装"这三件本来就该确定的事：
 *   1. art-panel：没配环境变量 → no-op；配了但连不上 → 降级且不抛
 *   2. tts：没启用 / 连不上 / 超时 → 都返回 false 且不抛；播放器模板按空格正确拆 argv
 *   3. fan-art：默认 hook 只打日志；注入实现后被调用；文件缺失直接返回 false；实现抛异常也不外泄
 *
 * 用法：node build.mjs && node test-hooks.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readArtPanelConfig, ArtPanel } from './lib/art-panel.js'
import { readTtsConfig, buildPlayerArgv, speakViaTts } from './lib/tts.js'
import { sendFanArtToQQ, setFanArtSender } from './lib/fan-art.js'

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---------- 1) art-panel 配置判定 ----------
check('缺 OBS_WS_URL → 不启用', readArtPanelConfig({ OBS_SCENE_NAME: '主场景' }) === null)
check('缺 OBS_SCENE_NAME → 不启用', readArtPanelConfig({ OBS_WS_URL: 'ws://x' }) === null)
const cfg = readArtPanelConfig({ OBS_WS_URL: 'ws://127.0.0.1:4455', OBS_SCENE_NAME: '主场景' })
check('配齐 → 启用，源名默认 DynamicArt', !!cfg && cfg.source === 'DynamicArt', JSON.stringify(cfg))
check('默认保持 30 秒', cfg?.holdMs === 30_000, String(cfg?.holdMs))
const cfg2 = readArtPanelConfig({ OBS_WS_URL: 'ws://x', OBS_SCENE_NAME: 's', OBS_ART_HOLD_MS: '5000', OBS_SOURCE_NAME: 'Art' })
check('自定义保持时长与源名', cfg2?.holdMs === 5000 && cfg2?.source === 'Art', JSON.stringify(cfg2))

// 未配置时 showArt 是 no-op，不抛
const logs = []
const noop = new ArtPanel(null, (m) => logs.push(m))
const r1 = await noop.showArt()
check('未配置 showArt 返回 ok:false 但不抛', r1.ok === false, r1.reason)
check('未配置 hideArt 也不抛', (await noop.hideArt()) === undefined)
noop.dispose()

// 配了但连不上：降级且不抛
delete process.env.OBS_WS_URL
process.env.OBS_WS_URL = 'ws://127.0.0.1:1'
const unconn = new ArtPanel({ url: 'ws://127.0.0.1:1', scene: '主场景', source: 'DynamicArt', holdMs: 1000 }, (m) => logs.push(m))
const r2 = await unconn.showArt()
check('连不上 OBS 时降级返回 ok:false', r2.ok === false, r2.reason)
check('降级时写了日志', logs.some((l) => l.includes('显示失败')), logs.slice(-1)[0] || '')
unconn.dispose()

// ---------- 2) TTS ----------
check('TTS_ENABLED=0 → 不启用', readTtsConfig({ TTS_ENABLED: '0' }) === null)
const tc = readTtsConfig({})
check('默认地址 9881/tts', tc?.url === 'http://127.0.0.1:9881/tts', tc?.url)
check('默认超时 3 秒', tc?.timeoutMs === 3000, String(tc?.timeoutMs))
const argv = buildPlayerArgv('powershell -NoProfile -Command "(New-Object Media.SoundPlayer \'{file}\').PlaySync()"', 'C:\\a b\\x.wav')
check('播放器模板拆 argv', argv.cmd === 'powershell' && argv.args.length === 3, JSON.stringify(argv))
check('{file} 被替换成独立参数', argv.args[2].includes('C:\\a b\\x.wav'), argv.args[2])
const argv2 = buildPlayerArgv('ffplay -autoexit {file}', '/tmp/x.wav')
check('ffplay 模板也正确', argv2.cmd === 'ffplay' && argv2.args.join(' ').includes('/tmp/x.wav'), argv2.args.join(' '))

// 连不上 → false 且不抛
const ok1 = await speakViaTts('测试一句', { url: 'http://127.0.0.1:1/tts', timeoutMs: 800, player: 'ffplay {file}' })
check('TTS 连不上返回 false 不抛', ok1 === false)
// 未启用 → false
check('TTS 未启用返回 false', (await speakViaTts('x', null)) === false)
// 空文本 → false
check('空文本不发请求', (await speakViaTts('  ', { url: 'http://127.0.0.1:1/tts', timeoutMs: 500, player: 'x' })) === false)

// ---------- 3) fan-art ----------
const dir = mkdtempSync(join(tmpdir(), 'fanart-'))
const file = join(dir, 'a.png')
writeFileSync(file, 'x')
check('默认 hook 只打日志、返回 false', (await sendFanArtToQQ('小明', file)) === false)
let called = null
setFanArtSender(async (u, p) => { called = { u, p }; return true })
check('注入实现后被调用', (await sendFanArtToQQ('小明', file)) === true && called?.u === '小明', JSON.stringify(called))
check('文件不存在直接 false', (await sendFanArtToQQ('小明', join(dir, 'nope.png'))) === false)
setFanArtSender(async () => { throw new Error('协议端挂了') })
check('实现抛异常不外泄', (await sendFanArtToQQ('小明', file)) === false)
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
