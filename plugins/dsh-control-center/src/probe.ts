/**
 * probe.ts —— 服务状态探测（纯逻辑，可离线测）
 *
 * 两类服务两种探法：
 *   · HTTP 服务（memory 8001 / painter 8002 / game-bot 8003 / audio-cover 8005）→ GET /health，2s 超时
 *   · 非 HTTP（live-director 9001 是 **WebSocket**、IndexTTS2 9881 **没有 health 端点**）→ 只测 TCP 能否连上
 *
 * 以及本机资源：GPU 显存（nvidia-smi）、内存（os）。
 * 全部并发 + allSettled：**任何一个卡死都不能让整块面板转圈**。
 */
import net from 'node:net'
import os from 'node:os'
import { execFile } from 'node:child_process'

export interface ServiceSpec {
  key: string
  label: string
  port: number
  /** 有就是 HTTP 探活，没有就是纯 TCP 探测 */
  healthPath?: string
  kind: 'http' | 'tcp'
}

/** 面板上展示的服务清单（端口与 dsh-service-manager 一致） */
export const SERVICES: ServiceSpec[] = [
  { key: 'memory', label: 'Memory 记忆', port: 8001, healthPath: '/health', kind: 'http' },
  { key: 'painter', label: 'Painter 生图', port: 8002, healthPath: '/health', kind: 'http' },
  { key: 'gamebot', label: 'GameBot 手柄', port: 8003, healthPath: '/health', kind: 'http' },
  { key: 'audiocover', label: 'AudioCover 翻唱', port: 8005, healthPath: '/health', kind: 'http' },
  { key: 'live', label: 'Live-Director 弹幕(WS)', port: 9001, kind: 'tcp' },
  { key: 'indextts', label: 'IndexTTS2 语音', port: 9881, kind: 'tcp' },
]

export interface ServiceStatus {
  key: string
  label: string
  port: number
  kind: 'http' | 'tcp'
  up: boolean
  /** 探测耗时 ms */
  ms: number
  /** HTTP 服务返回的摘要（如 model_loaded），TCP 服务为 undefined */
  detail?: string
  error?: string
}

/** 纯 TCP 探测：能连上就算活着 */
export function probeTcp(port: number, host = '127.0.0.1', timeoutMs = 2000): Promise<{ up: boolean; ms: number; error?: string }> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (up: boolean, error?: string) => {
      if (done) return
      done = true
      sock.destroy()
      resolve({ up, ms: Date.now() - t0, error })
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false, `超时 ${timeoutMs}ms`))
    sock.once('error', (e) => finish(false, (e as Error).message))
    sock.connect(port, host)
  })
}

/** HTTP 探活：只关心 2xx / 3xx */
export async function probeHttp(
  port: number,
  path = '/health',
  timeoutMs = 2000,
): Promise<{ up: boolean; ms: number; detail?: string; error?: string }> {
  const t0 = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctrl.signal })
    let detail = ''
    try {
      const j: any = await r.json()
      // 只挑几个短字段展示，别把整个 JSON 塞面板
      if (j && typeof j === 'object') {
        const bits: string[] = []
        if (typeof j.ok === 'boolean') bits.push(`ok=${j.ok}`)
        if (typeof j.model_loaded === 'boolean') bits.push(`model=${j.model_loaded ? '已加载' : '未加载'}`)
        if (typeof j.driver_ready === 'boolean') bits.push(`driver=${j.driver_ready}`)
        if (typeof j.provider === 'string') bits.push(j.provider)
        detail = bits.join(' ')
      }
    } catch {
      /* 不是 JSON 就算了 */
    }
    return { up: r.ok, ms: Date.now() - t0, detail: detail || undefined }
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `超时 ${timeoutMs}ms` : (e as Error).message
    return { up: false, ms: Date.now() - t0, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** 并发探测全部服务；单个失败只影响它自己 */
export async function probeAll(specs: ServiceSpec[] = SERVICES, timeoutMs = 2000): Promise<ServiceStatus[]> {
  const tasks = specs.map(async (s): Promise<ServiceStatus> => {
    if (s.kind === 'http') {
      const r = await probeHttp(s.port, s.healthPath || '/health', timeoutMs)
      return { key: s.key, label: s.label, port: s.port, kind: s.kind, up: r.up, ms: r.ms, detail: r.detail, error: r.error }
    }
    const r = await probeTcp(s.port, '127.0.0.1', timeoutMs)
    return { key: s.key, label: s.label, port: s.port, kind: s.kind, up: r.up, ms: r.ms, error: r.error }
  })
  const out = await Promise.allSettled(tasks)
  return out.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { key: specs[i].key, label: specs[i].label, port: specs[i].port, kind: specs[i].kind, up: false, ms: 0, error: String(r.reason) },
  )
}

// ---------------------------------------------------------------------------
// 本机资源
// ---------------------------------------------------------------------------

export interface GpuInfo {
  name: string
  memUsedMb: number
  memTotalMb: number
  utilPct: number
}

export interface HostInfo {
  memUsedMb: number
  memTotalMb: number
  memPct: number
  gpus: GpuInfo[]
  gpuError?: string
}

/** 解析 nvidia-smi 的单行 CSV（导出供测试，不依赖真跑 GPU） */
export function parseNvidiaSmi(stdout: string): GpuInfo[] {
  const out: GpuInfo[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const parts = t.split(',').map((x) => x.trim())
    if (parts.length < 4) continue
    const used = Number(parts[1])
    const total = Number(parts[2])
    const util = Number(parts[3])
    if (!Number.isFinite(used) || !Number.isFinite(total)) continue
    out.push({ name: parts[0], memUsedMb: used, memTotalMb: total, utilPct: Number.isFinite(util) ? util : 0 })
  }
  return out
}

function readGpu(): Promise<{ gpus: GpuInfo[]; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ gpus: [], error: err.message.split('\n')[0] })
        resolve({ gpus: parseNvidiaSmi(String(stdout || '')) })
      },
    )
  })
}

/** 内存 + GPU，全部失败也返回可用结构（不抛） */
export async function readHostInfo(): Promise<HostInfo> {
  const total = os.totalmem()
  const free = os.freemem()
  const usedMb = Math.round((total - free) / 1024 / 1024)
  const totalMb = Math.round(total / 1024 / 1024)
  const gpu = await readGpu()
  return {
    memUsedMb: usedMb,
    memTotalMb: totalMb,
    memPct: totalMb ? Math.round((usedMb / totalMb) * 100) : 0,
    gpus: gpu.gpus,
    gpuError: gpu.error,
  }
}
