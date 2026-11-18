/**
 * persona-assets.ts —— 读「当前激活角色的资产」（多角色解耦的事实源）
 *
 * 为什么约定读文件而不是跨插件服务：
 *   `dsh-control-center` 是独立进程、`tts.ts` 在另一个插件里，`ctx.provide/get` 对它们
 *   不可靠（启动时机不一致）。而 `config/personas/` 是**磁盘上的唯一事实源**，
 *   谁都能读、且切换角色后立刻生效，不需要重启。
 *
 * 约定（三个字段的名字不能改，别的插件照这个读）：
 *   config/personas/active.json          { active_id: "ohwhale" }
 *   config/personas/<id>/persona.json    { voice: { ref_audio }, assets: { ... } }
 *     · voice.ref_audio   参考音（相对仓库根，或绝对路径）
 *     · assets.expr_dir   表情图目录（相对仓库根）
 *     · assets.expr_prefix 表情文件名前缀（默认 pixel_）
 *     · assets.theme_color / theme_sea 面板主色
 *     · assets.display_name 面板上显示的名字（缺省回退 identity.self_name）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'

const LOG_TAG = '[dsh-persona-core/assets]'

export interface PersonaAssets {
  id: string
  displayName: string
  /** 表情目录绝对路径（可能不存在，调用方自行判断） */
  exprDir: string
  exprPrefix: string
  themeColor: string
  themeSea: string
  /** TTS 参考音绝对路径（可能不存在） */
  ttsRefAudio: string
  /** 原始 assets 对象，留作扩展（前端想用别的字段时从这里取） */
  raw: Record<string, unknown>
}

export interface LoadOptions {
  /** 仓库根（缺省按 PERSONA_OS_ROOT / 上溯找 config/personas 推断） */
  osRoot?: string
  /** 显式指定角色（缺省读 active.json） */
  personaId?: string
}

/** 从某目录往上找 config/personas 所在的那一层，返回仓库根 */
export function findOsRoot(start?: string): string {
  const env = process.env.PERSONA_OS_ROOT
  if (env && existsSync(env)) return resolve(env)

  let cur = resolve(start || process.cwd())
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, 'config', 'personas'))) return cur
    const up = resolve(cur, '..')
    if (up === cur) break
    cur = up
  }
  // 最后退回 cwd（调用方会因文件不存在而拿到默认值）
  return process.cwd()
}

function readJson(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

/** 读 active.json 里的角色 id；没有就按目录名排序取第一个 */
export function readActivePersonaId(root: string): string {
  const p = join(root, 'config', 'personas', 'active.json')
  const j = readJson(p)
  if (j && typeof j.active_id === 'string' && j.active_id) return j.active_id
  try {
    const list = readdirSync(join(root, 'config', 'personas'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    return list[0] || 'ohwhale'
  } catch {
    return 'ohwhale'
  }
}

/** 把相对路径按仓库根解析成绝对路径；已经是绝对路径就原样返回 */
export function resolveInRoot(root: string, p: string): string {
  if (!p) return ''
  return isAbsolute(p) ? p : resolve(root, p.replace(/\\/g, '/'))
}

/**
 * 按仓库根解析，**文件不存在就逐级向上找**。
 *
 * 为什么需要：`voice.ref_audio` 写的是 `ohwhale-deploy/assets/voice/ref_190.wav`，
 * 那是相对 **V1 工作区根**（`新建文件夹 (2)`）的，而仓库本体在
 * `新建文件夹 (2)/github-release/persona-os` 下 —— 直接从仓库根拼会拼出一个不存在的路径。
 * 所以这里退一步：沿着父目录逐层试，找到第一个真实存在的。
 */
export function resolveExisting(root: string, p: string, maxUp = 3): string {
  if (!p) return ''
  const first = resolveInRoot(root, p)
  if (isAbsolute(p)) return first
  if (existsSync(first)) return first

  let base = root
  for (let i = 0; i < maxUp; i++) {
    base = resolve(base, '..')
    const cand = resolveInRoot(base, p)
    if (existsSync(cand)) return cand
  }
  // 都没找到：返回最初那个（调用方自己会因为文件不存在而降级）
  return first
}

/**
 * 读当前（或指定）角色的资产。永远不抛异常——读不到就返回安全默认值，
 * 让调用方在"没配置"的情况下也能跑。
 */
export function loadPersonaAssets(opts: LoadOptions = {}): PersonaAssets {
  const root = opts.osRoot || findOsRoot()
  const id = opts.personaId || readActivePersonaId(root)
  const personaPath = join(root, 'config', 'personas', id, 'persona.json')
  const p = readJson(personaPath)

  if (!p) {
    console.error(`${LOG_TAG} 读不到 ${personaPath}，用默认资产（id=${id}）`)
  }

  const assets = (p?.assets && typeof p.assets === 'object') ? p.assets : {}
  const voice = (p?.voice && typeof p.voice === 'object') ? p.voice : {}
  const identity = (p?.identity && typeof p.identity === 'object') ? p.identity : {}

  const exprDirRel = String(assets.expr_dir || 'plugins/dsh-control-center/web/assets/expr')
  const refRel = String(voice.ref_audio || '')

  const out: PersonaAssets = {
    id,
    displayName: String(assets.display_name || identity.self_name || id),
    exprDir: resolveInRoot(root, exprDirRel),
    exprPrefix: typeof assets.expr_prefix === 'string' ? assets.expr_prefix : 'pixel_',
    themeColor: String(assets.theme_color || '#00F0FF'),
    themeSea: String(assets.theme_sea || '#5BC0BE'),
    ttsRefAudio: refRel ? resolveExisting(root, refRel) : '',
    raw: assets,
  }
  return out
}

/** 角色 id 换成文件名安全的形式（用于 per-persona 的状态文件） */
export function safeId(id: string): string {
  return String(id || 'default').replace(/[^\w.-]+/g, '_')
}

export const __testing = { LOG_TAG }
