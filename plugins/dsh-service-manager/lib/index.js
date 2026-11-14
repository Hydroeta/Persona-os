// src/index.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// src/index.ts
var LOG_TAG2 = "[dsh-service-manager]";
var HERE = path.dirname(fileURLToPath(import.meta.url));
var LOCAL_FALLBACK_ROOTS = [];
function looksLikeSourceRoot(cur) {
  return existsSync(path.join(cur, "ohwhale-deploy", "scripts", "indextts_server.py")) && existsSync(path.join(cur, "index-tts", ".venv", "Scripts", "python.exe"));
}
function walkUpForMarker(marker, maxUp = 8) {
  let cur = path.resolve(HERE, "..", "..", "..");
  for (let i = 0; i < maxUp; i++) {
    if (existsSync(path.join(cur, marker))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
function findSourceRoot() {
  const envRoot = process.env.PERSONA_OS_ROOT;
  if (envRoot && looksLikeSourceRoot(envRoot)) return path.resolve(envRoot);
  const found = walkUpForMarker(path.join("ohwhale-deploy", "scripts", "indextts_server.py"));
  if (found) return found;
  for (const root of LOCAL_FALLBACK_ROOTS) {
    if (looksLikeSourceRoot(root)) return path.resolve(root);
  }
  return null;
}
function findReleaseRoot() {
  const marker = path.join("core-services", "memory", "main.py");
  const envRoot = process.env.PERSONA_OS_ROOT;
  if (envRoot && existsSync(path.join(envRoot, marker))) return path.resolve(envRoot);
  const found = walkUpForMarker(marker);
  if (found) return found;
  for (const root of LOCAL_FALLBACK_ROOTS) {
    if (existsSync(path.join(root, marker))) return path.resolve(root);
    const inRelease = path.join(root, "github-release", "persona-os");
    if (existsSync(path.join(inRelease, marker))) return inRelease;
  }
  return null;
}
var SERVICES = [
  {
    name: "IndexTTS2",
    tag: "tts",
    pythonEnv: "INDEXTTS_PYTHON",
    pythonRel: (r) => path.join(r, "index-tts", ".venv", "Scripts", "python.exe"),
    scriptEnv: "INDEXTTS_SERVER",
    scriptRel: (r) => path.join(r, "ohwhale-deploy", "scripts", "indextts_server.py"),
    portEnv: "INDEXTTS_PORT",
    portDefault: 9881,
    // IndexTTS2 的 indextts_server.py 无标准 HTTP 健康端点 → 不轮询，spawn 后只看日志
    cwdFrom: "source"
  },
  {
    name: "Memory",
    tag: "memory",
    pythonEnv: "MEMORY_PYTHON",
    pythonRel: (r) => path.join(r, "ohwhale-deploy", ".venv", "Scripts", "python.exe"),
    scriptEnv: "MEMORY_SERVER",
    scriptRel: (r) => path.join(r, "core-services", "memory", "main.py"),
    portEnv: "MEMORY_PORT",
    portDefault: 8001,
    healthPath: "/health",
    cwdFrom: "release"
  },
  {
    name: "Painter",
    tag: "painter",
    pythonEnv: "PAINTER_PYTHON",
    pythonRel: (r) => path.join(r, "ohwhale-deploy", ".venv", "Scripts", "python.exe"),
    scriptEnv: "PAINTER_SERVER",
    scriptRel: (r) => path.join(r, "core-services", "painter", "main.py"),
    portEnv: "PAINTER_PORT",
    portDefault: 8002,
    healthPath: "/health",
    cwdFrom: "release"
  },
  {
    name: "GameBot",
    tag: "game",
    pythonEnv: "GAME_PYTHON",
    pythonRel: (r) => path.join(r, "ohwhale-deploy", ".venv", "Scripts", "python.exe"),
    scriptEnv: "GAME_SERVER",
    scriptRel: (r) => path.join(r, "core-services", "game-bot", "main.py"),
    portEnv: "GAME_BOT_PORT",
    portDefault: 8003,
    healthPath: "/health",
    cwdFrom: "release"
  },
  {
    name: "AudioCover",
    tag: "audio-cover",
    pythonEnv: "AUDIO_COVER_PYTHON",
    pythonRel: (r) => path.join(r, "ohwhale-deploy", ".venv", "Scripts", "python.exe"),
    scriptEnv: "AUDIO_COVER_SERVER",
    scriptRel: (r) => path.join(r, "core-services", "audio-cover", "main.py"),
    portEnv: "AUDIO_COVER_PORT",
    portDefault: 8005,
    healthPath: "/health",
    cwdFrom: "release"
  }
];
function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 800);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
async function portInUseRobust(port, host = "127.0.0.1") {
  for (let i = 0; i < 2; i++) {
    if (await portInUse(port, host)) return true;
    if (i === 0) await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
var children = /* @__PURE__ */ new Map();
var disposed = false;
var controlApi = null;
function killTreeSync(pid) {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
  }
}
async function waitHealth(svc, port, timeoutMs = 15e3) {
  if (!svc.healthPath) return true;
  const url = `http://127.0.0.1:${port}${svc.healthPath}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        console.log(`${LOG_TAG2} ${svc.name} \u5C31\u7EEA\uFF08port=${port}\uFF09`);
        return true;
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  console.warn(`${LOG_TAG2} ${svc.name} \u5065\u5EB7\u68C0\u67E5\u8D85\u65F6\uFF08port=${port}\uFF09\uFF0C\u8FDB\u7A0B\u53EF\u80FD\u4ECD\u5728\u542F\u52A8\uFF0C\u672A\u6740\uFF08\u4FDD\u7559\u73B0\u573A\u6392\u67E5\uFF09`);
  return false;
}
async function startService(svc, sourceRoot, releaseRoot) {
  const python = process.env[svc.pythonEnv] || svc.pythonRel(sourceRoot);
  const needRelease = svc.cwdFrom === "release" || svc.scriptRel.name;
  if (!existsSync(python)) {
    console.error(`${LOG_TAG2} ${svc.name} \u8DF3\u8FC7\uFF1Apython \u4E0D\u5B58\u5728 ${python}\uFF08\u53EF\u8BBE ${svc.pythonEnv}\uFF09`);
    return;
  }
  let script;
  if (process.env[svc.scriptEnv]) {
    script = process.env[svc.scriptEnv];
  } else {
    if (!releaseRoot) {
      console.error(`${LOG_TAG2} ${svc.name} \u8DF3\u8FC7\uFF1A\u65E0\u6CD5\u5B9A\u4F4D\u53D1\u5E03\u7248\u6839\uFF08\u53EF\u8BBE PERSONA_OS_ROOT \u6216 ${svc.scriptEnv}\uFF09`);
      return;
    }
    script = svc.scriptRel(releaseRoot);
  }
  if (!existsSync(script)) {
    console.error(`${LOG_TAG2} ${svc.name} \u8DF3\u8FC7\uFF1A\u811A\u672C\u4E0D\u5B58\u5728 ${script}`);
    return;
  }
  const port = Number(process.env[svc.portEnv] || svc.portDefault);
  if (await portInUseRobust(port)) {
    console.log(`${LOG_TAG2} \u7AEF\u53E3 ${port} \u5DF2\u88AB\u5360\u7528\uFF0C${svc.name} \u53EF\u80FD\u5DF2\u5728\u8FD0\u884C \u2192 \u8DF3\u8FC7\u62C9\u8D77\uFF08dispose \u4E0D\u4F1A\u52A8\u5B83\uFF09`);
    return;
  }
  const cwd = svc.cwdFrom === "release" && releaseRoot ? releaseRoot : sourceRoot;
  const env = { ...process.env };
  if (!env.PERSONA_OS_ROOT) env.PERSONA_OS_ROOT = sourceRoot;
  const child = spawn(python, [script], {
    cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const pid = child.pid;
  if (!pid) {
    console.error(`${LOG_TAG2} ${svc.name} spawn \u5931\u8D25\uFF1A\u672A\u62FF\u5230 pid`);
    return;
  }
  children.set(svc.name, child);
  console.log(`${LOG_TAG2} \u5DF2\u62C9\u8D77 ${svc.name}\uFF08pid=${pid}\uFF0Cport=${port}\uFF09`);
  child.stdout?.on("data", (chunk) => process.stdout.write(`${LOG_TAG2}[${svc.tag}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`${LOG_TAG2}[${svc.tag}-err] ${chunk}`));
  child.on("error", (err) => {
    console.error(`${LOG_TAG2} ${svc.name} \u5B50\u8FDB\u7A0B\u5F02\u5E38\uFF1A`, err);
    children.delete(svc.name);
  });
  child.on("exit", (code, signal) => {
    console.log(`${LOG_TAG2} ${svc.name} \u9000\u51FA code=${code} signal=${signal ?? "null"}`);
    children.delete(svc.name);
  });
  waitHealth(svc, port).catch(() => {
  });
}
var index_default = {
  name: "dsh-service-manager",
  apply(ctx) {
    console.log(`${LOG_TAG2} apply`);
    const sourceRoot = findSourceRoot();
    const releaseRoot = findReleaseRoot();
    if (!sourceRoot) {
      console.error(`${LOG_TAG2} \u65E0\u6CD5\u5B9A\u4F4D\u6E90\u9879\u76EE\u6839\uFF1A\u8BF7\u8BBE\u7F6E PERSONA_OS_ROOT \u6307\u5411 persona-os \u6E90\u9879\u76EE\u6839\uFF08\u542B index-tts/.venv\uFF09`);
    } else {
      console.log(`${LOG_TAG2} sourceRoot=${sourceRoot}`);
    }
    console.log(`${LOG_TAG2} releaseRoot=${releaseRoot ?? "(\u672A\u627E\u5230)"}`);
    for (const svc of SERVICES) {
      if (sourceRoot) {
        startService(svc, sourceRoot, releaseRoot).catch(
          (err) => console.error(`${LOG_TAG2} \u62C9\u8D77 ${svc.name} \u5931\u8D25\uFF1A`, err)
        );
      }
    }
    ctx.on("dispose", () => {
      if (disposed) return;
      disposed = true;
      const entries = Array.from(children.entries());
      if (entries.length === 0) {
        console.log(`${LOG_TAG2} dispose\uFF1A\u65E0\u672C\u63D2\u4EF6\u62C9\u8D77\u7684\u6D3B\u52A8\u5B50\u8FDB\u7A0B`);
        return;
      }
      for (const [name, child] of entries) {
        const pid = child.pid;
        if (!pid) continue;
        console.log(`${LOG_TAG2} dispose\uFF1A\u7EC8\u6B62 ${name} \u8FDB\u7A0B\u6811 pid=${pid}`);
        killTreeSync(pid);
      }
      children.clear();
    });
    if (sourceRoot) {
      const hookCtx = { sourceRoot, releaseRoot };
      startControlApi({
        names: SERVICES.map((s) => s.name),
        isRunning: async (name) => {
          const svc = SERVICES.find((s) => s.name === name);
          if (!svc) return false;
          return portInUseRobust(Number(process.env[svc.portEnv] || svc.portDefault));
        },
        stop: async (name) => {
          const svc = SERVICES.find((s) => s.name === name);
          if (!svc) return { ok: false, detail: `\u672A\u77E5\u670D\u52A1 ${name}` };
          const child = children.get(name);
          if (child?.pid) {
            killTreeSync(child.pid);
            children.delete(name);
            return { ok: true, detail: `\u5DF2\u7EC8\u6B62\u8FDB\u7A0B\u6811 pid=${child.pid}` };
          }
          const port = Number(process.env[svc.portEnv] || svc.portDefault);
          if (await portInUseRobust(port)) {
            return { ok: false, detail: `\u670D\u52A1\u5728\u8DD1\uFF08port=${port}\uFF09\u4F46\u4E0D\u662F\u672C\u63D2\u4EF6\u62C9\u8D77\u7684\uFF0C\u65E0\u6CD5\u5B89\u5168\u7EC8\u6B62` };
          }
          return { ok: true, detail: "\u672C\u6765\u5C31\u6CA1\u5728\u8DD1" };
        },
        start: async (name) => {
          const svc = SERVICES.find((s) => s.name === name);
          if (!svc) return { ok: false, detail: `\u672A\u77E5\u670D\u52A1 ${name}` };
          try {
            await startService(svc, sourceRoot, releaseRoot);
            return { ok: true, detail: "\u5DF2\u5C1D\u8BD5\u62C9\u8D77\uFF08\u5065\u5EB7\u68C0\u67E5\u5728\u540E\u53F0\u8DD1\uFF09" };
          } catch (e) {
            return { ok: false, detail: e.message };
          }
        }
      }).then((s) => {
        console.log(`${LOG_TAG2} \u63A7\u5236\u63A5\u53E3\u5C31\u7EEA\uFF1Ahttp://127.0.0.1:${s.port}`);
        controlApi = s;
      }).catch((e) => console.error(`${LOG_TAG2} \u63A7\u5236\u63A5\u53E3\u542F\u52A8\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u670D\u52A1\u62C9\u8D77\uFF09\uFF1A${e.message}`));
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
