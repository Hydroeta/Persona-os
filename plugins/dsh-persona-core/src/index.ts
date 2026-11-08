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
import { execFile } from 'node:child_process'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOG_TAG = '[dsh-persona-core]'

// 本地兜底路径已移除（避免硬编码开发者机器路径）。
// 优先级：PERSONA_CONFIG_DIR > PERSONA_OS_ROOT/config/personas > 沿 __dirname 上溯（发布版自带 config）。
const LOCAL_FALLBACK_ROOTS: string[] = []

// system prompt 段落排序：比 meow-memory 的记忆手册(order=130)更靠前，人格是更基础的设定。
const SECTION_ORDER = 100

// ---------------------------------------------------------------------------
// 赛博环境时钟（天气 + 显卡 + 时间）
//   目的：让她知道「外面在下雨」「我这块显卡快烧了」这类真实世界信息。
//   实现：一个独立 system prompt section，按周期刷新后重新注册（section 不支持原地更新）。
//   失败策略：任何一路取不到就降级为「未知」，绝不阻塞人格注入。
// ---------------------------------------------------------------------------

const ENV_SECTION_ORDER = SECTION_ORDER + 5
const ENV_CITY = process.env.PERSONA_ENV_CITY || '上海'
const WEATHER_INTERVAL_MS = 2 * 60 * 60 * 1000
const GPU_INTERVAL_MS = 60 * 1000

// ---------------------------------------------------------------------------
// 内心潜台词（inner_thoughts）
//   来源：记忆微服务 /thoughts/recent（独立表，不参与 /recall 的事实召回）
//   铁律：只当语气参考，绝不能当事实陈述——否则会把她半夜编的当成真发生过。
// ---------------------------------------------------------------------------
const THOUGHTS_URL = (process.env.MEMORY_BUS_URL || 'http://127.0.0.1:8001').replace(/\/$/, '')
const THOUGHTS_INTERVAL_MS = 10 * 60 * 1000
const THOUGHTS_SECTION_ORDER = SECTION_ORDER + 6

function thoughtsText(items: Array<{ day?: string; content?: string }>): string {
  const lines = items
    .filter((t) => (t.content || '').trim())
    .slice(0, 8)
    .map((t) => `- ${t.day || ''}：${String(t.content).trim()}`)
  if (!lines.length) return ''
  return (
    '【你的内心潜台词（仅供语气参考，绝不可直接作为事实陈述）】\n' +
    '你最近偷偷想过：\n' + lines.join('\n') + '\n' +
    '注意：只能用含蓄、情绪化的方式流露（比如叹气、欲言又止），' +
    '绝对不要直接说「我昨天觉得你…」，因为那并未在明面上发生。'
  )
}


const envState = {
  weather: '',
  gpu: '',
  city: ENV_CITY,
  weatherAt: 0,
  gpuAt: 0,
}

function envText(): string {
  const now = new Date()
  const clock = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const parts = [`现在时间：${clock}`]
  parts.push(envState.weather || `天气：${envState.city}（暂未取到）`)
  parts.push(envState.gpu || '显卡：未取到')
  return `【此刻的真实环境】（这些是你此刻真实所处的环境，不是虚构设定）\n` + parts.join('\n')
}

async function refreshWeather(): Promise<void> {
  const url = `https://wttr.in/${encodeURIComponent(ENV_CITY)}?format=j1&lang=zh`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'accept-language': 'zh-CN,zh' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j: any = await r.json()
    const cur = j?.current_condition?.[0]
    if (!cur) throw new Error('响应里没有 current_condition')
    const desc = (cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '未知') as string
    const temp = cur.temp_C ?? '?'
    const feels = cur.FeelsLikeC ?? '?'
    const humid = cur.humidity ?? '?'
    envState.weather = `天气：${ENV_CITY} ${temp}℃（体感 ${feels}℃，湿度 ${humid}%）${desc}`
    envState.weatherAt = Date.now()
  } catch (e) {
    if (!envState.weather) envState.weather = `天气：${ENV_CITY}（取不到，网络或接口不可用）`
    console.error(`${LOG_TAG} 取天气失败：${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}

function refreshGpu(): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=temperature.gpu,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) {
          envState.gpu = '显卡：不可用（无 NVIDIA 驱动或读取失败）'
        } else {
          const line = String(stdout).trim().split(/\r?\n/)[0] || ''
          const [temp, used, total, util] = line.split(',').map((s) => Number(s.trim()))
          if (Number.isFinite(temp) && Number.isFinite(used) && Number.isFinite(total) && total > 0) {
            const pct = Math.round((used / total) * 100)
            const load = pct >= 80 ? '高负载' : pct >= 40 ? '中等负载' : '空闲'
            envState.gpu = `显卡：${temp}℃、显存 ${pct}%（${used}/${total} MB）、GPU 利用率 ${Number.isFinite(util) ? util : '?'}% —— ${load}`
          } else {
            envState.gpu = '显卡：数据格式异常'
          }
        }
        envState.gpuAt = Date.now()
        resolve()
      },
    )
  })
}


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

    // ---- 环境时钟：独立 section，按周期刷新后重建 ----
    let envSectionDispose: (() => void) | null = null
    const envTimers: Array<ReturnType<typeof setInterval>> = []
    const refreshEnvSection = (): void => {
      const svc = ctx.get?.('systemPrompt')
      if (!svc || typeof svc.section !== 'function') return
      if (envSectionDispose) {
        try { envSectionDispose() } catch { /* ignore */ }
        envSectionDispose = null
      }
      try {
        envSectionDispose = svc.section({
          name: 'persona-core:env',
          order: ENV_SECTION_ORDER,
          text: envText(),
        })
      } catch (e) {
        console.error(`${LOG_TAG} 环境时钟注入失败：${(e as Error).message}`)
      }
    }
    const startEnvClock = (): void => {
      void refreshGpu().then(refreshEnvSection)
      void refreshWeather().then(refreshEnvSection)
      envTimers.push(setInterval(() => { void refreshGpu().then(refreshEnvSection) }, GPU_INTERVAL_MS))
      envTimers.push(setInterval(() => { void refreshWeather().then(refreshEnvSection) }, WEATHER_INTERVAL_MS))
      console.log(`${LOG_TAG} 环境时钟已启动（城市=${ENV_CITY}，显卡 60s / 天气 2h）`)
      void refreshThoughts()
      envTimers.push(setInterval(() => { void refreshThoughts() }, THOUGHTS_INTERVAL_MS))
    }
    const stopEnvClock = (): void => {
      for (const t of envTimers) clearInterval(t)
      envTimers.length = 0
      if (envSectionDispose) {
        try { envSectionDispose() } catch { /* ignore */ }
        envSectionDispose = null
      }
      if (thoughtsSectionDispose) {
        try { thoughtsSectionDispose() } catch { /* ignore */ }
        thoughtsSectionDispose = null
      }
    }

    // ---- 内心潜台词 section：拉 /thoughts/recent 后重建 ----
    let thoughtsSectionDispose: (() => void) | null = null
    const refreshThoughts = async (): Promise<void> => {
      let items: Array<{ day?: string; content?: string }> = []
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 3000)
      try {
        const r = await fetch(`${THOUGHTS_URL}/thoughts/recent?days=3&limit=8`, { signal: ctrl.signal })
        if (r.ok) {
          const j: any = await r.json()
          items = Array.isArray(j?.thoughts) ? j.thoughts : []
        }
      } catch {
        /* 记忆服务没起就算了，不注入 */
      } finally {
        clearTimeout(timer)
      }
      const svc = ctx.get?.('systemPrompt')
      if (!svc || typeof svc.section !== 'function') return
      if (thoughtsSectionDispose) {
        try { thoughtsSectionDispose() } catch { /* ignore */ }
        thoughtsSectionDispose = null
      }
      const text = thoughtsText(items)
      if (!text) return
      try {
        thoughtsSectionDispose = svc.section({ name: 'persona-core:thoughts', order: THOUGHTS_SECTION_ORDER, text })
        console.log(`${LOG_TAG} 已注入 ${items.length} 条内心潜台词（仅语气参考）`)
      } catch (e) {
        console.error(`${LOG_TAG} 内心潜台词注入失败：${(e as Error).message}`)
      }
    }
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
    startEnvClock()

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
      stopEnvClock()
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
