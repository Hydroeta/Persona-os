// src/index.ts
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
var LOG_TAG = "[dsh-persona-core]";
var LOCAL_FALLBACK_ROOTS = [];
var SECTION_ORDER = 100;
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
    console.log(`${LOG_TAG} personas root = ${personasRoot}`);
    let currentId = "";
    let sectionDispose = null;
    let guideTimer = null;
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
    for (const t of [switchTool, listTool]) {
      try {
        const d = ctx.tools.register(t);
        if (typeof d === "function") disposers.push(d);
        console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 ${t.name}`);
      } catch (e) {
        console.error(`${LOG_TAG} \u6CE8\u518C\u5DE5\u5177 ${t.name} \u5931\u8D25\uFF1A`, e);
      }
    }
    ctx.on("dispose", () => {
      if (guideTimer) clearTimeout(guideTimer);
      if (sectionDispose) {
        try {
          sectionDispose();
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
