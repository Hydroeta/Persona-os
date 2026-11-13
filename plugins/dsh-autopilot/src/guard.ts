/**
 * guard.ts —— 自进化的「安全防线」纯函数（不碰磁盘、不跑命令，便于单测）
 *
 * 规则很硬：
 *   · 只能改仓库内的路径（`..` / 绝对路径 / 盘符一律拒绝）
 *   · 内容里出现密钥、密码、本机用户目录 → 直接拒绝
 *   · 提案文件必须真实存在
 */

import { posix } from 'node:path'

export interface Change {
  file_path: string
  new_content: string
}

export interface GuardIssue {
  file_path?: string
  reason: string
  hint?: string
}

/** 把标题变成安全的文件名 */
export function slugify(title: string, maxLen = 40): string {
  const cleaned = (title || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (cleaned || 'proposal').slice(0, maxLen)
}

/** 提案落盘路径（相对仓库根）：data/proposals/YYYY-MM-DD_标题.md */
export function proposalRelPath(date: Date, title: string): string {
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return posix.join('data', 'proposals', `${d}_${slugify(title)}.md`)
}

/** 路径必须在仓库内，且不能是仓库根/系统路径 */
export function isPathInsideRepo(root: string, relPath: string): GuardIssue | null {
  const p = (relPath || '').trim()
  if (!p) return { reason: 'file_path 为空' }
  if (/^[a-zA-Z]:/.test(p)) return { file_path: p, reason: '不允许绝对盘符路径' }
  if (p.startsWith('/') || p.startsWith('\\')) return { file_path: p, reason: '不允许以根目录开头的路径' }
  const norm = posix.normalize(p.replace(/\\/g, '/'))
  if (norm.startsWith('..') || norm.includes('/../')) return { file_path: p, reason: '路径越出仓库（包含 ..）' }
  if (norm.startsWith('.git/') || norm === '.git') return { file_path: p, reason: '不允许改 .git' }
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!rootNorm) return { file_path: p, reason: '仓库根为空' }
  return null
}

/** 敏感内容扫描：命中任意一条就拒绝落盘 */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/, label: '疑似 API Key（sk-…）' },
  { re: /C:\\Users\\[^\\\s"']+/i, label: '本机用户目录（C:\\Users\\…）' },
  { re: /(password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/i, label: '硬编码密码' },
  { re: /(api[_-]?key|secret|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/i, label: '硬编码密钥' },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: '私钥' },
]

export function scanSecrets(filePath: string, content: string): GuardIssue[] {
  const issues: GuardIssue[] = []
  for (const { re, label } of SECRET_PATTERNS) {
    const m = content.match(re)
    if (m) issues.push({ file_path: filePath, reason: `疑似敏感内容：${label}`, hint: m[0].slice(0, 12) + '…' })
  }
  return issues
}

/** 校验一份改动清单；返回所有问题（空数组 = 通过） */
export function validateChanges(root: string, changes: Change[]): GuardIssue[] {
  const issues: GuardIssue[] = []
  if (!Array.isArray(changes) || changes.length === 0) {
    return [{ reason: 'changes 不能为空' }]
  }
  if (changes.length > 30) issues.push({ reason: `一次最多改 30 个文件（收到 ${changes.length}）` })
  for (const c of changes) {
    const pathIssue = isPathInsideRepo(root, c?.file_path ?? '')
    if (pathIssue) {
      issues.push(pathIssue)
      continue
    }
    if (typeof c.new_content !== 'string' || !c.new_content.length) {
      issues.push({ file_path: c.file_path, reason: 'new_content 为空（不接受空文件覆盖）' })
      continue
    }
    issues.push(...scanSecrets(c.file_path, c.new_content))
  }
  return issues
}

/** 从改动清单推出需要重编的插件目录（plugins/<name>） */
export function buildTargets(changes: Change[]): string[] {
  const dirs = new Set<string>()
  for (const c of changes) {
    const norm = (c.file_path || '').replace(/\\/g, '/')
    const m = norm.match(/^plugins\/([^/]+)\//)
    if (m) dirs.add(`plugins/${m[1]}`)
  }
  return [...dirs]
}

/** 提交信息的基本卫生：非空、不超长、不带换行 */
export function normalizeCommitMessage(msg: string): string {
  const one = (msg || '').replace(/\s+/g, ' ').trim()
  return (one || 'chore(auto): 自进化变更').slice(0, 120)
}
