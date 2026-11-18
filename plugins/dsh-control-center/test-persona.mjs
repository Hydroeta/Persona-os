/**
 * test-persona.mjs —— 多角色解耦验证（面板侧）
 *
 * 验的是：角色配置能正确驱动立绘目录 / 表情清单 / 主题色，
 * 而不是代码里写死某个人。
 *
 * 用法：node build.mjs && node test-persona.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const m = await import(pathToFileURL(join(process.cwd(), 'lib', 'persona.js')).href)
const { loadPanelPersona, listExpressions } = m

let pass = 0, fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---------- 造一个临时仓库，验证"换配置就换角色" ----------
const root = mkdtempSync(join(tmpdir(), 'persona-'))
const personas = join(root, 'config', 'personas')
const exprA = join(root, 'assets', 'exprA')
const exprB = join(root, 'assets', 'exprB')
for (const d of [join(personas, 'alice'), join(personas, 'bob'), exprA, exprB]) mkdirSync(d, { recursive: true })

// alice: 前缀 pixel_，3 个表情
for (const n of ['pixel_smile', 'pixel_sleepy', 'pixel_pout']) writeFileSync(join(exprA, n + '.png'), 'x')
// bob: 前缀 b_，2 个表情
for (const n of ['b_joy', 'b_shy']) writeFileSync(join(exprB, n + '.png'), 'x')

const mkPersona = (id, assets) => writeFileSync(
  join(personas, id, 'persona.json'),
  JSON.stringify({ id, identity: { self_name: id.toUpperCase() }, assets }, null, 2), 'utf-8')

mkPersona('alice', {
  expr_dir: 'assets/exprA', expr_prefix: 'pixel_',
  theme_color: '#FF0000', theme_sea: '#00FF00', display_name: '爱丽丝',
})
mkPersona('bob', {
  expr_dir: 'assets/exprB', expr_prefix: 'b_',
  theme_color: '#0000FF',
})
writeFileSync(join(personas, 'active.json'), JSON.stringify({ active_id: 'alice' }), 'utf-8')

// ---------- 1. 读 active ----------
const a = loadPanelPersona({ osRoot: root })
check('读到 active_id = alice', a.id === 'alice', a.id)
check('display_name 来自 assets', a.displayName === '爱丽丝', a.displayName)
check('主题色来自配置', a.themeColor === '#FF0000', a.themeColor)
check('副色来自配置', a.themeSea === '#00FF00', a.themeSea)
check('表情目录解析成绝对路径', a.exprDirAbs === exprA, a.exprDirAbs)
check('前缀来自配置', a.exprPrefix === 'pixel_', a.exprPrefix)

// ---------- 2. 表情清单 ----------
check('alice 列出 3 个表情', a.expressions.length === 3, a.expressions.join(','))
check('表情名去掉前缀与后缀', a.expressions.includes('smile'), a.expressions.join(','))
check('不会把 avatar.png 当表情', !a.expressions.includes('avatar'))
check('exprUrlBase 固定为 /persona-expr', a.exprUrlBase === '/persona-expr', a.exprUrlBase)

// ---------- 3. 切到 bob：全部跟着变 ----------
const b = loadPanelPersona({ osRoot: root, personaId: 'bob' })
check('bob 主题色不同', b.themeColor === '#0000FF', b.themeColor)
check('bob 表情目录不同', b.exprDirAbs === exprB, b.exprDirAbs)
check('bob 前缀不同', b.exprPrefix === 'b_', b.exprPrefix)
check('bob 列出它自己的 2 个表情', b.expressions.length === 2, b.expressions.join(','))
check('bob 没配 display_name 时回退 self_name', b.displayName === 'BOB', b.displayName)
check('bob 没配 theme_sea 时有默认值', b.themeSea === '#5BC0BE', b.themeSea)

// ---------- 4. active.json 改了立刻生效（不需要重启）----------
writeFileSync(join(personas, 'active.json'), JSON.stringify({ active_id: 'bob' }), 'utf-8')
const afterSwitch = loadPanelPersona({ osRoot: root })
check('改 active.json 后立刻读到 bob', afterSwitch.id === 'bob', afterSwitch.id)

// ---------- 5. 容错 ----------
const ghost = loadPanelPersona({ osRoot: root, personaId: '不存在' })
check('角色不存在不崩，回退默认色', ghost.themeColor === '#00F0FF', ghost.themeColor)
check('角色不存在时表情列表为空', ghost.expressions.length === 0, String(ghost.expressions.length))

check('目录不存在时 listExpressions 返回空数组', listExpressions(join(root, 'nope'), 'pixel_').length === 0)

// active.json 坏了也能靠目录名兜底
writeFileSync(join(personas, 'active.json'), '{坏 json', 'utf-8')
const broken = loadPanelPersona({ osRoot: root })
check('active.json 损坏时按目录名兜底', broken.id === 'alice' || broken.id === 'bob', broken.id)

rmSync(root, { recursive: true, force: true })

// ---------- 6. 真实仓库：当前角色能读出来 ----------
const realRoot = 'C:\\Users\\79365\\Desktop\\新建文件夹 (2)\\github-release\\persona-os'
if (existsSync(join(realRoot, 'config', 'personas'))) {
  const real = loadPanelPersona({ osRoot: realRoot })
  check('真实仓库能读当前角色', !!real.id, real.id)
  check('真实仓库表情目录存在', existsSync(real.exprDirAbs), real.exprDirAbs)
  check('真实仓库表情数 > 10', real.expressions.length > 10, String(real.expressions.length))
  check('真实角色有主题色', /^#[0-9a-f]{6}$/i.test(real.themeColor), real.themeColor)
} else {
  console.log('（跳过真实仓库检查：没找到 config/personas）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
