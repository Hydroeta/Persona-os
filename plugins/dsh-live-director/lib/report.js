import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/report.ts
var LOG_TAG = "[dsh-live-director/report]";
function panelEventUrl() {
  if (String(process.env.PANEL_EVENT || "") === "0") return "";
  return String(process.env.PANEL_EVENT_URL || "http://127.0.0.1:8088/api/event").trim();
}
async function reportEvent(ev, opts = {}) {
  const url = opts.url ?? panelEventUrl();
  if (!url) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 1500);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
      signal: ctrl.signal
    });
    return r.ok;
  } catch (e) {
    if (process.env.PANEL_EVENT_DEBUG === "1") {
      console.log(`${LOG_TAG} \u63A8\u9001\u5931\u8D25\uFF08\u9762\u677F\u53EF\u80FD\u6CA1\u5F00\uFF09\uFF1A${e.message}`);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}
function reportEventNoWait(ev, opts = {}) {
  void reportEvent(ev, opts).catch(() => {
  });
}
export {
  panelEventUrl,
  reportEvent,
  reportEventNoWait
};
//# sourceMappingURL=report.js.map
