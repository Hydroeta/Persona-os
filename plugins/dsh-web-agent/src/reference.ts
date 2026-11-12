/**
 * reference.ts —— 「先看别人怎么写的」：开源 / 网页参考搜索
 *
 * 为什么放这里：仓库里没有 dsh-autopilot / introspect_self / scout_web / save_proposal 这些工具
 * （外部方案里那套名字是编的），而 dsh-web-agent 本来就是"联网抓东西"的插件，参考搜索归它管。
 *
 * 两个来源：
 *   github：优先 api.github.com 搜仓库（按 star 排）并抓前两名 README；
 *           **被墙或超时时自动退回 Bing `site:github.com`**，从结果里抽 owner/repo
 *   web   ：Bing 结果页 HTML，取标题 + 摘要（不抓全文，全文交给 run_web_task）
 *
 * 一律 fail-soft：网络失败返回 { ok:false, error }，让调用方降级成"不参考网上的，自己写方案"。
 */

export interface ReferenceItem {
  title: string
  url: string
  stars?: number
  description?: string
  readme?: string
  /** 这条是怎么来的，便于排查 */
  via?: 'api' | 'bing' | 'gitee'
}

export interface ReferenceResult {
  ok: boolean
  query: string
  source: 'github' | 'web'
  items: ReferenceItem[]
  error?: string
  elapsed_ms: number
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'

async function fetchText(url: string, timeoutMs = 12_000, headers: Record<string, string> = {}): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA, ...headers } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(timer)
  }
}

/** Bing 的摘要里混着 &#0183; 之类的实体，简单地转回来 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

/** GitHub 开放 API：搜仓库 + 抓前两名 README */
export async function searchGithubApi(query: string, limit: number, readmeChars: number): Promise<ReferenceItem[]> {
  const q = encodeURIComponent(query)
  const body = await fetchText(
    `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${Math.max(1, Math.min(5, limit))}`,
    10_000,
    { accept: 'application/vnd.github+json' },
  )
  const j: any = JSON.parse(body)
  const repos: any[] = Array.isArray(j?.items) ? j.items.slice(0, limit) : []
  const items: ReferenceItem[] = repos.map((r) => ({
    title: r.full_name || r.name || '(unknown)',
    url: r.html_url || '',
    stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : undefined,
    description: (r.description || '').slice(0, 200),
    via: 'api' as const,
  }))
  for (const it of items.slice(0, 2)) {
    try {
      const rb = await fetchText(`https://api.github.com/repos/${it.title}/readme`, 10_000, {
        accept: 'application/vnd.github+json',
      })
      const rj: any = JSON.parse(rb)
      const text = Buffer.from(String(rj?.content || ''), String(rj?.encoding || 'base64')).toString('utf8')
      it.readme = text.replace(/\r/g, '').slice(0, readmeChars)
    } catch {
      /* 单个 README 挂了不影响整体 */
    }
  }
  return items
}

/** 通用 Bing 搜索：返回 (标题, url, 摘要) */
async function bingSearch(q: string, limit: number): Promise<ReferenceItem[]> {
  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`, 12_000)
  const items: ReferenceItem[] = []
  for (const block of html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []) {
    const m = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!m) continue
    const url = m[1]
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim()
    const snip = decodeEntities((block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [, ''])[1].replace(/<[^>]+>/g, '')).trim()
    if (!url.startsWith('http')) continue
    items.push({ title, url, description: snip.slice(0, 220) })
    if (items.length >= limit) break
  }
  return items
}

/** GitHub 不可达时的实用退路：Gitee 开放搜索（国内可达，仓库同样是开源代码） */
export async function searchGitee(query: string, limit: number): Promise<ReferenceItem[]> {
  const body = await fetchText(
    `https://gitee.com/api/v5/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.max(1, Math.min(5, limit))}`,
    10_000,
  )
  const arr: any[] = JSON.parse(body)
  return (Array.isArray(arr) ? arr : []).slice(0, limit).map((r) => ({
    title: r.full_name || r.path || '(unknown)',
    url: r.html_url || '',
    stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : undefined,
    description: String(r.description || '').slice(0, 200),
    via: 'gitee' as const,
  }))
}

/** GitHub 被墙时的退路：用 Bing 搜 site:github.com，从 URL 里抽 owner/repo */
export async function searchGithubViaBing(query: string, limit: number): Promise<ReferenceItem[]> {
  const hits = await bingSearch(`${query} site:github.com`, Math.max(limit * 2, 6))
  const out: ReferenceItem[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    const m = h.url.match(/^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/)
    if (!m) continue
    const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`
    if (seen.has(repo)) continue
    seen.add(repo)
    out.push({
      title: repo,
      url: `https://github.com/${repo}`,
      description: h.description,
      via: 'bing',
    })
    if (out.length >= limit) break
  }
  return out
}

/** 网页参考：Bing 取标题 + 摘要，过滤掉「只有首页」的结果 */
export async function searchWeb(query: string, limit: number): Promise<ReferenceItem[]> {
  const hits = await bingSearch(`${query} 最佳实践 开源方案`, Math.max(limit * 2, 6))
  const useful = hits.filter((h) => {
    try {
      const u = new URL(h.url)
      return u.pathname !== '/' || u.search.length > 1
    } catch {
      return false
    }
  })
  return (useful.length ? useful : hits).slice(0, limit)
}

export async function searchReference(opts: {
  query: string
  source?: 'github' | 'web'
  limit?: number
  readmeChars?: number
}): Promise<ReferenceResult> {
  const t0 = Date.now()
  const query = (opts.query || '').trim()
  const source = opts.source === 'web' ? 'web' : 'github'
  const limit = Math.max(1, Math.min(5, opts.limit ?? 3))
  if (!query) return { ok: false, query, source, items: [], error: 'query 不能为空', elapsed_ms: 0 }

  if (source === 'web') {
    try {
      const items = await searchWeb(query, limit)
      if (!items.length) return { ok: false, query, source, items: [], error: '没有搜到结果', elapsed_ms: Date.now() - t0 }
      return { ok: true, query, source, items, elapsed_ms: Date.now() - t0 }
    } catch (e) {
      return { ok: false, query, source, items: [], error: `搜索失败：${(e as Error).message}`, elapsed_ms: Date.now() - t0 }
    }
  }

  // github：先试官方 API，挂了再走 Bing 退路
  try {
    const items = await searchGithubApi(query, limit, opts.readmeChars ?? 1200)
    if (items.length) return { ok: true, query, source, items, elapsed_ms: Date.now() - t0 }
  } catch {
    /* 落到下面 */
  }
  // 第二选择：Gitee（国内可达）
  try {
    const gitems = await searchGitee(query, limit)
    if (gitems.length) return { ok: true, query, source, items: gitems, elapsed_ms: Date.now() - t0 }
  } catch {
    /* 落到 Bing 退路 */
  }
  try {
    const items = await searchGithubViaBing(query, limit)
    if (items.length) {
      return {
        ok: true,
        query,
        source,
        items,
        error: undefined,
        elapsed_ms: Date.now() - t0,
      }
    }
    return { ok: false, query, source, items: [], error: 'GitHub API 不可达，Bing 也没搜到仓库', elapsed_ms: Date.now() - t0 }
  } catch (e) {
    return {
      ok: false,
      query,
      source,
      items: [],
      error: `GitHub 不可达且退路失败：${(e as Error).message}`,
      elapsed_ms: Date.now() - t0,
    }
  }
}
