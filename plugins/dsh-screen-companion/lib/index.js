// src/index.ts
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// src/analyze.ts
var MAX_CARE_PER_DAY = 3;
function parseVlmReply(raw) {
  const text = (raw || "").trim();
  const grab = (label) => {
    const m = text.match(label);
    return m ? m[1].trim() : "";
  };
  let activity = grab(/(?:在干什么|做什么|activity)\s*[:：]\s*([^\n,，。;；]+)/i);
  let mood = grab(/(?:情绪|心情|mood)\s*[:：]\s*([^\n,，。;；]+)/i);
  if (!activity && !mood) {
    const seg = text.split(/[，,。;；\n]/).map((s) => s.trim()).filter(Boolean);
    activity = seg[0] || "\u672A\u77E5";
    mood = seg[1] || "\u672A\u77E5";
  }
  const hasError = /(error|exception|traceback|failed|报错|异常|错误)/i.test(text) || /失败|崩了|无法/i.test(text);
  return { activity: activity.slice(0, 20), mood: mood.slice(0, 12), hasError };
}
function isLongFocus(obs, now, hours = 2) {
  const windowMs = hours * 36e5;
  const lookback = windowMs * 1.2;
  const recent = obs.filter((o) => now - o.ts <= lookback);
  if (recent.length < 2) return false;
  const span = now - recent[0].ts;
  if (span < windowMs) return false;
  return recent.every((o) => /写代码|工作|文档|表格|编程|代码/.test(o.activity));
}
function decideCare(opts) {
  const { observations, now, lastCareAt, careCountToday } = opts;
  if (careCountToday >= MAX_CARE_PER_DAY) return { care: false, reason: "\u4ECA\u5929\u5DF2\u7ECF\u5173\u5FC3\u8FC7 3 \u6B21", kind: "none" };
  if (lastCareAt && now - lastCareAt < 45 * 6e4) {
    return { care: false, reason: "\u8DDD\u4E0A\u6B21\u5173\u5FC3\u4E0D\u8DB3 45 \u5206\u949F", kind: "none" };
  }
  const last = observations[observations.length - 1];
  if (!last) return { care: false, reason: "\u8FD8\u6CA1\u6709\u89C2\u5BDF\u6570\u636E", kind: "none" };
  if (last.hasError && /焦虑|烦躁|急|崩溃|emo/i.test(last.mood)) {
    return { care: true, reason: `\u753B\u9762\u6709\u62A5\u9519\u4E14\u60C5\u7EEA\u300C${last.mood}\u300D`, kind: "error_anxious" };
  }
  if (isLongFocus(observations, now)) {
    return { care: true, reason: "\u8FDE\u7EED 2 \u5C0F\u65F6\u90FD\u5728\u5DE5\u4F5C", kind: "long_focus" };
  }
  return { care: false, reason: "\u6CA1\u6709\u89E6\u53D1\u6761\u4EF6", kind: "none" };
}
var ERROR_LINES = [
  "\u8FD9\u4E2A\u62A5\u9519\u6211\u770B\u4E86\u4E00\u4F1A\u513F\u4E86\uFF0C\u5148\u559D\u53E3\u6C34\u518D\u56DE\u6765\uFF1F",
  "\u5361\u8FD9\u4E48\u4E45\u8FD8\u76EF\u7740\u5C4F\u5E55\uFF0C\u773C\u775B\u5148\u6B47\u4E00\u4E0B\u3002",
  "\u90A3\u6BB5\u62A5\u9519\u7EA2\u5F97\u6BD4\u4F60\u8138\u8FD8\u7EA2\uFF0C\u5148\u522B\u6025\u3002"
];
var LONG_LINES = [
  "\u4E24\u4E2A\u949F\u5934\u4E86\uFF0C\u8D77\u6765\u52A8\u52A8\u5427\uFF0C\u6211\u53C8\u4E0D\u4F1A\u8DD1\u3002",
  "\u5750\u592A\u4E45\u4E86\uFF0C\u8170\u4F1A\u6297\u8BAE\u7684\u3002",
  "\u4F60\u5DF2\u7ECF\u5199\u4E86\u5F88\u4E45\u4E86\uFF0C\u6B47\u5341\u5206\u949F\u4E0D\u803D\u8BEF\u4E8B\u3002"
];
function careLine(kind, seed = Date.now()) {
  const pool = kind === "error_anxious" ? ERROR_LINES : LONG_LINES;
  return pool[Math.abs(seed) % pool.length];
}

// src/index.ts
var LOG_TAG = "[dsh-screen-companion]";
var HEARTBEAT = join(tmpdir(), "dsh-screen-indicator.heartbeat");
var STATE_FILE = join(tmpdir(), "dsh-screen-companion-state.json");
var DEFAULT_GAME_PROCS = "Windose.exe,Stardew Valley.exe,BlackSouls.exe,steam.exe";
var VLM_PROMPT = "\u770B\u8FD9\u5F20\u5C4F\u5E55\u622A\u56FE\uFF0C\u7528\u4E24\u884C\u56DE\u7B54\uFF1A\u7B2C\u4E00\u884C\u300C\u5728\u5E72\u4EC0\u4E48:\u300D\u540E\u9762\u5199 4~10 \u4E2A\u5B57\uFF08\u5982 \u5199\u4EE3\u7801/\u770B\u89C6\u9891/\u6253\u6E38\u620F/\u770B\u6587\u6863\uFF09\uFF1B\u7B2C\u4E8C\u884C\u300C\u60C5\u7EEA:\u300D\u540E\u9762\u5199 2~4 \u4E2A\u5B57\uFF08\u5982 \u4E13\u6CE8/\u7126\u8651/\u8F7B\u677E/\u65E0\u804A\uFF09\u3002\u987A\u4FBF\u5224\u65AD\u753B\u9762\u91CC\u6709\u6CA1\u6709\u5927\u91CF\u7EA2\u8272\u62A5\u9519\u3002\u4E0D\u8981\u63CF\u8FF0\u622A\u56FE\u91CC\u7684\u5177\u4F53\u5185\u5BB9\u3002";
var Companion = class {
  constructor(opts = {}) {
    this.opts = opts;
    this.loadState();
  }
  observations = [];
  lastCareAt = 0;
  careCountToday = 0;
  dayKey = "";
  timer = null;
  stopped = false;
  get state() {
    return {
      observations: this.observations.length,
      careCountToday: this.careCountToday,
      lastCareAt: this.lastCareAt
    };
  }
  now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }
  dayString(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }
  loadState() {
    try {
      if (!existsSync(STATE_FILE)) return;
      const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      this.dayKey = s.dayKey || "";
      this.lastCareAt = s.lastCareAt || 0;
      this.careCountToday = this.dayKey === this.dayString(this.now()) ? s.careCountToday || 0 : 0;
    } catch {
    }
  }
  saveState() {
    try {
      writeFileSync(STATE_FILE, JSON.stringify({ dayKey: this.dayKey, lastCareAt: this.lastCareAt, careCountToday: this.careCountToday }));
    } catch {
    }
  }
  /** 绿眼睛还活着吗（心跳文件新鲜度） */
  indicatorAlive() {
    try {
      if (!existsSync(HEARTBEAT)) return false;
      const age = Date.now() - statSync(HEARTBEAT).mtimeMs;
      return age <= (this.opts.heartbeatStaleMs ?? 12e3);
    } catch {
      return false;
    }
  }
  /** 一次观察：截屏 → 视觉 → 记一条 Observation → 决定是否关心 */
  async tick() {
    if (this.stopped) return { skipped: "\u5DF2\u505C\u6B62" };
    if (!this.indicatorAlive()) return { skipped: "\u7EFF\u773C\u775B\u6CA1\u5728\u8DD1\uFF0C\u4E0D\u622A\u5C4F" };
    if (this.opts.shouldPause && await this.opts.shouldPause().catch(() => false)) {
      return { skipped: "\u6709\u6E38\u620F\u5728\u8DD1\uFF0C\u6682\u505C" };
    }
    const capture = this.opts.capture ?? defaultCapture;
    const describe = this.opts.describe ?? defaultDescribe;
    try {
      const buf = await capture();
      if (!buf || buf.length < 1024) return { skipped: "\u622A\u5C4F\u5931\u8D25\u6216\u7A7A\u767D" };
      const raw = await describe(buf.toString("base64"), VLM_PROMPT);
      const parsed = parseVlmReply(raw);
      const obs = { ts: this.now(), ...parsed };
      this.observations.push(obs);
      if (this.observations.length > 240) this.observations.shift();
      const today = this.dayString(obs.ts);
      if (this.dayKey !== today) {
        this.dayKey = today;
        this.careCountToday = 0;
      }
      const d = decideCare({
        observations: this.observations,
        now: obs.ts,
        lastCareAt: this.lastCareAt,
        careCountToday: this.careCountToday
      });
      console.log(`${LOG_TAG} \u89C2\u5BDF\uFF1A${obs.activity} / ${obs.mood}${obs.hasError ? "\uFF08\u6709\u62A5\u9519\uFF09" : ""} \u2192 ${d.care ? "\u6253\u6270" : "\u4E0D\u6253\u6270"}\uFF1A${d.reason}`);
      if (!d.care) return { observation: obs, cared: false };
      const line = careLine(d.kind, obs.ts);
      this.lastCareAt = obs.ts;
      this.careCountToday++;
      this.saveState();
      console.log(`${LOG_TAG} \u{1F4AC} \u5173\u5FC3\uFF08\u7B2C ${this.careCountToday} \u6B21/\u4ECA\u5929\uFF09\uFF1A${line}`);
      this.opts.onCare?.(line, { kind: d.kind, reason: d.reason, activity: obs.activity, mood: obs.mood });
      return { observation: obs, cared: true, line };
    } catch (e) {
      console.warn(`${LOG_TAG} \u672C\u6B21\u89C2\u5BDF\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09\uFF1A${e.message}`);
      return { skipped: `\u5931\u8D25\uFF1A${e.message}` };
    }
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    const interval = this.opts.intervalMs ?? 6e4;
    this.timer = setInterval(() => void this.tick(), interval);
    if (typeof this.timer.unref === "function") this.timer.unref();
    console.log(`${LOG_TAG} \u5DF2\u542F\u52A8\uFF1A\u6BCF ${Math.round(interval / 1e3)}s \u89C2\u5BDF\u4E00\u6B21\uFF1B\u7EFF\u773C\u775B\u5FC3\u8DF3 ${HEARTBEAT}`);
  }
  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(`${LOG_TAG} \u5DF2\u505C\u6B62`);
  }
  get running() {
    return this.timer !== null;
  }
};
async function defaultCapture() {
  try {
    const mod = await import("node-screenshots");
    const Monitor = mod.Monitor ?? mod.default?.Monitor;
    if (!Monitor?.all || typeof Monitor.all !== "function") return null;
    const monitors = Monitor.all();
    if (!monitors?.length) return null;
    const img = await monitors[0].captureImage();
    return await img.toJpeg();
  } catch (e) {
    console.warn(`${LOG_TAG} node-screenshots \u4E0D\u53EF\u7528\uFF1A${e.message}`);
    return null;
  }
}
async function defaultDescribe(base64, prompt) {
  const apiBase = (process.env.VISION_API_BASE || "").replace(/\/$/, "");
  const apiKey = process.env.VISION_API_KEY || "";
  if (!apiBase || !apiKey) throw new Error("\u6CA1\u6709\u914D\u7F6E VISION_API_BASE / VISION_API_KEY");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1e4);
  try {
    const r = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.VISION_MODEL || "glm-4v-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
            ]
          }
        ],
        max_tokens: 120
      })
    });
    if (!r.ok) throw new Error(`\u89C6\u89C9\u63A5\u53E3 ${r.status}`);
    const j = await r.json();
    return j?.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}
function makeGameProbe(list = process.env.DSH_SCREEN_GAME_PROCS || DEFAULT_GAME_PROCS) {
  const procs = list.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return () => new Promise((resolve) => {
    execFile("tasklist", ["/fo", "csv", "/nh"], { timeout: 5e3 }, (err, stdout) => {
      if (err || !stdout) return resolve(false);
      const lower = stdout.toLowerCase();
      resolve(procs.some((p) => p && lower.includes(p)));
    });
  });
}
export {
  Companion,
  LOG_TAG,
  VLM_PROMPT,
  makeGameProbe
};
//# sourceMappingURL=index.js.map
