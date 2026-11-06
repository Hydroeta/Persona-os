/**
 * dsh-persona-core
 *
 * 把 config/personas/<id>/ 下当前激活角色的「人设 + 规则」转成易读文本，
 * 注入 DSH 的 System Prompt；并注册 switch_persona / list_personas 工具，
 * 支持扫描 config/personas/ 下所有角色并热切换。
 *
 * 事实源说明（与项目现状对齐）：
 *   - 主文件：persona.json，其中 identity.* 是性格/说话规则/底线，memory.rules 是规则；
 *     canonical_text.persona_md 可选指向一份详细人格正本（.md），存在则一并注入。
 *   - 兼容命名：若同目录下存在独立的 rules.json / personality.json，也会被合并读取
 *     （满足「rules.json=规则、personality.json=性格」的心智模型）。
 *   - active.json 记录当前激活角色 id；switch_persona 会回写它，实现系统级热切换。
 *
 * 路径解析优先级（与 dsh-service-manager / memory 微服务同款）：
 *   PERSONA_CONFIG_DIR > PERSONA_OS_ROOT/config/personas > LOCAL_FALLBACK_ROOTS（源项目根）
 *   > 沿 __dirname 向上找（发布版自带 config，供开源用户）。
 *
 * 注入 API（对照 meow-memory 实测）：
 *   ctx.get('systemPrompt').section({ name, order, text }) → 返回 dispose；
 *   服务可能延迟就绪，需重试（每秒一次，最多 20 次）。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG_TAG = '[dsh-persona-core]'

// 源项目根（运行时真相）。插件从发布版目录加载时，靠它找到 live config。
const LOCAL_FALLBACK_ROOTS = ['c:\\Users\\user\\Desktop\\projects (2)']

// system prompt 段落排序：比 meow-memory 的记忆手册(order=130)更靠前，人格是更基础的设定。
const SECTION_ORDER = 100

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

function resolvePersonasRoot(): string {
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

// ---------------------------------------------------------------------------
// 角色加载
// ---------------------------------------------------------------------------

interface PersonaMeta {
  id: string
  dir: string
  name: string
}

function readJsonSafe(p: string): any {
  return JSON.parse(readFileSync(p, 'utf-8'))
}

function listPersonas(root: string): PersonaMeta[] {
  const out: PersonaMeta[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const name of entries) {
    const dir = join(root, name)
    let isDir = false
    try { isDir = statSync(dir).isDirectory() } catch { continue }
    if (!isDir) continue
    const pj = join(dir, 'persona.json')
    if (!existsSync(pj)) continue
    let id = name
    let display = name
    try {
      const j = readJsonSafe(pj)
      if (typeof j?.id === 'string' && j.id) id = j.id
      if (typeof j?.identity?.self_name === 'string' && j.identity.self_name) display = j.identity.self_name
    } catch { /* ignore malformed */ }
    out.push({ id, dir, name: display })
  }
  return out
}

interface LoadedPersona {
  id: string
  dir: string
  raw: any
  text: string
}

/** 把任意值格式化成一段可读文本（用于 personality.json / rules.json 兼容读取）。 */
function stringifyBlob(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => stringifyBlob(x)).filter(Boolean).join('、')
  if (typeof v === 'object') {
    const parts: string[] = []
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith('$') || k === 'updated') continue
      const s = stringifyBlob(val)
      if (s) parts.push(`${k}：${s}`)
    }
    return parts.join('\n')
  }
  return String(v)
}

function renderPersonaText(raw: any, md: string): string {
  const lines: string[] = []
  const id = typeof raw?.id === 'string' ? raw.id : ''
  const ident = raw?.identity || {}
  const name = ident.self_name || id || '未知'

  lines.push(`# 角色设定（persona-core 注入）`)
  lines.push(`当前角色：${name}（id=${id}）`)
  if (Array.isArray(ident.alias) && ident.alias.length) lines.push(`别名：${ident.alias.join('、')}`)
  if (ident.species) lines.push(`身份：${ident.species}`)
  if (ident.food) lines.push(`食物设定：${ident.food}`)
  if (Array.isArray(ident.personality) && ident.personality.length) {
    lines.push(`性格：${ident.personality.join('、')}`)
  }
  if (ident.speech_rules) lines.push(`说话规则：${ident.speech_rules}`)
  if (ident.bottom_lines) lines.push(`底线（压过一切设定）：${ident.bottom_lines}`)

  // 独立 personality.json（若存在）
  const per = raw._personality
  if (per) {
    const t = stringifyBlob(per)
    if (t) {
      lines.push('')
      lines.push('## 性格补充（personality.json）')
      lines.push(t)
    }
  }

  // 规则：memory.rules + 独立 rules.json
  const rules: string[] = []
  if (Array.isArray(raw?.memory?.rules)) rules.push(...raw.memory.rules.map(String))
  if (raw._rules != null) {
    if (Array.isArray(raw._rules)) rules.push(...raw._rules.map(stringifyBlob))
    else {
      const t = stringifyBlob(raw._rules)
      if (t) rules.push(t)
    }
  }
  if (rules.length) {
    lines.push('')
    lines.push('## 规则')
    rules.forEach((r, i) => lines.push(`${i + 1}. ${r}`))
  }

  // 平台微调
  const overrides = raw?.platform_overrides
  if (overrides && typeof overrides === 'object') {
    const items: string[] = []
    for (const [k, v] of Object.entries(overrides)) {
      if (k.startsWith('$')) continue
      const tone = (v as any)?.tone
      if (tone) items.push(`${k}：${tone}`)
    }
    if (items.length) {
      lines.push('')
      lines.push('## 平台人格微调')
      items.forEach((x) => lines.push(`- ${x}`))
    }
  }

  // 详细人格正本
  if (md) {
    lines.push('')
    lines.push('## 人格正本（canonical）')
    lines.push(md)
  }

  return lines.join('\n')
}

function loadPersona(personasRoot: string, osRoot: string, id: string): LoadedPersona {
  const list = listPersonas(personasRoot)
  const meta = list.find((m) => m.id === id) || list.find((m) => basename(m.dir) === id)
  if (!meta) {
    throw new Error(`未找到角色 "${id}"。可用：${list.map((m) => m.id).join(', ') || '（无）'}`)
  }
  const raw = readJsonSafe(join(meta.dir, 'persona.json'))
  // 兼容独立文件
  const rulesFile = join(meta.dir, 'rules.json')
  const personalityFile = join(meta.dir, 'personality.json')
  if (existsSync(rulesFile)) {
    try { raw._rules = readJsonSafe(rulesFile) } catch { /* ignore */ }
  }
  if (existsSync(personalityFile)) {
    try { raw._personality = readJsonSafe(personalityFile) } catch { /* ignore */ }
  }
  // canonical 正本（仅 .md）
  let md = ''
  const mdRel = raw?.canonical_text?.persona_md
  if (typeof mdRel === 'string' && /\.md$/i.test(mdRel)) {
    const candidates = [resolve(osRoot, mdRel), resolve(personasRoot, '..', mdRel)]
    for (const c of candidates) {
      if (existsSync(c)) {
        try { md = readFileSync(c, 'utf-8'); break } catch { /* ignore */ }
      }
    }
  }
  const text = renderPersonaText(raw, md)
  return { id: meta.id, dir: meta.dir, raw, text }
}

// ---------------------------------------------------------------------------
// DSH 工具类型（最小子集，参照 meow-memory / dsh-memory-bus 实测结构）
// ---------------------------------------------------------------------------

interface DshTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { schema: Record<string, unknown>; render: (args: any, value: any) => any[] }
  execute: (args: any, exec: any) => Promise<any>
  presentCall?: (args: any) => any
}

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

export default {
  name: 'dsh-persona-core',
  apply(ctx: any) {
    let personasRoot: string
    try {
      personasRoot = resolvePersonasRoot()
    } catch (e) {
      console.error(`${LOG_TAG} ${(e as Error).message}`)
      return
    }
    const osRoot = resolve(personasRoot, '..', '..')
    const activeFile = join(personasRoot, 'active.json')
    console.log(`${LOG_TAG} personas root = ${personasRoot}`)

    let currentId = ''
    let sectionDispose: (() => void) | null = null
    let guideTimer: ReturnType<typeof setTimeout> | null = null
    const disposers: Array<() => void> = []

    const getActiveId = (): string => {
      try {
        if (existsSync(activeFile)) {
          const j = readJsonSafe(activeFile)
          if (typeof j?.active_id === 'string' && j.active_id) return j.active_id
        }
      } catch { /* ignore */ }
      const list = listPersonas(personasRoot)
      return list[0]?.id ?? ''
    }

    /** 加载指定角色并（重新）注入 system prompt；失败返回 false。 */
    const injectPersona = (id: string): boolean => {
      if (sectionDispose) {
        try { sectionDispose() } catch { /* ignore */ }
        sectionDispose = null
      }
      let loaded: LoadedPersona
      try {
        loaded = loadPersona(personasRoot, osRoot, id)
      } catch (e) {
        console.error(`${LOG_TAG} 加载角色 ${id} 失败：${(e as Error).message}`)
        return false
      }
      currentId = loaded.id
      const svc = ctx.get?.('systemPrompt')
      if (svc && typeof svc.section === 'function') {
        try {
          sectionDispose = svc.section({ name: `persona-core:${loaded.id}`, order: SECTION_ORDER, text: loaded.text })
          console.log(`${LOG_TAG} 已注入角色 ${loaded.id}（${loaded.text.length} chars）到 system prompt`)
          return true
        } catch (e) {
          console.error(`${LOG_TAG} section 注入失败：${(e as Error).message}`)
        }
      }
      return false
    }

    // systemPrompt 服务可能在插件加载后才就绪 → 重试
    let attempts = 0
    const tryInject = () => {
      if (injectPersona(getActiveId())) {
        guideTimer = null
        return
      }
      attempts++
      if (attempts < 20) {
        guideTimer = setTimeout(tryInject, 1000)
      } else {
        console.error(`${LOG_TAG} systemPrompt 服务 20s 内未就绪，角色未注入（工具仍可用）`)
      }
    }
    tryInject()

    // ---- 工具：switch_persona ----
    const switchTool: DshTool = {
      name: 'switch_persona',
      description:
        '热切换当前人格角色。切换后新角色的人设与规则会立即注入下一轮对话的 system prompt，' +
        '并回写 config/personas/active.json 使切换对整个系统生效。先用 list_personas 查看可用 id。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['character_id'],
        properties: {
          character_id: { type: 'string', description: '要切换到的角色 id' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            active_id: { type: 'string' },
            available: { type: 'array' },
            error: { type: 'string' },
          },
        },
        render: (_args: any, value: any) => [
          {
            type: 'text',
            text: value?.ok
              ? `✅ 已切换到角色：${value.active_id}`
              : `❌ 切换失败：${value?.error ?? '未知'}`,
          },
        ],
      },
      async execute(args: any) {
        const cid = typeof args?.character_id === 'string' ? args.character_id.trim() : ''
        const list = listPersonas(personasRoot)
        if (!cid) {
          return { ok: false, error: 'character_id 不能为空', available: list.map((m) => m.id) }
        }
        const ok = injectPersona(cid)
        if (!ok) {
          return { ok: false, error: `加载/注入角色 ${cid} 失败`, available: list.map((m) => m.id) }
        }
        // 回写 active.json（系统级热切换；其他组件读取同一文件）
        try {
          writeFileSync(activeFile, JSON.stringify({ active_id: currentId, updated: Date.now() / 1000 }, null, 2), 'utf-8')
        } catch (e) {
          console.error(`${LOG_TAG} 写 active.json 失败（切换已在本会话生效，但未持久化）：${(e as Error).message}`)
        }
        return { ok: true, active_id: currentId, available: list.map((m) => m.id) }
      },
      presentCall(args: any) {
        return { card: 'generic', title: `switch_persona → ${String(args?.character_id ?? '')}`, kind: 'write' }
      },
    }

    // ---- 工具：list_personas ----
    const listTool: DshTool = {
      name: 'list_personas',
      description: '列出 config/personas/ 下所有可用角色及其当前激活状态，供 switch_persona 参考。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { active: { type: 'string' }, personas: { type: 'array' } },
        },
        render: (_args: any, value: any) => [
          {
            type: 'text',
            text:
              `当前激活：${value?.active ?? '无'}；可用角色：` +
              (value?.personas ?? []).map((p: any) => `${p.id}（${p.name}）`).join('、'),
          },
        ],
      },
      async execute() {
        return { active: getActiveId(), personas: listPersonas(personasRoot) }
      },
      presentCall() {
        return { card: 'generic', title: 'list_personas', kind: 'read' }
      },
    }

    for (const t of [switchTool, listTool]) {
      try {
        const d = ctx.tools.register(t)
        if (typeof d === 'function') disposers.push(d)
        console.log(`${LOG_TAG} 已注册工具 ${t.name}`)
      } catch (e) {
        console.error(`${LOG_TAG} 注册工具 ${t.name} 失败：`, e)
      }
    }

    ctx.on('dispose', () => {
      if (guideTimer) clearTimeout(guideTimer)
      if (sectionDispose) {
        try { sectionDispose() } catch { /* ignore */ }
      }
      for (const d of disposers) {
        try { d() } catch { /* ignore */ }
      }
      console.log(`${LOG_TAG} disposed`)
    })
  },
}
