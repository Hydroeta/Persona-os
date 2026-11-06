import { createRequire } from 'module';import { fileURLToPath as __bannerFileURLToPath } from 'url';import { dirname as __bannerDirname } from 'path';const require = createRequire(import.meta.url);const __filename = __bannerFileURLToPath(import.meta.url);const __dirname = __bannerDirname(__filename);

// src/game.ts
var LOG_TAG = "[dsh-game-agent]";
var ALLOWED_DIRECTIONS = /* @__PURE__ */ new Set(["forward", "backward", "left", "right"]);
var ALLOWED_BUTTONS = /* @__PURE__ */ new Set([
  "a",
  "b",
  "x",
  "y",
  "lb",
  "rb",
  "start",
  "back",
  "l3",
  "r3",
  "dpad_up",
  "dpad_down",
  "dpad_left",
  "dpad_right",
  "guide"
]);
var ALLOWED_TYPES = /* @__PURE__ */ new Set(["move", "press", "release", "reset"]);
function clampDuration(v) {
  const n = typeof v === "number" && isFinite(v) ? v : typeof v === "string" ? Number(v) : NaN;
  if (!isFinite(n)) return void 0;
  return Math.min(10, Math.max(0, n));
}
function buildGamePrompt(goal) {
  const g = String(goal ?? "").trim();
  return `\u4F60\u73B0\u5728\u5728\u73A9 PC \u6E38\u620F\uFF0C\u4F60\u7684\u76EE\u6807\u662F ${g || "\uFF08\u672A\u6307\u5B9A\uFF09"}\u3002\u6839\u636E\u753B\u9762\uFF0C\u4F60\u4E0B\u4E00\u6B65\u5E94\u8BE5\u505A\u4EC0\u4E48\u5B8F\u89C2\u52A8\u4F5C\uFF1F\uFF08\u5982\u4E00\u76F4\u5411\u524D\u8DD1\u3001\u6309 A \u8DF3\u8DC3\u3001\u6309 B \u4EA4\u4E92\uFF09

\u8BF7\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u4ED6\u6587\u5B57\u3001\u89E3\u91CA\u6216 markdown \u4EE3\u7801\u5757\u6807\u8BB0\u3002\u53EF\u9009\u683C\u5F0F\uFF1A
- \u79FB\u52A8\u6447\u6746\uFF1A{"type":"move","direction":"forward","duration":1.0}
  direction \u53EA\u80FD\u662F forward / backward / left / right\uFF1Bduration \u4E3A\u4FDD\u6301\u79D2\u6570\uFF080~10\uFF0C\u53EF\u4E0D\u586B\uFF09
- \u6309\u6309\u952E\uFF1A{"type":"press","button":"A","duration":0.2}
  button \u53EA\u80FD\u662F A / B / X / Y / LB / RB / start / back / L3 / R3 / dpad_up / dpad_down / dpad_left / dpad_right / guide
- \u677E\u5F00\u6309\u952E\uFF1A{"type":"release","button":"A"}
- \u590D\u4F4D\uFF1A{"type":"reset"}
\u5982\u679C\u753B\u9762\u91CC\u6682\u65F6\u4E0D\u9700\u8981\u64CD\u4F5C\uFF0C\u8F93\u51FA {"type":"reset"}\u3002`;
}
async function captureScreen(timeoutMs) {
  let mod;
  try {
    mod = await import("node-screenshots");
  } catch (e) {
    console.warn(`${LOG_TAG} node-screenshots \u52A0\u8F7D\u5931\u8D25\uFF08\u964D\u7EA7\uFF09\uFF1A${e.message}`);
    return null;
  }
  const Monitor = mod?.Monitor || mod?.default?.Monitor;
  if (typeof Monitor?.all !== "function") {
    console.warn(`${LOG_TAG} node-screenshots \u5BFC\u51FA\u5F02\u5E38\uFF08\u65E0 Monitor.all\uFF09\uFF0C\u964D\u7EA7`);
    return null;
  }
  try {
    const monitors = Monitor.all();
    if (!Array.isArray(monitors) || monitors.length === 0) return null;
    const primary = monitors.find((m) => typeof m?.isPrimary === "function" && m.isPrimary()) || monitors[0];
    const image = await Promise.race([
      primary.captureImage(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("\u622A\u5C4F\u8D85\u65F6")), timeoutMs))
    ]);
    const buf = await image.toJpeg();
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  } catch (e) {
    console.warn(`${LOG_TAG} \u622A\u5C4F\u5931\u8D25/\u964D\u7EA7\uFF1A${e.message}`);
    return null;
  }
}
function createVisionClient(opts = {}) {
  const apiBase = (opts.apiBase ?? process.env.VISION_API_BASE ?? "").replace(/\/$/, "");
  const apiKey = opts.apiKey ?? process.env.VISION_API_KEY ?? "";
  const model = opts.model ?? process.env.VISION_MODEL ?? "glm-4v";
  const timeoutMs = opts.timeoutMs ?? 15e3;
  return {
    async decide(base64Img, userPrompt) {
      if (!apiBase || !apiKey) {
        return "";
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(`${apiBase}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: userPrompt },
                  { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Img}` } }
                ]
              }
            ],
            max_tokens: 200,
            temperature: 0.2
          }),
          signal: ctrl.signal
        });
        const data = await r.json().catch(() => ({}));
        return String(data?.choices?.[0]?.message?.content ?? "").trim();
      } catch (e) {
        console.warn(`${LOG_TAG} \u89C6\u89C9\u8C03\u7528\u5931\u8D25\uFF08\u964D\u7EA7\u4E3A\u7A7A\uFF09\uFF1A${e.message}`);
        return "";
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
function extractJsonObject(raw) {
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}
function normalizeAction(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed;
  const t = String(o.type ?? "").trim().toLowerCase();
  if (!ALLOWED_TYPES.has(t)) return null;
  const type = t;
  if (type === "reset") {
    return { type: "reset" };
  }
  if (type === "move") {
    const dir = String(o.direction ?? "").trim().toLowerCase();
    if (!ALLOWED_DIRECTIONS.has(dir)) return null;
    const duration = clampDuration(o.duration);
    const out2 = { type: "move", direction: dir };
    if (duration !== void 0) out2.duration = duration;
    return out2;
  }
  const btn = String(o.button ?? "").trim().toLowerCase();
  if (!ALLOWED_BUTTONS.has(btn)) return null;
  const out = { type, button: btn };
  if (type === "press") {
    const duration = clampDuration(o.duration);
    if (duration !== void 0) out.duration = duration;
  }
  return out;
}
function extractAction(raw) {
  return normalizeAction(extractJsonObject(raw));
}
async function forwardAction(action, url, timeoutMs) {
  const base = url.replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(`${base}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  const text = await r.text().catch(() => "");
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const err = data?.detail?.error || data?.error || `HTTP ${r.status}`;
    throw new Error(`game-bot \u62D2\u7EDD\u6267\u884C\uFF1A${err}`);
  }
  return data;
}
function isOfflineError(msg) {
  return /abort|timeout|fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|network|连接被拒绝|连接超时/i.test(msg);
}
async function playGameStep(opts) {
  const goal = String(opts.goal ?? "").trim();
  const dryRun = opts.dry_run !== false;
  const gameBotUrl = opts.game_bot_url || process.env.GAME_BOT_URL || "http://127.0.0.1:8003";
  const captureTimeoutMs = opts.captureTimeoutMs ?? 2e3;
  const visionTimeoutMs = opts.visionTimeoutMs ?? 15e3;
  const forwardTimeoutMs = opts.forwardTimeoutMs ?? 4e3;
  const captureFn = opts.captureFn ?? (() => captureScreen(captureTimeoutMs));
  const vision = opts.visionClient ?? createVisionClient({
    apiBase: opts.visionApiBase,
    apiKey: opts.visionApiKey,
    model: opts.visionModel,
    timeoutMs: visionTimeoutMs
  });
  const forward = opts.forwardFn ?? forwardAction;
  let buf = null;
  try {
    const cap = await captureFn();
    buf = Buffer.isBuffer(cap) ? cap : null;
  } catch {
    buf = null;
  }
  if (!buf || buf.length === 0) {
    return { ok: false, reason: "\u622A\u5C4F\u5931\u8D25\uFF08node-screenshots \u672A\u5B89\u88C5\u6216\u622A\u5C4F\u8D85\u65F6\uFF09", goal, dry_run: dryRun, screenshot_bytes: 0 };
  }
  let rawVlm = "";
  try {
    rawVlm = await vision.decide(buf.toString("base64"), buildGamePrompt(goal));
  } catch (e) {
    return {
      ok: false,
      reason: `\u89C6\u89C9\u8C03\u7528\u5F02\u5E38\uFF1A${e.message}`,
      goal,
      dry_run: dryRun,
      screenshot_bytes: buf.length
    };
  }
  if (!rawVlm) {
    const configured = !!(opts.visionApiBase ?? process.env.VISION_API_BASE) && !!(opts.visionApiKey ?? process.env.VISION_API_KEY);
    return {
      ok: false,
      reason: configured ? "VLM \u672A\u8FD4\u56DE\u5185\u5BB9\uFF08\u79BB\u7EBF\u6216\u8D85\u65F6\uFF09" : "\u89C6\u89C9\u6A21\u578B\u672A\u914D\u7F6E\uFF08\u8BF7\u8BBE\u7F6E VISION_API_BASE / VISION_API_KEY\uFF09",
      goal,
      dry_run: dryRun,
      screenshot_bytes: buf.length,
      raw_vlm: ""
    };
  }
  const action = extractAction(rawVlm);
  if (!action) {
    return {
      ok: false,
      reason: "VLM \u8FD4\u56DE\u5185\u5BB9\u65E0\u6CD5\u89E3\u6790\u4E3A\u5408\u6CD5\u52A8\u4F5C JSON",
      goal,
      dry_run: dryRun,
      screenshot_bytes: buf.length,
      raw_vlm: rawVlm,
      action: null
    };
  }
  if (dryRun) {
    return {
      ok: true,
      reason: "dry_run\uFF1A\u4EC5\u8FD4\u56DE\u51B3\u7B56\u52A8\u4F5C\uFF0C\u672A\u8F6C\u53D1\u7ED9 game-bot",
      goal,
      dry_run: true,
      action,
      raw_vlm: rawVlm,
      executed: false,
      screenshot_bytes: buf.length
    };
  }
  try {
    const resp = await forward(action, gameBotUrl, forwardTimeoutMs);
    return {
      ok: true,
      reason: "\u52A8\u4F5C\u5DF2\u8F6C\u53D1 game-bot \u6267\u884C",
      goal,
      dry_run: false,
      action,
      raw_vlm: rawVlm,
      executed: true,
      game_bot_response: resp,
      screenshot_bytes: buf.length
    };
  } catch (e) {
    const msg = e?.message ?? String(e);
    return {
      ok: false,
      reason: isOfflineError(msg) ? "game-bot \u79BB\u7EBF" : `game-bot \u6267\u884C\u5931\u8D25\uFF1A${msg}`,
      goal,
      dry_run: false,
      action,
      raw_vlm: rawVlm,
      executed: false,
      screenshot_bytes: buf.length
    };
  }
}

// src/index.ts
var LOG_TAG2 = "[dsh-game-agent]";
function actionSummary(value) {
  const a = value.action;
  if (!a) return "\uFF08\u65E0\u5408\u6CD5\u52A8\u4F5C\uFF09";
  if (a.type === "move") return `move ${a.direction}${a.duration != null ? ` ${a.duration}s` : ""}`;
  if (a.type === "press") return `press ${a.button}${a.duration != null ? ` ${a.duration}s` : ""}`;
  if (a.type === "release") return `release ${a.button}`;
  return "reset";
}
var tool = {
  name: "play_game_step",
  description: "\u901A\u7528\u6E38\u620F\u4EE3\u7406\uFF1A\u622A\u53D6\u5F53\u524D\u5C4F\u5E55 \u2192 \u591A\u6A21\u6001 VLM \u6839\u636E\u76EE\u6807\u51B3\u7B56\u4E0B\u4E00\u6B65\u5B8F\u89C2\u52A8\u4F5C \u2192 \u8F6C\u53D1\u7ED9 game-bot \u865A\u62DF\u624B\u67C4\u5FAE\u670D\u52A1\uFF08:8003\uFF09\u6267\u884C\u3002\u9ED8\u8BA4 dry_run=true\uFF1A\u53EA\u8FD4\u56DE\u51B3\u7B56\u52A8\u4F5C\u9884\u89C8\uFF0C\u4E0D\u5B9E\u9645\u64CD\u4F5C\u624B\u67C4\uFF08\u5B89\u5168\uFF09\uFF1B\u4F20 dry_run=false \u624D\u771F\u6B63\u6267\u884C\u4E00\u6B65\u3002\u6BCF\u6B21\u8C03\u7528\u53EA\u6267\u884C\u4E00\u6B65\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u5FAA\u73AF\u3002",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["goal"],
    properties: {
      goal: {
        type: "string",
        description: '\u6E38\u620F\u76EE\u6807\uFF0C\u4F8B\u5982"\u5411\u524D\u8D70\u5230\u4F20\u9001\u9635"\u3001"\u8DF3\u4E0A\u5E73\u53F0"\u3001"\u548C NPC \u5BF9\u8BDD"'
      },
      dry_run: {
        type: "boolean",
        default: true,
        description: "true=\u53EA\u9884\u89C8\u51B3\u7B56\u52A8\u4F5C\u4E0D\u64CD\u4F5C\u624B\u67C4\uFF08\u9ED8\u8BA4\uFF0C\u5B89\u5168\uFF09\uFF1Bfalse=\u5B9E\u9645\u6267\u884C\u4E00\u6B65"
      },
      game_bot_url: {
        type: "string",
        description: "\u8986\u76D6 game-bot \u5730\u5740\uFF0C\u9ED8\u8BA4 http://127.0.0.1:8003"
      }
    }
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        reason: { type: "string" },
        goal: { type: "string" },
        dry_run: { type: "boolean" },
        executed: { type: "boolean" },
        action: { type: "object" },
        raw_vlm: { type: "string" },
        screenshot_bytes: { type: "integer" }
      }
    },
    render: (_args, value) => {
      const v = value ?? {};
      const lines = [];
      if (v.ok) {
        lines.push(`\u{1F3AE} \u6E38\u620F\u4EE3\u7406\uFF1A${v.reason ?? ""}`);
        lines.push(`\u76EE\u6807\uFF1A${v.goal ?? ""}`);
        lines.push(`\u51B3\u7B56\u52A8\u4F5C\uFF1A${actionSummary(v)}`);
        if (v.executed) lines.push("\u2705 \u5DF2\u8F6C\u53D1 game-bot \u6267\u884C");
        else if (v.dry_run) lines.push("\uFF08dry_run\uFF1A\u672A\u5B9E\u9645\u6267\u884C\uFF09");
      } else {
        lines.push(`\u26A0\uFE0F \u6E38\u620F\u4EE3\u7406\u672A\u6267\u884C\uFF1A${v.reason ?? "\u672A\u77E5"}`);
        if (v.goal) lines.push(`\u76EE\u6807\uFF1A${v.goal}`);
      }
      return [{ type: "text", text: lines.join("\n") }];
    }
  },
  async execute(args) {
    return await playGameStep({
      goal: typeof args?.goal === "string" ? args.goal : "",
      dry_run: args?.dry_run !== false,
      game_bot_url: typeof args?.game_bot_url === "string" ? args.game_bot_url : void 0
    });
  },
  presentCall(args) {
    const exec = args?.dry_run === false;
    return {
      card: "generic",
      title: `play_game_step${exec ? "\uFF08\u6267\u884C\uFF09" : "\uFF08\u9884\u89C8\uFF09"}`,
      kind: exec ? "write" : "read"
    };
  }
};
var index_default = {
  name: "dsh-game-agent",
  apply(ctx) {
    console.log(`${LOG_TAG2} apply`);
    const disposers = [];
    try {
      const d = ctx.tools.register(tool);
      if (typeof d === "function") disposers.push(d);
      console.log(`${LOG_TAG2} \u5DF2\u6CE8\u518C\u5DE5\u5177 play_game_step`);
    } catch (e) {
      console.error(`${LOG_TAG2} \u6CE8\u518C\u5DE5\u5177 play_game_step \u5931\u8D25\uFF1A`, e);
    }
    ctx.on("dispose", () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
        }
      }
      console.log(`${LOG_TAG2} disposed`);
    });
  }
};
export {
  buildGamePrompt,
  captureScreen,
  createVisionClient,
  index_default as default,
  extractAction,
  extractJsonObject,
  forwardAction,
  normalizeAction,
  playGameStep
};
//# sourceMappingURL=index.js.map
