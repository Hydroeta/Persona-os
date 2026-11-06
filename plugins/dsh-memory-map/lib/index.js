// src/index.ts
import { mkdirSync, existsSync, renameSync, readFileSync, statSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
var LOG_TAG = "[dsh-memory-map]";
var HERE = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.MEMORY_BUS_URL) process.env.MEMORY_BUS_URL = "http://127.0.0.1:8001";
var MEMORY_BUS_URL = process.env.MEMORY_BUS_URL.replace(/\/$/, "");
var LOCAL_FALLBACK_ROOTS = ["c:\\Users\\user\\Desktop\\\u65B0\u5EFA\u6587\u4EF6\u5939 (2)"];
function hash32(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h << 5) + h + s.charCodeAt(i) >>> 0;
  return h;
}
function hash01(s) {
  let h = hash32(s);
  h = (h ^ h >>> 16) >>> 0;
  h = Math.imul(h, 2246822507) >>> 0;
  h = (h ^ h >>> 13) >>> 0;
  h = Math.imul(h, 3266489909) >>> 0;
  h = (h ^ h >>> 16) >>> 0;
  return h / 4294967296;
}
function walkUpForMarker(marker, maxUp = 8) {
  let cur = path.resolve(HERE, "..", "..", "..");
  for (let i = 0; i < maxUp; i++) {
    if (existsSync(path.join(cur, marker))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
function findReleaseRoot() {
  const marker = path.join("core-services", "memory", "main.py");
  const envRoot = process.env.PERSONA_OS_ROOT;
  if (envRoot && existsSync(path.join(envRoot, marker))) return path.resolve(envRoot);
  const found = walkUpForMarker(marker);
  if (found) return found;
  for (const root of LOCAL_FALLBACK_ROOTS) {
    if (existsSync(path.join(root, marker))) return path.resolve(root);
    const inRelease = path.join(root, "github-release", "persona-os");
    if (existsSync(path.join(inRelease, marker))) return inRelease;
  }
  return null;
}
function resolveOutPath() {
  if (process.env.MEMORY_MAP_OUT) return path.resolve(process.env.MEMORY_MAP_OUT);
  const root = findReleaseRoot();
  const base = root || LOCAL_FALLBACK_ROOTS[0];
  return path.join(base, "data", "memory_constellation.json");
}
function excerpt(content, n = 120) {
  const s = (content || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "\u2026" : s;
}
function normTags(m) {
  const tags = Array.isArray(m.tags) ? m.tags : [];
  return tags.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean);
}
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.max(0, Math.min(255, Math.round(255 * c))).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function clusterHue(clusterId) {
  return hash32("hue|" + clusterId) % 360;
}
function starColor(m, clusterId) {
  const importance = Number.isFinite(m.importance) ? m.importance : 1;
  if (importance >= 4) return "#ffd87a";
  return hslToHex(clusterHue(clusterId), 78, 62);
}
function clusterIdOf(key) {
  return "c_" + hash32("cluster:" + key).toString(16).padStart(8, "0");
}
function representativeTag(m, freq) {
  const tags = Array.from(new Set(normTags(m))).sort();
  if (tags.length > 0) {
    let best = tags[0];
    let bestF = freq.get(tags[0]) || 0;
    for (let i = 1; i < tags.length; i++) {
      const f = freq.get(tags[i]) || 0;
      if (f > bestF) {
        bestF = f;
        best = tags[i];
      }
    }
    return { key: best, tags: [best], label: best };
  }
  const level = m.level || "fact";
  return { key: `__level__:${level}`, tags: [], label: `\u672A\u5206\u7C7B\xB7${level}` };
}
function assignClusters(rows) {
  const freq = /* @__PURE__ */ new Map();
  for (const m of rows) for (const t of normTags(m)) freq.set(t, (freq.get(t) || 0) + 1);
  const counts = /* @__PURE__ */ new Map();
  const base = /* @__PURE__ */ new Map();
  for (const m of rows) {
    const r = representativeTag(m, freq);
    base.set(m.id, r);
    counts.set(r.key, (counts.get(r.key) || 0) + 1);
  }
  const MERGE_KEY = "__other__";
  const finalKey = /* @__PURE__ */ new Map();
  if (counts.size > 15) {
    const keep = new Set(
      [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k]) => k)
    );
    for (const k of counts.keys()) finalKey.set(k, keep.has(k) ? k : MERGE_KEY);
  } else {
    for (const k of counts.keys()) finalKey.set(k, k);
  }
  const out = /* @__PURE__ */ new Map();
  for (const m of rows) {
    const b = base.get(m.id);
    const fk = finalKey.get(b.key) || b.key;
    out.set(m.id, {
      cid: clusterIdOf(fk),
      key: fk,
      label: fk === MERGE_KEY ? "\u5176\u4ED6\u8BB0\u5FC6" : b.label,
      tags: fk === MERGE_KEY ? [] : b.tags
    });
  }
  return out;
}
function centerFor(clusterId, count) {
  const u = hash01(clusterId + "|cu");
  const t = hash01(clusterId + "|ct");
  const baseR = 300 + Math.sqrt(Math.max(1, count)) * 26;
  const r = baseR * (0.45 + 0.55 * Math.sqrt(t));
  const phi = u * Math.PI * 2 + Math.sqrt(t) * 1.6;
  const y = (hash01(clusterId + "|cy") * 2 - 1) * 55;
  return {
    x: +(Math.cos(phi) * r).toFixed(2),
    y: +y.toFixed(2),
    z: +(Math.sin(phi) * r).toFixed(2)
  };
}
function diskOffset(memoryId, clusterR) {
  const t = hash01(memoryId + "|t");
  const arm = Math.floor(hash01(memoryId + "|arm") * 3);
  const armOffset = arm / 3 * Math.PI * 2;
  const radius = clusterR * Math.sqrt(t);
  const angle = armOffset + 4.5 * t + hash01(memoryId + "|j") * 0.6;
  const lx = radius * Math.cos(angle);
  const ly = radius * Math.sin(angle);
  const lz = (hash01(memoryId + "|z") * 2 - 1) * clusterR * 0.32;
  return { lx, ly, lz };
}
function starFor(m, clusterId, center, clusterCount) {
  const clusterR = 16 + Math.sqrt(Math.max(1, clusterCount)) * 6.5;
  const { lx, ly, lz } = diskOffset(m.id, clusterR);
  const clen = (m.content || "").length;
  const importance = Number.isFinite(m.importance) ? m.importance : 1;
  const size = Math.min(20, Math.max(3, 3 + importance * 1.5 + Math.log10(1 + clen) * 1.2));
  return {
    memory_id: m.id,
    cluster_id: clusterId,
    x: +(center.x + lx).toFixed(2),
    y: +(center.y + ly).toFixed(2),
    z: +(center.z + lz).toFixed(2),
    size: +size.toFixed(2),
    color: starColor(m, clusterId),
    title: (m.title || "").slice(0, 60),
    text: excerpt(m.content, 120),
    level: m.level || "fact",
    importance,
    created_at: m.created_at || 0
  };
}
async function fetchRecent(days, limit) {
  const url = `${MEMORY_BUS_URL}/recent?days=${days}&limit=${limit}`;
  const r = await fetch(url);
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) throw new Error(`memory /recent \u8FD4\u56DE ${r.status}: ${text || r.statusText}`);
  const results = Array.isArray(data?.results) ? data.results : [];
  return results;
}
async function loadSnapshot(p) {
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.stars) || !Array.isArray(obj.clusters)) return null;
    return obj;
  } catch {
    return null;
  }
}
async function atomicWriteJson(p, obj) {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmp, p);
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}
async function runSnapshot(opts) {
  const outPath = resolveOutPath();
  const rows = await fetchRecent(opts.days, opts.limit);
  const loaded = opts.rebuild ? null : await loadSnapshot(outPath);
  const existing = loaded && loaded.schema_version === 3 ? loaded : null;
  const stars = existing ? [...existing.stars] : [];
  const assigned = new Set(stars.map((s) => s.memory_id));
  const centers = /* @__PURE__ */ new Map();
  if (existing) for (const c of existing.clusters) centers.set(c.cluster_id, c.center);
  const assignment = assignClusters(rows);
  const clusterCount = /* @__PURE__ */ new Map();
  for (const a of assignment.values()) clusterCount.set(a.cid, (clusterCount.get(a.cid) || 0) + 1);
  let newCount = 0;
  for (const m of rows) {
    if (!m || typeof m.id !== "string") continue;
    if (assigned.has(m.id)) continue;
    const a = assignment.get(m.id);
    if (!a) continue;
    const cid = a.cid;
    if (!centers.has(cid)) centers.set(cid, centerFor(cid, clusterCount.get(cid) || 1));
    const center = centers.get(cid);
    stars.push(starFor(m, cid, center, clusterCount.get(cid) || 1));
    assigned.add(m.id);
    newCount++;
  }
  const counts = /* @__PURE__ */ new Map();
  const meta = /* @__PURE__ */ new Map();
  for (const s of stars) counts.set(s.cluster_id, (counts.get(s.cluster_id) || 0) + 1);
  for (const a of assignment.values()) {
    if (!meta.has(a.cid)) meta.set(a.cid, { label: a.label, tags: a.tags });
  }
  if (existing) {
    for (const c of existing.clusters) {
      if (!meta.has(c.cluster_id)) meta.set(c.cluster_id, { label: c.label, tags: c.tags || [] });
    }
  }
  const clusters = [];
  for (const [cid, cnt] of counts) {
    const freshCenter = centerFor(cid, cnt);
    centers.set(cid, freshCenter);
    const m = meta.get(cid) || { label: cid, tags: [] };
    clusters.push({ cluster_id: cid, label: m.label, tags: m.tags, count: cnt, center: freshCenter });
  }
  clusters.sort((a, b) => b.count - a.count);
  const rowById = /* @__PURE__ */ new Map();
  for (const m of rows) if (m && typeof m.id === "string") rowById.set(m.id, m);
  const clusterById = new Map(clusters.map((c) => [c.cluster_id, c]));
  for (const s of stars) {
    const m = rowById.get(s.memory_id);
    const c = clusterById.get(s.cluster_id);
    if (!m || !c) continue;
    const clusterR = 16 + Math.sqrt(Math.max(1, c.count)) * 6.5;
    const { lx, ly, lz } = diskOffset(m.id, clusterR);
    s.x = +(c.center.x + lx).toFixed(2);
    s.y = +(c.center.y + ly).toFixed(2);
    s.z = +(c.center.z + lz).toFixed(2);
    s.color = starColor(m, c.cluster_id);
    s.title = (m.title || "").slice(0, 60);
    s.text = excerpt(m.content, 120);
  }
  stars.sort((a, b) => b.created_at - a.created_at);
  const generatedAt = Date.now();
  const snapshot = {
    schema_version: 3,
    generated_at: generatedAt,
    days: opts.days,
    limit: opts.limit,
    total_memories: rows.length,
    clusters,
    stars
  };
  await atomicWriteJson(outPath, snapshot);
  return {
    ok: true,
    path: outPath,
    total_memories: rows.length,
    stars: stars.length,
    clusters: clusters.length,
    new_count: newCount,
    rebuild: opts.rebuild,
    generated_at: generatedAt
  };
}
var cronTimer = null;
function msUntilNext3am() {
  const now = /* @__PURE__ */ new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}
function scheduleCron() {
  if (process.env.MEMORY_MAP_CRON === "0") return;
  const ms = msUntilNext3am();
  const at = new Date(Date.now() + ms);
  console.log(`${LOG_TAG} \u6BCF\u65E5\u589E\u91CF\u5DF2\u8C03\u5EA6\uFF1A\u4E0B\u4E00\u6B21 ${at.toLocaleString()}\uFF08${Math.round(ms / 6e4)} \u5206\u949F\u540E\uFF09`);
  cronTimer = setTimeout(async () => {
    try {
      const res = await runSnapshot({ days: 90, limit: 500, rebuild: false });
      console.log(`${LOG_TAG} \u6BCF\u65E5\u589E\u91CF\u5B8C\u6210\uFF1A\u65B0\u589E ${res.new_count} \u661F\uFF0C\u5171 ${res.stars} \u661F / ${res.clusters} \u661F\u7CFB`);
    } catch (e) {
      console.error(`${LOG_TAG} \u6BCF\u65E5\u589E\u91CF\u5931\u8D25\uFF1A`, e);
    }
    scheduleCron();
  }, ms);
}
var WEB_DIR = path.resolve(HERE, "..", "web");
var JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store"
};
var webPort = 3080;
var webRegistered = false;
var webDisposers = [];
function isLoopbackHostname(hn) {
  const h = String(hn || "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  if (Number(m[1]) !== 127) return false;
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255);
}
function selfRejection(req) {
  try {
    const headers = req && req.headers || {};
    let hostUrl;
    try {
      hostUrl = new URL("http://" + String(headers.host || ""));
    } catch {
      return 403;
    }
    if (!isLoopbackHostname(hostUrl.hostname)) return 403;
    const site = String(headers["sec-fetch-site"] || "").toLowerCase();
    if (site === "cross-site") return 403;
    const origin = headers.origin;
    if (typeof origin === "string" && origin && origin !== "null") {
      try {
        if (new URL(origin).host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403;
      } catch {
        return 403;
      }
    }
    return null;
  } catch {
    return 403;
  }
}
function rejected(req, res, fence) {
  const deny = (code) => {
    try {
      res.statusCode = code;
      res.end();
    } catch {
    }
    ;
    return true;
  };
  const method = String(req && req.method || "GET").toUpperCase();
  if (method !== "GET") return deny(405);
  const self = selfRejection(req);
  if (self !== null) return deny(self);
  if (fence) {
    let code;
    try {
      code = fence.requestRejection(req);
    } catch {
      return deny(403);
    }
    if (code === void 0 || code === null || code === false) return false;
    return deny(typeof code === "number" ? code : 403);
  }
  return false;
}
function registerRoute(ws, fence, route) {
  const inner = route && route.handler;
  const wrapped = {
    ...route,
    handler: async (req, res) => {
      if (rejected(req, res, fence)) return;
      return inner(req, res);
    }
  };
  return ws.register(wrapped);
}
var webCache = /* @__PURE__ */ new Map();
function serveWeb(rel, contentType, res) {
  const p = path.join(WEB_DIR, rel);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(p).mtimeMs;
  } catch {
  }
  const cached = webCache.get(rel);
  if (!cached || cached.mtimeMs !== mtimeMs) {
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`memory-map asset not found: ${rel}`);
      return;
    }
    webCache.set(rel, { text, mtimeMs });
  }
  const c = webCache.get(rel);
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(c.text);
}
function serveSnapshot(res) {
  const p = resolveOutPath();
  if (!existsSync(p)) {
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ ok: false, error: "snapshot not generated yet", hint: "\u5148\u8C03\u7528 generate_constellation_snapshot" }));
    return;
  }
  try {
    const raw = readFileSync(p, "utf8");
    res.writeHead(200, JSON_HEADERS);
    res.end(raw);
  } catch (e) {
    res.writeHead(500, JSON_HEADERS);
    res.end(JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 200) }));
  }
}
function registerWebRoutes(ctx) {
  if (webRegistered) return;
  const run = (inner) => {
    if (webRegistered) return;
    webRegistered = true;
    const ws2 = inner?.webServer || inner?.get?.("webServer");
    if (!ws2 || typeof ws2.register !== "function") {
      console.warn(`${LOG_TAG} webServer.register \u4E0D\u53EF\u7528\uFF0C\u8DF3\u8FC7\u524D\u7AEF\u8DEF\u7531\u6CE8\u518C\uFF08\u4ECD\u53EF\u624B\u52A8\u7528\u9759\u6001\u670D\u52A1\u5668\u6253\u5F00 web/\uFF09`);
      return;
    }
    try {
      const addr = ws2.server?.address?.();
      if (addr && typeof addr.port === "number") webPort = addr.port;
    } catch {
    }
    const fence = (() => {
      try {
        const c = inner?.get?.("connection") || inner?.connection;
        return c && typeof c.requestRejection === "function" ? c : null;
      } catch {
        return null;
      }
    })();
    try {
      webDisposers.push(registerRoute(ws2, fence, {
        kind: "exact",
        path: "/api/constellation",
        handler: (_req, res) => serveSnapshot(res)
      }));
      for (const p of ["/memory-map", "/memory-map/", "/memory-map/index.html"]) {
        webDisposers.push(registerRoute(ws2, fence, {
          kind: "exact",
          path: p,
          handler: (_req, res) => serveWeb("index.html", "text/html; charset=utf-8", res)
        }));
      }
      webDisposers.push(registerRoute(ws2, fence, {
        kind: "exact",
        path: "/memory-map/app.bundle.js",
        handler: (_req, res) => serveWeb("app.bundle.js", "application/javascript; charset=utf-8", res)
      }));
      console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u524D\u7AEF\u8DEF\u7531\uFF1A/memory-map/ (\u9875\u9762) + /api/constellation (\u6570\u636E)\uFF0C\u7AEF\u53E3 ${webPort}`);
    } catch (e) {
      console.error(`${LOG_TAG} \u6CE8\u518C\u524D\u7AEF\u8DEF\u7531\u5931\u8D25\uFF1A`, e);
    }
  };
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["webServer"], run);
      return;
    } catch {
    }
  }
  const ws = ctx?.webServer || ctx?.get?.("webServer");
  if (ws) run(ctx);
}
var tool = {
  name: "generate_constellation_snapshot",
  description: "\u751F\u6210\uFF08\u6216\u589E\u91CF\u66F4\u65B0\uFF09\u8BB0\u5FC6\u661F\u5EA7\u5FEB\u7167 data/memory_constellation.json\uFF1A\u4ECE Memory \u5FAE\u670D\u52A1\u62C9\u53D6\u6700\u8FD1\u8BB0\u5FC6\uFF0C\u6309\u6700\u9AD8\u9891\u4EE3\u8868 tag \u805A\u6210\u661F\u7CFB\uFF08\u603B\u6570\u5C01\u9876 15\uFF09\uFF0C\u4E3A\u6BCF\u6761\u8BB0\u5FC6\u751F\u6210\u7A33\u5B9A\u7684 3D \u5750\u6807 (x,y,z)\u3001size \u4E0E color\u3002\u9ED8\u8BA4\u589E\u91CF\uFF08\u53EA\u8865\u65B0\u8BB0\u5FC6\uFF0C\u4FDD\u7559\u65E7\u5750\u6807\uFF09\uFF1Brebuild=true \u5168\u91CF\u91CD\u7B97\u3002Three.js 3D \u524D\u7AEF\u8BFB\u53D6\u8BE5 JSON\u3002",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      days: { type: "integer", minimum: 1, maximum: 3650, default: 90, description: "\u62C9\u53D6\u6700\u8FD1\u591A\u5C11\u5929\u7684\u8BB0\u5FC6" },
      limit: { type: "integer", minimum: 1, maximum: 5e3, default: 500, description: "\u6700\u591A\u62C9\u53D6\u6761\u6570" },
      rebuild: { type: "boolean", default: false, description: "true=\u5168\u91CF\u91CD\u7B97\uFF08\u4E22\u5F03\u65E7\u5750\u6807\uFF09\uFF1Bfalse=\u589E\u91CF\u8FFD\u52A0" }
    }
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        path: { type: "string" },
        total_memories: { type: "integer" },
        stars: { type: "integer" },
        clusters: { type: "integer" },
        new_count: { type: "integer" }
      }
    },
    render: (_args, value) => [
      {
        type: "text",
        text: `\u{1F30C} \u661F\u5EA7\u5FEB\u7167\u5DF2\u751F\u6210 \u2192 ${value?.path ?? ""}
\u8BB0\u5FC6 ${value?.total_memories ?? 0} \u6761 \u2192 ${value?.stars ?? 0} \u9897\u661F / ${value?.clusters ?? 0} \u4E2A\u661F\u7CFB` + (value?.rebuild ? "\uFF08\u5168\u91CF\u91CD\u7B97\uFF09" : `\uFF08\u672C\u6B21\u65B0\u589E ${value?.new_count ?? 0}\uFF09`)
      }
    ]
  },
  async execute(args) {
    const days = Number.isInteger(args?.days) ? Math.min(3650, Math.max(1, args.days)) : 90;
    const limit = Number.isInteger(args?.limit) ? Math.min(5e3, Math.max(1, args.limit)) : 500;
    const rebuild = args?.rebuild === true;
    return runSnapshot({ days, limit, rebuild });
  },
  presentCall(_args) {
    return { card: "generic", title: "generate_constellation_snapshot", kind: "read" };
  }
};
var uiTool = {
  name: "get_constellation_ui_url",
  description: "\u8FD4\u56DE\u300C\u6BCF\u65E5\u8BB0\u5FC6\u661F\u56FE\u300D3D \u661F\u4E91\u53EF\u89C6\u5316\u754C\u9762\u7684\u672C\u5730\u8BBF\u95EE\u5730\u5740\u3002\u8BE5\u9875\u9762\u7531 dsh-memory-map \u63D2\u4EF6\u6302\u5728 DSH Web \u670D\u52A1\u5668\u4E0A\uFF0C\u5C55\u793A\u8BB0\u5FC6\u661F\u7CFB\uFF08\u805A\u7C7B\u5305\u7EDC + \u661F\u5EA7\u8FDE\u7EBF + \u529B\u5BFC\u5411\u5E03\u5C40\uFF09\uFF0C\u652F\u6301\u60AC\u505C\u67E5\u770B\u8BB0\u5FC6\u6458\u8981\u3001\u6EDA\u8F6E\u7F29\u653E\u3001\u70B9\u51FB\u661F\u7CFB\u805A\u7126\u3002\u82E5\u8FD4\u56DE ready=false\uFF0C\u8BF4\u660E\u5FEB\u7167\u5C1A\u672A\u751F\u6210\uFF0C\u8BF7\u5148\u8C03\u7528 generate_constellation_snapshot\u3002",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ready: { type: "boolean" },
        url: { type: "string" },
        api: { type: "string" },
        port: { type: "integer" },
        snapshot_exists: { type: "boolean" }
      }
    },
    render: (_args, value) => [
      {
        type: "text",
        text: value?.ready ? `\u{1F30C} \u8BB0\u5FC6\u661F\u56FE\u754C\u9762\u5DF2\u5C31\u7EEA\uFF1A${value.url}
\uFF08\u6570\u636E\u6E90 ${value.api}\uFF0C\u5FEB\u7167\u5B58\u5728\uFF1A${value.snapshot_exists}\uFF09` : `\u26A0\uFE0F \u8BB0\u5FC6\u661F\u56FE\u5C1A\u672A\u5C31\u7EEA\uFF1A${value?.url ?? ""}
\u8BF7\u5148\u8C03\u7528 generate_constellation_snapshot \u751F\u6210\u5FEB\u7167\u3002`
      }
    ]
  },
  async execute() {
    const snapshotExists = existsSync(resolveOutPath());
    return {
      ready: snapshotExists,
      url: `http://127.0.0.1:${webPort}/memory-map/`,
      api: `http://127.0.0.1:${webPort}/api/constellation`,
      port: webPort,
      snapshot_exists: snapshotExists
    };
  },
  presentCall(_args) {
    return { card: "generic", title: "get_constellation_ui_url", kind: "read" };
  }
};
var index_default = {
  name: "dsh-memory-map",
  apply(ctx) {
    console.log(`${LOG_TAG} apply (memory=${MEMORY_BUS_URL})`);
    const disposers = [];
    try {
      const d = ctx.tools.register(tool);
      if (typeof d === "function") disposers.push(d);
      const d2 = ctx.tools.register(uiTool);
      if (typeof d2 === "function") disposers.push(d2);
      console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 generate_constellation_snapshot + get_constellation_ui_url`);
    } catch (e) {
      console.error(`${LOG_TAG} \u6CE8\u518C\u5DE5\u5177\u5931\u8D25\uFF1A`, e);
    }
    try {
      registerWebRoutes(ctx);
    } catch (e) {
      console.error(`${LOG_TAG} \u6CE8\u518C\u524D\u7AEF\u8DEF\u7531\u5F02\u5E38\uFF1A`, e);
    }
    try {
      if (typeof ctx.set === "function") {
        ctx.set("memoryMap", {
          generate: (opts) => runSnapshot({ days: opts?.days ?? 90, limit: opts?.limit ?? 500, rebuild: opts?.rebuild ?? false }),
          getSnapshotPath: resolveOutPath
        });
      }
    } catch {
    }
    scheduleCron();
    ctx.on("dispose", () => {
      console.log(`${LOG_TAG} dispose\uFF1A\u6CE8\u9500\u5DE5\u5177 + \u6E05\u5236\u5B9A\u65F6\u5668 + \u6CE8\u9500\u524D\u7AEF\u8DEF\u7531`);
      if (cronTimer) {
        clearTimeout(cronTimer);
        cronTimer = null;
      }
      for (const d of webDisposers) {
        try {
          d();
        } catch {
        }
      }
      for (const d of disposers) {
        try {
          d();
        } catch {
        }
      }
      webRegistered = false;
    });
  }
};
var __main = path.resolve(process.argv[1] || "");
if (__main === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const pick = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : void 0;
  };
  const days = pick("--days") ? Math.min(3650, Math.max(1, parseInt(pick("--days"), 10) || 90)) : 90;
  const limit = pick("--limit") ? Math.min(5e3, Math.max(1, parseInt(pick("--limit"), 10) || 500)) : 500;
  const rebuild = args.includes("--rebuild");
  if (args.includes("--regen")) {
    runSnapshot({ days, limit, rebuild }).then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    }).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else {
    console.log("dsh-memory-map CLI\uFF1A\u4F7F\u7528 --regen [--days N] [--limit N] [--rebuild] \u751F\u6210\u5FEB\u7167");
  }
}
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
