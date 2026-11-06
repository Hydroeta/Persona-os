import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/memory.ts
var LOG_TAG = "[dsh-live-director:memory]";
var DEFAULT_BASE_URL = (process.env.MEMORY_BUS_URL || "http://127.0.0.1:8001").replace(/\/$/, "");
function createHttpMemoryTransport(opts = {}) {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 3e3;
  return {
    async recall(query, limit = 10) {
      const q = String(query ?? "").trim();
      if (!q) return [];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(`${baseUrl}/recall?query=${encodeURIComponent(q)}&limit=${limit}`, {
          signal: ctrl.signal
        });
        const data = await r.json().catch(() => ({}));
        return Array.isArray(data?.results) ? data.results : [];
      } catch (e) {
        console.warn(`${LOG_TAG} recall \u5931\u8D25\uFF08\u964D\u7EA7\u4E3A\u7A7A\uFF09\uFF1A${e.message}`);
        return [];
      } finally {
        clearTimeout(timer);
      }
    },
    async remember(text, tags = [], level = "user") {
      const payload = String(text ?? "").trim();
      if (!payload) return;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        await fetch(`${baseUrl}/remember`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: payload, tags, level }),
          signal: ctrl.signal
        });
      } catch (e) {
        console.warn(`${LOG_TAG} remember \u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF0C\u4E0D\u963B\u585E\u76F4\u64AD\uFF09\uFF1A${e.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
var MemoryClient = class {
  transport;
  constructor(opts = {}) {
    this.transport = opts.transport ?? createHttpMemoryTransport({ baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs });
  }
  /**
   * 查询某用户的历史互动上下文。
   * recall 以用户名为关键词，再过滤 title/snippet/content/tags 确实包含该用户名的条目，
   * 避免无关记忆串台。查不到或服务不可用返回 ''。
   */
  async getUserContext(user) {
    const u = String(user ?? "").trim();
    if (!u) return "";
    const results = await this.transport.recall(u, 10);
    const relevant = results.filter((r) => {
      const hay = [r.title, r.snippet, r.content, ...r.tags ?? []].filter((x) => typeof x === "string" && x.length > 0).join(" ");
      return hay.includes(u);
    });
    if (!relevant.length) return "";
    const snippets = relevant.slice(0, 5).map((r) => (r.snippet || r.content || r.title || "").trim()).filter((s) => s.length > 0);
    return snippets.join("\uFF1B");
  }
  /**
   * 异步保存当前互动（fire-and-forget，不阻塞主线程）。
   * 用 level='user' 写入记忆库的 user 层，tags 带用户名便于下次 recall 命中。
   */
  saveUserInteraction(user, text) {
    const u = String(user ?? "").trim();
    const t = String(text ?? "").trim();
    if (!u || !t) return;
    const payload = `\u89C2\u4F17\u300C${u}\u300D\u4E92\u52A8\uFF1A${t}`;
    void this.transport.remember(payload, [u, "live-director"], "user");
  }
};
function buildMemoryPrompt(user, userContext) {
  const ctx = String(userContext ?? "").trim();
  if (!ctx) return "";
  return `\u6CE8\u610F\uFF1A\u5F53\u524D\u89C2\u4F17\u300C${user}\u300D\u662F\u8001\u719F\u4EBA\uFF0C\u5386\u53F2\u8BB0\u5FC6\u6863\u6848\u2014\u2014${ctx}\u3002\u8BF7\u50CF\u5BF9\u5F85\u719F\u4EBA\u4E00\u6837\u81EA\u7136\u3001\u70ED\u60C5\u5730\u547C\u5E94\uFF0C\u4F46\u4E0D\u8981\u673A\u68B0\u590D\u8FF0\u6863\u6848\u3002`;
}
export {
  LOG_TAG,
  MemoryClient,
  buildMemoryPrompt,
  createHttpMemoryTransport
};
//# sourceMappingURL=memory.js.map
