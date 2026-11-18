/**
 * persona.ts —— 读「当前激活角色」的资产（面板侧，多角色解耦）
 *
 * 为什么自己读文件而不问 persona-core：
 *   `dsh-control-center` 是独立进程，persona-core 在 DSH 宿主里；跨进程拿不到。
 *   `config/personas/` 是磁盘上的唯一事实源，直接读最稳，切角色后立刻生效。
 *
 * 约定字段（与 persona-core/src/persona-assets.ts 保持一致）：
 *   config/personas/active.json       { active_id }
 *   config/personas/<id>/persona.json { voice.ref_audio, assets.{expr_dir,expr_prefix,theme_color,theme_sea,display_name} }
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'

export interface PanelPersona {
  id: string
  displayName: string
  /** 表情目录（相对 URL，形如 /persona-expr），前端拼 `${exprBase}/${prefix}xxx.png` */
  exprUrlBase: string
  /** 表情目录的绝对路径（用于静态文件映射） */
  exprDirAbs: string
  exprPrefix: string
  themeColor: string
  themeSea: string
  /** 表情文件名清单（不含前缀/后缀），前端用它决定能切哪些表情 */
  expressions: string[]
}

/** 从某目录往上找 config/personas 所在的那一层 = 仓库根 */
export function findRepoRoot(start?: string): string {
  const env = process.env.PERSONA_OS_ROOT
  if (env && existsSync(env)) return resolve(env)
  let cur = resolve(start || process.cwd())
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, 'config', 'personas'))) return cur
    const up = resolve(cur, '..')
    if (up === cur) break
    cur = up
  }
  return process.cwd()
}

function readJsonSafe(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

/** 读取表情目录下有哪些表情（去前缀去后缀），按名字排序 */
export function listExpressions(dirAbs: string, prefix: string): string[] {
  try {
    if (!existsSync(dirAbs)) return []
    return readdirSync(dirAbs)
      .filter((f) => f.toLowerCase().endsWith('.png') && f.startsWith(prefix))
      .map((f) => f.slice(prefix.length).replace(/\.png$/i, ''))
      .filter((n) => n && n !== 'avatar')
      .sort()
  } catch {
    return []
  }
}

export interface LoadPersonaOptions {
  osRoot?: string
  personaId?: string
}

export function loadPanelPersona(opts: LoadPersonaOptions = {}): PanelPersona {
  const root = opts.osRoot || findRepoRoot()
  const personasDir = join(root, 'config', 'personas')

  let id = opts.personaId || ''
  if (!id) {
    const act = readJsonSafe(join(personasDir, 'active.json'))
    if (act && typeof act.active_id === 'string' && act.active_id) id = act.active_id
  }
  if (!id) {
    try {
      id = readdirSync(personasDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()[0] || 'ohwhale'
    } catch {
      id = 'ohwhale'
    }
  }

  const persona = readJsonSafe(join(personasDir, id, 'persona.json'))
  const assets = (persona?.assets && typeof persona.assets === 'object') ? persona.assets : {}
  const identity = (persona?.identity && typeof persona.identity === 'object') ? persona.identity : {}

  const exprDirRel = String(assets.expr_dir || 'plugins/dsh-control-center/web/assets/expr')
  const prefix = String(assets.expr_prefix || 'pixel_')
  const exprDirAbs = isAbsolute(exprDirRel) ? exprDirRel : resolve(root, exprDirRel)

  return {
    id,
    displayName: String(assets.display_name || identity.self_name || id),
    exprUrlBase: '/persona-expr',
    exprDirAbs,
    exprPrefix: prefix,
    themeColor: String(assets.theme_color || '#00F0FF'),
    themeSea: String(assets.theme_sea || '#5BC0BE'),
    expressions: listExpressions(exprDirAbs, prefix),
  }
}
