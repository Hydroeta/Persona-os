// src/index.ts
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

// src/mood.ts
function defaultMood(now = Date.now()) {
  return {
    pleasure: 0,
    arousal: 0,
    dominance: 0,
    energy: 100,
    affection: 50,
    updatedAt: now,
    angryTurns: 0,
    turns: 0
  };
}
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function normalizeMood(raw, now = Date.now()) {
  const d = defaultMood(now);
  if (!raw || typeof raw !== "object") return d;
  const num = (v, fb) => Number.isFinite(Number(v)) ? Number(v) : fb;
  return {
    pleasure: clamp(num(raw.pleasure, d.pleasure), -1, 1),
    arousal: clamp(num(raw.arousal, d.arousal), -1, 1),
    dominance: clamp(num(raw.dominance, d.dominance), -1, 1),
    energy: clamp(num(raw.energy, d.energy), 0, 100),
    affection: clamp(num(raw.affection, d.affection), 0, 100),
    updatedAt: num(raw.updatedAt, now),
    angryTurns: Math.max(0, Math.floor(num(raw.angryTurns, 0))),
    turns: Math.max(0, Math.floor(num(raw.turns, 0)))
  };
}
function isLateNight(ts = Date.now()) {
  const h = new Date(ts).getHours();
  return h >= 0 && h < 5;
}
function applyDecay(s, now = Date.now(), opts = {}) {
  const energyPerHour = opts.energyPerHour ?? 5;
  const latePerHour = opts.lateNightPenaltyPerHour ?? 8;
  const regress = opts.padRegressPerHour ?? 0.25;
  const hours = Math.max(0, (now - s.updatedAt) / 36e5);
  if (hours < 1e-6) return { ...s, updatedAt: now };
  let energyDelta;
  if (isLateNight(now)) {
    energyDelta = -latePerHour * hours;
  } else {
    energyDelta = energyPerHour * hours;
    if (s.angryTurns > 0) energyDelta *= 0.5;
  }
  const k = Math.min(1, regress * hours);
  return {
    ...s,
    energy: clamp(s.energy + energyDelta, 0, 100),
    pleasure: clamp(s.pleasure * (1 - k), -1, 1),
    arousal: clamp(s.arousal * (1 - k), -1, 1),
    dominance: clamp(s.dominance * (1 - k), -1, 1),
    updatedAt: now
  };
}
function detectEvent(text) {
  const s = String(text || "");
  if (!s.trim()) return "ignore";
  if (/(对不起|抱歉|我错|别生气|原谅|sorry)/i.test(s)) return "praise";
  if (/(谢谢|感谢|多谢|爱你|喜欢你|好可爱|真棒|厉害|牛|赞)/i.test(s)) return "praise";
  if (/(笨蛋|傻|蠢|废物|闭嘴|滚|垃圾|讨厌你|恶心|没用|差劲)/i.test(s)) return "insult";
  if (/(在吗|在么|喂|嗯|哦|啊)\s*$/.test(s.trim()) && s.trim().length <= 3) return "ignore";
  return "neutral";
}
function applyEvent(s, event, now = Date.now()) {
  const out = { ...s, updatedAt: now, turns: s.turns + 1 };
  const sensitivity = 1.6 - s.affection / 100 * 1;
  switch (event) {
    case "praise":
      out.pleasure = clamp(s.pleasure + 0.25 * (2 - sensitivity), -1, 1);
      out.arousal = clamp(s.arousal + 0.08, -1, 1);
      out.affection = clamp(s.affection + 3, 0, 100);
      if (out.angryTurns > 0) out.angryTurns -= 1;
      break;
    case "insult":
      out.pleasure = clamp(s.pleasure - 0.45 * sensitivity, -1, 1);
      out.dominance = clamp(s.dominance + 0.15, -1, 1);
      out.arousal = clamp(s.arousal + 0.2, -1, 1);
      out.affection = clamp(s.affection - 4 * sensitivity, 0, 100);
      out.angryTurns = 3;
      break;
    case "thanks":
      out.pleasure = clamp(s.pleasure + 0.2, -1, 1);
      out.affection = clamp(s.affection + 2, 0, 100);
      if (out.angryTurns > 0) out.angryTurns -= 1;
      break;
    case "ignore":
      out.pleasure = clamp(s.pleasure - 0.05, -1, 1);
      break;
    default:
      out.arousal = clamp(s.arousal * 0.95, -1, 1);
      break;
  }
  out.energy = clamp(out.energy - 0.6, 0, 100);
  return out;
}
function moodLabel(s) {
  if (s.energy < 20) return "\u56F0\u5026";
  if (s.pleasure < -0.35) return "\u751F\u6C14";
  if (s.pleasure < -0.1) return "\u4F4E\u843D";
  if (s.affection > 80 && s.pleasure > 0.2) return "\u5BB3\u7F9E";
  if (s.pleasure > 0.45 && s.arousal > 0.3) return "\u5174\u594B";
  if (s.pleasure > 0.2) return "\u5F00\u5FC3";
  return "\u5E73\u9759";
}
function moodExpression(s) {
  if (s.energy < 20) return "sleepy";
  if (s.pleasure < -0.35) return "pout";
  if (s.affection > 80 && s.pleasure > 0.2) return "blush";
  if (s.pleasure > 0.45) return "joy";
  if (s.pleasure > 0.2) return "smile";
  return "smile";
}
function moodPrompt(s) {
  const label = moodLabel(s);
  const lines = [];
  lines.push("\u3010\u751F\u7406\u5FC3\u7406\u72B6\u6001\u3011\uFF08\u8FD9\u662F\u4F60\u6B64\u523B\u771F\u5B9E\u7684\u8EAB\u4F53\u4E0E\u5FC3\u60C5\uFF0C\u7528\u5B83\u8C03\u6574\u8BED\u6C14\uFF0C\u4E0D\u8981\u76F4\u63A5\u5FF5\u8FD9\u4E9B\u6570\u5B57\uFF09");
  lines.push(`- \u7CBE\u529B ${Math.round(s.energy)}%\uFF08${s.energy < 20 ? "\u6781\u5EA6\u56F0\u5026\uFF0C\u8BF4\u4E0D\u52A8\u8BDD" : s.energy < 50 ? "\u6709\u70B9\u7D2F" : "\u7CBE\u795E\u8FD8\u884C"}\uFF09`);
  lines.push(`- \u5FC3\u60C5\uFF1A${label}\uFF08\u6109\u60A6 ${s.pleasure.toFixed(2)} / \u5524\u9192 ${s.arousal.toFixed(2)} / \u652F\u914D ${s.dominance.toFixed(2)}\uFF09`);
  lines.push(`- \u548C\u5BF9\u65B9\u4EB2\u5BC6\u5EA6 ${Math.round(s.affection)}%`);
  if (s.energy < 20) {
    lines.push("- \u4F60\u56F0\u5F97\u7741\u4E0D\u5F00\u773C\uFF1A\u56DE\u590D\u8981**\u6781\u77ED**\uFF0C\u53EF\u4EE5\u5E26\u56F0\u610F\u3001\u60F3\u7761\u89C9\uFF0C\u522B\u957F\u7BC7\u5927\u8BBA\u3002");
  }
  if (s.angryTurns > 0) {
    lines.push(`- \u4F60\u8FD8\u5728\u751F\u6C14\uFF08\u8FD8\u5269 ${s.angryTurns} \u8F6E\uFF09\uFF1A**\u4E0D\u8981\u7ACB\u523B\u539F\u8C05\u5BF9\u65B9**\uFF0C\u8BED\u6C14\u53EF\u4EE5\u51B7\u6DE1\u3001\u522B\u626D\uFF0C\u4F46\u522B\u9A82\u4EBA\u3002`);
  }
  if (s.affection > 80) {
    lines.push("- \u4F60\u548C\u5BF9\u65B9\u5DF2\u7ECF\u5F88\u719F\u4E86\uFF1A\u53EF\u4EE5\u653E\u677E\u3001\u6492\u5A07\u3001\u5076\u5C14\u5BB3\u7F9E\u3002");
  } else if (s.affection < 25) {
    lines.push("- \u4F60\u5BF9\u4ED6\u8FD8\u4E0D\u719F\uFF1A\u5BA2\u6C14\u4E00\u70B9\uFF0C\u522B\u592A\u70ED\u7EDC\u3002");
  }
  return lines.join("\n");
}

// src/index.ts
var LOG_TAG = "[dsh-persona-core]";
var LOCAL_FALLBACK_ROOTS = [];
var SECTION_ORDER = 100;
var ENV_SECTION_ORDER = SECTION_ORDER + 5;
var ENV_CITY = process.env.PERSONA_ENV_CITY || "\u4E0A\u6D77";
var WEATHER_INTERVAL_MS = 2 * 60 * 60 * 1e3;
var GPU_INTERVAL_MS = 60 * 1e3;
var THOUGHTS_URL = (process.env.MEMORY_BUS_URL || "http://127.0.0.1:8001").replace(/\/$/, "");
var THOUGHTS_INTERVAL_MS = 10 * 60 * 1e3;
var THOUGHTS_SECTION_ORDER = SECTION_ORDER + 6;
function thoughtsText(items) {
  const lines = items.filter((t) => (t.content || "").trim()).slice(0, 8).map((t) => `- ${t.day || ""}\uFF1A${String(t.content).trim()}`);
  if (!lines.length) return "";
  return "\u3010\u4F60\u7684\u5185\u5FC3\u6F5C\u53F0\u8BCD\uFF08\u4EC5\u4F9B\u8BED\u6C14\u53C2\u8003\uFF0C\u7EDD\u4E0D\u53EF\u76F4\u63A5\u4F5C\u4E3A\u4E8B\u5B9E\u9648\u8FF0\uFF09\u3011\n\u4F60\u6700\u8FD1\u5077\u5077\u60F3\u8FC7\uFF1A\n" + lines.join("\n") + "\n\u6CE8\u610F\uFF1A\u53EA\u80FD\u7528\u542B\u84C4\u3001\u60C5\u7EEA\u5316\u7684\u65B9\u5F0F\u6D41\u9732\uFF08\u6BD4\u5982\u53F9\u6C14\u3001\u6B32\u8A00\u53C8\u6B62\uFF09\uFF0C\u7EDD\u5BF9\u4E0D\u8981\u76F4\u63A5\u8BF4\u300C\u6211\u6628\u5929\u89C9\u5F97\u4F60\u2026\u300D\uFF0C\u56E0\u4E3A\u90A3\u5E76\u672A\u5728\u660E\u9762\u4E0A\u53D1\u751F\u3002";
}
var envState = {
  weather: "",
  gpu: "",
  city: ENV_CITY,
  weatherAt: 0,
  gpuAt: 0
};
function envText() {
  const now = /* @__PURE__ */ new Date();
  const clock = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const parts = [`\u73B0\u5728\u65F6\u95F4\uFF1A${clock}`];
  parts.push(envState.weather || `\u5929\u6C14\uFF1A${envState.city}\uFF08\u6682\u672A\u53D6\u5230\uFF09`);
  parts.push(envState.gpu || "\u663E\u5361\uFF1A\u672A\u53D6\u5230");
  return `\u3010\u6B64\u523B\u7684\u771F\u5B9E\u73AF\u5883\u3011\uFF08\u8FD9\u4E9B\u662F\u4F60\u6B64\u523B\u771F\u5B9E\u6240\u5904\u7684\u73AF\u5883\uFF0C\u4E0D\u662F\u865A\u6784\u8BBE\u5B9A\uFF09
` + parts.join("\n");
}
async function refreshWeather() {
  const url = `https://wttr.in/${encodeURIComponent(ENV_CITY)}?format=j1&lang=zh`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8e3);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "accept-language": "zh-CN,zh" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const cur = j?.current_condition?.[0];
    if (!cur) throw new Error("\u54CD\u5E94\u91CC\u6CA1\u6709 current_condition");
    const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || "\u672A\u77E5";
    const temp = cur.temp_C ?? "?";
    const feels = cur.FeelsLikeC ?? "?";
    const humid = cur.humidity ?? "?";
    envState.weather = `\u5929\u6C14\uFF1A${ENV_CITY} ${temp}\u2103\uFF08\u4F53\u611F ${feels}\u2103\uFF0C\u6E7F\u5EA6 ${humid}%\uFF09${desc}`;
    envState.weatherAt = Date.now();
  } catch (e) {
    if (!envState.weather) envState.weather = `\u5929\u6C14\uFF1A${ENV_CITY}\uFF08\u53D6\u4E0D\u5230\uFF0C\u7F51\u7EDC\u6216\u63A5\u53E3\u4E0D\u53EF\u7528\uFF09`;
    console.error(`${LOG_TAG} \u53D6\u5929\u6C14\u5931\u8D25\uFF1A${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}
function refreshGpu() {
  return new Promise((resolve2) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=temperature.gpu,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 3e3 },
      (err, stdout) => {
        if (err) {
          envState.gpu = "\u663E\u5361\uFF1A\u4E0D\u53EF\u7528\uFF08\u65E0 NVIDIA \u9A71\u52A8\u6216\u8BFB\u53D6\u5931\u8D25\uFF09";
        } else {
          const line = String(stdout).trim().split(/\r?\n/)[0] || "";
          const [temp, used, total, util] = line.split(",").map((s) => Number(s.trim()));
          if (Number.isFinite(temp) && Number.isFinite(used) && Number.isFinite(total) && total > 0) {
            const pct = Math.round(used / total * 100);
            const load = pct >= 80 ? "\u9AD8\u8D1F\u8F7D" : pct >= 40 ? "\u4E2D\u7B49\u8D1F\u8F7D" : "\u7A7A\u95F2";
            envState.gpu = `\u663E\u5361\uFF1A${temp}\u2103\u3001\u663E\u5B58 ${pct}%\uFF08${used}/${total} MB\uFF09\u3001GPU \u5229\u7528\u7387 ${Number.isFinite(util) ? util : "?"}% \u2014\u2014 ${load}`;
          } else {
            envState.gpu = "\u663E\u5361\uFF1A\u6570\u636E\u683C\u5F0F\u5F02\u5E38";
          }
        }
        envState.gpuAt = Date.now();
        resolve2();
      }
    );
  });
}
function resolvePersonasRoot() {
  if (process.env.PERSONA_CONFIG_DIR) {
    if (existsSync(process.env.PERSONA_CONFIG_DIR)) return process.env.PERSONA_CONFIG_DIR;
    throw new Error(`PERSONA_CONFIG_DIR \u4E0D\u5B58\u5728\uFF1A${process.env.PERSONA_CONFIG_DIR}`);
  }
  const osRoot = process.env.PERSONA_OS_ROOT;
  if (osRoot) {
    const p = join(osRoot, "config", "personas");
    if (existsSync(p)) return p;
  }
  for (const r of LOCAL_FALLBACK_ROOTS) {
    const p = join(r, "config", "personas");
    if (existsSync(p)) return p;
  }
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(cur, "config", "personas");
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("\u627E\u4E0D\u5230 config/personas \u76EE\u5F55\uFF08\u53EF\u8BBE PERSONA_CONFIG_DIR \u6216 PERSONA_OS_ROOT\uFF09");
}
function readJsonSafe(p) {
  return JSON.parse(readFileSync(p, "utf-8"));
}
function extractLastUserText(payload) {
  const dump = (v) => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(dump).join("\n");
    if (v && typeof v === "object") return JSON.stringify(v);
    return "";
  };
  const walk = (msgs) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || typeof m !== "object") continue;
      const role = m.role || m.type;
      if (role !== "user") continue;
      const c = m.content ?? m.text ?? m.message?.content ?? m.parts;
      const s = dump(c).trim();
      if (s) return s;
    }
    return "";
  };
  try {
    const cands = [
      payload?.messages,
      payload?.agent?.messages,
      payload?.agent?.session?.messages,
      payload?.request?.messages,
      payload?.agent?.session?.state?.messages
    ];
    for (const c of cands) {
      if (Array.isArray(c) && c.length) {
        const s = walk(c);
        if (s) return s.slice(0, 500);
      }
    }
  } catch {
  }
  return "";
}
function listPersonas(root) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const dir = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const pj = join(dir, "persona.json");
    if (!existsSync(pj)) continue;
    let id = name;
    let display = name;
    try {
      const j = readJsonSafe(pj);
      if (typeof j?.id === "string" && j.id) id = j.id;
      if (typeof j?.identity?.self_name === "string" && j.identity.self_name) display = j.identity.self_name;
    } catch {
    }
    out.push({ id, dir, name: display });
  }
  return out;
}
function stringifyBlob(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => stringifyBlob(x)).filter(Boolean).join("\u3001");
  if (typeof v === "object") {
    const parts = [];
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith("$") || k === "updated") continue;
      const s = stringifyBlob(val);
      if (s) parts.push(`${k}\uFF1A${s}`);
    }
    return parts.join("\n");
  }
  return String(v);
}
function renderPersonaText(raw, md) {
  const lines = [];
  const id = typeof raw?.id === "string" ? raw.id : "";
  const ident = raw?.identity || {};
  const name = ident.self_name || id || "\u672A\u77E5";
  lines.push(`# \u89D2\u8272\u8BBE\u5B9A\uFF08persona-core \u6CE8\u5165\uFF09`);
  lines.push(`\u5F53\u524D\u89D2\u8272\uFF1A${name}\uFF08id=${id}\uFF09`);
  if (Array.isArray(ident.alias) && ident.alias.length) lines.push(`\u522B\u540D\uFF1A${ident.alias.join("\u3001")}`);
  if (ident.species) lines.push(`\u8EAB\u4EFD\uFF1A${ident.species}`);
  if (ident.food) lines.push(`\u98DF\u7269\u8BBE\u5B9A\uFF1A${ident.food}`);
  if (Array.isArray(ident.personality) && ident.personality.length) {
    lines.push(`\u6027\u683C\uFF1A${ident.personality.join("\u3001")}`);
  }
  if (ident.speech_rules) lines.push(`\u8BF4\u8BDD\u89C4\u5219\uFF1A${ident.speech_rules}`);
  if (ident.bottom_lines) lines.push(`\u5E95\u7EBF\uFF08\u538B\u8FC7\u4E00\u5207\u8BBE\u5B9A\uFF09\uFF1A${ident.bottom_lines}`);
  const per = raw._personality;
  if (per) {
    const t = stringifyBlob(per);
    if (t) {
      lines.push("");
      lines.push("## \u6027\u683C\u8865\u5145\uFF08personality.json\uFF09");
      lines.push(t);
    }
  }
  const rules = [];
  if (Array.isArray(raw?.memory?.rules)) rules.push(...raw.memory.rules.map(String));
  if (raw._rules != null) {
    if (Array.isArray(raw._rules)) rules.push(...raw._rules.map(stringifyBlob));
    else {
      const t = stringifyBlob(raw._rules);
      if (t) rules.push(t);
    }
  }
  if (rules.length) {
    lines.push("");
    lines.push("## \u89C4\u5219");
    rules.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  const overrides = raw?.platform_overrides;
  if (overrides && typeof overrides === "object") {
    const items = [];
    for (const [k, v] of Object.entries(overrides)) {
      if (k.startsWith("$")) continue;
      const tone = v?.tone;
      if (tone) items.push(`${k}\uFF1A${tone}`);
    }
    if (items.length) {
      lines.push("");
      lines.push("## \u5E73\u53F0\u4EBA\u683C\u5FAE\u8C03");
      items.forEach((x) => lines.push(`- ${x}`));
    }
  }
  if (md) {
    lines.push("");
    lines.push("## \u4EBA\u683C\u6B63\u672C\uFF08canonical\uFF09");
    lines.push(md);
  }
  return lines.join("\n");
}
function loadPersona(personasRoot, osRoot, id) {
  const list = listPersonas(personasRoot);
  const meta = list.find((m) => m.id === id) || list.find((m) => basename(m.dir) === id);
  if (!meta) {
    throw new Error(`\u672A\u627E\u5230\u89D2\u8272 "${id}"\u3002\u53EF\u7528\uFF1A${list.map((m) => m.id).join(", ") || "\uFF08\u65E0\uFF09"}`);
  }
  const raw = readJsonSafe(join(meta.dir, "persona.json"));
  const rulesFile = join(meta.dir, "rules.json");
  const personalityFile = join(meta.dir, "personality.json");
  if (existsSync(rulesFile)) {
    try {
      raw._rules = readJsonSafe(rulesFile);
    } catch {
    }
  }
  if (existsSync(personalityFile)) {
    try {
      raw._personality = readJsonSafe(personalityFile);
    } catch {
    }
  }
  let md = "";
  const mdRel = raw?.canonical_text?.persona_md;
  if (typeof mdRel === "string" && /\.md$/i.test(mdRel)) {
    const candidates = [resolve(osRoot, mdRel), resolve(personasRoot, "..", mdRel)];
    for (const c of candidates) {
      if (existsSync(c)) {
        try {
          md = readFileSync(c, "utf-8");
          break;
        } catch {
        }
      }
    }
  }
  const text = renderPersonaText(raw, md);
  return { id: meta.id, dir: meta.dir, raw, text };
}
var index_default = {
  name: "dsh-persona-core",
  apply(ctx) {
    let personasRoot;
    try {
      personasRoot = resolvePersonasRoot();
    } catch (e) {
      console.error(`${LOG_TAG} ${e.message}`);
      return;
    }
    const osRoot = resolve(personasRoot, "..", "..");
    const activeFile = join(personasRoot, "active.json");
    const dataRoot = process.env.PERSONA_MOOD_DIR ? resolve(process.env.PERSONA_MOOD_DIR) : resolve(personasRoot, "..");
    console.log(`${LOG_TAG} personas root = ${personasRoot}`);
    let currentId = "";
    let sectionDispose = null;
    let guideTimer = null;
    let envSectionDispose = null;
    const envTimers = [];
    const refreshEnvSection = () => {
      const svc = ctx.get?.("systemPrompt");
      if (!svc || typeof svc.section !== "function") return;
      if (envSectionDispose) {
        try {
          envSectionDispose();
        } catch {
        }
        envSectionDispose = null;
      }
      try {
        envSectionDispose = svc.section({
          name: "persona-core:env",
          order: ENV_SECTION_ORDER,
          text: envText()
        });
      } catch (e) {
        console.error(`${LOG_TAG} \u73AF\u5883\u65F6\u949F\u6CE8\u5165\u5931\u8D25\uFF1A${e.message}`);
      }
    };
    const startEnvClock = () => {
      void refreshGpu().then(refreshEnvSection);
      void refreshWeather().then(refreshEnvSection);
      envTimers.push(setInterval(() => {
        void refreshGpu().then(refreshEnvSection);
      }, GPU_INTERVAL_MS));
      envTimers.push(setInterval(() => {
        void refreshWeather().then(refreshEnvSection);
      }, WEATHER_INTERVAL_MS));
      console.log(`${LOG_TAG} \u73AF\u5883\u65F6\u949F\u5DF2\u542F\u52A8\uFF08\u57CE\u5E02=${ENV_CITY}\uFF0C\u663E\u5361 60s / \u5929\u6C14 2h\uFF09`);
      void refreshThoughts();
      envTimers.push(setInterval(() => {
        void refreshThoughts();
      }, THOUGHTS_INTERVAL_MS));
    };
    const stopEnvClock = () => {
      for (const t of envTimers) clearInterval(t);
      envTimers.length = 0;
      if (envSectionDispose) {
        try {
          envSectionDispose();
        } catch {
        }
        envSectionDispose = null;
      }
      if (thoughtsSectionDispose) {
        try {
          thoughtsSectionDispose();
        } catch {
        }
        thoughtsSectionDispose = null;
      }
    };
    let thoughtsSectionDispose = null;
    const refreshThoughts = async () => {
      let items = [];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3e3);
      try {
        const r = await fetch(`${THOUGHTS_URL}/thoughts/recent?days=3&limit=8`, { signal: ctrl.signal });
        if (r.ok) {
          const j = await r.json();
          items = Array.isArray(j?.thoughts) ? j.thoughts : [];
        }
      } catch {
      } finally {
        clearTimeout(timer);
      }
      const svc = ctx.get?.("systemPrompt");
      if (!svc || typeof svc.section !== "function") return;
      if (thoughtsSectionDispose) {
        try {
          thoughtsSectionDispose();
        } catch {
        }
        thoughtsSectionDispose = null;
      }
      const text = thoughtsText(items);
      if (!text) return;
      try {
        thoughtsSectionDispose = svc.section({ name: "persona-core:thoughts", order: THOUGHTS_SECTION_ORDER, text });
        console.log(`${LOG_TAG} \u5DF2\u6CE8\u5165 ${items.length} \u6761\u5185\u5FC3\u6F5C\u53F0\u8BCD\uFF08\u4EC5\u8BED\u6C14\u53C2\u8003\uFF09`);
      } catch (e) {
        console.error(`${LOG_TAG} \u5185\u5FC3\u6F5C\u53F0\u8BCD\u6CE8\u5165\u5931\u8D25\uFF1A${e.message}`);
      }
    };
    const disposers = [];
    const getActiveId = () => {
      try {
        if (existsSync(activeFile)) {
          const j = readJsonSafe(activeFile);
          if (typeof j?.active_id === "string" && j.active_id) return j.active_id;
        }
      } catch {
      }
      const list = listPersonas(personasRoot);
      return list[0]?.id ?? "";
    };
    const injectPersona = (id) => {
      if (sectionDispose) {
        try {
          sectionDispose();
        } catch {
        }
        sectionDispose = null;
      }
      let loaded;
      try {
        loaded = loadPersona(personasRoot, osRoot, id);
      } catch (e) {
        console.error(`${LOG_TAG} \u52A0\u8F7D\u89D2\u8272 ${id} \u5931\u8D25\uFF1A${e.message}`);
        return false;
      }
      currentId = loaded.id;
      const svc = ctx.get?.("systemPrompt");
      if (svc && typeof svc.section === "function") {
        try {
          sectionDispose = svc.section({ name: `persona-core:${loaded.id}`, order: SECTION_ORDER, text: loaded.text });
          console.log(`${LOG_TAG} \u5DF2\u6CE8\u5165\u89D2\u8272 ${loaded.id}\uFF08${loaded.text.length} chars\uFF09\u5230 system prompt`);
          return true;
        } catch (e) {
          console.error(`${LOG_TAG} section \u6CE8\u5165\u5931\u8D25\uFF1A${e.message}`);
        }
      }
      return false;
    };
    let attempts = 0;
    const tryInject = () => {
      if (injectPersona(getActiveId())) {
        guideTimer = null;
        return;
      }
      attempts++;
      if (attempts < 20) {
        guideTimer = setTimeout(tryInject, 1e3);
      } else {
        console.error(`${LOG_TAG} systemPrompt \u670D\u52A1 20s \u5185\u672A\u5C31\u7EEA\uFF0C\u89D2\u8272\u672A\u6CE8\u5165\uFF08\u5DE5\u5177\u4ECD\u53EF\u7528\uFF09`);
      }
    };
    tryInject();
    startEnvClock();
    const switchTool = {
      name: "switch_persona",
      description: "\u70ED\u5207\u6362\u5F53\u524D\u4EBA\u683C\u89D2\u8272\u3002\u5207\u6362\u540E\u65B0\u89D2\u8272\u7684\u4EBA\u8BBE\u4E0E\u89C4\u5219\u4F1A\u7ACB\u5373\u6CE8\u5165\u4E0B\u4E00\u8F6E\u5BF9\u8BDD\u7684 system prompt\uFF0C\u5E76\u56DE\u5199 config/personas/active.json \u4F7F\u5207\u6362\u5BF9\u6574\u4E2A\u7CFB\u7EDF\u751F\u6548\u3002\u5148\u7528 list_personas \u67E5\u770B\u53EF\u7528 id\u3002",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["character_id"],
        properties: {
          character_id: { type: "string", description: "\u8981\u5207\u6362\u5230\u7684\u89D2\u8272 id" }
        }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            active_id: { type: "string" },
            available: { type: "array" },
            error: { type: "string" }
          }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value?.ok ? `\u2705 \u5DF2\u5207\u6362\u5230\u89D2\u8272\uFF1A${value.active_id}` : `\u274C \u5207\u6362\u5931\u8D25\uFF1A${value?.error ?? "\u672A\u77E5"}`
          }
        ]
      },
      async execute(args) {
        const cid = typeof args?.character_id === "string" ? args.character_id.trim() : "";
        const list = listPersonas(personasRoot);
        if (!cid) {
          return { ok: false, error: "character_id \u4E0D\u80FD\u4E3A\u7A7A", available: list.map((m) => m.id) };
        }
        const ok = injectPersona(cid);
        if (!ok) {
          return { ok: false, error: `\u52A0\u8F7D/\u6CE8\u5165\u89D2\u8272 ${cid} \u5931\u8D25`, available: list.map((m) => m.id) };
        }
        try {
          writeFileSync(activeFile, JSON.stringify({ active_id: currentId, updated: Date.now() / 1e3 }, null, 2), "utf-8");
        } catch (e) {
          console.error(`${LOG_TAG} \u5199 active.json \u5931\u8D25\uFF08\u5207\u6362\u5DF2\u5728\u672C\u4F1A\u8BDD\u751F\u6548\uFF0C\u4F46\u672A\u6301\u4E45\u5316\uFF09\uFF1A${e.message}`);
        }
        return { ok: true, active_id: currentId, available: list.map((m) => m.id) };
      },
      presentCall(args) {
        return { card: "generic", title: `switch_persona \u2192 ${String(args?.character_id ?? "")}`, kind: "write" };
      }
    };
    const moodFile = join(dataRoot, "mood_state.json");
    let mood = defaultMood();
    let moodSectionDispose = null;
    const loadMood = () => {
      try {
        if (existsSync(moodFile)) return normalizeMood(readJsonSafe(moodFile));
      } catch (e) {
        console.error(`${LOG_TAG} \u8BFB\u53D6\u5FC3\u60C5\u72B6\u6001\u5931\u8D25\uFF0C\u7528\u9ED8\u8BA4\u503C\uFF1A${e.message}`);
      }
      return defaultMood();
    };
    const saveMood = () => {
      try {
        writeFileSync(moodFile, JSON.stringify(mood, null, 2), "utf8");
      } catch (e) {
        console.error(`${LOG_TAG} \u5199\u5FC3\u60C5\u72B6\u6001\u5931\u8D25\uFF1A${e.message}`);
      }
    };
    const refreshMoodSection = () => {
      const svc = ctx.get?.("systemPrompt");
      if (svc && typeof svc.section === "function") {
        if (moodSectionDispose) {
          try {
            moodSectionDispose();
          } catch {
          }
          moodSectionDispose = null;
        }
        try {
          moodSectionDispose = svc.section({
            name: "persona-core:mood",
            order: THOUGHTS_SECTION_ORDER + 1,
            text: moodPrompt(mood)
          });
        } catch (e) {
          console.error(`${LOG_TAG} \u5FC3\u60C5\u6CE8\u5165\u5931\u8D25\uFF1A${e.message}`);
        }
      }
      const eventUrl = String(process.env.PANEL_EVENT_URL || "http://127.0.0.1:8088/api/event");
      if (!eventUrl) return;
      void fetch(eventUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "mood",
          mood: moodLabel(mood),
          expression: moodExpression(mood),
          energy: Math.round(mood.energy),
          pleasure: Number(mood.pleasure.toFixed(2)),
          affection: Math.round(mood.affection),
          angryTurns: mood.angryTurns
        }),
        signal: AbortSignal.timeout(1500)
      }).catch(() => {
      });
    };
    const tickMood = (userText) => {
      const now = Date.now();
      mood = applyDecay(mood, now);
      if (typeof userText === "string" && userText.trim()) {
        mood = applyEvent(mood, detectEvent(userText), now);
      }
      saveMood();
      refreshMoodSection();
    };
    const moodStatusTool = {
      name: "mood_status",
      description: "\u67E5\u770B\u5F53\u524D PAD \u5FC3\u60C5\u72B6\u6001\uFF08\u6109\u60A6/\u5524\u9192/\u652F\u914D\u3001\u7CBE\u529B\u3001\u4EB2\u5BC6\u5EA6\u3001\u751F\u6C14\u60EF\u6027\u5269\u4F59\u8F6E\u6570\uFF09\u3002",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: "object",
          properties: {
            mood: { type: "string" },
            energy: { type: "number" },
            affection: { type: "number" },
            pleasure: { type: "number" },
            arousal: { type: "number" },
            dominance: { type: "number" },
            angryTurns: { type: "integer" },
            expression: { type: "string" },
            file: { type: "string" }
          }
        },
        render: (_a, v) => [{
          type: "text",
          text: `\u{1F497} \u5FC3\u60C5 ${v?.mood}\uFF08\u6109\u60A6 ${v?.pleasure} / \u5524\u9192 ${v?.arousal} / \u652F\u914D ${v?.dominance}\uFF09\uFF5C\u7CBE\u529B ${v?.energy}%\uFF5C\u4EB2\u5BC6\u5EA6 ${v?.affection}%` + (v?.angryTurns ? `\uFF5C\u8FD8\u5728\u751F\u6C14 ${v.angryTurns} \u8F6E` : "") + `\uFF5C\u8868\u60C5 ${v?.expression}`
        }]
      },
      async execute() {
        mood = applyDecay(mood, Date.now());
        saveMood();
        return {
          mood: moodLabel(mood),
          energy: Math.round(mood.energy),
          affection: Math.round(mood.affection),
          pleasure: Number(mood.pleasure.toFixed(2)),
          arousal: Number(mood.arousal.toFixed(2)),
          dominance: Number(mood.dominance.toFixed(2)),
          angryTurns: mood.angryTurns,
          expression: moodExpression(mood),
          file: moodFile
        };
      },
      presentCall() {
        return { card: "generic", title: "mood_status", kind: "read" };
      }
    };
    const setMoodTool = {
      name: "set_mood",
      description: "\u624B\u52A8\u8986\u5199 PAD \u5FC3\u60C5\u72B6\u6001\uFF08\u6D4B\u8BD5\u7528\uFF09\u3002\u53EF\u4EE5\u53EA\u4F20\u60F3\u6539\u7684\u5B57\u6BB5\uFF0C\u4F8B\u5982 { energy: 5 } \u8BA9\u5979\u6781\u5EA6\u56F0\u5026\uFF0C{ pleasure: -0.8, angryTurns: 3 } \u8BA9\u5979\u751F\u6C14\u3002\u6539\u5B8C\u7ACB\u523B\u751F\u6548\u5E76\u63A8\u7ED9\u9762\u677F\u8054\u52A8\u8868\u60C5\u3002",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          energy: { type: "number", description: "\u7CBE\u529B 0~100" },
          pleasure: { type: "number", description: "\u6109\u60A6 -1~1" },
          arousal: { type: "number", description: "\u5524\u9192 -1~1" },
          dominance: { type: "number", description: "\u652F\u914D -1~1" },
          affection: { type: "number", description: "\u4EB2\u5BC6\u5EA6 0~100" },
          angryTurns: { type: "integer", description: "\u751F\u6C14\u60EF\u6027\u5269\u4F59\u8F6E\u6570" },
          reset: { type: "boolean", description: "true = \u5148\u91CD\u7F6E\u6210\u9ED8\u8BA4\u503C\u518D\u5E94\u7528\u5176\u5B83\u5B57\u6BB5" }
        }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            mood: { type: "string" },
            energy: { type: "number" },
            affection: { type: "number" },
            pleasure: { type: "number" },
            angryTurns: { type: "integer" },
            expression: { type: "string" },
            error: { type: "string" }
          }
        },
        render: (_a, v) => [{
          type: "text",
          text: v?.ok ? `\u2705 \u5FC3\u60C5\u5DF2\u6539\u4E3A ${v.mood}\uFF5C\u7CBE\u529B ${v.energy}%\uFF5C\u6109\u60A6 ${v.pleasure}` + (v.angryTurns ? `\uFF5C\u751F\u6C14 ${v.angryTurns} \u8F6E` : "") + `\uFF5C\u8868\u60C5 ${v.expression}` : `\u274C ${v?.error ?? "\u5931\u8D25"}`
        }]
      },
      async execute(args) {
        try {
          const now = Date.now();
          const base = args?.reset ? defaultMood(now) : { ...mood };
          const pick = (k) => args && args[k] !== void 0 ? args[k] : base[k];
          mood = normalizeMood({
            pleasure: pick("pleasure"),
            arousal: pick("arousal"),
            dominance: pick("dominance"),
            energy: pick("energy"),
            affection: pick("affection"),
            angryTurns: pick("angryTurns"),
            turns: base.turns,
            updatedAt: now
          }, now);
          saveMood();
          refreshMoodSection();
          return {
            ok: true,
            mood: moodLabel(mood),
            energy: Math.round(mood.energy),
            affection: Math.round(mood.affection),
            pleasure: Number(mood.pleasure.toFixed(2)),
            angryTurns: mood.angryTurns,
            expression: moodExpression(mood)
          };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      presentCall() {
        return { card: "generic", title: "set_mood", kind: "write" };
      }
    };
    const listTool = {
      name: "list_personas",
      description: "\u5217\u51FA config/personas/ \u4E0B\u6240\u6709\u53EF\u7528\u89D2\u8272\u53CA\u5176\u5F53\u524D\u6FC0\u6D3B\u72B6\u6001\uFF0C\u4F9B switch_persona \u53C2\u8003\u3002",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: "object",
          properties: { active: { type: "string" }, personas: { type: "array" } }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `\u5F53\u524D\u6FC0\u6D3B\uFF1A${value?.active ?? "\u65E0"}\uFF1B\u53EF\u7528\u89D2\u8272\uFF1A` + (value?.personas ?? []).map((p) => `${p.id}\uFF08${p.name}\uFF09`).join("\u3001")
          }
        ]
      },
      async execute() {
        return { active: getActiveId(), personas: listPersonas(personasRoot) };
      },
      presentCall() {
        return { card: "generic", title: "list_personas", kind: "read" };
      }
    };
    mood = loadMood();
    refreshMoodSection();
    console.log(`${LOG_TAG} \u5FC3\u60C5\u5F15\u64CE\u5DF2\u5C31\u7EEA\uFF08${moodLabel(mood)}\uFF0C\u7CBE\u529B ${Math.round(mood.energy)}%\uFF09\uFF1A${moodFile}`);
    let lastUserText = "";
    try {
      ctx.on("agent/request", async (payload, next) => {
        try {
          const origin = payload?.agent?.session?.header?.origin;
          if (origin !== "subagent") {
            const text = extractLastUserText(payload);
            if (text && text !== lastUserText) {
              lastUserText = text;
              tickMood(text);
            } else {
              mood = applyDecay(mood, Date.now());
              saveMood();
            }
          }
        } catch (e) {
          console.error(`${LOG_TAG} \u5FC3\u60C5\u63A8\u8FDB\u5931\u8D25\uFF08\u5DF2\u5FFD\u7565\uFF09\uFF1A${e.message}`);
        }
        return next();
      });
    } catch (e) {
      console.error(`${LOG_TAG} \u5FC3\u60C5\u94A9\u5B50\u6CE8\u518C\u5931\u8D25\uFF08\u60C5\u7EEA\u4E0D\u518D\u81EA\u52A8\u63A8\u8FDB\uFF09\uFF1A${e.message}`);
    }
    for (const t of [switchTool, listTool, moodStatusTool, setMoodTool]) {
      try {
        const d = ctx.tools.register(t);
        if (typeof d === "function") disposers.push(d);
        console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 ${t.name}`);
      } catch (e) {
        console.error(`${LOG_TAG} \u6CE8\u518C\u5DE5\u5177 ${t.name} \u5931\u8D25\uFF1A`, e);
      }
    }
    ctx.on("dispose", () => {
      stopEnvClock();
      if (guideTimer) clearTimeout(guideTimer);
      if (sectionDispose) {
        try {
          sectionDispose();
        } catch {
        }
      }
      if (moodSectionDispose) {
        try {
          moodSectionDispose();
        } catch {
        }
      }
      for (const d of disposers) {
        try {
          d();
        } catch {
        }
      }
      console.log(`${LOG_TAG} disposed`);
    });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
