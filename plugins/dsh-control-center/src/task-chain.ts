/**
 * task-chain.ts —— 从 DSH 会话记录里还原"任务链"（谁在什么时候调了什么工具）
 *
 * 为什么这么做：
 *   DSH 不给插件暴露工具调用钩子，但**会话记录本身就存了** `tool/call` 与
 *   `tool/result` 两类事件。所以这里不拦截，而是**事后解析记录**。
 *
 * 关键坑（2026-11-18 踩过）：
 *   `session.v4.jsonl.zstd` 不是"一个 zstd 流"，而是**上万个小 zstd 帧首尾相接**。
 *   `zlib.zstdDecompressSync(整个文件)` 只会解出第一帧（244 字节的 session 头），
 *   看起来像是"没存工具调用"。必须按魔数 `28 B5 2F FD` 切开、逐帧解压。
 *
 * 性能：42MB / 2.7 万帧 / 6500 条调用，全量解压约 1 秒。
 *   所以这里带一层按 (路径, mtime, size) 的缓存，重复查询不再解压。
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import zlib from 'node:zlib'

const LOG_TAG = '[dsh-control-center/task-chain]'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export interface ToolCall {
  turn: number
  step: number
  seq: number
  time: number
  callId: string
  name: string
  /** 参数原文（JSON 字符串），过长时截断 */
  args: string
  /** 有对应结果时为 true */
  hasResult?: boolean
}

export interface TaskChain {
  ok: boolean
  sessionPath?: string
  sessionId?: string
  totalCalls?: number
  calls?: ToolCall[]
  error?: string
}

// ---------------- 解码 ----------------

/** 把"多帧相接"的 zstd 文件解成一整串文本 */
export function decodeZstdFrames(raw: Buffer): string {
  const offsets: number[] = []
  let i = 0
  while ((i = raw.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i)
    i += 4
  }
  if (!offsets.length) {
    // 不是多帧格式，按单流试一次
    try {
      return zlib.zstdDecompressSync(raw).toString('utf8')
    } catch {
      return ''
    }
  }

  const parts: string[] = []
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length
    try {
      const out = zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8')
      if (out) parts.push(out)
    } catch {
      /* 单帧坏了不影响整体 */
    }
  }
  return parts.join('')
}

// ---------------- 缓存 ----------------

interface CacheEntry {
  mtimeMs: number
  size: number
  lines: string[]
}
const lineCache = new Map<string, CacheEntry>()

function readLines(sessionPath: string): string[] {
  const st = statSync(sessionPath)
  const hit = lineCache.get(sessionPath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.lines

  const raw = readFileSync(sessionPath)
  const text = decodeZstdFrames(raw)
  const lines = text.split('\n').filter(Boolean)
  lineCache.set(sessionPath, { mtimeMs: st.mtimeMs, size: st.size, lines })
  return lines
}

// ---------------- 解析 ----------------

const MAX_ARGS_LEN = 300

/** 从 JSONL 行里抽出所有 tool/call，并按 callId 标记是否拿到了结果 */
export function parseToolCalls(lines: string[]): ToolCall[] {
  const calls: ToolCall[] = []
  const resultIds = new Set<string>()

  for (const ln of lines) {
    // 快速跳过不相关行（绝大多数是 assistant/message）
    if (!ln.includes('tool/call') && !ln.includes('tool/result')) continue
    let o: any
    try {
      o = JSON.parse(ln)
    } catch {
      continue
    }
    const d = o?.data
    if (!d) continue

    if (o.type === 'tool/call') {
      const args = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? '')
      calls.push({
        turn: Number(d.turn ?? 0),
        step: Number(d.step ?? 0),
        seq: Number(o.seq ?? 0),
        time: Number(o.time ?? 0),
        callId: String(d.callId ?? ''),
        name: String(d.name ?? ''),
        args: args.length > MAX_ARGS_LEN ? args.slice(0, MAX_ARGS_LEN) + '…' : args,
      })
    } else if (o.type === 'tool/result') {
      const id = d.toolCallId || d.message?.toolCallId || d.message?.source?.callId
      if (id) resultIds.add(String(id))
    }
  }

  for (const c of calls) {
    if (resultIds.has(c.callId)) c.hasResult = true
  }
  return calls
}

// ---------------- 找会话文件 ----------------

export interface FindOptions {
  /** 只看这个工作区目录名（默认取所有） */
  workspace?: string
  /** 找最近 N 个会话（默认 1） */
  recent?: number
}

/** 在 ~/.dsh/sessions 下按修改时间找最近的几个会话（每个会话目录里是 session.v4.jsonl.zstd） */
export function findRecentSessions(opts: FindOptions = {}): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const root = join(home, '.dsh', 'sessions')
  if (!existsSync(root)) return []

  const out: Array<{ path: string; mtime: number }> = []
  let wsDirs: string[]
  try {
    wsDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }

  for (const ws of wsDirs) {
    if (opts.workspace && !ws.includes(opts.workspace)) continue
    const wsPath = join(root, ws)
    let sessions: string[]
    try {
      sessions = readdirSync(wsPath, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('session'))
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const s of sessions) {
      const f = join(wsPath, s, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      try {
        out.push({ path: f, mtime: statSync(f).mtimeMs })
      } catch {
        /* ignore */
      }
    }
  }

  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, Math.max(1, opts.recent ?? 1)).map((x) => x.path)
}

/** 从文件路径反推 sessionId */
export function sessionIdOf(sessionPath: string): string {
  const dir = basename(join(sessionPath, '..'))
  return dir.startsWith('session') ? dir : basename(sessionPath)
}

// ---------------- 对外主函数 ----------------

export interface GetChainOptions {
  /** 指定会话文件；不给就用最近的 */
  sessionPath?: string
  workspace?: string
  /** 只看名字包含这些关键字的调用（可空） */
  tools?: string[]
  /** 只要最后 N 条（默认 40） */
  limit?: number
  /** 只看某个 turn 之后 */
  afterTurn?: number
}

/** 取一条任务链 */
export function getTaskChain(opts: GetChainOptions = {}): TaskChain {
  try {
    const sessionPath = opts.sessionPath || findRecentSessions({ workspace: opts.workspace, recent: 1 })[0]
    if (!sessionPath) {
      return { ok: false, error: '没找到会话记录（~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd）' }
    }
    if (!existsSync(sessionPath)) {
      return { ok: false, error: `会话文件不存在：${sessionPath}` }
    }

    const lines = readLines(sessionPath)
    let calls = parseToolCalls(lines)

    if (opts.tools?.length) {
      const set = new Set(opts.tools.map((t) => t.toLowerCase()))
      calls = calls.filter((c) => set.has(c.name.toLowerCase()))
    }
    if (typeof opts.afterTurn === 'number') {
      calls = calls.filter((c) => c.turn > opts.afterTurn!)
    }

    const total = calls.length
    const limit = Math.max(1, opts.limit ?? 40)
    // 取最后 N 条：任务链看"最近做了什么"更有用
    const tail = calls.slice(-limit)

    console.log(`${LOG_TAG} 解析 ${basename(sessionPath)}：${total} 条调用，返回最后 ${tail.length} 条`)
    return {
      ok: true,
      sessionPath,
      sessionId: sessionIdOf(sessionPath),
      totalCalls: total,
      calls: tail,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 清缓存（测试用） */
export function __clearCache(): void {
  lineCache.clear()
}
