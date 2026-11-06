/**
 * dsh-service-manager
 *
 * 职责（统一进程生命周期管理）：
 *   DSH 加载本插件时（apply），在后台自动拉起本地微服务；卸载/热重载时（dispose），
 *   把「本插件拉起的」进程树彻底杀掉，防止僵尸进程占满显存/端口。
 *
 * 目前托管四个服务：
 *   - IndexTTS2  语音合成   端口 9881（无 HTTP 健康端点，spawn 后只看日志）
 *   - Memory     记忆存取   端口 8001（GET /health）
 *   - Painter    生图引擎   端口 8002（GET /health）
 *   - GameBot    虚拟手柄   端口 8003（GET /health，vgamepad + ViGEmBus）
 *
 * 契约说明（对照 DSH 0.2.0-rc.2 实测）：
 *   - 退出钩子是 ctx.on("dispose", cb)。
 *   - 该版本没有顶层 "ready" 事件；插件启动初始化直接写在 apply(ctx) 里。
 *     因此在 apply 里异步拉起进程（不阻塞插件加载），在 dispose 里同步清理。
 *
 * 路径解析（两套根，优先级从高到低）：
 *   源项目根 sourceRoot（含 venv 算力 / 模型权重 / tools / memory.db）：
 *     - PERSONA_OS_ROOT（若同时含 ohwhale-deploy/scripts/indextts_server.py 与 index-tts/.venv）
 *     - 从插件 lib 位置上溯探测（link 安装时 lib/index.js 上溯三级为项目根）
 *     - LOCAL_FALLBACK_ROOTS 里的已知本地源项目绝对路径
 *   发布版根 releaseRoot（含 core-services/<svc>/main.py 脚本）：
 *     - PERSONA_OS_ROOT（若含 core-services/memory/main.py）
 *     - 从插件 lib 位置上溯探测（link 安装时上溯三级 = 发布版根）
 *     - LOCAL_FALLBACK_ROOTS 直接命中，或 <root>/github-release/persona-os
 *
 * 进程归属原则（避免误杀，经验 1184468）：
 *   - 启动前先探端口：若已被占用 → 视为「已有实例在跑」，跳过拉起且不登记（dispose 不动它）。
 *   - dispose 只杀「本插件 spawn 出来并登记过 pid」的进程树；绝不按端口盲杀。
 *
 * 环境透传：spawn 时 env = {...process.env}；若未设置 PERSONA_OS_ROOT，则补成 sourceRoot，
 *   让 memory / painter 微服务能定位源项目的 memory.db 与 tools/painter.py。
 *   其余 *_PORT / *_PYTHON / *_SERVER 覆盖变量原样透传，优先级 env > 默认路径。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG_TAG = '[dsh-service-manager]'
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 本地兜底路径已移除（避免硬编码开发者机器路径）。
 * 源项目根 / 发布版根定位优先级：PERSONA_OS_ROOT > 从 lib 位置上溯探测。
 * 若上溯找不到 index-tts/.venv，请设置 PERSONA_OS_ROOT 指向含 ohwhale-deploy 的工作区根。
 */
const LOCAL_FALLBACK_ROOTS: string[] = []

// ---------------------------------------------------------------------------
// 路径探测
// ---------------------------------------------------------------------------

function looksLikeSourceRoot(cur: string): boolean {
  return (
    existsSync(path.join(cur, 'ohwhale-deploy', 'scripts', 'indextts_server.py')) &&
    existsSync(path.join(cur, 'index-tts', '.venv', 'Scripts', 'python.exe'))
  )
}

/** 沿 HERE 上溯找标记文件，最多 maxUp 层；找到第一个命中即返回。 */
function walkUpForMarker(marker: string, maxUp = 8): string | null {
  // link 安装：lib/index.js -> 上溯三级为项目/发布版根；找不到再继续向上
  let cur = path.resolve(HERE, '..', '..', '..')
  for (let i = 0; i < maxUp; i++) {
    if (existsSync(path.join(cur, marker))) return cur
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function findSourceRoot(): string | null {
  const envRoot = process.env.PERSONA_OS_ROOT
  if (envRoot && looksLikeSourceRoot(envRoot)) return path.resolve(envRoot)

  const found = walkUpForMarker(path.join('ohwhale-deploy', 'scripts', 'indextts_server.py'))
  if (found) return found

  for (const root of LOCAL_FALLBACK_ROOTS) {
    if (looksLikeSourceRoot(root)) return path.resolve(root)
  }
  return null
}

function findReleaseRoot(): string | null {
  const marker = path.join('core-services', 'memory', 'main.py')
  const envRoot = process.env.PERSONA_OS_ROOT
  if (envRoot && existsSync(path.join(envRoot, marker))) return path.resolve(envRoot)

  const found = walkUpForMarker(marker)
  if (found) return found

  for (const root of LOCAL_FALLBACK_ROOTS) {
    if (existsSync(path.join(root, marker))) return path.resolve(root)
    const inRelease = path.join(root, 'github-release', 'persona-os')
    if (existsSync(path.join(inRelease, marker))) return inRelease
  }
  return null
}

// ---------------------------------------------------------------------------
// 服务描述
// ---------------------------------------------------------------------------

interface Svc {
  name: string
  tag: string
  pythonEnv: string
  pythonRel: (sourceRoot: string) => string
  scriptEnv: string
  scriptRel: (releaseRoot: string) => string
  portEnv: string
  portDefault: number
  healthPath?: string
  cwdFrom: 'source' | 'release'
}

const SERVICES: Svc[] = [
  {
    name: 'IndexTTS2',
    tag: 'tts',
    pythonEnv: 'INDEXTTS_PYTHON',
    pythonRel: (r) => path.join(r, 'index-tts', '.venv', 'Scripts', 'python.exe'),
    scriptEnv: 'INDEXTTS_SERVER',
    scriptRel: (r) => path.join(r, 'ohwhale-deploy', 'scripts', 'indextts_server.py'),
    portEnv: 'INDEXTTS_PORT',
    portDefault: 9881,
    // IndexTTS2 的 indextts_server.py 无标准 HTTP 健康端点 → 不轮询，spawn 后只看日志
    cwdFrom: 'source',
  },
  {
    name: 'Memory',
    tag: 'memory',
    pythonEnv: 'MEMORY_PYTHON',
    pythonRel: (r) => path.join(r, 'ohwhale-deploy', '.venv', 'Scripts', 'python.exe'),
    scriptEnv: 'MEMORY_SERVER',
    scriptRel: (r) => path.join(r, 'core-services', 'memory', 'main.py'),
    portEnv: 'MEMORY_PORT',
    portDefault: 8001,
    healthPath: '/health',
    cwdFrom: 'release',
  },
  {
    name: 'Painter',
    tag: 'painter',
    pythonEnv: 'PAINTER_PYTHON',
    pythonRel: (r) => path.join(r, 'ohwhale-deploy', '.venv', 'Scripts', 'python.exe'),
    scriptEnv: 'PAINTER_SERVER',
    scriptRel: (r) => path.join(r, 'core-services', 'painter', 'main.py'),
    portEnv: 'PAINTER_PORT',
    portDefault: 8002,
    healthPath: '/health',
    cwdFrom: 'release',
  },
  {
    name: 'GameBot',
    tag: 'game',
    pythonEnv: 'GAME_PYTHON',
    pythonRel: (r) => path.join(r, 'ohwhale-deploy', '.venv', 'Scripts', 'python.exe'),
    scriptEnv: 'GAME_SERVER',
    scriptRel: (r) => path.join(r, 'core-services', 'game-bot', 'main.py'),
    portEnv: 'GAME_BOT_PORT',
    portDefault: 8003,
    healthPath: '/health',
    cwdFrom: 'release',
  },
]

// ---------------------------------------------------------------------------
// 端口探测：避免重复拉起
// ---------------------------------------------------------------------------

function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, 800)
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/** 带重试的占用探测：并发/高负载下偶发 connect 抖动，重试 2 次避免误判「空闲」而重复拉起。
 *  各微服务脚本自身也有端口防冲突（占用则 exit 1），这里只是让日志更干净。 */
async function portInUseRobust(port: number, host = '127.0.0.1'): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    if (await portInUse(port, host)) return true
    if (i === 0) await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

// ---------------------------------------------------------------------------
// 进程管理
// ---------------------------------------------------------------------------

const children = new Map<string, ChildProcess>()
let disposed = false

function killTreeSync(pid: number): void {
  if (process.platform === 'win32') {
    // Windows：taskkill /T 杀整个进程树（含 torch 子进程），/F 强制
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

async function waitHealth(svc: Svc, port: number, timeoutMs = 15000): Promise<boolean> {
  if (!svc.healthPath) return true
  const url = `http://127.0.0.1:${port}${svc.healthPath}`
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) {
        console.log(`${LOG_TAG} ${svc.name} 就绪（port=${port}）`)
        return true
      }
    } catch {
      /* still starting */
    }
    await new Promise((r) => setTimeout(r, 700))
  }
  console.warn(`${LOG_TAG} ${svc.name} 健康检查超时（port=${port}），进程可能仍在启动，未杀（保留现场排查）`)
  return false
}

async function startService(svc: Svc, sourceRoot: string, releaseRoot: string | null): Promise<void> {
  const python = process.env[svc.pythonEnv] || svc.pythonRel(sourceRoot)
  const needRelease = svc.cwdFrom === 'release' || svc.scriptRel.name // 所有脚本都在 release 树
  if (!existsSync(python)) {
    console.error(`${LOG_TAG} ${svc.name} 跳过：python 不存在 ${python}（可设 ${svc.pythonEnv}）`)
    return
  }
  let script: string
  if (process.env[svc.scriptEnv]) {
    script = process.env[svc.scriptEnv]!
  } else {
    if (!releaseRoot) {
      console.error(`${LOG_TAG} ${svc.name} 跳过：无法定位发布版根（可设 PERSONA_OS_ROOT 或 ${svc.scriptEnv}）`)
      return
    }
    script = svc.scriptRel(releaseRoot)
  }
  if (!existsSync(script)) {
    console.error(`${LOG_TAG} ${svc.name} 跳过：脚本不存在 ${script}`)
    return
  }

  const port = Number(process.env[svc.portEnv] || svc.portDefault)

  if (await portInUseRobust(port)) {
    console.log(`${LOG_TAG} 端口 ${port} 已被占用，${svc.name} 可能已在运行 → 跳过拉起（dispose 不会动它）`)
    return
  }

  const cwd = svc.cwdFrom === 'release' && releaseRoot ? releaseRoot : sourceRoot
  // 透传现有环境；若未设 PERSONA_OS_ROOT 则补成 sourceRoot，让 memory/painter 定位源项目
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (!env.PERSONA_OS_ROOT) env.PERSONA_OS_ROOT = sourceRoot

  const child = spawn(python, [script], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const pid = child.pid
  if (!pid) {
    console.error(`${LOG_TAG} ${svc.name} spawn 失败：未拿到 pid`)
    return
  }
  children.set(svc.name, child)
  console.log(`${LOG_TAG} 已拉起 ${svc.name}（pid=${pid}，port=${port}）`)

  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`${LOG_TAG}[${svc.tag}] ${chunk}`))
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`${LOG_TAG}[${svc.tag}-err] ${chunk}`))
  child.on('error', (err) => {
    console.error(`${LOG_TAG} ${svc.name} 子进程异常：`, err)
    children.delete(svc.name)
  })
  child.on('exit', (code, signal) => {
    console.log(`${LOG_TAG} ${svc.name} 退出 code=${code} signal=${signal ?? 'null'}`)
    children.delete(svc.name)
  })

  // 不阻塞 apply：健康检查在后台跑，就绪/超时只记日志
  waitHealth(svc, port).catch(() => {})
}

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-service-manager',
  apply(ctx: any) {
    console.log(`${LOG_TAG} apply`)

    const sourceRoot = findSourceRoot()
    const releaseRoot = findReleaseRoot()
    if (!sourceRoot) {
      console.error(`${LOG_TAG} 无法定位源项目根：请设置 PERSONA_OS_ROOT 指向 persona-os 源项目根（含 index-tts/.venv）`)
    } else {
      console.log(`${LOG_TAG} sourceRoot=${sourceRoot}`)
    }
    console.log(`${LOG_TAG} releaseRoot=${releaseRoot ?? '(未找到)'}`)

    // 异步拉起，不阻塞插件加载；失败只记日志，不让插件加载崩溃
    for (const svc of SERVICES) {
      if (sourceRoot) {
        startService(svc, sourceRoot, releaseRoot).catch((err) =>
          console.error(`${LOG_TAG} 拉起 ${svc.name} 失败：`, err),
        )
      }
    }

    ctx.on('dispose', () => {
      if (disposed) return
      disposed = true
      const entries = Array.from(children.entries())
      if (entries.length === 0) {
        console.log(`${LOG_TAG} dispose：无本插件拉起的活动子进程`)
        return
      }
      for (const [name, child] of entries) {
        const pid = child.pid
        if (!pid) continue
        console.log(`${LOG_TAG} dispose：终止 ${name} 进程树 pid=${pid}`)
        killTreeSync(pid)
      }
      children.clear()
    })
  },
}
