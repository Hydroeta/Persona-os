// src/index.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
var LOG_TAG = "[dsh-service-manager]";
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
        console.log(`${LOG_TAG} ${svc.name} \u5C31\u7EEA\uFF08port=${port}\uFF09`);
        return true;
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  console.warn(`${LOG_TAG} ${svc.name} \u5065\u5EB7\u68C0\u67E5\u8D85\u65F6\uFF08port=${port}\uFF09\uFF0C\u8FDB\u7A0B\u53EF\u80FD\u4ECD\u5728\u542F\u52A8\uFF0C\u672A\u6740\uFF08\u4FDD\u7559\u73B0\u573A\u6392\u67E5\uFF09`);
  return false;
}
async function startService(svc, sourceRoot, releaseRoot) {
  const python = process.env[svc.pythonEnv] || svc.pythonRel(sourceRoot);
  const needRelease = svc.cwdFrom === "release" || svc.scriptRel.name;
  if (!existsSync(python)) {
    console.error(`${LOG_TAG} ${svc.name} \u8DF3\u8FC7\uFF1Apython \u4E0D\u5B58\u5728 ${python}\uFF08\u53EF\u8BBE ${svc.pythonEnv}\uFF09`);
    return;
  }
  let script;
  if (process.env[svc.scriptEnv]) {
    script = process.env[svc.scriptEnv];
  } else {
    if (!releaseRoot) {
      console.error(`${LOG_TAG} ${svc.name} \u8DF3\u8FC7\uFF1A\u65E0\u6CD5\u5B9A\u4F4D\u53D1\u5E03\u7248\u6839\uFF08\u53EF\u8BBE PERSONA_OS_ROOT \u6216 ${svc.scriptEnv}\uFF09`);
      return;
    }
    script = svc.scriptRel(releaseRoot);
  }
  if (!existsSync(script)) {
    console.error(`${LOG_TAG} ${svc.name} \u8DF3\u8FC7\uFF1A\u811A\u672C\u4E0D\u5B58\u5728 ${script}`);
    return;
  }
  const port = Number(process.env[svc.portEnv] || svc.portDefault);
  if (await portInUseRobust(port)) {
    console.log(`${LOG_TAG} \u7AEF\u53E3 ${port} \u5DF2\u88AB\u5360\u7528\uFF0C${svc.name} \u53EF\u80FD\u5DF2\u5728\u8FD0\u884C \u2192 \u8DF3\u8FC7\u62C9\u8D77\uFF08dispose \u4E0D\u4F1A\u52A8\u5B83\uFF09`);
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
    console.error(`${LOG_TAG} ${svc.name} spawn \u5931\u8D25\uFF1A\u672A\u62FF\u5230 pid`);
    return;
  }
  children.set(svc.name, child);
  console.log(`${LOG_TAG} \u5DF2\u62C9\u8D77 ${svc.name}\uFF08pid=${pid}\uFF0Cport=${port}\uFF09`);
  child.stdout?.on("data", (chunk) => process.stdout.write(`${LOG_TAG}[${svc.tag}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`${LOG_TAG}[${svc.tag}-err] ${chunk}`));
  child.on("error", (err) => {
    console.error(`${LOG_TAG} ${svc.name} \u5B50\u8FDB\u7A0B\u5F02\u5E38\uFF1A`, err);
    children.delete(svc.name);
  });
  child.on("exit", (code, signal) => {
    console.log(`${LOG_TAG} ${svc.name} \u9000\u51FA code=${code} signal=${signal ?? "null"}`);
    children.delete(svc.name);
  });
  waitHealth(svc, port).catch(() => {
  });
}
var index_default = {
  name: "dsh-service-manager",
  apply(ctx) {
    console.log(`${LOG_TAG} apply`);
    const sourceRoot = findSourceRoot();
    const releaseRoot = findReleaseRoot();
    if (!sourceRoot) {
      console.error(`${LOG_TAG} \u65E0\u6CD5\u5B9A\u4F4D\u6E90\u9879\u76EE\u6839\uFF1A\u8BF7\u8BBE\u7F6E PERSONA_OS_ROOT \u6307\u5411 persona-os \u6E90\u9879\u76EE\u6839\uFF08\u542B index-tts/.venv\uFF09`);
    } else {
      console.log(`${LOG_TAG} sourceRoot=${sourceRoot}`);
    }
    console.log(`${LOG_TAG} releaseRoot=${releaseRoot ?? "(\u672A\u627E\u5230)"}`);
    for (const svc of SERVICES) {
      if (sourceRoot) {
        startService(svc, sourceRoot, releaseRoot).catch(
          (err) => console.error(`${LOG_TAG} \u62C9\u8D77 ${svc.name} \u5931\u8D25\uFF1A`, err)
        );
      }
    }
    ctx.on("dispose", () => {
      if (disposed) return;
      disposed = true;
      const entries = Array.from(children.entries());
      if (entries.length === 0) {
        console.log(`${LOG_TAG} dispose\uFF1A\u65E0\u672C\u63D2\u4EF6\u62C9\u8D77\u7684\u6D3B\u52A8\u5B50\u8FDB\u7A0B`);
        return;
      }
      for (const [name, child] of entries) {
        const pid = child.pid;
        if (!pid) continue;
        console.log(`${LOG_TAG} dispose\uFF1A\u7EC8\u6B62 ${name} \u8FDB\u7A0B\u6811 pid=${pid}`);
        killTreeSync(pid);
      }
      children.clear();
    });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
