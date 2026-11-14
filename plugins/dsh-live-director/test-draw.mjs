/**
 * test-draw.mjs —— 画师接单链路离线验证（不依赖 OBS / 生图 API）
 *
 * 覆盖：
 *   1. 指令解析（!画 / !画头像 / 不是指令）
 *   2. 模式智能匹配（像素→pixel、素描→strokes、其他→stages）
 *   3. 冷却（全局 30s / 单用户 60s）
 *   4. 落盘路径（头像进 fan_art、普通单进 out）
 *   5. 端到端：起 painter-bridge（本地底图模式）→ 发一条 !画头像 → 文件真的落到 fan_art
 *
 * 用法：node build.mjs && node test-draw.mjs
 */
import { mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseDrawCommand,
  pickMode,
  pickGridSize,
  DrawCooldown,
  targetPath,
  safeName,
  announceStart,
  announceDone,
  handleDrawCommand,
  COOLDOWN_REPLY,
} from './lib/draw.js'
import { startPainterBridge } from './lib/painter-bridge.js'
import { generatePaintProcess } from '../dsh-painter/lib/index.js'

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---------- 1) 解析 ----------
const a = parseDrawCommand('!画 像素风的猫')
check('!画 解析成功', !!a && a.kind === 'art', JSON.stringify(a))
check('像素→pixel', a?.mode === 'pixel', a?.mode)
check('普通单 16:9', a?.aspect === '16:9', a?.aspect)
const b = parseDrawCommand('!画头像 赛博女仆')
check('!画头像 解析成功', !!b && b.kind === 'avatar', JSON.stringify(b))
check('头像 1:1', b?.aspect === '1:1', b?.aspect)
const c = parseDrawCommand('!画头像赛博女仆')
check('!画头像 紧贴内容也能解析', !!c && c.kind === 'avatar' && c.content === '赛博女仆', JSON.stringify(c))
check('非指令返回 null', parseDrawCommand('今天天气不错') === null)
check('空指令返回 null', parseDrawCommand('!画') === null)
check('全角感叹号也认', parseDrawCommand('！画 一只猫')?.content === '一只猫')

// ---------- 2) 模式 ----------
check('素描→strokes', pickMode('素描一只猫') === 'strokes')
check('8-bit→pixel', pickMode('8-bit 小猫') === 'pixel')
check('默认 stages', pickMode('一只猫') === 'stages')
check('像素带数字取格子', pickGridSize('像素风 128 格', 'pixel') === 128, String(pickGridSize('像素风 128 格', 'pixel')))
check('像素默认 64', pickGridSize('像素风', 'pixel') === 64)
check('非像素模式无 grid', pickGridSize('一只猫', 'stages') === undefined)

// ---------- 3) 冷却 ----------
const cd = new DrawCooldown({ globalMs: 30_000, perUserMs: 60_000 })
const t0 = 1_000_000
check('首次允许', cd.check('u1', t0).allowed)
cd.mark('u1', t0)
check('同人 1 分钟内被拦', !cd.check('u1', t0 + 1_000).allowed)
check('别人 10 秒后被全局拦', !cd.check('u2', t0 + 10_000).allowed)
check('同人 61 秒后放行', cd.check('u1', t0 + 61_000).allowed)
check('全局冷却 30 秒后别人可画', cd.check('u2', t0 + 30_001).allowed)

// ---------- 4) 落盘路径 ----------
const dirs = { outDir: join(tmpdir(), 'drawtest', 'out'), fanArtDir: join(tmpdir(), 'drawtest', 'fan_art'), framesRoot: join(tmpdir(), 'drawtest', 'frames') }
const av = targetPath({ kind: 'avatar', content: 'x', mode: 'stages', aspect: '1:1' }, '小明', dirs, new Date(2026, 10, 14))
check('头像路径格式', /2026-11-14_小明\.png$/.test(av), av)
check('头像落在 fan_art', av.includes('fan_art'), av)
const art = targetPath({ kind: 'art', content: 'x', mode: 'stages', aspect: '16:9' }, '小明', dirs)
check('普通单落在 out', art.includes('out') && art.endsWith('.png'), art)
check('文件名清洗非法字符', safeName('a/b:c*d') === 'a_b_c_d', safeName('a/b:c*d'))

// ---------- 5) 文案 ----------
check('开工文案（普通）', announceStart({ kind: 'art', content: '像素风的猫', mode: 'pixel', aspect: '16:9' }, '小明').includes('像素风的猫'))
check('开工文案（头像）', announceStart({ kind: 'avatar', content: 'x', mode: 'stages', aspect: '1:1' }, '小明').includes('头像'))
check('完成文案（普通）', announceDone({ kind: 'art', content: 'x', mode: 'stages', aspect: '16:9' }, '小明', true).includes('挂在墙上'))
check('完成文案（头像）', announceDone({ kind: 'avatar', content: 'x', mode: 'stages', aspect: '1:1' }, '小明', true).includes('专属相册'))

// ---------- 6) 冷却回复 ----------
const spoke = []
const d1 = { dirs, speak: (t) => spoke.push(t), cooldown: new DrawCooldown({ globalMs: 30_000, perUserMs: 60_000 }) }
const r1 = handleDrawCommand('!画 一只猫', 'u1', d1)
check('第一条接单', r1.handled && r1.reply && !r1.reply.includes('画笔还没干'), r1.reply)
const r2 = handleDrawCommand('!画 一只狗', 'u1', d1)
check('第二条被冷却拦下', r2.handled && r2.reply === COOLDOWN_REPLY, r2.reply || '')
const r3 = handleDrawCommand('随便聊聊', 'u1', d1)
check('非画图指令不接管', r3.handled === false)

// ---------- 7) 端到端：桥 + 本地底图 → 落盘 ----------
const e2eDir = join(tmpdir(), 'drawtest_e2e')
rmSync(e2eDir, { recursive: true, force: true })
mkdirSync(e2eDir, { recursive: true })
process.env.PAINTER_LOCAL_IMAGE = resolve('../dsh-painter/lib/../src/../lib/index.js') // 占位，下面会覆盖
// 用一张真实 png：拿 paint 自己的测试图（SVG 光栅化）不方便，直接用 sharp 现场画一张
const sharp = (await import('../dsh-painter/node_modules/sharp/lib/index.js')).default
const localPng = join(e2eDir, 'base.png')
await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 40, g: 90, b: 150 } } }).png().toFile(localPng)
process.env.PAINTER_LOCAL_IMAGE = localPng

const bridge = await startPainterBridge(async (req) => {
  const res = await generatePaintProcess({ ...req, duration_ms: 2000, fps: 10 })
  return { ok: res.ok, path: res.path, frames: res.frames, elapsed_ms: res.elapsed_ms, mode: res.mode, width: res.width, height: res.height, error: res.error }
}, { port: 0 })
const bridgeUrl = `http://127.0.0.1:${bridge.port}`
const spoke2 = []
const e2eDirs = { outDir: join(e2eDir, 'out'), fanArtDir: join(e2eDir, 'fan_art'), framesRoot: join(e2eDir, 'frames') }
handleDrawCommand('!画头像 赛博女仆', '测试粉丝', { dirs: e2eDirs, speak: (t) => spoke2.push(t), bridgeUrl })

// 等后台任务落地（最长 30 秒）
const deadline = Date.now() + 30_000
let landed = false
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 400))
  if (existsSync(e2eDirs.fanArtDir)) {
    const files = readdirSync(e2eDirs.fanArtDir).filter((f) => f.endsWith('.png'))
    if (files.length) { landed = true; break }
  }
}
check('端到端：头像文件真的落盘', landed, landed ? readdirSync(e2eDirs.fanArtDir).join(',') : '超时没落盘')
// 收尾文案是在作画结束后才播的，落盘后要再给它一点时间
{
  const doneDeadline = Date.now() + 5_000
  while (Date.now() < doneDeadline && spoke2.length < 2) await new Promise((r) => setTimeout(r, 200))
}
check('端到端：开工+完成都播报了', spoke2.length >= 2, JSON.stringify(spoke2))

await bridge.close()
rmSync(e2eDir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
