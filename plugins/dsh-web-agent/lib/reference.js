// src/reference.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
async function fetchText(url, timeoutMs = 12e3, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": UA, ...headers } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}
function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d))).replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}
async function searchGithubApi(query, limit, readmeChars) {
  const q = encodeURIComponent(query);
  const body = await fetchText(
    `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${Math.max(1, Math.min(5, limit))}`,
    1e4,
    { accept: "application/vnd.github+json" }
  );
  const j = JSON.parse(body);
  const repos = Array.isArray(j?.items) ? j.items.slice(0, limit) : [];
  const items = repos.map((r) => ({
    title: r.full_name || r.name || "(unknown)",
    url: r.html_url || "",
    stars: typeof r.stargazers_count === "number" ? r.stargazers_count : void 0,
    description: (r.description || "").slice(0, 200),
    via: "api"
  }));
  for (const it of items.slice(0, 2)) {
    try {
      const rb = await fetchText(`https://api.github.com/repos/${it.title}/readme`, 1e4, {
        accept: "application/vnd.github+json"
      });
      const rj = JSON.parse(rb);
      const text = Buffer.from(String(rj?.content || ""), String(rj?.encoding || "base64")).toString("utf8");
      it.readme = text.replace(/\r/g, "").slice(0, readmeChars);
    } catch {
    }
  }
  return items;
}
async function bingSearch(q, limit) {
  const html = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`, 12e3);
  const items = [];
  for (const block of html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []) {
    const m = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const url = m[1];
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    const snip = decodeEntities((block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [, ""])[1].replace(/<[^>]+>/g, "")).trim();
    if (!url.startsWith("http")) continue;
    items.push({ title, url, description: snip.slice(0, 220) });
    if (items.length >= limit) break;
  }
  return items;
}
async function searchGitee(query, limit) {
  const body = await fetchText(
    `https://gitee.com/api/v5/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.max(1, Math.min(5, limit))}`,
    1e4
  );
  const arr = JSON.parse(body);
  return (Array.isArray(arr) ? arr : []).slice(0, limit).map((r) => ({
    title: r.full_name || r.path || "(unknown)",
    url: r.html_url || "",
    stars: typeof r.stargazers_count === "number" ? r.stargazers_count : void 0,
    description: String(r.description || "").slice(0, 200),
    via: "gitee"
  }));
}
async function searchGithubViaBing(query, limit) {
  const hits = await bingSearch(`${query} site:github.com`, Math.max(limit * 2, 6));
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const h of hits) {
    const m = h.url.match(/^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/);
    if (!m) continue;
    const repo = `${m[1]}/${m[2].replace(/\.git$/, "")}`;
    if (seen.has(repo)) continue;
    seen.add(repo);
    out.push({
      title: repo,
      url: `https://github.com/${repo}`,
      description: h.description,
      via: "bing"
    });
    if (out.length >= limit) break;
  }
  return out;
}
async function searchWeb(query, limit) {
  const hits = await bingSearch(`${query} \u6700\u4F73\u5B9E\u8DF5 \u5F00\u6E90\u65B9\u6848`, Math.max(limit * 2, 6));
  const useful = hits.filter((h) => {
    try {
      const u = new URL(h.url);
      return u.pathname !== "/" || u.search.length > 1;
    } catch {
      return false;
    }
  });
  return (useful.length ? useful : hits).slice(0, limit);
}
async function searchReference(opts) {
  const t0 = Date.now();
  const query = (opts.query || "").trim();
  const source = opts.source === "web" ? "web" : "github";
  const limit = Math.max(1, Math.min(5, opts.limit ?? 3));
  if (!query) return { ok: false, query, source, items: [], error: "query \u4E0D\u80FD\u4E3A\u7A7A", elapsed_ms: 0 };
  if (source === "web") {
    try {
      const items = await searchWeb(query, limit);
      if (!items.length) return { ok: false, query, source, items: [], error: "\u6CA1\u6709\u641C\u5230\u7ED3\u679C", elapsed_ms: Date.now() - t0 };
      return { ok: true, query, source, items, elapsed_ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, query, source, items: [], error: `\u641C\u7D22\u5931\u8D25\uFF1A${e.message}`, elapsed_ms: Date.now() - t0 };
    }
  }
  try {
    const items = await searchGithubApi(query, limit, opts.readmeChars ?? 1200);
    if (items.length) return { ok: true, query, source, items, elapsed_ms: Date.now() - t0 };
  } catch {
  }
  try {
    const gitems = await searchGitee(query, limit);
    if (gitems.length) return { ok: true, query, source, items: gitems, elapsed_ms: Date.now() - t0 };
  } catch {
  }
  try {
    const items = await searchGithubViaBing(query, limit);
    if (items.length) {
      return {
        ok: true,
        query,
        source,
        items,
        error: void 0,
        elapsed_ms: Date.now() - t0
      };
    }
    return { ok: false, query, source, items: [], error: "GitHub API \u4E0D\u53EF\u8FBE\uFF0CBing \u4E5F\u6CA1\u641C\u5230\u4ED3\u5E93", elapsed_ms: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      query,
      source,
      items: [],
      error: `GitHub \u4E0D\u53EF\u8FBE\u4E14\u9000\u8DEF\u5931\u8D25\uFF1A${e.message}`,
      elapsed_ms: Date.now() - t0
    };
  }
}
export {
  searchGitee,
  searchGithubApi,
  searchGithubViaBing,
  searchReference,
  searchWeb
};
//# sourceMappingURL=reference.js.map
