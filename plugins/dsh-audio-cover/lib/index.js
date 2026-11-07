// src/index.ts
var LOG_TAG = "[dsh-audio-cover]";
if (!process.env.AUDIO_COVER_URL) process.env.AUDIO_COVER_URL = "http://127.0.0.1:8005";
var BASE_URL = (process.env.AUDIO_COVER_URL || "http://127.0.0.1:8005").replace(/\/$/, "");
async function call(path, body) {
  const url = `${BASE_URL}${path}`;
  const init = body === void 0 ? { method: "GET" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  let r;
  try {
    r = await fetch(url, init);
  } catch (e) {
    throw new Error(`\u8FDE\u4E0D\u4E0A audio-cover \u5FAE\u670D\u52A1 ${BASE_URL}\uFF08\u5148\u786E\u8BA4\u5B83\u5DF2\u542F\u52A8\uFF09\uFF1A${e?.message || e}`);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const detail = data?.detail || data?.error || text || r.statusText;
    throw new Error(`audio-cover \u8FD4\u56DE ${r.status}\uFF1A${detail}`);
  }
  return data;
}
var tools = [
  {
    name: "toggle_live_cover",
    description: "\u5B9E\u65F6 AI \u7FFB\u5531\uFF08SVC\uFF09\u5F00\u5173\u3002start \u8BA9 audio-cover \u5FAE\u670D\u52A1\u6253\u5F00\u300C\u8F93\u5165\u8BBE\u5907 \u2192 \u53D8\u58F0 \u2192 \u8F93\u51FA\u8BBE\u5907\u300D\u7684\u97F3\u9891\u6D41\uFF1Bstop \u91CA\u653E\u97F3\u9891\u6D41\u3002mode=bypass \u4E3A\u76F4\u901A\uFF08\u9A8C\u8BC1\u8DEF\u7531\uFF09\uFF0Cmode=tone \u8F93\u51FA\u6B63\u5F26\u6D4B\u8BD5\u97F3\uFF08\u9A8C\u8BC1\u8F93\u51FA\u94FE\u8DEF\uFF09\u3002\u9700\u8981\u5B9E\u65F6\u628A\u6B4C\u58F0\u53D8\u6210\u89D2\u8272\u97F3\u8272\u65F6\uFF0C\u914D\u5408 VB-CABLE \u7B49\u865A\u62DF\u58F0\u5361\u4F7F\u7528\u3002",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "status", "devices"], description: "\u8981\u6267\u884C\u7684\u52A8\u4F5C" },
        input_device: { type: "string", description: '\u8F93\u5165\u8BBE\u5907\u540D\u6216\u7D22\u5F15\uFF08\u5982 "CABLE Output (VB-Audio Virtual Cable)"\uFF09\uFF0Cstart \u65F6\u7528' },
        output_device: { type: "string", description: "\u8F93\u51FA\u8BBE\u5907\u540D\u6216\u7D22\u5F15\uFF0C\u7559\u7A7A\u4E3A\u7CFB\u7EDF\u9ED8\u8BA4" },
        pitch: { type: "integer", description: "\u53D8\u8C03\u534A\u97F3\uFF0CRVC \u63A5\u5165\u540E\u751F\u6548\uFF0C\u9ED8\u8BA4 0" },
        mode: { type: "string", enum: ["bypass", "tone"], description: "bypass \u76F4\u901A / tone \u6B63\u5F26\u6D4B\u8BD5\uFF0C\u9ED8\u8BA4 bypass" },
        gain: { type: "number", description: "\u76F4\u901A\u589E\u76CA\uFF0C\u9ED8\u8BA4 1.0" }
      },
      required: ["action"]
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          action: { type: "string" },
          state: { type: "object" },
          count: { type: "integer" },
          devices: { type: "array" }
        }
      },
      render: (_args, value) => {
        const a = String(value?.action || "");
        if (a === "devices") {
          const list = Array.isArray(value?.devices) ? value.devices : [];
          const lines = list.filter((d) => d.in > 0 || d.out > 0).slice(0, 24).map((d) => `[${d.index}] in=${d.in} out=${d.out} ${d.name}`);
          return [{ type: "text", text: `\u97F3\u9891\u8BBE\u5907 ${value?.count ?? list.length} \u4E2A\uFF1A
` + lines.join("\n") }];
        }
        const s = value?.state || {};
        const text = a === "status" ? `\u7FFB\u5531\u670D\u52A1\uFF1Arunning=${s.running} mode=${s.mode} frames=${s.frames} \u79D2=${s.seconds} \u9519\u8BEF=${s.last_error ?? "\u65E0"}` : `\u7FFB\u5531${a === "start" ? "\u5DF2\u542F\u52A8" : "\u5DF2\u505C\u6B62"}\uFF1Arunning=${s.running} mode=${s.mode}`;
        return [{ type: "text", text }];
      }
    },
    async execute(args) {
      const action = String(args?.action || "").toLowerCase();
      if (action === "start") {
        const body = {
          input_device: args?.input_device ?? null,
          output_device: args?.output_device ?? null,
          pitch: Number.isInteger(args?.pitch) ? args.pitch : 0,
          mode: args?.mode === "tone" ? "tone" : "bypass",
          gain: typeof args?.gain === "number" ? args.gain : 1
        };
        const res2 = await call("/start", body);
        console.log(`${LOG_TAG} start -> running=${res2?.running} mode=${res2?.mode}`);
        return { ok: true, action: "start", state: res2 };
      }
      if (action === "stop") {
        const res2 = await call("/stop", {});
        console.log(`${LOG_TAG} stop -> running=${res2?.running}`);
        return { ok: true, action: "stop", state: res2 };
      }
      if (action === "devices") {
        const res2 = await call("/devices");
        return { ok: true, action: "devices", count: res2?.count, devices: res2?.devices };
      }
      const res = await call("/health");
      return { ok: true, action: "status", state: res };
    },
    presentCall(args) {
      const a = String(args?.action || "").toLowerCase();
      return {
        card: "generic",
        title: `toggle_live_cover: ${a}`,
        kind: a === "start" || a === "stop" ? "write" : "read"
      };
    }
  }
];
var index_default = {
  name: "dsh-audio-cover",
  // cordis 依赖注入：不声明 inject 时访问 ctx.tools 会抛 cannot get property "tools" without inject
  inject: ["tools"],
  apply(ctx) {
    console.log(`${LOG_TAG} apply (base=${BASE_URL})`);
    const disposers = [];
    for (const t of tools) {
      try {
        const d = ctx.tools.register(t);
        if (typeof d === "function") disposers.push(d);
        console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 ${t.name}`);
      } catch (e) {
        console.error(`${LOG_TAG} \u6CE8\u518C\u5DE5\u5177 ${t.name} \u5931\u8D25\uFF1A`, e);
      }
    }
    ctx.on("dispose", () => {
      console.log(`${LOG_TAG} dispose\uFF1A\u6CE8\u9500 ${disposers.length} \u4E2A\u5DE5\u5177`);
      for (const d of disposers) {
        try {
          d();
        } catch {
        }
      }
    });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
