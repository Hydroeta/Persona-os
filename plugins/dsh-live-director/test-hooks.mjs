/**
 * test-hooks.mjs —— OBS 显隐 / TTS / QQ hook 三块的离线验证
 *
 * 这些模块在**当前机器上没法真跑**（OBS 没开、4455 与 9881 都不通），
 * 所以这里验证的是"配置判定 + 降级不崩 + 参数拼装"这三件本来就该确定的事。
 *
 * TTS 的接口契约**以 indextts_server.py 的源码为准**（GET + query，media_type=wav）。
 *
 * 用法：node build.mjs && node test-hooks.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readArtPanelConfig, ArtPanel } from './lib/art-panel.js'
import {
  readTtsConfig,
  buildPlayerArgv,
  buildTtsUrl,
  speakViaTts,
  isSpeaking,
  __resetSpeakingForTest,
} from './lib/tts.js'
import { sendFanArtToQQ, setFanArtSender } from './lib/fan-art.js'

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// 造一个假参考音（TTS 配置会检查它是否存在）
const tmp = mkdtempSync(join(tmpdir(), 'tts-hooks-'))
const refWav = join(tmp, 'ref.wav')
writeFileSync(refWav, 'RIFF....')

// ---------- 1) art-panel 配置判定 ----------
check('缺 OBS_WS_URL → 不启用', readArtPanelConfig({ OBS_SCENE_NAME: '主场景' }) === null)
check('缺 OBS_SCENE_NAME → 不启用', readArtPanelConfig({ OBS_WS_URL: 'ws://x' }) === null)
const cfg = readArtPanelConfig({ OBS_WS_URL: 'ws://127.0.0.1:4455', OBS_SCENE_NAME: '主场景' })
check('配齐 → 启用，源名默认 DynamicArt', !!cfg && cfg.source === 'DynamicArt', JSON.stringify(cfg))
check('默认保持 30 秒', cfg?.holdMs === 30_000, String(cfg?.holdMs))
const cfg2 = readArtPanelConfig({ OBS_WS_URL: 'ws://x', OBS_SCENE_NAME: 's', OBS_ART_HOLD_MS: '5000', OBS_SOURCE_NAME: 'Art' })
check('自定义保持时长与源名', cfg2?.holdMs === 5000 && cfg2?.source === 'Art', JSON.stringify(cfg2))

const logs = []
const noop = new ArtPanel(null, (m) => logs.push(m))
const r1 = await noop.showArt()
check('未配置 showArt 返回 ok:false 但不抛', r1.ok === false, r1.reason)
check('未配置 hideArt 也不抛', (await noop.hideArt()) === undefined)
noop.dispose()

const unconn = new ArtPanel({ url: 'ws://127.0.0.1:1', scene: '主场景', source: 'DynamicArt', holdMs: 1000 }, (m) => logs.push(m))
const r2 = await unconn.showArt()
check('连不上 OBS 时降级返回 ok:false', r2.ok === false, r2.reason)
unconn.dispose()

// ---------- 2) TTS 配置 ----------
check('TTS_ENABLED=0 → 不启用', readTtsConfig({ TTS_ENABLED: '0' }) === null)
const tc = readTtsConfig({ TTS_REF_AUDIO: refWav })
check('默认 base 是 9881（不含 /tts）', tc?.base === 'http://127.0.0.1:9881', tc?.base)
check('默认超时 60 秒', tc?.timeoutMs === 60_000, String(tc?.timeoutMs))
const tc2 = readTtsConfig({ TTS_SERVICE_URL: 'http://127.0.0.1:9881/tts/', TTS_REF_AUDIO: refWav })
check('URL 尾部 /tts 与斜杠被剥掉', tc2?.base === 'http://127.0.0.1:9881', tc2?.base)
check('参考音路径原样保留', tc?.refAudio === refWav, tc?.refAudio)

// ---------- 3) 请求格式：必须 GET + query + media_type=wav ----------
const u = buildTtsUrl('http://127.0.0.1:9881', '今天真开心', 'C:\\a b\\ref.wav')
check('路径是 /tts', u.startsWith('http://127.0.0.1:9881/tts?'), u)
check('带 text 参数', u.includes('text=%E4%BB%8A'), u)
check('带 ref_audio_path 且编码空格', u.includes('ref_audio_path=') && u.includes('a+b%5Cref.wav'), u)
check('必带 media_type=wav', u.includes('media_type=wav'), u)

// ---------- 4) 播放器 argv ----------
const argv = buildPlayerArgv(`powershell -NoProfile -Command "(New-Object Media.SoundPlayer '{file}').PlaySync()"`, 'C:\\a b\\x.wav')
check('播放器模板按引号拆 argv', argv.cmd === 'powershell' && argv.args.length === 3, JSON.stringify(argv))
check('{file} 整体替换（含空格路径不裂开）', argv.args[2].includes('C:\\a b\\x.wav'), argv.args[2])
const argv2 = buildPlayerArgv('ffplay -autoexit {file}', '/tmp/x.wav')
check('ffplay 模板也正确', argv2.cmd === 'ffplay' && argv2.args.join(' ').includes('/tmp/x.wav'), argv2.args.join(' '))

// ---------- 5) 降级路径 ----------
__resetSpeakingForTest()
check('空文本不发请求', (await speakViaTts('  ', { base: 'http://127.0.0.1:1', refAudio: refWav, timeoutMs: 500, player: 'ffplay {file}' })) === false)
check(
  '缺参考音 → 不发请求直接降级',
  (await speakViaTts('x', { base: 'http://127.0.0.1:1', refAudio: '', timeoutMs: 500, player: 'ffplay {file}' })) === false,
)
check(
  '参考音不存在 → 降级',
  (await speakViaTts('x', { base: 'http://127.0.0.1:1', refAudio: join(tmp, 'nope.wav'), timeoutMs: 500, player: 'ffplay {file}' })) === false,
)
check(
  '服务连不上 → 降级不抛',
  (await speakViaTts('x', { base: 'http://127.0.0.1:1', refAudio: refWav, timeoutMs: 800, player: 'ffplay {file}' })) === false,
)
check('降级后说话锁被释放', isSpeaking() === false)

// ---------- 6) 正在播报锁 ----------
// 用一个"接得住连接但永远不回"的本地服务，让请求挂在超时里，从而观察 speaking 状态
__resetSpeakingForTest()
const { createServer } = await import('node:http')
const hangSrv = createServer(() => {
  /* 收下请求但永不响应，用来模拟合成慢 */
})
await new Promise((r) => hangSrv.listen(0, '127.0.0.1', r))
const hangPort = hangSrv.address().port
const p1 = speakViaTts('第一句', { base: `http://127.0.0.1:${hangPort}`, refAudio: refWav, timeoutMs: 1200, player: 'ffplay {file}' })
await new Promise((r) => setTimeout(r, 80))
const during = isSpeaking()
const second = await speakViaTts('第二句', { base: 'http://127.0.0.1:1', refAudio: refWav, timeoutMs: 500, player: 'ffplay {file}' })
check('请求进行中 speaking 为 true', during === true, `during=${during}`)
check('播报中第二条被丢弃', second === false)
await p1
check('结束后 speaking 复位', isSpeaking() === false)
await new Promise((r) => hangSrv.close(r))

// ---------- 7) fan-art ----------
const dir = mkdtempSync(join(tmpdir(), 'fanart-'))
const file = join(dir, 'a.png')
writeFileSync(file, 'x')
check('默认 hook 只打日志、返回 false', (await sendFanArtToQQ('小明', file)) === false)
let called = null
setFanArtSender(async (usr, p) => { called = { usr, p }; return true })
check('注入实现后被调用', (await sendFanArtToQQ('小明', file)) === true && called?.usr === '小明', JSON.stringify(called))
check('文件不存在直接 false', (await sendFanArtToQQ('小明', join(dir, 'nope.png'))) === false)
setFanArtSender(async () => { throw new Error('协议端挂了') })
check('实现抛异常不外泄', (await sendFanArtToQQ('小明', file)) === false)

rmSync(tmp, { recursive: true, force: true })
rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
