// src/index.ts
import { existsSync } from "node:fs";
import { chromium } from "playwright";
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
    let toolDispose = null;
    try {
      const d = ctx.tools.register(tool);
      if (typeof d === "function") toolDispose = d;
      console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 run_web_task`);
    } catch (e) {
      console.error(`${LOG_TAG} \u6CE8\u518C run_web_task \u5931\u8D25\uFF1A`, e);
    }
    ctx.on("dispose", async () => {
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
  saveToMemory
};
//# sourceMappingURL=index.js.map
