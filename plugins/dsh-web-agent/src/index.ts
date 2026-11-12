/**
 * dsh-web-agent
 *
 * 后台无头浏览器（Playwright + Chromium），静默抓取网页，绝不抢占物理鼠标。
 *
 * 设计要点：
 *   - 单例 Browser：插件级别只 launch 一次，每次调用新建 Context+Page，用完关闭，防内存泄漏。
 *   - dispose 时 await browser.close() 彻底释放。
 *   - 反爬：headless + --disable-blink-features=AutomationControlled + 伪造 userAgent。
 *   - 防挂死：导航/操作 timeout 15s，任务总看门狗 45s；任何异常 catch 后返回友好结果，绝不抛未捕获异常。
 *   - 正文提取：在页面内剔除 script/style/nav 等噪声，优先 article/main，输出轻量 Markdown，截断 4000 字符。
 *   - 浏览器内核不可用时的逃生通道：设 WEB_AGENT_CHROMIUM_PATH 指向系统 Chrome/Edge 可执行文件。
 */

import { existsSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { searchReference } from './reference.js'

export { searchReference } from './reference.js'

const LOG_TAG = '[dsh-web-agent]'

// 一个常见的桌面 Chrome UA，避免被轻易识别为 HeadlessChrome
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const NAV_TIMEOUT = 15000 // 单次导航/操作超时（毫秒）
const TASK_TIMEOUT = 45000 // 单任务总看门狗（毫秒）
const MAX_CONTENT_CHARS = 4000 // 正文截断上限
const MAX_LINKS = 100 // 链接数量上限

// ---------------------------------------------------------------------------
// 单例 Browser
// ---------------------------------------------------------------------------

let browser: Browser | null = null
let launching: Promise<Browser> | null = null

// 系统浏览器探测：内置 chromium 未下载时，回退到系统已装的 Edge/Chrome（Chromium 内核均可驱动）。
// 路径覆盖：常见默认安装目录（x64 / x86 / 本地用户安装）。
const SYSTEM_BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
].filter(Boolean)

function detectSystemBrowser(): string | null {
  for (const p of SYSTEM_BROWSER_CANDIDATES) {
    if (p && existsSync(p)) return p
  }
  return null
}

const BASE_LAUNCH_OPTS = {
  headless: true,
  args: ['--disable-blink-features=AutomationControlled'],
}

async function getBrowser(): Promise<Browser> {
  if (browser) return browser
  if (launching) return launching
  launching = (async () => {
    const explicit = process.env.WEB_AGENT_CHROMIUM_PATH
    if (explicit) {
      const b = await chromium.launch({ ...BASE_LAUNCH_OPTS, executablePath: explicit })
      browser = b
      console.log(`${LOG_TAG} 浏览器已启动（单例，executablePath=${explicit}）`)
      return b
    }
    // 优先用 playwright 内置 chromium（需先 npx playwright install chromium）
    try {
      const b = await chromium.launch(BASE_LAUNCH_OPTS)
      browser = b
      console.log(`${LOG_TAG} 内置 chromium 已启动（单例）`)
      return b
    } catch (e) {
      // 内置不可用（未下载 / 沙箱无写权限）→ 回退系统 Edge/Chrome；仍失败才抛错
      const sys = detectSystemBrowser()
      if (!sys) throw e
      const b = await chromium.launch({ ...BASE_LAUNCH_OPTS, executablePath: sys })
      browser = b
      console.log(`${LOG_TAG} 内置 chromium 不可用，回退到系统浏览器：${sys}`)
      return b
    }
  })()
  try {
    return await launching
  } finally {
    launching = null
  }
}

// ---------------------------------------------------------------------------
// 页面内正文提取（在浏览器上下文执行）
// ---------------------------------------------------------------------------

interface ExtractResult {
  title: string
  text: string
}

function extractInPage(): ExtractResult {
  const removeSelectors =
    'script,style,noscript,template,iframe,svg,nav,header,footer,aside,form,button,input,select,textarea'.split(',')
  removeSelectors.forEach((sel) => {
    try {
      document.querySelectorAll(sel).forEach((e) => e.remove())
    } catch {
      /* ignore */
    }
  })
  const root = document.querySelector('article') || document.querySelector('main') || document.body
  const lines: string[] = []
  const walk = (node: Node) => {
    if (!node) return
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.textContent || '').replace(/\s+/g, ' ').trim()
        if (t) lines.push(t)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element
        const tag = el.tagName.toLowerCase()
        if (/^h[1-4]$/.test(tag)) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (t) lines.push('\n' + '#'.repeat(Number(tag[1])) + ' ' + t)
        } else if (tag === 'a') {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
          const href = el.getAttribute('href') || ''
          if (t) lines.push(href ? `[${t}](${href})` : t)
        } else if (tag === 'li') {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
          if (t) lines.push('- ' + t)
        } else if (tag === 'br') {
          lines.push('')
        } else {
          walk(el)
        }
      }
    })
  }
  walk(root)
  const title = (document.title || '').trim()
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { title, text }
}

function extractLinksInPage(): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = []
  document.querySelectorAll('a[href]').forEach((a) => {
    const t = (a.textContent || '').replace(/\s+/g, ' ').trim()
    const h = a.getAttribute('href') || ''
    if (h) out.push({ text: t.slice(0, 80), href: h })
  })
  return out
}

// ---------------------------------------------------------------------------
// 任务执行
// ---------------------------------------------------------------------------

export interface WebTaskArgs {
  url: string
  action?: string // extract_text（默认） | click_selector | extract_links
  selector?: string
}

export interface WebTaskResult {
  ok: boolean
  url: string
  action: string
  error?: string
  title?: string
  text?: string
  char_count?: number
  truncated?: boolean
  links?: Array<{ text: string; href: string }>
  link_count?: number
}

export async function runWebTask(args: WebTaskArgs): Promise<WebTaskResult> {
  const url = (args.url || '').trim()
  if (!url) return { ok: false, url: '', action: args.action || 'extract_text', error: 'url 不能为空' }
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, url, action: args.action || 'extract_text', error: 'url 必须以 http:// 或 https:// 开头' }
  }

  const action = (args.action || 'extract_text').trim()
  const selector = (args.selector || '').trim()
  const validActions = ['extract_text', 'click_selector', 'extract_links']
  if (!validActions.includes(action)) {
    return { ok: false, url, action, error: `未知 action "${action}"，可选：${validActions.join(' / ')}` }
  }

  let context: BrowserContext | null = null
  let page: Page | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null
  try {
    const b = await getBrowser()
    context = await b.newContext({ userAgent: DEFAULT_UA, viewport: { width: 1280, height: 800 } })
    page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT)

    const work = (async (): Promise<WebTaskResult> => {
      await page!.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })

      if (action === 'click_selector') {
        if (!selector) throw new Error('action=click_selector 时必须提供 selector')
        await page!.click(selector, { timeout: NAV_TIMEOUT })
        // 点击后可能跳转，等待 DOM 就绪；失败不致命
        await page!.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {})
      }

      if (action === 'extract_links') {
        const all = await page!.evaluate(extractLinksInPage)
        return {
          ok: true,
          url,
          action,
          links: all.slice(0, MAX_LINKS),
          link_count: all.length,
        }
      }

      // 默认 extract_text（click_selector 点击后也提取正文）
      const { title, text } = await page!.evaluate(extractInPage)
      const truncated = text.length > MAX_CONTENT_CHARS
      return {
        ok: true,
        url,
        action,
        title,
        text: truncated ? text.slice(0, MAX_CONTENT_CHARS) + '…(已截断)' : text,
        char_count: text.length,
        truncated,
      }
    })()

    const watchdogPromise = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('任务总超时（45s），页面已强制关闭')), TASK_TIMEOUT)
    })
    const result = await Promise.race([work, watchdogPromise])
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, url, action, error: msg.slice(0, 300) }
  } finally {
    if (watchdog) clearTimeout(watchdog)
    try {
      if (page) await page.close()
    } catch {
      /* ignore */
    }
    try {
      if (context) await context.close()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 抓取结果 → 记忆总线（:8001 /remember）
//   level 固定 fact；project 用「网页抓取/<域名>」，这样 /recall 能带出处，
//   不会被当成"她自己知道的事"。写入失败一律静默，绝不阻塞抓取。
// ---------------------------------------------------------------------------

const MEMORY_URL = (process.env.MEMORY_BUS_URL || 'http://127.0.0.1:8001').replace(/\/$/, '')
const SAVE_MAX_CHARS = 300 // 单条 fact 不超过 300 字，避免污染记忆库
const SAVE_COOLDOWN_MS = 10 * 60 * 1000 // 同一域名 10 分钟内只存一次，防止刷库

const lastSaveByHost = new Map<string, number>()

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 把抓取正文压成一条可读的 fact：标题 + 摘要首段，超长截断。 */
function toFact(url: string, title: string, text: string): string {
  const host = hostOf(url)
  const body = (text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SAVE_MAX_CHARS)
  const head = title ? `《${title.slice(0, 60)}》` : ''
  return `网页抓取 ${host}：${head}${body}`.slice(0, SAVE_MAX_CHARS)
}

/**
 * 抓取成功后写一条 fact。返回是否真的写入。
 * 规则：正文太短（<80 字）视为无内容不存；同域名 10 分钟内不重复存。
 */
export async function saveToMemory(url: string, title: string, text: string): Promise<boolean> {
  const body = (text || '').trim()
  if (body.length < 80) return false
  const host = hostOf(url)
  const now = Date.now()
  const last = lastSaveByHost.get(host) ?? 0
  if (now - last < SAVE_COOLDOWN_MS) return false

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const r = await fetch(`${MEMORY_URL}/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: toFact(url, title, body),
        tags: ['网页抓取', host],
        level: 'fact',
        project: `网页抓取/${host}`,
      }),
      signal: ctrl.signal,
    })
    if (!r.ok) {
      console.error(`${LOG_TAG} 写记忆失败：HTTP ${r.status}`)
      return false
    }
    lastSaveByHost.set(host, now)
    console.log(`${LOG_TAG} 📝 已写入事实记忆：${host}《${String(title).slice(0, 30)}》`)
    return true
  } catch (e) {
    console.error(`${LOG_TAG} 写记忆失败：${(e as Error).message}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// DSH 工具类型（最小子集，参照 dsh-memory-bus / meow-memory 实测结构）
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
  name: 'dsh-web-agent',
  apply(ctx: any) {
    // 暴露服务供其他插件调用（best-effort，ctx.set 不存在时静默跳过）
    try {
      if (typeof ctx.set === 'function') {
        ctx.set('webAgent', { runTask: runWebTask })
        console.log(`${LOG_TAG} 已暴露 webAgent 服务（ctx.get('webAgent')）`)
      }
    } catch (e) {
      console.error(`${LOG_TAG} 暴露 webAgent 服务失败：${(e as Error).message}`)
    }

    const tool: DshTool = {
      name: 'run_web_task',
      description:
        '后台无头浏览器抓取网页（不抢占鼠标）。传入 url；action 可选 extract_text（默认，抓正文）、click_selector（点击 selector 后抓正文）、extract_links（抓所有链接）。所有操作有 15s 超时与 45s 总看门狗，超时/失败返回友好提示，不会卡死。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string', description: '目标网址，必须以 http:// 或 https:// 开头' },
          action: {
            type: 'string',
            description: '动作：extract_text（默认）/ click_selector / extract_links',
            enum: ['extract_text', 'click_selector', 'extract_links'],
          },
          selector: { type: 'string', description: 'click_selector 用的 CSS 选择器' },
          save_to_memory: {
            type: 'boolean',
            description: '抓成功后把正文压成一条 fact 写进记忆总线（默认 false）。同域名 10 分钟内只存一次。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            url: { type: 'string' },
            action: { type: 'string' },
            title: { type: 'string' },
            text: { type: 'string' },
            error: { type: 'string' },
            memory_saved: { type: 'boolean' },
          },
        },
        render: (_args: any, value: any) => [
          {
            type: 'text',
            text: value?.ok
              ? `🌐 ${value.action} ${value.url}\n标题：${value.title ?? ''}\n${value.text ?? ''}`.slice(0, 1500) +
                (value?.memory_saved ? '\n📝 已存入事实记忆' : '')
              : `❌ web_agent 失败：${value?.error ?? '未知'}（${value?.url ?? ''}）`,
          },
        ],
      },
      async execute(args: any) {
        const res: any = await runWebTask({ url: args?.url, action: args?.action, selector: args?.selector })
        let saved = false
        if (args?.save_to_memory && res?.ok && res?.action === 'extract_text') {
          saved = await saveToMemory(String(args?.url ?? ''), String(res?.title ?? ''), String(res?.text ?? ''))
        }
        return { ...res, memory_saved: saved }
      },
      presentCall(args: any) {
        return { card: 'generic', title: `web_agent → ${String(args?.action ?? 'extract_text')} ${String(args?.url ?? '')}`, kind: 'read' }
      },
    }

    // 第二个工具：动手造轮子之前先看别人怎么写的
    const refTool: DshTool = {
      name: 'search_reference',
      description:
        '开工前先参考开源/网页方案：source=github 搜仓库（按 star 排，带回前两名的 README 片段），source=web 搜技术文章（标题+摘要）。网络失败会返回 ok:false，这时应降级为自己写方案，别反复重试。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: '检索词，建议英文技术词，如 "nodejs audio queue optimization"' },
          source: { type: 'string', enum: ['github', 'web'], description: 'github=开源仓库（默认）｜web=技术文章' },
          limit: { type: 'number', description: '返回条数，1~5，默认 3' },
          readme_chars: { type: 'number', description: 'github 模式下 README 截取长度，默认 1200' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            query: { type: 'string' },
            source: { type: 'string' },
            items: { type: 'array' },
            error: { type: 'string' },
            elapsed_ms: { type: 'number' },
          },
        },
        render: (_args: any, value: any) => [
          {
            type: 'text',
            text: value?.ok
              ? `🔎 ${value.source} 参考（${value.query}，${value.elapsed_ms}ms）\n` +
                value.items
                  .map(
                    (it: any, i: number) =>
                      `${i + 1}. ${it.title}${it.stars != null ? ` ⭐${it.stars}` : ''}\n   ${it.url}\n   ${(it.description || '').slice(0, 120)}${it.readme ? `\n   README：${it.readme.replace(/\s+/g, ' ').slice(0, 400)}…` : ''}`,
                  )
                  .join('\n')
              : `⚠️ 参考搜索失败（${value?.error ?? '未知'}），建议直接自己写方案，不要重试`,
          },
        ],
      },
      async execute(args: any) {
        return await searchReference({
          query: String(args?.query ?? ''),
          source: args?.source === 'web' ? 'web' : 'github',
          limit: Number(args?.limit ?? 3),
          readmeChars: Number(args?.readme_chars ?? 1200),
        })
      },
      presentCall(args: any) {
        return { card: 'generic', title: `参考搜索 → ${String(args?.query ?? '')}`, kind: 'read' }
      },
    }

    let toolDispose: (() => void) | null = null
    try {
      const d = ctx.tools.register(tool)
      if (typeof d === 'function') toolDispose = d
      console.log(`${LOG_TAG} 已注册工具 run_web_task`)
    } catch (e) {
      console.error(`${LOG_TAG} 注册 run_web_task 失败：`, e)
    }

    let refDispose: (() => void) | null = null
    try {
      const d = ctx.tools.register(refTool)
      if (typeof d === 'function') refDispose = d
      console.log(`${LOG_TAG} 已注册工具 search_reference`)
    } catch (e) {
      console.error(`${LOG_TAG} 注册 search_reference 失败：`, e)
    }

    ctx.on('dispose', async () => {
      if (refDispose) {
        try { refDispose() } catch { /* ignore */ }
      }
      if (toolDispose) {
        try {
          toolDispose()
        } catch {
          /* ignore */
        }
      }
      if (browser) {
        try {
          await browser.close()
          console.log(`${LOG_TAG} chromium 已关闭`)
        } catch (e) {
          console.error(`${LOG_TAG} 关闭 chromium 失败：${(e as Error).message}`)
        }
        browser = null
      }
      console.log(`${LOG_TAG} disposed`)
    })
  },
}
