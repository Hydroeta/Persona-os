// src/index.ts
import { existsSync } from "node:fs";
import { chromium } from "playwright";

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

// src/index.ts
var LOG_TAG = "[dsh-web-agent]";
var DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var NAV_TIMEOUT = 15e3;
var TASK_TIMEOUT = 45e3;
var MAX_CONTENT_CHARS = 4e3;
var MAX_LINKS = 100;
var browser = null;
var launching = null;
var SYSTEM_BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`
].filter(Boolean);
function detectSystemBrowser() {
  for (const p of SYSTEM_BROWSER_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}
var BASE_LAUNCH_OPTS = {
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"]
};
async function getBrowser() {
  if (browser) return browser;
  if (launching) return launching;
  launching = (async () => {
    const explicit = process.env.WEB_AGENT_CHROMIUM_PATH;
    if (explicit) {
      const b = await chromium.launch({ ...BASE_LAUNCH_OPTS, executablePath: explicit });
      browser = b;
      console.log(`${LOG_TAG} \u6D4F\u89C8\u5668\u5DF2\u542F\u52A8\uFF08\u5355\u4F8B\uFF0CexecutablePath=${explicit}\uFF09`);
      return b;
    }
    try {
      const b = await chromium.launch(BASE_LAUNCH_OPTS);
      browser = b;
      console.log(`${LOG_TAG} \u5185\u7F6E chromium \u5DF2\u542F\u52A8\uFF08\u5355\u4F8B\uFF09`);
      return b;
    } catch (e) {
      const sys = detectSystemBrowser();
      if (!sys) throw e;
      const b = await chromium.launch({ ...BASE_LAUNCH_OPTS, executablePath: sys });
      browser = b;
      console.log(`${LOG_TAG} \u5185\u7F6E chromium \u4E0D\u53EF\u7528\uFF0C\u56DE\u9000\u5230\u7CFB\u7EDF\u6D4F\u89C8\u5668\uFF1A${sys}`);
      return b;
    }
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}
function extractInPage() {
  const removeSelectors = "script,style,noscript,template,iframe,svg,nav,header,footer,aside,form,button,input,select,textarea".split(",");
  removeSelectors.forEach((sel) => {
    try {
      document.querySelectorAll(sel).forEach((e) => e.remove());
    } catch {
    }
  });
  const root = document.querySelector("article") || document.querySelector("main") || document.body;
  const lines = [];
  const walk = (node) => {
    if (!node) return;
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.textContent || "").replace(/\s+/g, " ").trim();
        if (t) lines.push(t);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child;
        const tag = el.tagName.toLowerCase();
        if (/^h[1-4]$/.test(tag)) {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (t) lines.push("\n" + "#".repeat(Number(tag[1])) + " " + t);
        } else if (tag === "a") {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          const href = el.getAttribute("href") || "";
          if (t) lines.push(href ? `[${t}](${href})` : t);
        } else if (tag === "li") {
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (t) lines.push("- " + t);
        } else if (tag === "br") {
          lines.push("");
        } else {
          walk(el);
        }
      }
    });
  };
  walk(root);
  const title = (document.title || "").trim();
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}
function extractLinksInPage() {
  const out = [];
  document.querySelectorAll("a[href]").forEach((a) => {
    const t = (a.textContent || "").replace(/\s+/g, " ").trim();
    const h = a.getAttribute("href") || "";
    if (h) out.push({ text: t.slice(0, 80), href: h });
  });
  return out;
}
async function runWebTask(args) {
  const url = (args.url || "").trim();
  if (!url) return { ok: false, url: "", action: args.action || "extract_text", error: "url \u4E0D\u80FD\u4E3A\u7A7A" };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, url, action: args.action || "extract_text", error: "url \u5FC5\u987B\u4EE5 http:// \u6216 https:// \u5F00\u5934" };
  }
  const action = (args.action || "extract_text").trim();
  const selector = (args.selector || "").trim();
  const validActions = ["extract_text", "click_selector", "extract_links"];
  if (!validActions.includes(action)) {
    return { ok: false, url, action, error: `\u672A\u77E5 action "${action}"\uFF0C\u53EF\u9009\uFF1A${validActions.join(" / ")}` };
  }
  let context = null;
  let page = null;
  let watchdog = null;
  try {
    const b = await getBrowser();
    context = await b.newContext({ userAgent: DEFAULT_UA, viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);
    const work = (async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      if (action === "click_selector") {
        if (!selector) throw new Error("action=click_selector \u65F6\u5FC5\u987B\u63D0\u4F9B selector");
        await page.click(selector, { timeout: NAV_TIMEOUT });
        await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT }).catch(() => {
        });
      }
      if (action === "extract_links") {
        const all = await page.evaluate(extractLinksInPage);
        return {
          ok: true,
          url,
          action,
          links: all.slice(0, MAX_LINKS),
          link_count: all.length
        };
      }
      const { title, text } = await page.evaluate(extractInPage);
      const truncated = text.length > MAX_CONTENT_CHARS;
      return {
        ok: true,
        url,
        action,
        title,
        text: truncated ? text.slice(0, MAX_CONTENT_CHARS) + "\u2026(\u5DF2\u622A\u65AD)" : text,
        char_count: text.length,
        truncated
      };
    })();
    const watchdogPromise = new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("\u4EFB\u52A1\u603B\u8D85\u65F6\uFF0845s\uFF09\uFF0C\u9875\u9762\u5DF2\u5F3A\u5236\u5173\u95ED")), TASK_TIMEOUT);
    });
    const result = await Promise.race([work, watchdogPromise]);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, url, action, error: msg.slice(0, 300) };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    try {
      if (page) await page.close();
    } catch {
    }
    try {
      if (context) await context.close();
    } catch {
    }
  }
}
var MEMORY_URL = (process.env.MEMORY_BUS_URL || "http://127.0.0.1:8001").replace(/\/$/, "");
var SAVE_MAX_CHARS = 300;
var SAVE_COOLDOWN_MS = 10 * 60 * 1e3;
var lastSaveByHost = /* @__PURE__ */ new Map();
function hostOf(url) {
  try {
    return new URL(url).host || "unknown";
  } catch {
    return "unknown";
  }
}
function toFact(url, title, text) {
  const host = hostOf(url);
  const body = (text || "").replace(/\s+/g, " ").trim().slice(0, SAVE_MAX_CHARS);
  const head = title ? `\u300A${title.slice(0, 60)}\u300B` : "";
  return `\u7F51\u9875\u6293\u53D6 ${host}\uFF1A${head}${body}`.slice(0, SAVE_MAX_CHARS);
}
async function saveToMemory(url, title, text) {
  const body = (text || "").trim();
  if (body.length < 80) return false;
  const host = hostOf(url);
  const now = Date.now();
  const last = lastSaveByHost.get(host) ?? 0;
  if (now - last < SAVE_COOLDOWN_MS) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3e3);
  try {
    const r = await fetch(`${MEMORY_URL}/remember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: toFact(url, title, body),
        tags: ["\u7F51\u9875\u6293\u53D6", host],
        level: "fact",
        project: `\u7F51\u9875\u6293\u53D6/${host}`
      }),
      signal: ctrl.signal
    });
    if (!r.ok) {
      console.error(`${LOG_TAG} \u5199\u8BB0\u5FC6\u5931\u8D25\uFF1AHTTP ${r.status}`);
      return false;
    }
    lastSaveByHost.set(host, now);
    console.log(`${LOG_TAG} \u{1F4DD} \u5DF2\u5199\u5165\u4E8B\u5B9E\u8BB0\u5FC6\uFF1A${host}\u300A${String(title).slice(0, 30)}\u300B`);
    return true;
  } catch (e) {
    console.error(`${LOG_TAG} \u5199\u8BB0\u5FC6\u5931\u8D25\uFF1A${e.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
var index_default = {
  name: "dsh-web-agent",
  apply(ctx) {
    try {
      if (typeof ctx.set === "function") {
        ctx.set("webAgent", { runTask: runWebTask });
        console.log(`${LOG_TAG} \u5DF2\u66B4\u9732 webAgent \u670D\u52A1\uFF08ctx.get('webAgent')\uFF09`);
      }
    } catch (e) {
      console.error(`${LOG_TAG} \u66B4\u9732 webAgent \u670D\u52A1\u5931\u8D25\uFF1A${e.message}`);
    }
    const tool = {
      name: "run_web_task",
      description: "\u540E\u53F0\u65E0\u5934\u6D4F\u89C8\u5668\u6293\u53D6\u7F51\u9875\uFF08\u4E0D\u62A2\u5360\u9F20\u6807\uFF09\u3002\u4F20\u5165 url\uFF1Baction \u53EF\u9009 extract_text\uFF08\u9ED8\u8BA4\uFF0C\u6293\u6B63\u6587\uFF09\u3001click_selector\uFF08\u70B9\u51FB selector \u540E\u6293\u6B63\u6587\uFF09\u3001extract_links\uFF08\u6293\u6240\u6709\u94FE\u63A5\uFF09\u3002\u6240\u6709\u64CD\u4F5C\u6709 15s \u8D85\u65F6\u4E0E 45s \u603B\u770B\u95E8\u72D7\uFF0C\u8D85\u65F6/\u5931\u8D25\u8FD4\u56DE\u53CB\u597D\u63D0\u793A\uFF0C\u4E0D\u4F1A\u5361\u6B7B\u3002",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", description: "\u76EE\u6807\u7F51\u5740\uFF0C\u5FC5\u987B\u4EE5 http:// \u6216 https:// \u5F00\u5934" },
          action: {
            type: "string",
            description: "\u52A8\u4F5C\uFF1Aextract_text\uFF08\u9ED8\u8BA4\uFF09/ click_selector / extract_links",
            enum: ["extract_text", "click_selector", "extract_links"]
          },
          selector: { type: "string", description: "click_selector \u7528\u7684 CSS \u9009\u62E9\u5668" },
          save_to_memory: {
            type: "boolean",
            description: "\u6293\u6210\u529F\u540E\u628A\u6B63\u6587\u538B\u6210\u4E00\u6761 fact \u5199\u8FDB\u8BB0\u5FC6\u603B\u7EBF\uFF08\u9ED8\u8BA4 false\uFF09\u3002\u540C\u57DF\u540D 10 \u5206\u949F\u5185\u53EA\u5B58\u4E00\u6B21\u3002"
          }
        }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            url: { type: "string" },
            action: { type: "string" },
            title: { type: "string" },
            text: { type: "string" },
            error: { type: "string" },
            memory_saved: { type: "boolean" }
          }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value?.ok ? `\u{1F310} ${value.action} ${value.url}
\u6807\u9898\uFF1A${value.title ?? ""}
${value.text ?? ""}`.slice(0, 1500) + (value?.memory_saved ? "\n\u{1F4DD} \u5DF2\u5B58\u5165\u4E8B\u5B9E\u8BB0\u5FC6" : "") : `\u274C web_agent \u5931\u8D25\uFF1A${value?.error ?? "\u672A\u77E5"}\uFF08${value?.url ?? ""}\uFF09`
          }
        ]
      },
      async execute(args) {
        const res = await runWebTask({ url: args?.url, action: args?.action, selector: args?.selector });
        let saved = false;
        if (args?.save_to_memory && res?.ok && res?.action === "extract_text") {
          saved = await saveToMemory(String(args?.url ?? ""), String(res?.title ?? ""), String(res?.text ?? ""));
        }
        return { ...res, memory_saved: saved };
      },
      presentCall(args) {
        return { card: "generic", title: `web_agent \u2192 ${String(args?.action ?? "extract_text")} ${String(args?.url ?? "")}`, kind: "read" };
      }
    };
    const refTool = {
      name: "search_reference",
      description: "\u5F00\u5DE5\u524D\u5148\u53C2\u8003\u5F00\u6E90/\u7F51\u9875\u65B9\u6848\uFF1Asource=github \u641C\u4ED3\u5E93\uFF08\u6309 star \u6392\uFF0C\u5E26\u56DE\u524D\u4E24\u540D\u7684 README \u7247\u6BB5\uFF09\uFF0Csource=web \u641C\u6280\u672F\u6587\u7AE0\uFF08\u6807\u9898+\u6458\u8981\uFF09\u3002\u7F51\u7EDC\u5931\u8D25\u4F1A\u8FD4\u56DE ok:false\uFF0C\u8FD9\u65F6\u5E94\u964D\u7EA7\u4E3A\u81EA\u5DF1\u5199\u65B9\u6848\uFF0C\u522B\u53CD\u590D\u91CD\u8BD5\u3002",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: '\u68C0\u7D22\u8BCD\uFF0C\u5EFA\u8BAE\u82F1\u6587\u6280\u672F\u8BCD\uFF0C\u5982 "nodejs audio queue optimization"' },
          source: { type: "string", enum: ["github", "web"], description: "github=\u5F00\u6E90\u4ED3\u5E93\uFF08\u9ED8\u8BA4\uFF09\uFF5Cweb=\u6280\u672F\u6587\u7AE0" },
          limit: { type: "number", description: "\u8FD4\u56DE\u6761\u6570\uFF0C1~5\uFF0C\u9ED8\u8BA4 3" },
          readme_chars: { type: "number", description: "github \u6A21\u5F0F\u4E0B README \u622A\u53D6\u957F\u5EA6\uFF0C\u9ED8\u8BA4 1200" }
        }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            query: { type: "string" },
            source: { type: "string" },
            items: { type: "array" },
            error: { type: "string" },
            elapsed_ms: { type: "number" }
          }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value?.ok ? `\u{1F50E} ${value.source} \u53C2\u8003\uFF08${value.query}\uFF0C${value.elapsed_ms}ms\uFF09
` + value.items.map(
              (it, i) => `${i + 1}. ${it.title}${it.stars != null ? ` \u2B50${it.stars}` : ""}
   ${it.url}
   ${(it.description || "").slice(0, 120)}${it.readme ? `
   README\uFF1A${it.readme.replace(/\s+/g, " ").slice(0, 400)}\u2026` : ""}`
            ).join("\n") : `\u26A0\uFE0F \u53C2\u8003\u641C\u7D22\u5931\u8D25\uFF08${value?.error ?? "\u672A\u77E5"}\uFF09\uFF0C\u5EFA\u8BAE\u76F4\u63A5\u81EA\u5DF1\u5199\u65B9\u6848\uFF0C\u4E0D\u8981\u91CD\u8BD5`
          }
        ]
      },
      async execute(args) {
        return await searchReference({
          query: String(args?.query ?? ""),
          source: args?.source === "web" ? "web" : "github",
          limit: Number(args?.limit ?? 3),
          readmeChars: Number(args?.readme_chars ?? 1200)
        });
      },
      presentCall(args) {
        return { card: "generic", title: `\u53C2\u8003\u641C\u7D22 \u2192 ${String(args?.query ?? "")}`, kind: "read" };
      }
    };
    let toolDispose = null;
    try {
      const d = ctx.tools.register(tool);
      if (typeof d === "function") toolDispose = d;
      console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 run_web_task`);
    } catch (e) {
      console.error(`${LOG_TAG} \u6CE8\u518C run_web_task \u5931\u8D25\uFF1A`, e);
    }
    let refDispose = null;
    try {
      const d = ctx.tools.register(refTool);
      if (typeof d === "function") refDispose = d;
      console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 search_reference`);
    } catch (e) {
      console.error(`${LOG_TAG} \u6CE8\u518C search_reference \u5931\u8D25\uFF1A`, e);
    }
    ctx.on("dispose", async () => {
      if (refDispose) {
        try {
          refDispose();
        } catch {
        }
      }
      if (toolDispose) {
        try {
          toolDispose();
        } catch {
        }
      }
      if (browser) {
        try {
          await browser.close();
          console.log(`${LOG_TAG} chromium \u5DF2\u5173\u95ED`);
        } catch (e) {
          console.error(`${LOG_TAG} \u5173\u95ED chromium \u5931\u8D25\uFF1A${e.message}`);
        }
        browser = null;
      }
      console.log(`${LOG_TAG} disposed`);
    });
  }
};
export {
  index_default as default,
  runWebTask,
  saveToMemory,
  searchReference
};
//# sourceMappingURL=index.js.map
