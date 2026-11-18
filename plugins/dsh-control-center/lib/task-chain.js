import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/task-chain.ts
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import zlib from "node:zlib";
var LOG_TAG = "[dsh-control-center/task-chain]";
var ZSTD_MAGIC = Buffer.from([40, 181, 47, 253]);
function decodeZstdFrames(raw) {
  const offsets = [];
  let i = 0;
  while ((i = raw.indexOf(ZSTD_MAGIC, i)) !== -1) {
    offsets.push(i);
    i += 4;
  }
  if (!offsets.length) {
    try {
      return zlib.zstdDecompressSync(raw).toString("utf8");
    } catch {
      return "";
    }
  }
  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length;
    try {
      const out = zlib.zstdDecompressSync(raw.subarray(start, end)).toString("utf8");
      if (out) parts.push(out);
    } catch {
    }
  }
  return parts.join("");
}
var lineCache = /* @__PURE__ */ new Map();
function readLines(sessionPath) {
  const st = statSync(sessionPath);
  const hit = lineCache.get(sessionPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.lines;
  const raw = readFileSync(sessionPath);
  const text = decodeZstdFrames(raw);
  const lines = text.split("\n").filter(Boolean);
  lineCache.set(sessionPath, { mtimeMs: st.mtimeMs, size: st.size, lines });
  return lines;
}
var MAX_ARGS_LEN = 300;
function parseToolCalls(lines) {
  const calls = [];
  const resultIds = /* @__PURE__ */ new Set();
  for (const ln of lines) {
    if (!ln.includes("tool/call") && !ln.includes("tool/result")) continue;
    let o;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    const d = o?.data;
    if (!d) continue;
    if (o.type === "tool/call") {
      const args = typeof d.arguments === "string" ? d.arguments : JSON.stringify(d.arguments ?? "");
      calls.push({
        turn: Number(d.turn ?? 0),
        step: Number(d.step ?? 0),
        seq: Number(o.seq ?? 0),
        time: Number(o.time ?? 0),
        callId: String(d.callId ?? ""),
        name: String(d.name ?? ""),
        args: args.length > MAX_ARGS_LEN ? args.slice(0, MAX_ARGS_LEN) + "\u2026" : args
      });
    } else if (o.type === "tool/result") {
      const id = d.toolCallId || d.message?.toolCallId || d.message?.source?.callId;
      if (id) resultIds.add(String(id));
    }
  }
  for (const c of calls) {
    if (resultIds.has(c.callId)) c.hasResult = true;
  }
  return calls;
}
function findRecentSessions(opts = {}) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const root = join(home, ".dsh", "sessions");
  if (!existsSync(root)) return [];
  const out = [];
  let wsDirs;
  try {
    wsDirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  for (const ws of wsDirs) {
    if (opts.workspace && !ws.includes(opts.workspace)) continue;
    const wsPath = join(root, ws);
    let sessions;
    try {
      sessions = readdirSync(wsPath, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("session")).map((d) => d.name);
    } catch {
      continue;
    }
    for (const s of sessions) {
      const f = join(wsPath, s, "session.v4.jsonl.zstd");
      if (!existsSync(f)) continue;
      try {
        out.push({ path: f, mtime: statSync(f).mtimeMs });
      } catch {
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, Math.max(1, opts.recent ?? 1)).map((x) => x.path);
}
function sessionIdOf(sessionPath) {
  const dir = basename(join(sessionPath, ".."));
  return dir.startsWith("session") ? dir : basename(sessionPath);
}
function getTaskChain(opts = {}) {
  try {
    const sessionPath = opts.sessionPath || findRecentSessions({ workspace: opts.workspace, recent: 1 })[0];
    if (!sessionPath) {
      return { ok: false, error: "\u6CA1\u627E\u5230\u4F1A\u8BDD\u8BB0\u5F55\uFF08~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd\uFF09" };
    }
    if (!existsSync(sessionPath)) {
      return { ok: false, error: `\u4F1A\u8BDD\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${sessionPath}` };
    }
    const lines = readLines(sessionPath);
    let calls = parseToolCalls(lines);
    if (opts.tools?.length) {
      const set = new Set(opts.tools.map((t) => t.toLowerCase()));
      calls = calls.filter((c) => set.has(c.name.toLowerCase()));
    }
    if (typeof opts.afterTurn === "number") {
      calls = calls.filter((c) => c.turn > opts.afterTurn);
    }
    const total = calls.length;
    const limit = Math.max(1, opts.limit ?? 40);
    const tail = calls.slice(-limit);
    console.log(`${LOG_TAG} \u89E3\u6790 ${basename(sessionPath)}\uFF1A${total} \u6761\u8C03\u7528\uFF0C\u8FD4\u56DE\u6700\u540E ${tail.length} \u6761`);
    return {
      ok: true,
      sessionPath,
      sessionId: sessionIdOf(sessionPath),
      totalCalls: total,
      calls: tail
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function __clearCache() {
  lineCache.clear();
}
export {
  __clearCache,
  decodeZstdFrames,
  findRecentSessions,
  getTaskChain,
  parseToolCalls,
  sessionIdOf
};
//# sourceMappingURL=task-chain.js.map
