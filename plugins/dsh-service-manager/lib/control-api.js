// src/control-api.ts
import { createServer } from "node:http";
var LOG_TAG = "[dsh-service-manager/ctl]";
var CTL_PORT = Number(process.env.SERVICE_CTL_PORT) || 8010;
var CTL_TOKEN = process.env.SERVICE_CTL_TOKEN || "";
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 65536) {
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
function startControlApi(hooks, opts = {}) {
  const port = opts.port ?? CTL_PORT;
  const token = opts.token ?? CTL_TOKEN;
  const stopped = /* @__PURE__ */ new Set();
  const allowed = (name) => hooks.names.includes(name);
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/health") {
        return json(res, 200, { ok: true, services: hooks.names });
      }
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "only POST" });
      if (token && req.headers["x-ctl-token"] !== token) return json(res, 401, { ok: false, error: "token \u4E0D\u5339\u914D" });
      await readBody(req).catch(() => "");
      if (u.pathname === "/start-all") {
        const out = [];
        for (const name2 of hooks.names) {
          if (stopped.has(name2)) {
            out.push({ name: name2, ok: false, detail: "\u88AB\u624B\u52A8\u505C\u6B62\uFF0C\u8DF3\u8FC7\uFF08\u53EF\u5148 /start?name=\uFF09" });
            continue;
          }
          if (await hooks.isRunning(name2)) {
            out.push({ name: name2, ok: true, detail: "\u5DF2\u5728\u8FD0\u884C" });
            continue;
          }
          const r = await hooks.start(name2);
          out.push({ name: name2, ...r });
        }
        return json(res, 200, { ok: out.every((o) => o.ok), results: out });
      }
      const name = u.pathname === "/restart" || u.pathname === "/stop" || u.pathname === "/start" ? String(u.searchParams.get("name") || "") : "";
      if (!name) return json(res, 400, { ok: false, error: "\u7F3A\u5C11 name \u53C2\u6570" });
      if (!allowed(name)) return json(res, 400, { ok: false, error: `\u672A\u77E5\u670D\u52A1\uFF1A${name}\uFF08\u53EF\u7528\uFF1A${hooks.names.join("/")}\uFF09` });
      if (u.pathname === "/restart") {
        const k = await hooks.stop(name);
        stopped.delete(name);
        const s2 = await hooks.start(name);
        return json(res, k.ok && s2.ok ? 200 : 500, { ok: k.ok && s2.ok, stop: k, start: s2 });
      }
      if (u.pathname === "/stop") {
        const k = await hooks.stop(name);
        if (k.ok) stopped.add(name);
        return json(res, k.ok ? 200 : 500, { ok: k.ok, stop: k });
      }
      stopped.delete(name);
      const s = await hooks.start(name);
      return json(res, s.ok ? 200 : 500, { ok: s.ok, start: s });
    } catch (e) {
      console.error(`${LOG_TAG} \u5904\u7406\u5931\u8D25\uFF1A${e.message}`);
      return json(res, 500, { ok: false, error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      console.log(`${LOG_TAG} \u63A7\u5236\u63A5\u53E3\u5DF2\u76D1\u542C http://127.0.0.1:${actual}`);
      resolve({ port: actual, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
export {
  CTL_PORT,
  CTL_TOKEN,
  startControlApi
};
//# sourceMappingURL=control-api.js.map
