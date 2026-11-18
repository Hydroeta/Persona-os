import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/persona.ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
function findRepoRoot(start) {
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
function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
function listExpressions(dirAbs, prefix) {
  try {
    if (!existsSync(dirAbs)) return [];
    return readdirSync(dirAbs).filter((f) => f.toLowerCase().endsWith(".png") && f.startsWith(prefix)).map((f) => f.slice(prefix.length).replace(/\.png$/i, "")).filter((n) => n && n !== "avatar").sort();
  } catch {
    return [];
  }
}
function loadPanelPersona(opts = {}) {
  const root = opts.osRoot || findRepoRoot();
  const personasDir = join(root, "config", "personas");
  let id = opts.personaId || "";
  if (!id) {
    const act = readJsonSafe(join(personasDir, "active.json"));
    if (act && typeof act.active_id === "string" && act.active_id) id = act.active_id;
  }
  if (!id) {
    try {
      id = readdirSync(personasDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()[0] || "ohwhale";
    } catch {
      id = "ohwhale";
    }
  }
  const persona = readJsonSafe(join(personasDir, id, "persona.json"));
  const assets = persona?.assets && typeof persona.assets === "object" ? persona.assets : {};
  const identity = persona?.identity && typeof persona.identity === "object" ? persona.identity : {};
  const exprDirRel = String(assets.expr_dir || "plugins/dsh-control-center/web/assets/expr");
  const prefix = String(assets.expr_prefix || "pixel_");
  const exprDirAbs = isAbsolute(exprDirRel) ? exprDirRel : resolve(root, exprDirRel);
  return {
    id,
    displayName: String(assets.display_name || identity.self_name || id),
    exprUrlBase: "/persona-expr",
    exprDirAbs,
    exprPrefix: prefix,
    themeColor: String(assets.theme_color || "#00F0FF"),
    themeSea: String(assets.theme_sea || "#5BC0BE"),
    expressions: listExpressions(exprDirAbs, prefix)
  };
}
export {
  findRepoRoot,
  listExpressions,
  loadPanelPersona
};
//# sourceMappingURL=persona.js.map
