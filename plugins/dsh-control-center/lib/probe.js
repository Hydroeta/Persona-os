import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/probe.ts
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
var SERVICES = [
  { key: "memory", label: "Memory \u8BB0\u5FC6", port: 8001, healthPath: "/health", kind: "http" },
  { key: "painter", label: "Painter \u751F\u56FE", port: 8002, healthPath: "/health", kind: "http" },
  { key: "gamebot", label: "GameBot \u624B\u67C4", port: 8003, healthPath: "/health", kind: "http" },
  { key: "audiocover", label: "AudioCover \u7FFB\u5531", port: 8005, healthPath: "/health", kind: "http" },
  { key: "live", label: "Live-Director \u5F39\u5E55(WS)", port: 9001, kind: "tcp" },
  { key: "indextts", label: "IndexTTS2 \u8BED\u97F3", port: 9881, kind: "tcp" }
];
function probeTcp(port, host = "127.0.0.1", timeoutMs = 2e3) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (up, error) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ up, ms: Date.now() - t0, error });
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false, `\u8D85\u65F6 ${timeoutMs}ms`));
    sock.once("error", (e) => finish(false, e.message));
    sock.connect(port, host);
  });
}
async function probeHttp(port, path = "/health", timeoutMs = 2e3) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctrl.signal });
    let detail = "";
    try {
      const j = await r.json();
      if (j && typeof j === "object") {
        const bits = [];
        if (typeof j.ok === "boolean") bits.push(`ok=${j.ok}`);
        if (typeof j.model_loaded === "boolean") bits.push(`model=${j.model_loaded ? "\u5DF2\u52A0\u8F7D" : "\u672A\u52A0\u8F7D"}`);
        if (typeof j.driver_ready === "boolean") bits.push(`driver=${j.driver_ready}`);
        if (typeof j.provider === "string") bits.push(j.provider);
        detail = bits.join(" ");
      }
    } catch {
    }
    return { up: r.ok, ms: Date.now() - t0, detail: detail || void 0 };
  } catch (e) {
    const msg = e.name === "AbortError" ? `\u8D85\u65F6 ${timeoutMs}ms` : e.message;
    return { up: false, ms: Date.now() - t0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
async function probeAll(specs = SERVICES, timeoutMs = 2e3) {
  const tasks = specs.map(async (s) => {
    if (s.kind === "http") {
      const r2 = await probeHttp(s.port, s.healthPath || "/health", timeoutMs);
      return { key: s.key, label: s.label, port: s.port, kind: s.kind, up: r2.up, ms: r2.ms, detail: r2.detail, error: r2.error };
    }
    const r = await probeTcp(s.port, "127.0.0.1", timeoutMs);
    return { key: s.key, label: s.label, port: s.port, kind: s.kind, up: r.up, ms: r.ms, error: r.error };
  });
  const out = await Promise.allSettled(tasks);
  return out.map(
    (r, i) => r.status === "fulfilled" ? r.value : { key: specs[i].key, label: specs[i].label, port: specs[i].port, kind: specs[i].kind, up: false, ms: 0, error: String(r.reason) }
  );
}
function parseNvidiaSmi(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(",").map((x) => x.trim());
    if (parts.length < 4) continue;
    const used = Number(parts[1]);
    const total = Number(parts[2]);
    const util = Number(parts[3]);
    if (!Number.isFinite(used) || !Number.isFinite(total)) continue;
    out.push({ name: parts[0], memUsedMb: used, memTotalMb: total, utilPct: Number.isFinite(util) ? util : 0 });
  }
  return out;
}
function readGpu() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 3e3, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ gpus: [], error: err.message.split("\n")[0] });
        resolve({ gpus: parseNvidiaSmi(String(stdout || "")) });
      }
    );
  });
}
async function readHostInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedMb = Math.round((total - free) / 1024 / 1024);
  const totalMb = Math.round(total / 1024 / 1024);
  const gpu = await readGpu();
  return {
    memUsedMb: usedMb,
    memTotalMb: totalMb,
    memPct: totalMb ? Math.round(usedMb / totalMb * 100) : 0,
    gpus: gpu.gpus,
    gpuError: gpu.error
  };
}
export {
  SERVICES,
  parseNvidiaSmi,
  probeAll,
  probeHttp,
  probeTcp,
  readHostInfo
};
//# sourceMappingURL=probe.js.map
