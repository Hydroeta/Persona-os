/**
 * dsh-self-play · 核心纯逻辑（与 DSH 进程解耦，可脱离宿主单测）
 *
 * 流程：拉取角色近期真实回复样本 → 本地 Ollama 审查 AI 味/客服腔（3s 超时降级）→
 *       提取 1~3 条负向指令 → 去重后追加到 config/personas/<id>/rules.json 的
 *       negative_rules（先备份 rules_backup.json，再原子写）。
 *
 * 安全契约（必须遵守，不可破坏）：
 *   - Ollama 离线 / 超时 / 返回非 JSON → 一律返回 { ok:false, reason }，绝不抛错崩溃。
 *   - 默认 dry_run=true，只预览不落盘；只有显式传 dry_run:false（或 cron 调用）才写文件。
 *   - 写文件前一定先备份；写文件用 tmp+rename 原子操作，避免半写损坏。
 *   - 无新规则（已存在 / 未发现 AI 味）→ 不备份、不写。
 *
 * 路径解析与 dsh-persona-core 完全一致：
 *   PERSONA_CONFIG_DIR > PERSONA_OS_ROOT/config/personas > LOCAL_FALLBACK_ROOTS > 沿 __dirname 上溯
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG_TAG = '[dsh-self-play]'

// 本地兜底路径已移除（避免硬编码开发者机器路径）。
// 优先级：PERSONA_CONFIG_DIR > PERSONA_OS_ROOT/config/personas > 沿 __dirname 上溯（发布版自带 config）。
const LOCAL_FALLBACK_ROOTS: string[] = []

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

export interface SelfPlayOptions {
  /** true=只生成审查结果不写文件（默认，安全）；false=备份后写入 */
  dry_run?: boolean
  /** 指定角色 id；默认读 config/personas/active.json 的 active_id */
  persona_id?: string
  /** 直接提供待审查样本（跳过 memory 拉取），用于测试/手动注入 */
  samples?: string[]
  /** Memory 微服务地址，默认 MEMORY_BUS_URL 或 http://127.0.0.1:8001 */
  memoryUrl?: string
  /** Ollama 地址，默认 OLLAMA_BASE_URL 或 http://127.0.0.1:11434 */
  ollamaUrl?: string
  /** Ollama 模型，默认 OLLAMA_MODEL 或 qwen2.5:7b */
  ollamaModel?: string
  /** Ollama 调用超时（毫秒），默认 3000 */
  timeoutMs?: number
  /** 拉取/审查的样本上限，默认 20 */
  sampleLimit?: number
}

export interface SelfPlayResult {
  ok: boolean
  reason?: string
  persona_id?: string
  samples_count?: number
  /** 本次 Ollama 新提取到的负向指令（未去重前） */
  negative_rules?: string[]
  rules_path?: string
  backup_path?: string
  backup_written?: boolean
  written?: boolean
  dry_run?: boolean
}

export interface RulesDoc {
  negative_rules: string[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// 路径解析（与 dsh-persona-core 对齐）
// ---------------------------------------------------------------------------

export function resolvePersonasRoot(): string {
  if (process.env.PERSONA_CONFIG_DIR) {
    if (existsSync(process.env.PERSONA_CONFIG_DIR)) return process.env.PERSONA_CONFIG_DIR
    throw new Error(`PERSONA_CONFIG_DIR 不存在：${process.env.PERSONA_CONFIG_DIR}`)
  }
  const osRoot = process.env.PERSONA_OS_ROOT
  if (osRoot) {
    const p = join(osRoot, 'config', 'personas')
    if (existsSync(p)) return p
  }
  for (const r of LOCAL_FALLBACK_ROOTS) {
    const p = join(r, 'config', 'personas')
    if (existsSync(p)) return p
  }
  let cur = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    const p = join(cur, 'config', 'personas')
    if (existsSync(p)) return p
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  throw new Error('找不到 config/personas 目录（可设 PERSONA_CONFIG_DIR 或 PERSONA_OS_ROOT）')
}

function listPersonaDirs(personasRoot: string): string[] {
  let entries: string[] = []
  try { entries = readdirSync(personasRoot) } catch { return [] }
  return entries.filter((name) => {
    try { return statSync(join(personasRoot, name)).isDirectory() && existsSync(join(personasRoot, name, 'persona.json')) } catch { return false }
  })
}

function getActiveId(personasRoot: string): string {
  const activeFile = join(personasRoot, 'active.json')
  if (existsSync(activeFile)) {
    try {
      const j = JSON.parse(readFileSync(activeFile, 'utf-8'))
      if (typeof j?.active_id === 'string' && j.active_id) return j.active_id
    } catch { /* fallthrough */ }
  }
  const dirs = listPersonaDirs(personasRoot)
  return dirs[0] ?? ''
}

// ---------------------------------------------------------------------------
// 1. 样本获取：memory 微服务 /recent（近期真实文本）
// ---------------------------------------------------------------------------

export async function fetchRecentSamples(memoryUrl: string, limit: number): Promise<string[]> {
  const url = `${memoryUrl.replace(/\/$/, '')}/recent?days=7&limit=${Math.min(Math.max(limit * 3, limit), 500)}`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return []
    const data = (await r.json()) as any
    const list = Array.isArray(data?.results) ? data.results : []
    const out: string[] = []
    for (const item of list) {
      const c = typeof item?.content === 'string' ? item.content.trim() : ''
      if (c.length >= 4) out.push(c)
      if (out.length >= limit) break
    }
    return out
  } catch {
    return [] // memory 离线 → 空样本，由上层给出"无可用样本"
  }
}

// ---------------------------------------------------------------------------
// 2. Ollama 审查
// ---------------------------------------------------------------------------

/** 严格按用户给定的裁判 Prompt。只改样本注入，不动裁判人设。 */
const AUDIT_SYSTEM_PROMPT =
  '你是一个严格的 AI 语感裁判。请审查以下 AI 角色的回复样本，找出其中带有"客服腔"、"AI 味"' +
  '（如：长篇大论说教、用"首先/其次"、用"希望帮到你"结尾）的句子。请输出一个 JSON 数组，' +
  '包含 1-3 条需要避免的负向指令（例如："绝对不要用客服腔的总结结尾"）。' +
  '如果没有发现 AI 味，返回空数组。'

function buildAuditUserPrompt(samples: string[]): string {
  const body = samples.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return `以下是该角色最近的回复样本：\n\n${body}\n\n请只输出 JSON 数组，不要输出任何其他文字、解释或 markdown 代码块标记。`
}

/**
 * 从模型原始输出中提取第一个 JSON 字符串数组。
 * 用括号深度扫描定位完整数组（经验：模型常把 JSON 包在 ```json 里或前后加散文，
 * 正则 /\[.*\]/ 会在嵌套/多行时截断或误匹配）。
 */
export function extractStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const start = raw.indexOf('[')
  if (start < 0) return []
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '[') depth++
    else if (ch === ']') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return []
  let arr: unknown
  try { arr = JSON.parse(raw.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0 && x.length <= 300)
    .slice(0, 3)
}

export async function auditWithOllama(
  samples: string[],
  opts: { url: string; model: string; timeoutMs: number },
): Promise<string[]> {
  if (!samples.length) return []
  const messages = [
    { role: 'system' as const, content: AUDIT_SYSTEM_PROMPT },
    { role: 'user' as const, content: buildAuditUserPrompt(samples) },
  ]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  let text = ''
  try {
    const r = await fetch(`${opts.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model, messages, stream: false, temperature: 0.3 }),
      signal: controller.signal,
    })
    text = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } finally {
    clearTimeout(timer)
  }
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { return [] }
  const content = data?.choices?.[0]?.message?.content ?? ''
  return extractStringArray(content)
}

// ---------------------------------------------------------------------------
// 3. 规则读写（备份 + 原子写 + 去重）
// ---------------------------------------------------------------------------

export function loadRules(rulesPath: string): RulesDoc {
  if (!existsSync(rulesPath)) return { negative_rules: [] }
  try {
    const j = JSON.parse(readFileSync(rulesPath, 'utf-8'))
    if (j && typeof j === 'object') {
      if (!Array.isArray(j.negative_rules)) j.negative_rules = []
      return j as RulesDoc
    }
  } catch { /* 文件损坏 → 按空处理，避免污染；备份会保留损坏原件 */ }
  return { negative_rules: [] }
}

export function mergeNegativeRules(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((x) => x.trim()))
  const out = [...existing]
  for (const r of incoming) {
    const t = (typeof r === 'string' ? r : '').trim()
    if (t && !seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

/**
 * 先把当前 rules.json 备份为 rules_backup.json，再把 next 原子写入 rules.json。
 * dry_run=true 时完全不碰磁盘。返回是否真的写了备份 / 主文件。
 */
export function backupAndWriteRules(
  rulesPath: string,
  next: RulesDoc,
  dryRun: boolean,
): { backup_written: boolean; written: boolean } {
  if (dryRun) return { backup_written: false, written: false }
  const backupPath = rulesPath.replace(/\.json$/i, '_backup.json')
  let backupWritten = false
  try {
    if (existsSync(rulesPath)) {
      writeFileSync(backupPath, readFileSync(rulesPath), 'utf-8')
    } else {
      // 首次创建：备份一份"创建前"的空快照，便于还原
      writeFileSync(backupPath, JSON.stringify({ negative_rules: [] }, null, 2), 'utf-8')
    }
    backupWritten = true
  } catch {
    backupWritten = false
  }
  // 原子写：写 .tmp → rename，杜绝半写
  const tmp = `${rulesPath}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  renameSync(tmp, rulesPath)
  return { backup_written: backupWritten, written: true }
}

// ---------------------------------------------------------------------------
// 4. 编排：runSelfPlay
// ---------------------------------------------------------------------------

export async function runSelfPlay(opts: SelfPlayOptions = {}): Promise<SelfPlayResult> {
  const dryRun = opts.dry_run !== false // 默认 true：安全预览
  const memoryUrl = opts.memoryUrl || process.env.MEMORY_BUS_URL || 'http://127.0.0.1:8001'
  const ollamaUrl = opts.ollamaUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
  const ollamaModel = opts.ollamaModel || process.env.OLLAMA_MODEL || 'qwen2.5:7b'
  const timeoutMs = opts.timeoutMs ?? 3000
  const sampleLimit = opts.sampleLimit ?? 20

  // ---- 样本 ----
  let samples: string[] = Array.isArray(opts.samples)
    ? opts.samples.filter((s) => typeof s === 'string' && s.trim())
    : []
  if (!samples.length) {
    try { samples = await fetchRecentSamples(memoryUrl, sampleLimit) } catch { samples = [] }
  }
  if (!samples.length) {
    return { ok: false, reason: '无可用样本（memory 离线或近期无记录）', dry_run: dryRun, samples_count: 0 }
  }

  // ---- Ollama 审查（超时/离线 → 降级，绝不抛错）----
  let negativeRules: string[] = []
  try {
    negativeRules = await auditWithOllama(samples.slice(0, sampleLimit), { url: ollamaUrl, model: ollamaModel, timeoutMs })
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    const offline = /abort|timeout|fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|network/i.test(msg)
    return {
      ok: false,
      reason: offline ? 'Ollama 离线' : `Ollama 调用失败：${msg}`,
      dry_run: dryRun,
      samples_count: samples.length,
    }
  }
  if (!negativeRules.length) {
    return {
      ok: true,
      reason: '未发现 AI 味，无需更新',
      samples_count: samples.length,
      negative_rules: [],
      dry_run: dryRun,
      written: false,
    }
  }

  // ---- 定位 persona + rules.json ----
  let personasRoot: string
  try { personasRoot = resolvePersonasRoot() } catch (e) {
    return {
      ok: false,
      reason: `找不到 config/personas：${(e as Error).message}`,
      samples_count: samples.length,
      negative_rules: negativeRules,
      dry_run: dryRun,
    }
  }
  const personaId = (opts.persona_id ?? '').trim() || getActiveId(personasRoot)
  if (!personaId) {
    return { ok: false, reason: '无法确定 persona_id', samples_count: samples.length, negative_rules: negativeRules, dry_run: dryRun }
  }
  const rulesPath = join(personasRoot, personaId, 'rules.json')
  const backupPath = rulesPath.replace(/\.json$/i, '_backup.json')

  // ---- 合并去重 ----
  const cur = loadRules(rulesPath)
  const existing = Array.isArray(cur.negative_rules) ? cur.negative_rules : []
  const merged = mergeNegativeRules(existing, negativeRules)
  const newCount = merged.length - existing.length
  if (newCount <= 0) {
    return {
      ok: true,
      reason: '提取到的规则已全部存在，无新增',
      persona_id: personaId,
      samples_count: samples.length,
      negative_rules: [],
      rules_path: rulesPath,
      dry_run: dryRun,
      written: false,
    }
  }

  // ---- 备份 + 写入 ----
  const next: RulesDoc = { ...cur, negative_rules: merged }
  const { backup_written, written } = backupAndWriteRules(rulesPath, next, dryRun)
  return {
    ok: true,
    reason: dryRun
      ? 'dry_run：仅生成审查结果，未写入文件'
      : `已追加 ${newCount} 条负向规则到 ${personaId}/rules.json`,
    persona_id: personaId,
    samples_count: samples.length,
    negative_rules: negativeRules,
    rules_path: rulesPath,
    backup_path: backupPath,
    backup_written,
    written,
    dry_run: dryRun,
  }
}
