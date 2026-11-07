/**
 * dsh-audio-cover
 *
 * 把 Audio Cover 微服务（core-services/audio-cover，默认 http://127.0.0.1:8005）
 * 暴露为 DSH 工具 toggle_live_cover。
 *
 * 设计原则：TS 管调度（谁在什么时候开/关），Python 管音频流与推理。
 * 现阶段微服务只跑音频闭环（bypass 直通 / tone 正弦测试），RVC 推理后续替换服务内部实现。
 *
 * 环境变量：
 *   AUDIO_COVER_URL  微服务地址（默认 http://127.0.0.1:8005）
 */

const LOG_TAG = '[dsh-audio-cover]'
if (!process.env.AUDIO_COVER_URL) process.env.AUDIO_COVER_URL = 'http://127.0.0.1:8005'
const BASE_URL = (process.env.AUDIO_COVER_URL || 'http://127.0.0.1:8005').replace(/\/$/, '')

interface DshTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: any, exec: any) => Promise<any>
  presentCall?: (args: any) => any
}

async function call(path: string, body?: unknown): Promise<any> {
  const url = `${BASE_URL}${path}`
  const init: RequestInit = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  let r: Response
  try {
    r = await fetch(url, init)
  } catch (e: any) {
    throw new Error(`连不上 audio-cover 微服务 ${BASE_URL}（先确认它已启动）：${e?.message || e}`)
  }
  const text = await r.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!r.ok) {
    const detail = data?.detail || data?.error || text || r.statusText
    throw new Error(`audio-cover 返回 ${r.status}：${detail}`)
  }
  return data
}

const tools: DshTool[] = [
  {
    name: 'toggle_live_cover',
    description:
      '实时 AI 翻唱（SVC）开关。start 让 audio-cover 微服务打开「输入设备 → 变声 → 输出设备」的音频流；' +
      'stop 释放音频流。mode=bypass 为直通（验证路由），mode=tone 输出正弦测试音（验证输出链路）。' +
      '需要实时把歌声变成角色音色时，配合 VB-CABLE 等虚拟声卡使用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status', 'devices'], description: '要执行的动作' },
        input_device: { type: 'string', description: '输入设备名或索引（如 "CABLE Output (VB-Audio Virtual Cable)"），start 时用' },
        output_device: { type: 'string', description: '输出设备名或索引，留空为系统默认' },
        pitch: { type: 'integer', description: '变调半音，RVC 接入后生效，默认 0' },
        mode: { type: 'string', enum: ['bypass', 'tone'], description: 'bypass 直通 / tone 正弦测试，默认 bypass' },
        gain: { type: 'number', description: '直通增益，默认 1.0' },
      },
      required: ['action'],
    },
    async execute(args: any) {
      const action = String(args?.action || '').toLowerCase()
      if (action === 'start') {
        const body: Record<string, unknown> = {
          input_device: args?.input_device ?? null,
          output_device: args?.output_device ?? null,
          pitch: Number.isInteger(args?.pitch) ? args.pitch : 0,
          mode: args?.mode === 'tone' ? 'tone' : 'bypass',
          gain: typeof args?.gain === 'number' ? args.gain : 1.0,
        }
        const res = await call('/start', body)
        console.log(`${LOG_TAG} start -> running=${res?.running} mode=${res?.mode}`)
        return { ok: true, action: 'start', state: res }
      }
      if (action === 'stop') {
        const res = await call('/stop', {})
        console.log(`${LOG_TAG} stop -> running=${res?.running}`)
        return { ok: true, action: 'stop', state: res }
      }
      if (action === 'devices') {
        const res = await call('/devices')
        return { ok: true, action: 'devices', count: res?.count, devices: res?.devices }
      }
      const res = await call('/health')
      return { ok: true, action: 'status', state: res }
    },
    presentCall(args: any) {
      const a = String(args?.action || '').toLowerCase()
      return {
        card: 'generic',
        title: `toggle_live_cover: ${a}`,
        kind: a === 'start' || a === 'stop' ? 'write' : 'read',
      }
    },
  },
]

export default {
  name: 'dsh-audio-cover',
  apply(ctx: any) {
    console.log(`${LOG_TAG} apply (base=${BASE_URL})`)
    const disposers: Array<() => void> = []
    for (const t of tools) {
      try {
        const d = ctx.tools.register(t)
        if (typeof d === 'function') disposers.push(d)
        console.log(`${LOG_TAG} 已注册工具 ${t.name}`)
      } catch (e) {
        console.error(`${LOG_TAG} 注册工具 ${t.name} 失败：`, e)
      }
    }
    ctx.on('dispose', () => {
      console.log(`${LOG_TAG} dispose：注销 ${disposers.length} 个工具`)
      for (const d of disposers) {
        try { d() } catch { /* ignore */ }
      }
    })
  },
}
