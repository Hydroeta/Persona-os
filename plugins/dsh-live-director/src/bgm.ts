/**
 * bgm.ts —— 翻唱伴奏联动
 *
 * `!翻唱 <歌名>` 时让 OBS 播放对应伴奏。两条路径：
 *   1. 配了 OBS_WS_URL（obs-websocket v5，默认端口 4455）→ 走 WebSocket：
 *      SetInputSettings（把 local_file 指到匹配到的音频）→ TriggerMediaInputAction(RESTART)
 *   2. 没配或连不上 → mock 模式只打日志，绝不阻塞弹幕主链路
 *
 * 环境变量：
 *   OBS_WS_URL       obs-websocket 地址，如 ws://127.0.0.1:4455；留空=不启用
 *   OBS_WS_PASSWORD  认证密码（obs-websocket 5.x 的 ServerPassword）
 *   OBS_BGM_SOURCE   OBS 里媒体源的输入名（默认 "BGM"）
 *   BGM_DIR          伴奏目录；按文件名模糊匹配歌名（含中文）
 */

import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'

const LOG_TAG = '[dsh-live-director/bgm]'
const OBS_WS_URL = process.env.OBS_WS_URL || ''
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD || ''
const OBS_BGM_SOURCE = process.env.OBS_BGM_SOURCE || 'BGM'
const BGM_DIR = process.env.BGM_DIR || ''

export interface BgmResult {
  ok: boolean
  mode: 'obs' | 'mock'
  song: string
  file?: string
  source?: string
  error?: string
}

/** 在 BGM_DIR 里按歌名模糊匹配音频文件 */
function findSongFile(song: string): string | undefined {
  if (!BGM_DIR || !fs.existsSync(BGM_DIR)) return undefined
  const exts = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac'])
  let files: string[] = []
  try {
    files = fs.readdirSync(BGM_DIR).filter((f) => exts.has(path.extname(f).toLowerCase()))
  } catch {
    return undefined
  }
  const key = song.trim().toLowerCase()
  if (!key) return undefined
  const hit = files.find((f) => f.toLowerCase().includes(key)) || files.find((f) => path.parse(f).name.toLowerCase() === key)
  return hit ? path.join(BGM_DIR, hit) : undefined
}

/** obs-websocket v5 最小客户端：connect → auth → 发请求 */
class ObsClient {
  private ws: WebSocket | null = null
  private reqId = 0
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  async connect(timeoutMs = 1500): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(OBS_WS_URL)
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('连接 obs-websocket 超时'))
      }, timeoutMs)
      ws.on('open', () => {
        // 等 Hello(op 0)，若带 auth 需要校验
      })
      ws.on('message', (raw) => {
        let msg: any
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (msg.op === 0 && msg.d?.authentication) {
          if (!OBS_WS_PASSWORD) {
            clearTimeout(timer)
            ws.terminate()
            reject(new Error('OBS 要求密码但未设 OBS_WS_PASSWORD'))
            return
          }
          // TODO: 5.x 的 challenge/salt sha256 认证；本机常见配置为关闭认证，先明确报错
          clearTimeout(timer)
          ws.terminate()
          reject(new Error('OBS 开启了 WebSocket 认证（需 sha256 challenge），当前未实现'))
          return
        }
        if (msg.op === 2) {
          clearTimeout(timer)
          this.ws = ws
          resolve()
          return
        }
        if (msg.op === 7) {
          const p = this.pending.get(msg.d?.requestId)
          if (p) {
            this.pending.delete(msg.d.requestId)
            if (msg.d.requestStatus?.result) p.resolve(msg.d.responseData ?? {})
            else p.reject(new Error(msg.d.requestStatus?.comment || 'OBS 请求失败'))
          }
        }
      })
      ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  request(requestType: string, requestData: Record<string, unknown> = {}, timeoutMs = 1500): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('OBS 未连接'))
    const requestId = String(++this.reqId)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`OBS 请求超时：${requestType}`))
      }, timeoutMs)
      this.pending.set(requestId, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws!.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }))
    })
  }

  close(): void {
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
  }
}

const obs = new ObsClient()

/** 播一首伴奏：优先 OBS，失败降级 mock */
export async function playBgm(song: string): Promise<BgmResult> {
  const name = String(song || '').trim()
  const file = findSongFile(name)

  if (!OBS_WS_URL) {
    console.log(`${LOG_TAG} mock 播放伴奏：${name || '(未指定)'}${file ? ` -> ${file}` : ''}`)
    return { ok: true, mode: 'mock', song: name, file, source: OBS_BGM_SOURCE }
  }

  try {
    await obs.connect()
    if (file) {
      await obs.request('SetInputSettings', {
        inputName: OBS_BGM_SOURCE,
        inputSettings: { local_file: file, is_local_file: true },
        overlay: true,
      })
    }
    await obs.request('TriggerMediaInputAction', {
      inputName: OBS_BGM_SOURCE,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    })
    console.log(`${LOG_TAG} OBS 伴奏已起：${name || '(未指定)'}${file ? ` -> ${file}` : ''}`)
    return { ok: true, mode: 'obs', song: name, file, source: OBS_BGM_SOURCE }
  } catch (e: any) {
    const error = e?.message || String(e)
    console.error(`${LOG_TAG} OBS 伴奏失败（降级 mock）：${error}`)
    return { ok: false, mode: 'mock', song: name, file, source: OBS_BGM_SOURCE, error }
  }
}

/** 停伴奏：OBS 媒体源暂停/停止；mock 模式只打日志 */
export async function stopBgm(): Promise<BgmResult> {
  if (!OBS_WS_URL) {
    console.log(`${LOG_TAG} mock 停止伴奏`)
    return { ok: true, mode: 'mock', song: '', source: OBS_BGM_SOURCE }
  }
  try {
    await obs.connect()
    await obs.request('TriggerMediaInputAction', {
      inputName: OBS_BGM_SOURCE,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
    })
    return { ok: true, mode: 'obs', song: '', source: OBS_BGM_SOURCE }
  } catch (e: any) {
    return { ok: false, mode: 'mock', song: '', source: OBS_BGM_SOURCE, error: e?.message || String(e) }
  }
}
