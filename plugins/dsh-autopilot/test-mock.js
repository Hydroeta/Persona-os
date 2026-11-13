/**
 * test-mock.js —— dsh-autopilot 的安全防线离线验证
 * 不触碰真实仓库：用临时目录 + dry_run 为主，真执行只跑「拒绝路径」这类不该写盘的用例。
 * 运行：node build.mjs && node test-mock.js
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isPathInsideRepo,
  scanSecrets,
  validateChanges,
  buildTargets,
  normalizeCommitMessage,
  proposalRelPath,
  slugify,
} from './lib/guard.js'
import { saveProposal, executeEvolution } from './lib/index.js'

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  cond ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'autopilot-'))
mkdirSync(join(root, 'data', 'proposals'), { recursive: true })
writeFileSync(join(root, 'package.json'), '{"name":"tmp"}')
// 伪造一个 git 仓库标记，让 findRepoRoot 有东西可用（真执行用例不走这里）
mkdirSync(join(root, '.git'), { recursive: true })

// ---------- 1) 路径守卫 ----------
check('拒绝盘符绝对路径', !!isPathInsideRepo(root, 'C:\\Users\\x\\a.ts'))
check('拒绝 .. 越界', !!isPathInsideRepo(root, 'plugins/../../etc/passwd'))
check('拒绝改 .git', !!isPathInsideRepo(root, '.git/config'))
check('正常插件路径通过', isPathInsideRepo(root, 'plugins/dsh-painter/src/index.ts') === null)

// ---------- 2) 敏感内容扫描 ----------
check('扫描 sk- 密钥', scanSecrets('a.ts', 'const k = "sk-abcdefghijklmnop123456"').length > 0)
check('扫描本机用户目录', scanSecrets('a.ts', 'path = "C:\\Users\\79365\\x"').length > 0)
check('扫描硬编码密码', scanSecrets('a.ts', 'password = "hunter2"').length > 0)
check('扫描私钥块', scanSecrets('a.ts', '-----BEGIN RSA PRIVATE KEY-----').length > 0)
check('正常代码不误报', scanSecrets('a.ts', 'export function add(a,b){return a+b}').length === 0)

// ---------- 3) 改动清单校验 ----------
check('空 changes 被拒', validateChanges(root, []).length > 0)
check('空内容被拒', validateChanges(root, [{ file_path: 'a/b.ts', new_content: '' }]).length > 0)
const bad = validateChanges(root, [{ file_path: '../evil.ts', new_content: 'x' }])
check('越界路径整体判失败', bad.length > 0)
const tooMany = validateChanges(root, Array.from({ length: 31 }, (_, i) => ({ file_path: `a/${i}.ts`, new_content: 'x' })))
check('超过 30 个文件被拒', tooMany.some((i) => /最多改 30/.test(i.reason)))

// ---------- 4) 编译目标推断 ----------
check('从改动推出插件目录', JSON.stringify(buildTargets([{ file_path: 'plugins/dsh-painter/src/index.ts', new_content: 'x' }])) === '["plugins/dsh-painter"]')
check('非插件文件不产出目标', buildTargets([{ file_path: 'README.md', new_content: 'x' }]).length === 0)
check('提交信息清洗', normalizeCommitMessage('feat(auto):   a\n\n b  ') === 'feat(auto): a b')

// ---------- 5) save_proposal ----------
const p1 = await saveProposal({ root, title: '记忆压缩方案', markdown_content: '# 方案\n把记忆按热度分层，冷数据压缩成摘要。' })
check('方案保存成功', p1.ok && !!p1.path, p1.path || p1.error)
check('路径带日期与标题', /data\/proposals\/\d{4}-\d{2}-\d{2}_记忆压缩方案\.md$/.test(p1.path || ''), p1.path || '')
check('短内容被拒', !(await saveProposal({ root, title: 'x', markdown_content: '太短' })).ok)
check('slug 去掉非法字符', slugify('a/b:c*d') === 'a-b-c-d', slugify('a/b:c*d'))
check('proposalRelPath 合法', proposalRelPath(new Date(2026, 10, 13), '测试') === 'data/proposals/2026-11-13_测试.md')

// ---------- 6) execute_evolution：默认 dry run 不写盘 ----------
const before = existsSync(join(root, 'plugins'))
const dry = await executeEvolution({
  root,
  proposalPath: p1.path,
  changes: [{ file_path: 'plugins/x/src/a.ts', new_content: 'export const a = 1' }],
  commitMessage: 'feat(auto): test',
})
check('默认 dry_run', dry.dry_run === true && dry.ok === true, JSON.stringify(dry.steps.map((s) => s.step)))
check('dry_run 不写文件', existsSync(join(root, 'plugins')) === before)

// ---------- 7) 真执行被安全项拦住 ----------
const noConfirm = await executeEvolution({
  root,
  proposalPath: p1.path,
  changes: [{ file_path: 'plugins/x/src/a.ts', new_content: 'export const a = 1' }],
  commitMessage: 'x',
  dryRun: false,
})
check('少了 confirm 拒绝执行', noConfirm.ok === false && /confirm/.test(noConfirm.error || ''), noConfirm.error || '')

const badProposal = await executeEvolution({
  root,
  proposalPath: 'data/proposals/不存在.md',
  changes: [{ file_path: 'plugins/x/src/a.ts', new_content: 'x' }],
  dryRun: false,
  confirm: true,
})
check('提案不存在拒绝执行', badProposal.ok === false && /提案不存在/.test(badProposal.error || ''), badProposal.error || '')

const secret = await executeEvolution({
  root,
  proposalPath: p1.path,
  changes: [{ file_path: 'plugins/x/src/a.ts', new_content: 'const k="sk-abcdefghijk1234567890"' }],
  dryRun: false,
  confirm: true,
})
check('敏感内容拒绝执行', secret.ok === false && /敏感/.test(secret.error || ''), secret.error || '')
check('被拒后仍没写文件', !existsSync(join(root, 'plugins', 'x')))

rmSync(root, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
