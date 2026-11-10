// src/index.ts
import { mkdirSync, readdirSync } from "node:fs";
import { mkdir, rename, writeFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import axios from "axios";
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
  baseImageSize: clampInt(process.env.PAINTER_BASE_IMAGE_SIZE, 64, 4096, 1024)
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
      const meta = await sharp(buf).metadata();
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
    const buf = await sharp(svg).resize(size, size).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: env.jpegQuality }).toBuffer();
    return { buffer: buf, width: size, height: size, source: "local-test" };
  } catch {
    const buf = await sharp(makeGradientBuffer(size, size), { raw: { width: size, height: size, channels: 4 } }).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: env.jpegQuality }).toBuffer();
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
async function getBaseImage(prompt) {
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
  const withAlpha = await sharp(base).joinChannel(mask.toBuffer(), { raw: { width: w, height: h, channels: 1 } }).toBuffer();
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).composite([{ input: withAlpha, blend: "over" }]).jpeg({ quality }).toBuffer();
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
    try {
      const got = await getBaseImage(prompt);
      base = got.buffer;
      w = got.width;
      h = got.height;
      source = got.source;
      painterMsg = got.message ? decodeURIComponentSafe(got.message) : "";
    } catch (e) {
      return { ok: false, error: `\u83B7\u53D6\u5E95\u56FE\u5931\u8D25\uFF1A${e.message}`, elapsed_ms: Math.round(performance.now() - t0) };
    }
    if (job.abort.signal.aborted) {
      return { ok: false, cancelled: true, error: "\u5DF2\u53D6\u6D88", elapsed_ms: Math.round(performance.now() - t0), source };
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
      if (env.revealMode === "grid") mask.revealFractionGrid(p, env.grid);
      else mask.revealFraction(p);
      const buf = await renderFrame(base, mask, env.jpegQuality);
      await atomicWrite(obsPath, buf, String(jobId));
      framesWritten++;
      if (framesDir) {
        const name = `frame_${String(i + 1).padStart(padLen, "0")}.jpg`;
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
    const finalBuf = await sharp(base).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: env.jpegQuality }).toBuffer();
    await atomicWrite(obsPath, finalBuf, String(jobId));
    return {
      ok: true,
      path: obsPath,
      frames: framesWritten,
      elapsed_ms: Math.round(performance.now() - t0),
      source,
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
  description: "\u9010\u5E27\u4F5C\u753B\uFF1A\u6839\u636E prompt \u751F\u6210\u4E00\u5F20\u5B8C\u6574\u56FE\u7247\uFF0C\u7136\u540E\u7528\u626B\u63CF\u7EBF\u906E\u7F69\u9010\u5E27\u663E\u5F71\uFF0C\u539F\u5B50\u5199\u5165\u8986\u76D6 obs_output_path\uFF08OBS \u76D1\u542C\u7684\u56FE\u7247\u7EDD\u5BF9\u8DEF\u5F84\uFF09\uFF0C\u6A21\u62DF\u4EBA\u7C7B\u4F5C\u753B\u8FC7\u7A0B\u3002duration_ms \u9ED8\u8BA4 4000\uFF0Cfps \u9ED8\u8BA4 10\u3002\u65B0\u8C03\u7528\u4F1A\u81EA\u52A8\u4E2D\u65AD\u4E0A\u4E00\u6B21\u4F5C\u753B\u3002\u8FD4\u56DE {ok, path, frames, elapsed_ms}\u3002",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "obs_output_path"],
    properties: {
      prompt: { type: "string", description: "\u751F\u56FE\u63D0\u793A\u8BCD\uFF0C\u5982\u300C\u4E00\u53EA\u8D5B\u535A\u670B\u514B\u9CB8\u9C7C\u300D" },
      obs_output_path: { type: "string", description: "OBS \u76D1\u542C\u7684\u56FE\u7247\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u5982 C:\\live_assets\\current_paint.jpg" },
      duration_ms: { type: "number", description: "\u6574\u4E2A\u4F5C\u753B\u8FC7\u7A0B\u6301\u7EED\u6BEB\u79D2\u6570\uFF0C\u9ED8\u8BA4 4000" },
      fps: { type: "number", description: "\u5237\u65B0\u9891\u7387\uFF08\u5E27/\u79D2\uFF09\uFF0C\u9ED8\u8BA4 10" }
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
      fps: args?.fps
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
