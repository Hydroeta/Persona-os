// src/persona-assets.ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
var LOG_TAG = "[dsh-persona-core/assets]";
function findOsRoot(start) {
  const env = process.env.PERSONA_OS_ROOT;
  if (env && existsSync(env)) return resolve(env);
  let cur = resolve(start || process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, "config", "personas"))) return cur;
    const up = resolve(cur, "..");
    if (up === cur) break;
    cur = up;
  }
  return process.cwd();
}
function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
function readActivePersonaId(root) {
  const p = join(root, "config", "personas", "active.json");
  const j = readJson(p);
  if (j && typeof j.active_id === "string" && j.active_id) return j.active_id;
  try {
    const list = readdirSync(join(root, "config", "personas"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    return list[0] || "ohwhale";
  } catch {
    return "ohwhale";
  }
}
function resolveInRoot(root, p) {
  if (!p) return "";
  return isAbsolute(p) ? p : resolve(root, p.replace(/\\/g, "/"));
}
function resolveExisting(root, p, maxUp = 3) {
  if (!p) return "";
  const first = resolveInRoot(root, p);
  if (isAbsolute(p)) return first;
  if (existsSync(first)) return first;
  let base = root;
  for (let i = 0; i < maxUp; i++) {
    base = resolve(base, "..");
    const cand = resolveInRoot(base, p);
    if (existsSync(cand)) return cand;
  }
  return first;
}
function loadPersonaAssets(opts = {}) {
  const root = opts.osRoot || findOsRoot();
  const id = opts.personaId || readActivePersonaId(root);
  const personaPath = join(root, "config", "personas", id, "persona.json");
  const p = readJson(personaPath);
  if (!p) {
    console.error(`${LOG_TAG} \u8BFB\u4E0D\u5230 ${personaPath}\uFF0C\u7528\u9ED8\u8BA4\u8D44\u4EA7\uFF08id=${id}\uFF09`);
  }
  const assets = p?.assets && typeof p.assets === "object" ? p.assets : {};
  const voice = p?.voice && typeof p.voice === "object" ? p.voice : {};
  const identity = p?.identity && typeof p.identity === "object" ? p.identity : {};
  const exprDirRel = String(assets.expr_dir || "plugins/dsh-control-center/web/assets/expr");
  const refRel = String(voice.ref_audio || "");
  const out = {
    id,
    displayName: String(assets.display_name || identity.self_name || id),
    exprDir: resolveInRoot(root, exprDirRel),
    exprPrefix: String(assets.expr_prefix || "pixel_"),
    themeColor: String(assets.theme_color || "#00F0FF"),
    themeSea: String(assets.theme_sea || "#5BC0BE"),
    ttsRefAudio: refRel ? resolveExisting(root, refRel) : "",
    raw: assets
  };
  return out;
}
function safeId(id) {
  return String(id || "default").replace(/[^\w.-]+/g, "_");
}
var __testing = { LOG_TAG };
export {
  __testing,
  findOsRoot,
  loadPersonaAssets,
  readActivePersonaId,
  resolveExisting,
  resolveInRoot,
  safeId
};
//# sourceMappingURL=persona-assets.js.map
