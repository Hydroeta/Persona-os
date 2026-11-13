/**
 * dsh-autopilot —— 自进化总控
 *
 * 只提供两个工具，本身不懂模型：
 *   save_proposal     把方案写进 data/proposals/YYYY-MM-DD_标题.md
 *   execute_evolution 按方案改文件 → 备份 → 编译 → 敏感词扫描 → 提交推送
 *
 * 安全默认：**dry_run = true**。必须显式 dry_run:false + confirm:true 才真的动文件与 git。
 * 任何一步失败都回滚到执行前的状态，并把原因如实返回（绝不静默继续）。
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  type Change,
  buildTargets,
  normalizeCommitMessage,
  proposalRelPath,
  validateChanges,
} from './guard.js'

export const LOG_TAG = '[dsh-autopilot]'
export { validateChanges, proposalRelPath, slugify, scanSecrets, buildTargets } from './guard.js'

/** 仓库根：从本插件目录往上找到有 .git 的那层（可用 DSH_AUTOPILOT_ROOT 覆盖） */
export function findRepoRoot(start: string): string {
  let cur = resolve(start)
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, '.git'))) return cur
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return resolve(start)
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0
      res({ code, out: `${stdout || ''}${stderr || ''}`.trim() })
    })
  })
}

// ---------------------------------------------------------------------------
// 工具 1：save_proposal
// ---------------------------------------------------------------------------

export interface ProposalResult {
  ok: boolean
  path?: string
  error?: string
}

export async function saveProposal(opts: {
  root: string
  title: string
  markdown_content: string
  now?: Date
}): Promise<ProposalResult> {
  const title = (opts.title || '').trim()
  const body = opts.markdown_content || ''
  if (!title) return { ok: false, error: 'title 不能为空' }
  if (body.trim().length < 20) return { ok: false, error: '方案内容太短（至少 20 字），不像一份可审批的方案' }
  const rel = proposalRelPath(opts.now ?? new Date(), title)
  const abs = join(opts.root, rel)
  try {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, body, 'utf8')
    return { ok: true, path: rel }
  } catch (e) {
    return { ok: false, error: `写入失败：${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// 工具 2：execute_evolution
// ---------------------------------------------------------------------------

export interface EvolutionResult {
  ok: boolean
  dry_run: boolean
  steps: Array<{ step: string; ok: boolean; detail?: string }>
  error?: string
  commit?: string
}

export async function executeEvolution(opts: {
  root: string
  proposalPath: string
  changes: Change[]
  commitMessage: string
  dryRun?: boolean
  confirm?: boolean
  build?: boolean
}): Promise<EvolutionResult> {
  const root = opts.root
  const dry = opts.dryRun !== false            // 默认 dry run
  const steps: EvolutionResult['steps'] = []
  const push = (step: string, ok: boolean, detail?: string) => steps.push({ step, ok, detail })

  // 0) 前置校验
  const proposalAbs = join(root, (opts.proposalPath || '').replace(/\\/g, '/'))
  if (!opts.proposalPath || !existsSync(proposalAbs)) {
    return { ok: false, dry_run: dry, steps, error: `提案不存在：${opts.proposalPath || '(空)'}` }
  }
  const issues = validateChanges(root, opts.changes || [])
  if (issues.length) {
    return {
      ok: false,
      dry_run: dry,
      steps,
      error: `改动校验未通过：${issues.map((i) => `${i.file_path || ''} ${i.reason}`).join('；')}`,
    }
  }
  push('校验改动（路径/敏感内容）', true, `${opts.changes.length} 个文件`)

  if (dry) {
    push('dry_run：未写入任何文件', true, '传 dry_run:false + confirm:true 才真执行')
    return { ok: true, dry_run: true, steps }
  }
  if (opts.confirm !== true) {
    return { ok: false, dry_run: false, steps, error: '缺少 confirm:true，拒绝真执行' }
  }

  // 1) 记录还原点（干净就记 HEAD，脏就先打一个备份提交）
  const status = await run('git', ['status', '--porcelain'], root)
  const head = await run('git', ['rev-parse', 'HEAD'], root)
  const restoreRef = head.code === 0 ? head.out.trim() : ''
  push('记录还原点', true, restoreRef ? restoreRef.slice(0, 8) : '(无 HEAD)')

  const dirty = status.out.length > 0
  if (dirty) {
    const backup = await run('git', ['add', '-A'], root)
    const commit = await run('git', ['commit', '-m', 'chore(auto): backup before evolution'], root)
    push('备份当前改动（commit）', backup.code === 0 && commit.code === 0, commit.out.split('\n')[0])
  }

  const restore = async (why: string): Promise<EvolutionResult> => {
    await run('git', ['checkout', '--', '.'], root)
    if (restoreRef) await run('git', ['reset', '--hard', restoreRef], root)
    push('回滚到执行前', true, why)
    return { ok: false, dry_run: false, steps, error: why }
  }

  // 2) 写文件
  try {
    for (const c of opts.changes) {
      const abs = join(root, c.file_path.replace(/\\/g, '/'))
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, c.new_content, 'utf8')
    }
    push('写入文件', true, opts.changes.map((c) => c.file_path).join(', ').slice(0, 200))
  } catch (e) {
    return await restore(`写文件失败：${(e as Error).message}`)
  }

  // 3) 编译（逐插件 node build.mjs；root 没有 build 脚本，别跑 pnpm build）
  if (opts.build !== false) {
    const targets = buildTargets(opts.changes)
    for (const dir of targets) {
      const buildFile = join(root, dir, 'build.mjs')
      if (!existsSync(buildFile)) continue
      const r = await run(process.execPath, ['build.mjs'], join(root, dir), 180_000)
      const ok = r.code === 0
      push(`编译 ${dir}`, ok, ok ? '' : r.out.slice(-400))
      if (!ok) return await restore(`编译失败：${dir}`)
    }
    if (!targets.length) push('编译', true, '改的文件不在插件目录，跳过')
  }

  // 4) 提交 + 推送（3 次重试）
  const msg = normalizeCommitMessage(opts.commitMessage)
  await run('git', ['add', '-A'], root)
  const commit = await run('git', ['commit', '-m', msg], root)
  if (commit.code !== 0) return await restore(`提交失败：${commit.out.slice(-300)}`)
  const sha = (await run('git', ['rev-parse', '--short', 'HEAD'], root)).out.trim()
  push('提交', true, sha)

  let pushed = false
  for (let i = 1; i <= 3 && !pushed; i++) {
    const p = await run('git', ['push'], root, 120_000)
    pushed = p.code === 0 || /main -> main|Everything up-to-date/.test(p.out)
    push(`推送（第 ${i} 次）`, pushed, pushed ? '' : p.out.slice(-300))
  }
  if (!pushed) {
    // 推送失败不回滚本地提交，但要如实说明
    return { ok: false, dry_run: false, steps, error: '推送三次都失败，本地已提交，需人工处理', commit: sha }
  }
  return { ok: true, dry_run: false, steps, commit: sha }
}

// ---------------------------------------------------------------------------
// DSH 插件入口
// ---------------------------------------------------------------------------

export const name = 'dsh-autopilot'

export function apply(ctx: any): void {
  const root = process.env.DSH_AUTOPILOT_ROOT
    ? resolve(process.env.DSH_AUTOPILOT_ROOT)
    : findRepoRoot(process.cwd())
  console.log(`${LOG_TAG} 已加载，仓库根：${root}`)

  const disposers: Array<() => void> = []

  const saveTool = {
    name: 'save_proposal',
    description: '把一份自进化方案写进 data/proposals/YYYY-MM-DD_标题.md，返回相对路径（供人审批）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'markdown_content'],
      properties: {
        title: { type: 'string', description: '方案标题（会成为文件名）' },
        markdown_content: { type: 'string', description: '方案正文（Markdown）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, path: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_a: any, v: any) => [
        { type: 'text', text: v?.ok ? `📝 方案已保存：${v.path}` : `❌ 保存失败：${v?.error ?? '未知'}` },
      ],
    },
    async execute(args: any) {
      return await saveProposal({ root, title: String(args?.title ?? ''), markdown_content: String(args?.markdown_content ?? '') })
    },
    presentCall: (a: any) => ({ card: 'generic', title: `保存方案 → ${String(a?.title ?? '')}`, kind: 'write' }),
  }

  const executeTool = {
    name: 'execute_evolution',
    description:
      '按审批过的方案改代码：校验路径与敏感内容 → 备份 → 写文件 → 逐插件编译 → 提交 → 推送，任一步失败自动回滚。默认 dry_run=true，必须显式 dry_run:false 且 confirm:true 才真执行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['proposal_path', 'changes'],
      properties: {
        proposal_path: { type: 'string', description: '提案文件相对路径（data/proposals/…）' },
        changes: {
          type: 'array',
          description: '要覆盖的文件列表，最多 30 个',
          items: {
            type: 'object',
            required: ['file_path', 'new_content'],
            properties: { file_path: { type: 'string' }, new_content: { type: 'string' } },
          },
        },
        commit_message: { type: 'string', description: '提交信息，默认 chore(auto): 自进化变更' },
        dry_run: { type: 'boolean', description: '默认 true：只校验不写入' },
        confirm: { type: 'boolean', description: '真执行必须显式传 true' },
        build: { type: 'boolean', description: '是否逐插件编译，默认 true' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dry_run: { type: 'boolean' },
          steps: { type: 'array' },
          error: { type: 'string' },
          commit: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [
        {
          type: 'text',
          text:
            `${v?.ok ? '✅' : '❌'} 自进化${v?.dry_run ? '（dry run）' : ''}${v?.commit ? ` · ${v.commit}` : ''}` +
            `\n${(v?.steps || []).map((s: any) => `${s.ok ? '·' : '✗'} ${s.step}${s.detail ? `：${s.detail}` : ''}`).join('\n')}` +
            (v?.error ? `\n❗ ${v.error}` : ''),
        },
      ],
    },
    async execute(args: any) {
      return await executeEvolution({
        root,
        proposalPath: String(args?.proposal_path ?? ''),
        changes: Array.isArray(args?.changes) ? args.changes : [],
        commitMessage: String(args?.commit_message ?? ''),
        dryRun: args?.dry_run !== false,
        confirm: args?.confirm === true,
        build: args?.build !== false,
      })
    },
    presentCall: (a: any) => ({ card: 'generic', title: `自进化 → ${String(a?.commit_message ?? '')}`, kind: 'write' }),
  }

  for (const t of [saveTool, executeTool]) {
    try {
      const d = ctx.tools.register(t)
      if (typeof d === 'function') disposers.push(d)
      console.log(`${LOG_TAG} 已注册工具 ${t.name}`)
    } catch (e) {
      console.error(`${LOG_TAG} 注册 ${t.name} 失败：`, e)
    }
  }

  ctx.on('dispose', () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    console.log(`${LOG_TAG} disposed`)
  })
}

// 供测试/手动调用
export { run as _run, rm as _rm, readFile as _read }
