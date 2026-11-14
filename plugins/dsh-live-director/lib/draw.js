import { createRequire } from 'module'; const require = createRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/report.ts
var report_exports = {};
__export(report_exports, {
  panelEventUrl: () => panelEventUrl,
  reportEvent: () => reportEvent,
  reportEventNoWait: () => reportEventNoWait
});
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
var LOG_TAG;
var init_report = __esm({
  "src/report.ts"() {
    "use strict";
    LOG_TAG = "[dsh-live-director/report]";
  }
});

// src/fan-art.ts
var fan_art_exports = {};
__export(fan_art_exports, {
  sendFanArtToQQ: () => sendFanArtToQQ,
  setFanArtSender: () => setFanArtSender
});
import { existsSync } from "node:fs";
function setFanArtSender(fn) {
  sender = fn;
}
async function sendFanArtToQQ(userId, filePath) {
  if (!userId || !filePath) return false;
  if (!existsSync(filePath)) {
    console.error(`${LOG_TAG2} \u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u8DF3\u8FC7\u4EA4\u4ED8\uFF1A${filePath}`);
    return false;
  }
  try {
    return await sender(userId, filePath);
  } catch (e) {
    console.error(`${LOG_TAG2} \u4EA4\u4ED8\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u4F5C\u753B\uFF09\uFF1A${e.message}`);
    return false;
  }
}
var LOG_TAG2, sender;
var init_fan_art = __esm({
  "src/fan-art.ts"() {
    "use strict";
    LOG_TAG2 = "[dsh-live-director/fan-art]";
    sender = async (userId, filePath) => {
      console.log(`${LOG_TAG2} [QQ Hook] \u51C6\u5907\u5C06 ${filePath} \u53D1\u9001\u7ED9 ${userId}`);
      return false;
    };
  }
});

// src/draw.ts
import { mkdirSync, existsSync as existsSync2, readdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

// src/painter-bridge.ts
var BRIDGE_PORT = Number(process.env.PAINTER_BRIDGE_PORT) || 9011;
var BRIDGE_TOKEN = process.env.PAINTER_BRIDGE_TOKEN || "";
var BRIDGE_URL = (process.env.PAINTER_BRIDGE_URL || `http://127.0.0.1:${BRIDGE_PORT}`).replace(/\/$/, "");
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

// src/draw.ts
var LOG_TAG3 = "[dsh-live-director/draw]";
var COOLDOWN_REPLY = "\u522B\u6025\uFF0C\u753B\u7B14\u8FD8\u6CA1\u5E72\u5462";
function pickMode(text) {
  const t = String(text || "").toLowerCase();
  if (/像素|8-?bit|pixel|马赛克|复古游戏/.test(t)) return "pixel";
  if (/排线|素描|线稿|铅笔|速写|lineart|sketch/.test(t)) return "strokes";
  return "stages";
}
function pickGridSize(text, mode) {
  if (mode !== "pixel") return void 0;
  const m = /(\d{2,3})\s*(?:×|x|p|格|像素)/i.exec(String(text || ""));
  if (m) {
    const n = Number(m[1]);
    if (n >= 8 && n <= 256) return n;
  }
  return 64;
}
function parseDrawCommand(text) {
  const raw = String(text || "").trim();
  const m = /^[!！]画\s*(.*)$/.exec(raw);
  if (!m) return null;
  let rest = (m[1] || "").trim();
  let kind = "art";
  if (/^头像\s*(.*)$/s.test(rest)) {
    kind = "avatar";
    rest = (rest.replace(/^头像\s*/s, "") || "").trim();
  } else if (/^头像$/.test(rest)) {
    kind = "avatar";
    rest = "";
  }
  if (!rest) return null;
  const mode = pickMode(rest);
  return {
    kind,
    content: rest,
    mode,
    gridSize: pickGridSize(rest, mode),
    aspect: kind === "avatar" ? "1:1" : "16:9"
  };
}
function announceStart(cmd, user) {
  if (cmd.kind === "avatar") return `\u7ED9 ${user} \u753B\u4E2A\u5934\u50CF\uFF0C\u7B49\u7740\u54E6`;
  return `\u597D\u561E\uFF0C\u8FD9\u5C31\u753B\u4E2A${cmd.content}`;
}
function announceDone(cmd, user, ok) {
  if (!ok) return `\u8FD9\u5F20\u6CA1\u753B\u6210\uFF0C${user} \u518D\u70B9\u4E00\u6B21\u5427`;
  if (cmd.kind === "avatar") return `${user} \u7684\u5934\u50CF\u753B\u597D\u5566\uFF0C\u5DF2\u7ECF\u4FDD\u5B58\u5728\u4E13\u5C5E\u76F8\u518C\u91CC\u5566\uFF01`;
  return `\u753B\u597D\u5566\uFF0C\u6302\u5728\u5899\u4E0A\u5927\u5BB6\u770B\u597D\u770B\u5417\uFF1F`;
}
function announceDoneFor(cmd, user, ok) {
  return announceDone(cmd, user, ok);
}
var DEFAULT_DRAW_COOLDOWN = {
  globalMs: 3e4,
  perUserMs: 6e4
};
var DrawCooldown = class {
  constructor(cfg = DEFAULT_DRAW_COOLDOWN) {
    this.cfg = cfg;
  }
  lastGlobal = 0;
  lastUser = /* @__PURE__ */ new Map();
  /** 只检查不记录 */
  check(user, now = Date.now()) {
    const ug = now - this.lastGlobal;
    const uu = now - (this.lastUser.get(user) || 0);
    const remain = Math.max(this.cfg.globalMs - ug, this.cfg.perUserMs - uu, 0);
    return { allowed: remain <= 0, remainMs: remain };
  }
  /** 检查通过后调用，记录时间戳 */
  mark(user, now = Date.now()) {
    this.lastGlobal = now;
    this.lastUser.set(user, now);
  }
};
function today() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function safeName(name) {
  return String(name || "anon").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "anon";
}
function targetPath(cmd, user, dirs, now = /* @__PURE__ */ new Date()) {
  if (cmd.kind === "avatar") {
    const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return join(resolve(dirs.fanArtDir), `${d}_${safeName(user)}.png`);
  }
  const ts = now.getTime();
  return join(resolve(dirs.outDir), `live_${ts}.png`);
}
function framesDirFor(root, now = /* @__PURE__ */ new Date()) {
  const p = join(resolve(root), `draw_${now.getTime()}`);
  mkdirSync(p, { recursive: true });
  return p;
}
function latestArt(dir, limit = 5) {
  if (!existsSync2(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort().slice(-limit).map((f) => join(dir, f));
  } catch {
    return [];
  }
}
function handleDrawCommand(text, user, deps) {
  const cmd = parseDrawCommand(text);
  if (!cmd) return { handled: false };
  const cd = deps.cooldown ?? new DrawCooldown();
  const verdict = cd.check(user);
  if (!verdict.allowed) {
    return { handled: true, reply: COOLDOWN_REPLY };
  }
  cd.mark(user);
  const start = announceStart(cmd, user);
  deps.speak?.(start);
  if (deps.panel) {
    void deps.panel.showArt().catch((e) => console.error(`${LOG_TAG3} OBS \u663E\u793A\u5F02\u5E38\uFF1A${e.message}`));
  }
  void runDraw(cmd, user, deps).catch((e) => {
    console.error(`${LOG_TAG3} \u4F5C\u753B\u4EFB\u52A1\u5F02\u5E38\uFF1A${e.message}`);
  });
  return { handled: true, reply: start };
}
async function runDraw(cmd, user, deps) {
  const png = targetPath(cmd, user, deps.dirs);
  mkdirSync(resolve(deps.dirs.fanArtDir), { recursive: true });
  mkdirSync(resolve(deps.dirs.outDir), { recursive: true });
  mkdirSync(resolve(deps.dirs.framesRoot), { recursive: true });
  const framesDir = framesDirFor(deps.dirs.framesRoot);
  const prompt = deps.buildPrompt ? deps.buildPrompt(cmd) : cmd.content;
  try {
    const { reportEventNoWait: reportEventNoWait2 } = await Promise.resolve().then(() => (init_report(), report_exports));
    reportEventNoWait2({ type: "paint_start", prompt });
  } catch {
  }
  const res = await requestPaint({
    prompt,
    obs_output_path: png,
    frames_dir: framesDir,
    mode: cmd.mode,
    grid_size: cmd.gridSize,
    aspect: cmd.aspect,
    duration_ms: 8e3,
    fps: 12
  }, { url: deps.bridgeUrl });
  if (res.ok && res.path) {
    try {
      copyFileSync(res.path, png);
    } catch (e) {
      console.error(`${LOG_TAG3} \u843D\u76D8\u5931\u8D25\uFF08\u4ECD\u5728\u539F\u8DEF\u5F84\uFF09\uFF1A${e.message}`);
    }
  } else {
    console.error(`${LOG_TAG3} \u4F5C\u753B\u5931\u8D25\uFF1A${res.error || "\u672A\u77E5"}`);
  }
  const done = announceDone(cmd, user, !!res.ok);
  deps.speak?.(done);
  if (res.ok && cmd.kind === "avatar") {
    try {
      const { sendFanArtToQQ: sendFanArtToQQ2 } = await Promise.resolve().then(() => (init_fan_art(), fan_art_exports));
      await sendFanArtToQQ2(user, png);
    } catch (e) {
      console.error(`${LOG_TAG3} \u5934\u50CF\u4EA4\u4ED8\u5F02\u5E38\uFF08\u4E0D\u5F71\u54CD\u4F5C\u753B\uFF09\uFF1A${e.message}`);
    }
  }
  try {
    const { reportEventNoWait: reportEventNoWait2 } = await Promise.resolve().then(() => (init_report(), report_exports));
    reportEventNoWait2({ type: "paint_end", ok: !!res.ok });
  } catch {
  }
  console.log(`${LOG_TAG3} ${cmd.kind} \u5B8C\u6210 user=${user} mode=${cmd.mode} aspect=${cmd.aspect} ok=${res.ok} -> ${png}`);
}
export {
  COOLDOWN_REPLY,
  DEFAULT_DRAW_COOLDOWN,
  DrawCooldown,
  LOG_TAG3 as LOG_TAG,
  announceDone,
  announceDoneFor,
  announceStart,
  framesDirFor,
  handleDrawCommand,
  latestArt,
  parseDrawCommand,
  pickGridSize,
  pickMode,
  safeName,
  targetPath,
  today
};
//# sourceMappingURL=draw.js.map
