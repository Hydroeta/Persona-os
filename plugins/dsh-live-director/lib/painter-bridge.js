import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/painter-bridge.ts
import { createServer } from "node:http";
var LOG_TAG = "[dsh-live-director/painter-bridge]";
var BRIDGE_PORT = Number(process.env.PAINTER_BRIDGE_PORT) || 9011;
var BRIDGE_TOKEN = process.env.PAINTER_BRIDGE_TOKEN || "";
var BRIDGE_URL = (process.env.PAINTER_BRIDGE_URL || `http://127.0.0.1:${BRIDGE_PORT}`).replace(/\/$/, "");
function readBody(req, limit = 1048576) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
function startPainterBridge(paint, opts = {}) {
  const port = opts.port ?? BRIDGE_PORT;
  const token = opts.token ?? BRIDGE_TOKEN;
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, service: "painter-bridge" });
        if (req.method !== "POST" || req.url !== "/paint") return send(res, 404, { ok: false, error: "not found" });
        if (token && req.headers["x-bridge-token"] !== token) return send(res, 401, { ok: false, error: "token \u4E0D\u5339\u914D" });
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return send(res, 400, { ok: false, error: "JSON \u89E3\u6790\u5931\u8D25" });
        }
        if (!body.prompt || !body.obs_output_path) return send(res, 400, { ok: false, error: "prompt \u4E0E obs_output_path \u5FC5\u586B" });
        const r = await paint(body);
        return send(res, r.ok ? 200 : 500, r);
      } catch (e) {
        console.error(`${LOG_TAG} \u5904\u7406\u5931\u8D25\uFF1A${e.message}`);
        return send(res, 500, { ok: false, error: e.message });
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`${LOG_TAG} \u5DF2\u76D1\u542C http://127.0.0.1:${actual}/paint`);
      resolve({
        port: actual,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}
async function requestPaint(req, opts = {}) {
  const url = `${opts.url || BRIDGE_URL}/paint`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12e4);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...BRIDGE_TOKEN ? { "x-bridge-token": BRIDGE_TOKEN } : {} },
      body: JSON.stringify(req),
      signal: ctrl.signal
    });
    const j = await r.json().catch(() => ({}));
    return { ok: !!j.ok, ...j };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}
export {
  BRIDGE_PORT,
  BRIDGE_TOKEN,
  BRIDGE_URL,
  requestPaint,
  startPainterBridge
};
//# sourceMappingURL=painter-bridge.js.map
