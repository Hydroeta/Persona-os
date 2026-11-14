// src/index.ts
import { mkdirSync, readdirSync } from "node:fs";
import { mkdir, rename, writeFile, unlink, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import sharp3 from "sharp";
import axios from "axios";

// src/strokes.ts
import sharp from "sharp";
async function loadGray(buf, width) {
  const meta = await sharp(buf).metadata();
  const iw = meta.width || 512;
  const ih = meta.height || 512;
  const w = Math.max(64, Math.round(width));
  const h = Math.max(64, Math.round(ih / iw * w));
  const { data } = await sharp(buf).flatten({ background: "#ffffff" }).resize(w, h, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { gray: new Uint8Array(data), w, h };
}
function morph(src, w, h, r, dilate) {
  if (r <= 0) return src;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let dy = -r; dy <= r && v !== (dilate ? 1 : 0); dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          if (dilate) {
            if (src[yy * w + xx]) {
              v = 1;
              break;
            }
          } else if (!src[yy * w + xx]) {
            v = 0;
            break;
          }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
function thin(src, w, h) {
  const img = Uint8Array.from(src);
  const at = (x, y) => x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x];
  let changed = true;
  let pass = 0;
  while (changed && pass < 40) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      const del = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!img[y * w + x]) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          del.push(y * w + x);
        }
      }
      for (const i of del) {
        img[i] = 0;
        changed = true;
      }
    }
    pass++;
  }
  return img;
}
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let idx = -1;
  let maxD = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const d = Math.abs(dy * px - dx * py + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps || idx < 0) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}
function chaikin(pts, iter) {
  let cur = pts;
  for (let k = 0; k < iter; k++) {
    if (cur.length < 3) break;
    const out = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const [x0, y0] = cur[i];
      const [x1, y1] = cur[i + 1];
      out.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      out.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}
var lenOf = (pts) => {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
};
var norm = (v) => {
  const m = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / m, v[1] / m];
};
function stitch(polys) {
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const used = new Array(polys.length).fill(false);
  const out = [];
  const seeds = polys.map((_, i) => i).sort((a, b) => lenOf(polys[b]) - lenOf(polys[a]));
  for (const seed of seeds) {
    if (used[seed]) continue;
    used[seed] = true;
    const chain = [...polys[seed]];
    let grown = true;
    while (grown) {
      grown = false;
      const tail = chain[chain.length - 1];
      const prev = chain[chain.length - 2] || tail;
      const tdir = norm([tail[0] - prev[0], tail[1] - prev[1]]);
      let best = -1;
      let bestD = 12 * 12;
      let flip = false;
      for (let i = 0; i < polys.length; i++) {
        if (used[i]) continue;
        const s = polys[i];
        for (const f of [false, true]) {
          const seg = f ? [...s].reverse() : s;
          const head = seg[0];
          const nxt = seg[1] || head;
          const dir = norm([nxt[0] - head[0], nxt[1] - head[1]]);
          if (tdir[0] * dir[0] + tdir[1] * dir[1] < 0.2) continue;
          const dd = d2(tail, head);
          if (dd < bestD) {
            bestD = dd;
            best = i;
            flip = f;
          }
        }
      }
      if (best >= 0) {
        used[best] = true;
        const s = flip ? [...polys[best]].reverse() : polys[best];
        chain.push(...s.slice(1));
        grown = true;
      }
    }
    out.push(chain);
  }
  let more = true;
  while (more) {
    more = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        const ends = [
          { p: a[0], d: norm([a[0][0] - a[1][0], a[0][1] - a[1][1]]), rev: true },
          { p: a[a.length - 1], d: norm([a[a.length - 1][0] - a[a.length - 2][0], a[a.length - 1][1] - a[a.length - 2][1]]), rev: false }
        ];
        const starts = [
          { p: b[0], d: norm([b[1][0] - b[0][0], b[1][1] - b[0][1]]), rev: false },
          { p: b[b.length - 1], d: norm([b[b.length - 2][0] - b[b.length - 1][0], b[b.length - 2][1] - b[b.length - 1][1]]), rev: true }
        ];
        let merged = null;
        for (const e of ends) {
          for (const s of starts) {
            const gx = s.p[0] - e.p[0];
            const gy = s.p[1] - e.p[1];
            const gLen = Math.hypot(gx, gy);
            if (gLen > 40) continue;
            const g = norm([gx, gy]);
            if (e.d[0] * g[0] + e.d[1] * g[1] < 0.5) continue;
            if (s.d[0] * g[0] + s.d[1] * g[1] < 0.5) continue;
            const A = e.rev ? [...a].reverse() : a;
            const B = s.rev ? [...b].reverse() : b;
            merged = [...A, ...B.slice(1)];
            break;
          }
          if (merged) break;
        }
        if (merged) {
          out[i] = merged;
          out.splice(j, 1);
          more = true;
          break outer;
        }
      }
    }
  }
  return out;
}
async function analyzeStrokes(buf, opts = {}) {
  const W = opts.width ?? 768;
  const binT = opts.binThreshold ?? 0;
  const openR = opts.openRadius ?? 1;
  const minArea = opts.minArea ?? 150;
  const minLen = opts.minLen ?? 0;
  const eps = opts.rdpEpsilon ?? 1.8;
  const smooth = opts.smooth ?? 1;
  const cropBottom = opts.cropBottom ?? 0;
  const orderMode = opts.order ?? "band";
  const palette = opts.palette && opts.palette.length ? opts.palette : ["#22384f"];
  const { gray, w, h } = await loadGray(buf, W);
  if (cropBottom > 0) {
    const cut = Math.round(h * (1 - cropBottom));
    for (let y = cut; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = 255;
  }
  let thr = binT;
  if (!thr) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < w * h; i++) hist[gray[i]]++;
    const total = w * h;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > bestVar) {
        bestVar = between;
        best = i;
      }
    }
    thr = Math.max(50, Math.min(220, best || 128));
  }
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = gray[i] < thr ? 1 : 0;
  const opened = morph(morph(bin, w, h, openR, false), w, h, openR, true);
  const label = new Int32Array(w * h).fill(-1);
  const keep = new Uint8Array(w * h);
  let comp = 0;
  for (let start = 0; start < w * h; start++) {
    if (!opened[start] || label[start] >= 0) continue;
    const stack = [start];
    label[start] = comp;
    const px = [];
    while (stack.length) {
      const i = stack.pop();
      px.push(i);
      const x = i % w;
      const y = i / w | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (opened[j] && label[j] < 0) {
            label[j] = comp;
            stack.push(j);
          }
        }
      }
    }
    if (px.length >= minArea) for (const i of px) keep[i] = 1;
    comp++;
  }
  const skel = thin(keep, w, h);
  const visited = new Uint8Array(w * h);
  const NB = [-1, -w - 1, -w, -w + 1, 1, w + 1, w, w - 1];
  const neighbours = (i) => {
    const x = i % w;
    const out = [];
    for (const d of NB) {
      const j = i + d;
      if (j < 0 || j >= w * h) continue;
      if (Math.abs(j % w - x) > 1) continue;
      if (skel[j]) out.push(j);
    }
    return out;
  };
  const raw = [];
  const walk = (start) => {
    let cur = start;
    let prev = -1;
    const line = [];
    while (cur >= 0 && !visited[cur]) {
      visited[cur] = 1;
      line.push([cur % w, cur / w | 0]);
      const nbs = neighbours(cur).filter((j) => !visited[j]);
      if (!nbs.length) break;
      if (nbs.length === 1) {
        prev = cur;
        cur = nbs[0];
        continue;
      }
      const cx = cur % w;
      const cy = cur / w | 0;
      const dx = prev >= 0 ? cx - prev % w : 0;
      const dy = prev >= 0 ? cy - (prev / w | 0) : 0;
      let best = -1;
      let bestScore = -Infinity;
      for (const j of nbs) {
        const vx = j % w - cx;
        const vy = (j / w | 0) - cy;
        const score = prev >= 0 ? vx * dx + vy * dy : vx * 0.4 - vy * 0.9;
        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }
      prev = cur;
      cur = best;
    }
    if (line.length >= 8) raw.push(line);
  };
  for (let i = 0; i < w * h; i++) if (skel[i] && !visited[i] && neighbours(i).length === 1) walk(i);
  for (let i = 0; i < w * h; i++) if (skel[i] && !visited[i]) walk(i);
  const polys = raw.map((s) => rdp(s, eps)).map((s) => smooth > 0 ? chaikin(s, smooth) : s).filter((s) => s.length >= 2 && lenOf(s) >= minLen);
  const merged = stitch(polys);
  const paths = merged.map((s) => {
    const ys = s.map((p) => p[1]);
    const xs = s.map((p) => p[0]);
    const cy = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length);
    const band = Math.min(palette.length - 1, Math.max(0, Math.floor(cy / h * palette.length)));
    return {
      d: "M" + s.map((p) => `${p[0]},${p[1]}`).join("L"),
      len: lenOf(s),
      color: palette[band],
      cy,
      top: Math.min(...ys)
    };
  });
  if (orderMode === "length") paths.sort((a, b) => b.len - a.len);
  else {
    paths.sort((a, b) => {
      const ba = Math.round(a.top / 110);
      const bb = Math.round(b.top / 110);
      return ba !== bb ? ba - bb : b.len - a.len;
    });
  }
  const totalLen = paths.reduce((a, p) => a + p.len, 0);
  return { width: w, height: h, strokes: paths.map(({ d, len, color, cy }) => ({ d, len, color, cy })), totalLen, frameCount: 0, H: h };
}
async function renderStrokeFrame(res, p, quality = 88, opts = {}) {
  const W = res.width;
  const H = res.height;
  const budget = p * res.totalLen;
  let acc = 0;
  const els = [];
  const lw = opts.lineWidth ?? Math.max(2, Math.round((opts.width ?? W) / 220));
  for (const s of res.strokes) {
    if (acc >= budget) break;
    const want = Math.min(s.len, budget - acc);
    acc += s.len;
    if (want < 0.5) continue;
    els.push(
      `<path d="${s.d}" fill="none" stroke="${s.color}" stroke-width="${lw}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${s.len.toFixed(1)}" stroke-dashoffset="${(s.len - want).toFixed(1)}"/>`
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#fff"/>${els.join("")}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality }).toBuffer();
}

// src/pixel.ts
import sharp2 from "sharp";
async function readPixelGrid(buffer, n, size) {
  if (n < 2) throw new Error("n \u81F3\u5C11\u4E3A 2");
  const meta = await sharp2(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error("\u56FE\u7247\u5C3A\u5BF8\u65E0\u6548");
  const want = size && size % n === 0 ? size : Math.round(meta.width / n) * n;
  const side = Math.max(n, want);
  const { data, info } = await sharp2(buffer).flatten({ background: { r: 255, g: 255, b: 255 } }).resize(side, side, { fit: "cover", kernel: "nearest" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const cell = side / n;
  const colors = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) {
      const x = Math.min(side - 1, Math.floor(c * cell + cell / 2));
      const y = Math.min(side - 1, Math.floor(r * cell + cell / 2));
      const i = (y * side + x) * channels;
      row.push([data[i], data[i + 1], data[i + 2], 255]);
    }
    colors.push(row);
  }
  return { n, size: side, cell, colors };
}
function luma(rgb) {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = s * 1664525 + 1013904223 >>> 0;
    return s / 4294967296;
  };
}
function planBrickOrder(grid, opts = {}) {
  const n = grid.n;
  const jitter = opts.jitter ?? 0.15;
  const rng = makeRng(opts.seed ?? 1);
  const cx = (n - 1) / 2;
  const cy = (n - 1) / 2;
  const maxR = Math.hypot(cx, cy) || 1;
  const cells = [];
  const lumas = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) lumas.push(luma(grid.colors[r][c]));
  lumas.sort((a, b) => a - b);
  const lo = lumas[Math.floor(lumas.length * 0.15)];
  const hi = lumas[Math.floor(lumas.length * 0.85)];
  const span = Math.max(1, hi - lo);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const L = luma(grid.colors[r][c]);
      const norm2 = Math.min(1, Math.max(0, (L - lo) / span));
      const band = norm2 < 1 / 3 ? 0 : norm2 < 2 / 3 ? 1 : 2;
      const radius = Math.hypot(c - cx, r - cy) / maxR;
      cells.push({ r, c, band, radius, rnd: rng() });
    }
  }
  cells.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    if (Math.abs(a.radius - b.radius) > 0.02) return b.radius - a.radius;
    return a.rnd - b.rnd;
  });
  const total = cells.length;
  return cells.map((cell, i) => {
    const base = (i + 0.5) / total;
    const t = Math.min(0.999, Math.max(0, base + (cell.rnd - 0.5) * 2 * jitter * (1 / total) * total * 1));
    return { r: cell.r, c: cell.c, t };
  });
}
async function renderPixelFrame(grid, order, p, opts = {}) {
  const bg = opts.background ?? { r: 255, g: 255, b: 255 };
  const { n, size, cell } = grid;
  const buf = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    buf[i * 3] = bg.r;
    buf[i * 3 + 1] = bg.g;
    buf[i * 3 + 2] = bg.b;
  }
  const filled = /* @__PURE__ */ new Set();
  for (const o of order) {
    if (o.t > p) continue;
    const idx = o.r * n + o.c;
    if (filled.has(idx)) continue;
    filled.add(idx);
    const [r, g, b] = grid.colors[o.r][o.c];
    const x0 = o.c * cell;
    const y0 = o.r * cell;
    for (let y = y0; y < y0 + cell; y++) {
      const rowOff = y * size;
      for (let x = x0; x < x0 + cell; x++) {
        const i = (rowOff + x) * 3;
        buf[i] = r;
        buf[i + 1] = g;
        buf[i + 2] = b;
      }
    }
  }
  return await sharp2(buf, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}
function planBrickBatches(n) {
  const cells = n * n;
  const batch = cells <= 2500 ? 1 : cells <= 6400 ? 4 : Math.max(4, Math.round(cells / 1600));
  const steps = Math.max(50, Math.min(120, Math.round(cells / batch / 60) * 60 || 60));
  return { batch, steps: Math.max(60, Math.min(140, steps)) };
}

// src/index.ts
var LOG_TAG = "[dsh-painter]";
if (!process.env.IMAGE_GEN_URL && process.env.PAINTER_USE_LOCAL_IMAGE !== "1") {
  process.env.IMAGE_GEN_URL = "http://127.0.0.1:8002/generate";
}
var env = {
  imageGenUrl: (process.env.IMAGE_GEN_URL || "").trim(),
  imageGenTimeoutMs: clampInt(process.env.IMAGE_GEN_TIMEOUT_MS, 1e3, 6e5, 3e4),
  imageGenRetries: clampInt(process.env.IMAGE_GEN_RETRIES, 0, 10, 2),
  revealMode: (process.env.PAINTER_REVEAL_MODE || "scanline").toLowerCase() === "grid" ? "grid" : "scanline",
  grid: clampInt(process.env.PAINTER_GRID, 2, 64, 20),
  testMode: process.env.PAINTER_TEST_MODE === "1" || !!process.env.PAINTER_FRAMES_DIR,
  framesDir: (process.env.PAINTER_FRAMES_DIR || "").trim(),
  jpegQuality: clampInt(process.env.PAINTER_JPEG_QUALITY, 1, 100, 88),
  baseImageSize: clampInt(process.env.PAINTER_BASE_IMAGE_SIZE, 64, 4096, 1024),
  // 三阶段派生作画（勾线→铺色→细节）；设 PAINTER_THREE_STAGE=0 可退回单图扫描线
  threeStage: process.env.PAINTER_THREE_STAGE !== "0",
  stageLong: clampInt(process.env.PAINTER_STAGE_LONG, 256, 1536, 768)
};
function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function decodeURIComponentSafe(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
function readPainterHeaders(headers) {
  const get = (k) => {
    const v = headers?.[k];
    return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  };
  const decode = (v) => {
    if (!v) return "";
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  return {
    msg: decode(get("x-painter-msg")),
    outPath: decode(get("x-painter-path")),
    provider: get("x-painter-provider")
  };
}
async function fetchRemoteImage(prompt) {
  const url = env.imageGenUrl;
  let lastErr = null;
  for (let attempt = 0; attempt <= env.imageGenRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env.imageGenTimeoutMs);
      const resp = await axios.post(url, { prompt, scene: "live" }, {
        responseType: "arraybuffer",
        signal: controller.signal,
        timeout: env.imageGenTimeoutMs,
        validateStatus: (s) => s >= 200 && s < 300
      });
      clearTimeout(timer);
      const ct = String(resp.headers["content-type"] || "").toLowerCase();
      let buf = Buffer.from(resp.data);
      if (ct.includes("json") || buf.length && buf[0] === 123) {
        try {
          const j = JSON.parse(buf.toString("utf8"));
          const imgUrl = j?.url || j?.data?.[0]?.url || j?.image_url || "";
          if (imgUrl) {
            const r2 = await axios.get(imgUrl, { responseType: "arraybuffer", timeout: env.imageGenTimeoutMs });
            buf = Buffer.from(r2.data);
          }
        } catch {
        }
      }
      const meta = await sharp3(buf).metadata();
      if (!meta.width || !meta.height) throw new Error("\u56FE\u7247\u5C3A\u5BF8\u65E0\u6548");
      const hdr = readPainterHeaders(resp.headers);
      return {
        buffer: buf,
        width: meta.width,
        height: meta.height,
        source: hdr.provider ? `remote:${hdr.provider}` : `remote:${url}`,
        message: hdr.msg || void 0
      };
    } catch (e) {
      lastErr = e;
      if (attempt < env.imageGenRetries) {
        await new Promise((r) => setTimeout(r, 1e3 * 2 ** attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
async function generateLocalTestImage(prompt) {
  const size = env.baseImageSize;
  try {
    const svg = makeTestSvg(prompt, size);
    const buf = await sharp3(svg).resize(size, size).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: env.jpegQuality }).toBuffer();
    return { buffer: buf, width: size, height: size, source: "local-test" };
  } catch {
    const buf = await sharp3(makeGradientBuffer(size, size), { raw: { width: size, height: size, channels: 4 } }).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: env.jpegQuality }).toBuffer();
    return { buffer: buf, width: size, height: size, source: "local-test-gradient" };
  }
}
function svgEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function makeTestSvg(prompt, size) {
  const text = svgEscape(prompt.slice(0, 40));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#0f0c29"/><stop offset="50%" stop-color="#302b63"/><stop offset="100%" stop-color="#24243e"/>
</linearGradient>
<linearGradient id="txt" x1="0" y1="0" x2="1" y2="0">
<stop offset="0%" stop-color="#f7971e"/><stop offset="100%" stop-color="#ffd200"/>
</linearGradient>
</defs>
<rect width="100%" height="100%" fill="url(#bg)"/>
<circle cx="${Math.round(size * 0.82)}" cy="${Math.round(size * 0.18)}" r="${Math.round(size * 0.1)}" fill="#ffd200" opacity="0.85"/>
<text x="50%" y="46%" font-family="Segoe UI, Microsoft YaHei, Arial, sans-serif" font-size="${Math.round(size * 0.075)}" font-weight="700" fill="url(#txt)" text-anchor="middle" dominant-baseline="middle">${text}</text>
<text x="50%" y="58%" font-family="Segoe UI, Arial, sans-serif" font-size="${Math.round(size * 0.032)}" fill="#ffffff" text-anchor="middle" opacity="0.8">dsh-painter test image</text>
</svg>`;
  return Buffer.from(svg, "utf8");
}
function makeGradientBuffer(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      const i = (y * w + x) * 4;
      buf[i] = Math.round(15 + t * 48);
      buf[i + 1] = Math.round(12 + t * 43);
      buf[i + 2] = Math.round(41 + t * 62);
      buf[i + 3] = 255;
    }
  }
  return buf;
}
async function readLocalImage() {
  const p = String(process.env.PAINTER_LOCAL_IMAGE || "").trim();
  const buf = await readFile(p);
  const meta = await sharp3(buf).metadata();
  if (!meta.width || !meta.height) throw new Error(`\u672C\u5730\u5E95\u56FE\u65E0\u6548\uFF1A${p}`);
  return { buffer: buf, width: meta.width, height: meta.height, source: `local:${p}`, format: meta.format };
}
async function getBaseImage(prompt) {
  if (process.env.PAINTER_LOCAL_IMAGE) return readLocalImage();
  if (env.imageGenUrl) return fetchRemoteImage(prompt);
  return generateLocalTestImage(prompt);
}
var RevealMask = class {
  width;
  height;
  data;
  revealed = 0;
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
  }
  /** 扫描线：按光栅序（左→右、上→下）显影前 p 比例像素。只增不减。 */
  revealFraction(p) {
    const total = this.width * this.height;
    const target = Math.min(total, Math.max(this.revealed, Math.round(p * total)));
    if (target > this.revealed) {
      this.data.fill(255, this.revealed, target);
      this.revealed = target;
    }
  }
  /** 网格：按光栅序整块显影，前 p 比例的格子整块点亮。只增不减。 */
  revealFractionGrid(p, grid) {
    const cols = grid;
    const rows = grid;
    const blockW = Math.ceil(this.width / cols);
    const blockH = Math.ceil(this.height / rows);
    const total = cols * rows;
    const targetBlocks = Math.min(total, Math.max(0, Math.round(p * total)));
    for (let b = 0; b < targetBlocks; b++) {
      const br = Math.floor(b / cols);
      const bc = b % cols;
      const x0 = bc * blockW;
      const y0 = br * blockH;
      const x1 = Math.min(this.width, x0 + blockW);
      const y1 = Math.min(this.height, y0 + blockH);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = y * this.width + x;
          if (this.data[idx] === 0) {
            this.data[idx] = 255;
            this.revealed++;
          }
        }
      }
    }
  }
  toBuffer() {
    return Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }
};
async function renderFrame(base, mask, quality) {
  const w = mask.width;
  const h = mask.height;
  const withAlpha = await sharp3(base).joinChannel(mask.toBuffer(), { raw: { width: w, height: h, channels: 1 } }).toBuffer();
  return sharp3({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite([{ input: withAlpha, blend: "over" }]).jpeg({ quality }).toBuffer();
}
var STAGE_P1 = 0.46;
var STAGE_P2 = 0.82;
function boxBlur(src, w, h, r) {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / win | 0;
      sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win | 0;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
function sketchFromRgb(rgb, w, h) {
  const n = w * h;
  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    gray[i] = rgb[j] * 0.299 + rgb[j + 1] * 0.587 + rgb[j + 2] * 0.114 | 0;
  }
  const blur = boxBlur(gray, w, h, Math.max(2, Math.round(w / 220)));
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const inv = 255 - blur[i];
    let v = inv >= 255 ? 255 : Math.min(255, gray[i] * 255 / Math.max(1, 255 - inv));
    v = Math.max(0, Math.min(255, (v - 150) * (255 / 105)));
    out[i * 3] = v;
    out[i * 3 + 1] = v;
    out[i * 3 + 2] = v;
  }
  return out;
}
function flatFromRgb(rgb, w, h) {
  const n = w * h;
  const ch = [0, 1, 2].map((c) => {
    const one = new Uint8Array(n);
    for (let i = 0; i < n; i++) one[i] = rgb[i * 3 + c];
    return boxBlur(one, w, h, 2);
  });
  const q = (v) => v > 232 ? 250 : Math.max(0, Math.min(255, Math.round(v / 40) * 40));
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = q(ch[0][i]);
    out[i * 3 + 1] = q(ch[1][i]);
    out[i * 3 + 2] = q(ch[2][i]);
  }
  return out;
}
function inkDistanceField(sketch, w, h, sw, sh) {
  const small = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / sh * h));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) / sw * w));
      const v = sketch[(sy * w + sx) * 3];
      if (v < 205) small[y * sw + x] = 1;
    }
  }
  const dist = new Float32Array(sw * sh);
  const INF = 1e6;
  for (let i = 0; i < sw * sh; i++) dist[i] = small[i] ? 0 : INF;
  const D1 = 1;
  const D2 = 1.4142;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[i - 1] + D1);
      if (y > 0) {
        d = Math.min(d, dist[i - sw] + D1);
        if (x > 0) d = Math.min(d, dist[i - sw - 1] + D2);
        if (x < sw - 1) d = Math.min(d, dist[i - sw + 1] + D2);
      }
      dist[i] = d;
    }
  }
  let maxDist = 0;
  for (let y = sh - 1; y >= 0; y--) {
    for (let x = sw - 1; x >= 0; x--) {
      const i = y * sw + x;
      let d = dist[i];
      if (x < sw - 1) d = Math.min(d, dist[i + 1] + D1);
      if (y < sh - 1) {
        d = Math.min(d, dist[i + sw] + D1);
        if (x < sw - 1) d = Math.min(d, dist[i + sw + 1] + D2);
        if (x > 0) d = Math.min(d, dist[i + sw - 1] + D2);
      }
      dist[i] = d;
      if (d > maxDist && d < INF) maxDist = d;
    }
  }
  let s = 625341585;
  for (let i = 0; i < sw * sh; i++) {
    s = s * 1103515245 + 12345 >>> 0;
    if (dist[i] > 0) dist[i] += ((s >>> 16) / 65535 - 0.5) * 1.8;
  }
  return { dist, sw, sh, maxDist: Math.max(1, maxDist) };
}
async function prepareStages(finalBuf, targetLong) {
  const meta = await sharp3(finalBuf).metadata();
  const iw = meta.width || 1024;
  const ih = meta.height || 1024;
  const scale = Math.min(1, targetLong / Math.max(iw, ih));
  const w = Math.max(64, Math.round(iw * scale));
  const h = Math.max(64, Math.round(ih * scale));
  const { data: rgb } = await sharp3(finalBuf).flatten({ background: "#ffffff" }).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const final = new Uint8Array(rgb);
  const sketch = sketchFromRgb(final, w, h);
  const flat = flatFromRgb(final, w, h);
  const sw = Math.min(200, w);
  const sh = Math.max(1, Math.round(h / w * sw));
  const field = inkDistanceField(sketch, w, h, sw, sh);
  const dw = Math.ceil(w / 4);
  const dh = Math.ceil(h / 4);
  const dither = new Uint8Array(dw * dh);
  let seed = 2654435769;
  for (let i = 0; i < dither.length; i++) {
    seed = seed * 1664525 + 1013904223 >>> 0;
    dither[i] = seed >>> 24;
  }
  const sx0 = new Int32Array(w);
  const sx1 = new Int32Array(w);
  const stx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = x * sw / w - 0.5;
    const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
    sx0[x] = x0;
    sx1[x] = Math.max(0, Math.min(sw - 1, x0 + 1));
    stx[x] = Math.max(0, Math.min(1, fx - x0));
  }
  const sy0 = new Int32Array(h);
  const sy1 = new Int32Array(h);
  const sty = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const fy = y * sh / h - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    sy0[y] = y0;
    sy1[y] = Math.max(0, Math.min(sh - 1, y0 + 1));
    sty[y] = Math.max(0, Math.min(1, fy - y0));
  }
  const xf = new Float32Array(w);
  for (let x = 0; x < w; x++) xf[x] = x / w;
  return {
    w,
    h,
    sketch,
    flat,
    final,
    dist: field.dist,
    sw: field.sw,
    sh: field.sh,
    maxDist: field.maxDist,
    dither,
    dw,
    dh,
    sx0,
    sx1,
    stx,
    sy0,
    sy1,
    sty,
    xf
  };
}
async function renderStageFrame(st, p, quality) {
  const { w, h, sketch, flat, final, dist, sw, sh, maxDist, dither, dw, dh, sx0, sx1, stx, sy0, sy1, sty, xf } = st;
  const n = w * h;
  const out = Buffer.alloc(n * 3);
  if (p <= STAGE_P1) {
    const prog = p / STAGE_P1;
    const diag = 1.35;
    const lim = prog * diag;
    for (let y = 0; y < h; y++) {
      const ry = y / h * 0.35;
      const row = y * w * 3;
      for (let x = 0; x < w; x++) {
        const k = row + x * 3;
        if (xf[x] + ry <= lim) {
          out[k] = sketch[k];
          out[k + 1] = sketch[k + 1];
          out[k + 2] = sketch[k + 2];
        } else {
          out[k] = out[k + 1] = out[k + 2] = 255;
        }
      }
    }
  } else if (p <= STAGE_P2) {
    const grow = (p - STAGE_P1) / (STAGE_P2 - STAGE_P1) * maxDist;
    const band = 1.6;
    for (let y = 0; y < h; y++) {
      const y0 = sy0[y];
      const y1 = sy1[y];
      const ty = sty[y];
      const rowA = y0 * sw;
      const rowB = y1 * sw;
      const row = y * w * 3;
      for (let x = 0; x < w; x++) {
        const x0 = sx0[x];
        const x1 = sx1[x];
        const tx = stx[x];
        const d = dist[rowA + x0] * (1 - tx) * (1 - ty) + dist[rowA + x1] * tx * (1 - ty) + dist[rowB + x0] * (1 - tx) * ty + dist[rowB + x1] * tx * ty;
        let a = (grow + band - d) / (2 * band);
        a = a <= 0 ? 0 : a >= 1 ? 1 : a;
        const k = row + x * 3;
        out[k] = sketch[k] + (flat[k] - sketch[k]) * a | 0;
        out[k + 1] = sketch[k + 1] + (flat[k + 1] - sketch[k + 1]) * a | 0;
        out[k + 2] = sketch[k + 2] + (flat[k + 2] - sketch[k + 2]) * a | 0;
      }
    }
  } else {
    const thr = (p - STAGE_P2) / (1 - STAGE_P2) * 260;
    for (let y = 0; y < h; y++) {
      const by = Math.min(dh - 1, y >> 2);
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const src = dither[by * dw + Math.min(dw - 1, x >> 2)] < thr ? final : flat;
        out[i * 3] = src[i * 3];
        out[i * 3 + 1] = src[i * 3 + 1];
        out[i * 3 + 2] = src[i * 3 + 2];
      }
    }
  }
  return sharp3(Buffer.from(out), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality }).toBuffer();
}
async function atomicWrite(target, buf, tmpSuffix) {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${tmpSuffix}`;
  await writeFile(tmp, buf);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
  try {
    await writeFile(target, buf);
  } catch {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
var currentJob = null;
var jobSeq = 0;
var lastObsPath = "";
function cleanupStrayTmps(obsPath) {
  try {
    const dir = dirname(obsPath);
    const base = basename(obsPath);
    for (const e of readdirSync(dir)) {
      if (e.startsWith(base + ".tmp")) {
        unlink(join(dir, e)).catch(() => {
        });
      }
    }
  } catch {
  }
}
function abortCurrentJob() {
  if (!currentJob) return;
  const job = currentJob;
  currentJob = null;
  try {
    job.abort.abort();
  } catch {
  }
  if (job.timer) {
    clearTimeout(job.timer);
    job.timer = null;
  }
  unlink(`${job.obsPath}.tmp.${job.id}`).catch(() => {
  });
}
function cancelPaint() {
  abortCurrentJob();
}
function parseAspect(a) {
  if (!a) return null;
  if (typeof a === "object") {
    const w = Number(a.width);
    const h = Number(a.height);
    if (w > 0 && h > 0) return { rw: w, rh: h };
    return null;
  }
  const m = /^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/.exec(String(a).trim());
  if (!m) return null;
  const rw = Number(m[1]);
  const rh = Number(m[2]);
  if (rw <= 0 || rh <= 0) return null;
  return { rw, rh };
}
async function cropToAspect(buf, aspect) {
  const meta = await sharp3(buf).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) throw new Error("\u5E95\u56FE\u5C3A\u5BF8\u65E0\u6548\uFF0C\u65E0\u6CD5\u6309\u753B\u5E45\u88C1\u526A");
  const target = aspect.rw / aspect.rh;
  const cur = W / H;
  if (Math.abs(cur - target) < 0.01) return { buffer: buf, width: W, height: H };
  let cw = W;
  let ch = H;
  if (cur > target) cw = Math.round(H * target);
  else ch = Math.round(W / target);
  cw = Math.max(2, Math.min(W, cw));
  ch = Math.max(2, Math.min(H, ch));
  const left = Math.floor((W - cw) / 2);
  const top = Math.floor((H - ch) / 2);
  const out = await sharp3(buf).extract({ left, top, width: cw, height: ch }).png().toBuffer();
  return { buffer: out, width: cw, height: ch };
}
async function generatePaintProcess(args) {
  const prompt = (args.prompt || "").trim();
  const obsPath = (args.obs_output_path || "").trim();
  if (!prompt) return { ok: false, error: "prompt \u4E0D\u80FD\u4E3A\u7A7A" };
  if (!obsPath) return { ok: false, error: "obs_output_path \u4E0D\u80FD\u4E3A\u7A7A\uFF08OBS \u76D1\u542C\u7684\u56FE\u7247\u7EDD\u5BF9\u8DEF\u5F84\uFF09" };
  const durationMs = clampInt(String(args.duration_ms), 500, 6e5, 4e3);
  const fps = clampInt(String(args.fps), 1, 60, 10);
  const totalFrames = Math.max(1, Math.round(durationMs / (1e3 / fps)));
  const interval = 1e3 / fps;
  lastObsPath = obsPath;
  abortCurrentJob();
  const jobId = ++jobSeq;
  const job = { id: jobId, abort: new AbortController(), timer: null, obsPath };
  currentJob = job;
  const t0 = performance.now();
  let framesWritten = 0;
  let source = "unknown";
  let painterMsg = "";
  try {
    let base;
    let w;
    let h;
    let baseFmt = "";
    try {
      const genPrompt = args.mode === "strokes" && !/lineart|coloring book|线稿/i.test(prompt) ? `${prompt}\uFF0Csimple lineart, clean thick strokes, coloring book page, black ink on white background, no shading` : prompt;
      const got = await getBaseImage(genPrompt);
      base = got.buffer;
      w = got.width;
      h = got.height;
      source = got.source;
      baseFmt = String(got.format || "");
      painterMsg = got.message ? decodeURIComponentSafe(got.message) : "";
    } catch (e) {
      return { ok: false, error: `\u83B7\u53D6\u5E95\u56FE\u5931\u8D25\uFF1A${e.message}`, elapsed_ms: Math.round(performance.now() - t0) };
    }
    const aspectArg = parseAspect(args.aspect);
    if (aspectArg) {
      try {
        const cut = await cropToAspect(base, aspectArg);
        base = cut.buffer;
        w = cut.width;
        h = cut.height;
        baseFmt = "png";
        console.log(`${LOG_TAG} \u6309\u753B\u5E45 ${aspectArg.rw}:${aspectArg.rh} \u88C1\u526A \u2192 ${w}\xD7${h}`);
      } catch (e) {
        console.error(`${LOG_TAG} \u753B\u5E45\u88C1\u526A\u5931\u8D25\uFF0C\u6CBF\u7528\u539F\u56FE ${w}\xD7${h}\uFF1A${e.message}`);
      }
    }
    if (job.abort.signal.aborted) {
      return { ok: false, cancelled: true, error: "\u5DF2\u53D6\u6D88", elapsed_ms: Math.round(performance.now() - t0), source };
    }
    let stages = null;
    let strokeRes = null;
    if (args.mode === "strokes") {
      try {
        const res = await analyzeStrokes(base, {
          width: env.stageLong,
          binThreshold: process.env.PAINTER_BIN_THRESH ? clampInt(process.env.PAINTER_BIN_THRESH, 40, 254, 128) : void 0,
          openRadius: clampInt(process.env.PAINTER_OPEN_R, 0, 4, 1),
          minArea: clampInt(process.env.PAINTER_MIN_AREA, 20, 5e3, 150),
          minLen: clampInt(process.env.PAINTER_MIN_LEN, 0, 400, 0),
          smooth: clampInt(process.env.PAINTER_SMOOTH, 0, 3, 1),
          cropBottom: Number(process.env.PAINTER_CROP_BOTTOM || 0.06),
          palette: args.palette && args.palette.length ? args.palette : ["#22384f"]
        });
        if (res.strokes.length >= 5) strokeRes = res;
        else console.error(`${LOG_TAG} \u7B14\u753B\u53EA\u6709 ${res.strokes.length} \u6761\uFF0C\u9000\u56DE\u4E09\u9636\u6BB5`);
      } catch (e) {
        console.error(`${LOG_TAG} \u7B14\u753B\u8FFD\u8E2A\u5931\u8D25\uFF0C\u9000\u56DE\u4E09\u9636\u6BB5\uFF1A${e.message}`);
      }
    }
    let pixelRes = null;
    if (args.mode === "pixel") {
      try {
        const n = clampInt(String(args.grid_size), 8, 256, 64);
        const grid = await readPixelGrid(base, n);
        const order = planBrickOrder(grid, { seed: 7 });
        const { batch } = planBrickBatches(n);
        pixelRes = { grid, order, batch };
        console.log(`${LOG_TAG} \u50CF\u7D20\u6A21\u5F0F\uFF1A${n}\xD7${n}\uFF0C\u6BCF\u683C ${grid.cell}px\uFF0C\u6BCF\u6B65\u5237 ${batch} \u683C`);
      } catch (e) {
        console.error(`${LOG_TAG} \u50CF\u7D20\u5316\u5931\u8D25\uFF0C\u9000\u56DE\u4E09\u9636\u6BB5\uFF1A${e.message}`);
      }
    }
    if (!pixelRes && !strokeRes && env.threeStage) {
      try {
        stages = await prepareStages(base, env.stageLong);
      } catch (e) {
        console.error(`${LOG_TAG} \u4E09\u9636\u6BB5\u6D3E\u751F\u5931\u8D25\uFF0C\u9000\u56DE\u626B\u63CF\u7EBF\uFF1A${e.message}`);
        stages = null;
      }
    }
    let framesDir = "";
    if (env.testMode) {
      framesDir = env.framesDir || join(process.cwd(), "temp_paint_frames");
      mkdirSync(framesDir, { recursive: true });
    }
    const padLen = Math.max(3, String(totalFrames).length);
    const mask = new RevealMask(w, h);
    const writeFrame = async (i) => {
      if (job.abort.signal.aborted) return;
      const p = (i + 1) / totalFrames;
      let buf;
      if (pixelRes) {
        const total = pixelRes.order.length;
        const k = Math.floor(p * total / pixelRes.batch);
        const q = Math.min(1, k * pixelRes.batch / total);
        buf = await renderPixelFrame(pixelRes.grid, pixelRes.order, q);
      } else if (strokeRes) {
        buf = await renderStrokeFrame(strokeRes, p, env.jpegQuality);
      } else if (stages) {
        buf = await renderStageFrame(stages, p, env.jpegQuality);
      } else {
        if (env.revealMode === "grid") mask.revealFractionGrid(p, env.grid);
        else mask.revealFraction(p);
        buf = await renderFrame(base, mask, env.jpegQuality);
      }
      await atomicWrite(obsPath, buf, String(jobId));
      framesWritten++;
      if (framesDir) {
        const isPng = pixelRes && !/^jpe?g$/.test(String(baseFmt));
        const name = `frame_${String(i + 1).padStart(padLen, "0")}.${isPng ? "png" : "jpg"}`;
        await writeFile(join(framesDir, name), buf).catch(() => {
        });
      }
    };
    for (let i = 0; i < totalFrames; i++) {
      if (job.abort.signal.aborted) break;
      const frameStart = performance.now();
      await writeFrame(i);
      if (job.abort.signal.aborted) break;
      if (i < totalFrames - 1) {
        const elapsed = performance.now() - frameStart;
        const wait = Math.max(0, interval - elapsed);
        await new Promise((resolve) => {
          const t = setTimeout(() => resolve(), wait);
          job.timer = t;
          job.abort.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true }
          );
        });
      }
    }
    if (job.abort.signal.aborted) {
      return {
        ok: false,
        cancelled: true,
        error: "\u4F5C\u753B\u88AB\u65B0\u4EFB\u52A1\u6253\u65AD",
        frames: framesWritten,
        elapsed_ms: Math.round(performance.now() - t0),
        source
      };
    }
    const finalBuf = pixelRes ? await renderPixelFrame(pixelRes.grid, pixelRes.order, 1) : await sharp3(base).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: env.jpegQuality }).toBuffer();
    await atomicWrite(obsPath, finalBuf, String(jobId));
    return {
      ok: true,
      path: obsPath,
      frames: framesWritten,
      elapsed_ms: Math.round(performance.now() - t0),
      source,
      mode: pixelRes ? "pixel" : strokeRes ? "strokes" : stages ? "stages" : "scanline",
      strokes: strokeRes ? strokeRes.strokes.length : void 0,
      grid_size: pixelRes ? pixelRes.grid.n : void 0,
      aspect: aspectArg ? `${aspectArg.rw}:${aspectArg.rh}` : void 0,
      width: w,
      height: h,
      message: painterMsg || void 0
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      frames: framesWritten,
      elapsed_ms: Math.round(performance.now() - t0),
      source
    };
  } finally {
    if (currentJob === job) {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
      currentJob = null;
    }
    unlink(`${obsPath}.tmp.${jobId}`).catch(() => {
    });
  }
}
var paintTool = {
  name: "generate_paint_process",
  description: "\u9010\u5E27\u4F5C\u753B\uFF1A\u6839\u636E prompt \u751F\u6210\u4E00\u5F20\u5B8C\u6574\u56FE\u7247\uFF0C\u518D\u5728\u672C\u5730\u6D3E\u751F\u300C\u7EBF\u7A3F \u2192 \u94FA\u8272 \u2192 \u7EC6\u8282\u300D\u4E09\u4E2A\u9636\u6BB5\uFF0C\u9010\u5E27\u663E\u5F71\u5E76\u539F\u5B50\u5199\u5165\u8986\u76D6 obs_output_path\uFF08OBS \u76D1\u542C\u7684\u56FE\u7247\u7EDD\u5BF9\u8DEF\u5F84\uFF09\uFF0C\u6A21\u62DF\u4EBA\u7C7B\u4E00\u7B14\u4E00\u7B14\u4F5C\u753B\u3002duration_ms \u9ED8\u8BA4 4000\uFF0Cfps \u9ED8\u8BA4 10\u3002\u65B0\u8C03\u7528\u4F1A\u81EA\u52A8\u4E2D\u65AD\u4E0A\u4E00\u6B21\u4F5C\u753B\u3002\u8FD4\u56DE {ok, path, frames, elapsed_ms}\u3002",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "obs_output_path"],
    properties: {
      prompt: { type: "string", description: "\u751F\u56FE\u63D0\u793A\u8BCD\uFF0C\u5982\u300C\u4E00\u53EA\u8D5B\u535A\u670B\u514B\u9CB8\u9C7C\u300D" },
      obs_output_path: { type: "string", description: "OBS \u76D1\u542C\u7684\u56FE\u7247\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u5982 C:\\live_assets\\current_paint.jpg" },
      duration_ms: { type: "number", description: "\u6574\u4E2A\u4F5C\u753B\u8FC7\u7A0B\u6301\u7EED\u6BEB\u79D2\u6570\uFF0C\u9ED8\u8BA4 4000" },
      fps: { type: "number", description: "\u5237\u65B0\u9891\u7387\uFF08\u5E27/\u79D2\uFF09\uFF0C\u9ED8\u8BA4 10" },
      mode: { type: "string", enum: ["stages", "strokes", "pixel"], description: "stages=\u4E09\u9636\u6BB5\u6D3E\u751F\uFF08\u9ED8\u8BA4\uFF09\uFF1Bstrokes=\u771F\u9010\u7B14\u52FE\u7EBF\uFF0C\u5E95\u56FE\u9700\u662F\u5E72\u51C0\u7EBF\u7A3F\uFF1Bpixel=\u50CF\u7D20\u780C\u7816\uFF08N\xD7N \u683C\u5B50\u6309\u6697\u2192\u4E2D\u2192\u4EAE\u4E00\u5757\u5757\u586B\u6EE1\uFF09" },
      grid_size: { type: "number", description: "pixel \u6A21\u5F0F\u7684\u7F51\u683C\u8FB9\u957F\uFF08\u683C\u5B50\u6570\uFF09\uFF0C\u9ED8\u8BA4 64\uFF1B32=\u5757\u5927\u6000\u65E7\u300164=\u6700\u7A33\u3001128=\u7EC6\u817B" },
      palette: { type: "array", items: { type: "string" }, description: 'strokes \u6A21\u5F0F\u7684\u914D\u8272\uFF08\u6309\u7B14\u753B\u91CD\u5FC3\u7EB5\u5E26\u53D6\uFF09\uFF0C\u5982 ["#22384f","#5f9ea6"]\uFF0C\u53EA\u7ED9\u4E00\u4E2A\u5C31\u662F\u5355\u8272' }
    }
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        path: { type: "string" },
        frames: { type: "number" },
        elapsed_ms: { type: "number" },
        source: { type: "string" },
        message: { type: "string", description: "\u751F\u56FE\u4FA7\u7ED9\u7684\u4EBA\u7C7B\u53EF\u8BFB\u8BF4\u660E\uFF08\u5DF2\u89E3\u7801\uFF09\uFF0C\u5982\u300C\u753B\u597D\u5566\uFF01\u300D" },
        error: { type: "string" }
      }
    },
    render: (_args, value) => [
      {
        type: "text",
        text: value?.ok ? `\u{1F3A8} \u4F5C\u753B\u5B8C\u6210 \u2192 ${value.path ?? ""}
\u5E27\u6570\uFF1A${value.frames ?? 0}\u3000\u8017\u65F6\uFF1A${value.elapsed_ms ?? 0}ms\u3000\u5E95\u56FE\u6E90\uFF1A${value.source ?? ""}` + (value?.message ? `
${value.message}` : "") : `\u274C \u4F5C\u753B\u5931\u8D25\uFF1A${value?.error ?? "\u672A\u77E5"}${value?.cancelled ? "\uFF08\u5DF2\u88AB\u65B0\u4EFB\u52A1\u6253\u65AD\uFF09" : ""}`
      }
    ]
  },
  async execute(args) {
    return generatePaintProcess({
      prompt: args?.prompt,
      obs_output_path: args?.obs_output_path,
      duration_ms: args?.duration_ms,
      fps: args?.fps,
      mode: args?.mode,
      palette: args?.palette
    });
  },
  presentCall(args) {
    return {
      card: "generic",
      title: `\u{1F3A8} painter \u2192 ${String(args?.prompt ?? "").slice(0, 40)}`,
      kind: "write"
    };
  }
};
var index_default = {
  name: "dsh-painter",
  apply(ctx) {
    try {
      if (typeof ctx.set === "function") {
        ctx.set("painter", { generate: generatePaintProcess, cancel: cancelPaint });
        console.log(`${LOG_TAG} \u5DF2\u66B4\u9732 painter \u670D\u52A1\uFF08ctx.get('painter')\uFF09`);
      }
    } catch (e) {
      console.error(`${LOG_TAG} \u66B4\u9732 painter \u670D\u52A1\u5931\u8D25\uFF1A${e.message}`);
    }
    let toolDispose = null;
    try {
      const d = ctx.tools.register(paintTool);
      if (typeof d === "function") toolDispose = d;
      console.log(`${LOG_TAG} \u5DF2\u6CE8\u518C\u5DE5\u5177 generate_paint_process`);
    } catch (e) {
      console.error(`${LOG_TAG} \u6CE8\u518C generate_paint_process \u5931\u8D25\uFF1A`, e);
    }
    ctx.on("dispose", () => {
      if (toolDispose) {
        try {
          toolDispose();
        } catch {
        }
      }
      abortCurrentJob();
      if (lastObsPath) cleanupStrayTmps(lastObsPath);
      console.log(`${LOG_TAG} disposed`);
    });
  }
};
export {
  cancelPaint,
  index_default as default,
  generatePaintProcess
};
//# sourceMappingURL=index.js.map
