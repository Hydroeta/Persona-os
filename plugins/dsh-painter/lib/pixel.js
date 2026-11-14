// src/pixel.ts
import sharp from "sharp";
async function readPixelGrid(buffer, n, size) {
  if (n < 2) throw new Error("n \u81F3\u5C11\u4E3A 2");
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error("\u56FE\u7247\u5C3A\u5BF8\u65E0\u6548");
  const want = size && size % n === 0 ? size : Math.round(meta.width / n) * n;
  const side = Math.max(n, want);
  const { data, info } = await sharp(buffer).flatten({ background: { r: 255, g: 255, b: 255 } }).resize(side, side, { fit: "cover", kernel: "nearest" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
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
      const norm = Math.min(1, Math.max(0, (L - lo) / span));
      const band = norm < 1 / 3 ? 0 : norm < 2 / 3 ? 1 : 2;
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
  return await sharp(buf, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}
function planBrickBatches(n) {
  const cells = n * n;
  const batch = cells <= 2500 ? 1 : cells <= 6400 ? 4 : Math.max(4, Math.round(cells / 1600));
  const steps = Math.max(50, Math.min(120, Math.round(cells / batch / 60) * 60 || 60));
  return { batch, steps: Math.max(60, Math.min(140, steps)) };
}
function quantizeProgress(p, batch, total) {
  const stepCells = batch / total;
  const k = Math.floor(p / stepCells);
  return Math.min(1, (k * batch + (k > 0 ? batch : 0)) / total);
}
export {
  planBrickBatches,
  planBrickOrder,
  quantizeProgress,
  readPixelGrid,
  renderPixelFrame
};
//# sourceMappingURL=pixel.js.map
