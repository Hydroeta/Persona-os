/**
 * tts.ts —— 真实 TTS 播报
 *
 * **未验证模块**：本机 9881 上没有 IndexTTS2 在跑，所以这里只保证
 *   "服务在就出声、服务不在就静默降级，绝不阻塞弹幕主循环"。
 *
 * 环境变量：
 *   TTS_SERVICE_URL  默认 http://127.0.0.1:9881/tts
 *   TTS_VOICE        可选，透传给服务端的音色名
 *   TTS_TIMEOUT_MS   请求超时，默认 3000
 *   TTS_PLAYER       播放器命令模板，`{file}` 会被替换成临时 wav 路径；
 *                    默认 windows 下用 PowerShell 的 SoundPlayer（零依赖、必定可用）
 *   TTS_ENABLED      设 '0' 关闭（只打日志）
 *
 * 播放策略：**不引入新依赖**。
 *   - Windows 默认：`powershell -NoProfile -Command "(New-Object Media.SoundPlayer '<file>').PlaySync()"`
 *     SoundPlayer 只吃 WAV（PCM），所以要求服务端回 wav。
 *   - 想换播放器就设 TTS_PLAYER，比如 `ffplay -autoexit -nodisp {file}`。
 *
 * 降级：任何一步失败都打 `[TTS降级] 播放失败: xxx` 并返回 false，调用方不用管。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LOG_TAG = '[dsh-live-director/tts]'

export interface TtsConfig {
  url: string
  voice?: string
  timeoutMs: number
  player: string
}

const DEFAULT_PLAYER =
  process.platform === 'win32'
    ? `powershell -NoProfile -Command "(New-Object Media.SoundPlayer '{file}').PlaySync()"`
    : 'ffplay -autoexit -nodisp -loglevel quiet {file}'

export function readTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig | null {
  if (String(env.TTS_ENABLED || '') === '0') return null
  const url = String(env.TTS_SERVICE_URL || 'http://127.0.0.1:9881/tts').trim()
  if (!url) return null
  const t = Number(env.TTS_TIMEOUT_MS)
  return {
    url,
    voice: env.TTS_VOICE ? String(env.TTS_VOICE) : undefined,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 3000,
    player: String(env.TTS_PLAYER || DEFAULT_PLAYER),
  }
}

/**
 * 把播放器模板拆成 argv。
 * 按空格切，但 **引号内的空格不算分隔**，引号本身剥掉；
 * `{file}` 若出现在引号内，替换后仍作为一个参数项（路径含空格也安全）。
 */
export function buildPlayerArgv(template: string, file: string): { cmd: string; args: string[] } {
  const tokens: string[] = []
  let cur = ''
  let quote = ''
  for (const ch of template.trim()) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) tokens.push(cur)
  if (!tokens.length) throw new Error('播放器命令为空')
  const cmd = tokens[0]
  const args = tokens.slice(1).map((p) => (p === '{file}' ? file : p.replace('{file}', file)))
  return { cmd, args }
}

/**
 * 合成并播放。返回是否真的播了。
 * 注意：这里 await 到"请求完成 + 起播放器"，不 await 播放结束 —— 免得把主循环卡住 3 秒。
 */
export async function speakViaTts(text: string, cfg: TtsConfig | null = readTtsConfig()): Promise<boolean> {
  const content = String(text || '').trim()
  if (!content) return false
  if (!cfg) {
    console.log(`${LOG_TAG} [TTS降级] 未启用`)
    return false
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
  let dir = ''
  try {
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: content, ...(cfg.voice ? { voice: cfg.voice } : {}) }),
      signal: ctrl.signal,
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 100) throw new Error(`返回音频过小（${buf.length} 字节）`)

    dir = await mkdtemp(join(tmpdir(), 'dsh-tts-'))
    const file = join(dir, 'speak.wav')
    await writeFile(file, buf)

    const { cmd, args } = buildPlayerArgv(cfg.player, file)
    execFile(cmd, args, { windowsHide: true }, (err) => {
      if (err) console.error(`${LOG_TAG} [TTS降级] 播放失败: ${err.message}`)
      // 播放结束后清临时目录（不 await，失败无所谓）
      void rm(dir, { recursive: true, force: true }).catch(() => {})
    })
    console.log(`${LOG_TAG} 🔊 已交给播放器（${buf.length} 字节）：${content}`)
    return true
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `超时（${cfg.timeoutMs}ms）` : (e as Error).message
    console.error(`${LOG_TAG} [TTS降级] 播放失败: ${msg}`)
    if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {})
    return false
  } finally {
    clearTimeout(timer)
  }
}
