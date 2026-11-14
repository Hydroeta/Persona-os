/**
 * tts.ts —— 真实 TTS 播报（对接 ohwhale-deploy/scripts/indextts_server.py）
 *
 * 【以源码为准，不是猜的】接口契约来自 indextts_server.py 的 do_GET：
 *   GET /tts?text=<文本>&ref_audio_path=<参考音绝对路径>&media_type=wav
 *     · **只有 GET，没有 POST**
 *     · ref_audio_path 必填，服务端会 os.path.isfile() 校验，不存在返回 400
 *     · 不带 media_type=wav 时返回**裸 PCM**（s16le / 单声道 / 32kHz），播放器放不了
 *   GET /health → {"ok": true, "model_loaded": bool}（模型惰性加载，首请求前恒为 false）
 *
 * 环境变量：
 *   TTS_SERVICE_URL   服务根地址，默认 http://127.0.0.1:9881
 *   TTS_REF_AUDIO     参考音绝对路径。**不配时自动找鲸鱼娘的 ref_190.wav**（见 DEFAULT_REF_CANDIDATES）；
 *                     都找不到就降级不发请求（日志会写「未配置参考音路径」）
 *   TTS_TIMEOUT_MS    超时，默认 60000（CPU 一句 1~2 分钟，3 秒必超时）
 *   TTS_PLAYER        播放器模板，`{file}` 会被替换成临时 wav 路径
 *   TTS_ENABLED       设 '0' 关闭（只打日志）
 *   TTS_WARMUP        设 '0' 关闭启动预热
 *
 * 两道并发防御：
 *   1. **正在播报锁**：上一句还没播完，新请求直接丢弃（直播里宁可少说一句，也不要排队几十秒）
 *   2. **服务端本来就是串行**（_infer_lock），所以我们这边不排队、只丢
 */
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'

const LOG_TAG = '[dsh-live-director/tts]'

/**
 * 默认参考音候选（鲸鱼娘）。
 * 不硬编码进仓库里某个人的绝对路径，只按"相对用户目录"的常见落点探测。
 */
const DEFAULT_REF_CANDIDATES = [
  process.env.WHALE_REF_AUDIO || '',
  join(homedir(), 'Documents', 'douyin-whale', 'out', 'ref_video', 'ref_190.wav'),
  join(homedir(), 'Desktop', '新建文件夹 (2)', 'ohwhale-deploy', 'assets', 'voice', 'states', 'ref_calm.wav'),
].filter(Boolean)

/** 探测默认参考音；都没有返回空串 */
export function resolveDefaultRef(): string {
  for (const p of DEFAULT_REF_CANDIDATES) {
    try {
      if (p && existsSync(p)) return p
    } catch {
      /* 忽略 */
    }
  }
  return ''
}

export interface TtsConfig {
  /** 服务根，不含 /tts */
  base: string
  refAudio: string
  timeoutMs: number
  player: string
}

const DEFAULT_PLAYER =
  process.platform === 'win32'
    ? `powershell -NoProfile -Command "(New-Object Media.SoundPlayer '{file}').PlaySync()"`
    : 'ffplay -autoexit -nodisp -loglevel quiet {file}'

export function readTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig | null {
  if (String(env.TTS_ENABLED || '') === '0') return null
  const base = String(env.TTS_SERVICE_URL || 'http://127.0.0.1:9881').trim().replace(/\/+$/, '').replace(/\/tts$/, '')
  if (!base) return null
  // 参考音：优先环境变量；没配就按候选列表自动探测（鲸鱼娘 ref_190.wav）
  const refAudio = String(env.TTS_REF_AUDIO || '').trim() || resolveDefaultRef()
  const t = Number(env.TTS_TIMEOUT_MS)
  return {
    base,
    refAudio,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 60_000,
    player: String(env.TTS_PLAYER || DEFAULT_PLAYER),
  }
}

/** 拼 /tts 的 GET 地址（导出供测试；参数全部 encodeURIComponent） */
export function buildTtsUrl(base: string, text: string, refAudio: string): string {
  const q = new URLSearchParams({ text, ref_audio_path: refAudio, media_type: 'wav' })
  return `${base.replace(/\/+$/, '')}/tts?${q.toString()}`
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

/** 正在播报锁：true = 上一句还没完 */
let speaking = false
/** 给测试用的观察口 */
export function isSpeaking(): boolean {
  return speaking
}
export function __resetSpeakingForTest(): void {
  speaking = false
}

/**
 * 合成并播放。返回是否真的播了。
 * - 正在播报时直接丢弃新请求（返回 false，日志说明原因）
 * - 请求完成后**不 await 播放结束**返回？→ 这里选择 await（用 speaking 锁挡住后续），
 *   与需求一致：上一句没播完就别插队。
 */
export async function speakViaTts(text: string, cfg: TtsConfig | null = readTtsConfig()): Promise<boolean> {
  const content = String(text || '').trim()
  if (!content) return false
  if (!cfg) {
    console.log(`${LOG_TAG} [TTS降级] 未启用`)
    return false
  }
  if (!cfg.refAudio) {
    console.log(`${LOG_TAG} [TTS降级] 未配置参考音路径（TTS_REF_AUDIO）`)
    return false
  }
  if (!existsSync(cfg.refAudio)) {
    console.log(`${LOG_TAG} [TTS降级] 参考音文件不存在：${cfg.refAudio}`)
    return false
  }
  if (speaking) {
    console.log(`${LOG_TAG} [TTS降级] 上一句还在播，丢弃：${content.slice(0, 20)}`)
    return false
  }
  speaking = true

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs)
  let dir = ''
  try {
    const url = buildTtsUrl(cfg.base, content, cfg.refAudio)
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`HTTP ${r.status} ${body.slice(0, 120)}`)
    }
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 100) throw new Error(`返回音频过小（${buf.length} 字节）`)

    dir = await mkdtemp(join(tmpdir(), 'dsh-tts-'))
    const file = join(dir, 'speak.wav')
    await writeFile(file, buf)

    const { cmd, args } = buildPlayerArgv(cfg.player, file)
    await new Promise<void>((resolve) => {
      execFile(cmd, args, { windowsHide: true }, (err) => {
        if (err) console.error(`${LOG_TAG} [TTS降级] 播放失败: ${err.message}`)
        resolve()
      })
    })
    void rm(dir, { recursive: true, force: true }).catch(() => {})
    console.log(`${LOG_TAG} 🔊 播报完成（${buf.length} 字节）：${content}`)
    return true
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `超时（${cfg.timeoutMs}ms）` : (e as Error).message
    console.error(`${LOG_TAG} [TTS降级] 播放失败: ${msg}`)
    if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {})
    return false
  } finally {
    clearTimeout(timer)
    speaking = false
  }
}

/**
 * 预热：后台发一句「嗯」，让 IndexTTS2 惰性加载模型（首次加载几十秒）。
 * 失败静默；不占用 speaking 锁（用的是独立请求），避免挡住真实播报。
 */
export async function warmupTts(cfg: TtsConfig | null = readTtsConfig()): Promise<boolean> {
  if (!cfg || !cfg.refAudio || !existsSync(cfg.refAudio)) return false
  if (String(process.env.TTS_WARMUP || '') === '0') return false
  try {
    const r = await fetch(buildTtsUrl(cfg.base, '嗯', cfg.refAudio), {
      method: 'GET',
      signal: AbortSignal.timeout(cfg.timeoutMs),
    })
    console.log(`${LOG_TAG} 🔥 预热${r.ok ? '成功' : `失败 HTTP ${r.status}`}`)
    return r.ok
  } catch (e) {
    console.log(`${LOG_TAG} 预热失败（不影响播报）：${(e as Error).message}`)
    return false
  }
}
