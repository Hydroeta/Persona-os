import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/perception.ts
var LOG_TAG = "[dsh-live-director:perception]";
var VISION_KEYWORDS = ["\u5728\u5E72\u561B", "\u753B\u4E86\u4EC0\u4E48", "\u753B\u7684\u4EC0\u4E48", "\u5728\u753B\u4EC0\u4E48", "\u770B\u4E00\u4E0B", "\u770B\u770B", "\u753B\u9762", "\u5C4F\u5E55", "\u4F60\u5728\u5E72\u561B", "\u5728\u505A\u4EC0\u4E48"];
function shouldCaptureScreen(text) {
  const t = String(text ?? "");
  if (!t) return false;
  return VISION_KEYWORDS.some((kw) => t.includes(kw));
}
async function defaultCapture(timeoutMs) {
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
      new Promise(
        (_, reject) => setTimeout(() => reject(new Error("\u622A\u5C4F\u8D85\u65F6")), timeoutMs)
      )
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
  const timeoutMs = opts.timeoutMs ?? 8e3;
  return {
    async describe(base64Img, prompt) {
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
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Img}` } }
                ]
              }
            ],
            max_tokens: 100
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
var Perception = class {
  captureFn;
  vision;
  captureTimeoutMs;
  overallTimeoutMs;
  maxImageBytes;
  constructor(opts = {}) {
    this.captureTimeoutMs = opts.captureTimeoutMs ?? 2e3;
    this.overallTimeoutMs = opts.overallTimeoutMs ?? 1e4;
    this.maxImageBytes = opts.maxImageBytes ?? 2 * 1024 * 1024;
    this.vision = opts.visionClient ?? createVisionClient();
    this.captureFn = opts.captureFn ?? null;
  }
  /**
   * 截取主屏幕 → 压缩 base64 → 视觉模型描述，返回 ≤20 字的画面描述。
   * 任何环节失败/超时都返回 ''，绝不抛错打断直播。
   */
  async captureScreenContext() {
    const overall = new AbortController();
    const overallTimer = setTimeout(() => overall.abort(), this.overallTimeoutMs);
    try {
      let buf = null;
      try {
        const cap = this.captureFn ? await this.captureFn() : await defaultCapture(this.captureTimeoutMs);
        buf = Buffer.isBuffer(cap) ? cap : null;
      } catch {
        buf = null;
      }
      if (!buf || buf.length === 0) return "";
      if (buf.length > this.maxImageBytes) {
        console.warn(`${LOG_TAG} \u622A\u56FE\u8FC7\u5927\uFF08${buf.length}B > ${this.maxImageBytes}B\uFF09\uFF0C\u8DF3\u8FC7\u89C6\u89C9`);
        return "";
      }
      const b64 = buf.toString("base64");
      const desc = await this.vision.describe(b64, "\u7528 20 \u5B57\u4EE5\u5185\u63CF\u8FF0\u8FD9\u5F20\u56FE\u91CC\u4E3B\u64AD\u6B63\u5728\u5E72\u561B");
      return desc;
    } catch (e) {
      console.warn(`${LOG_TAG} captureScreenContext \u5F02\u5E38\uFF08\u964D\u7EA7\u4E3A\u7A7A\uFF09\uFF1A${e.message}`);
      return "";
    } finally {
      clearTimeout(overallTimer);
    }
  }
};
function buildScreenPrompt(desc) {
  const d = String(desc ?? "").trim();
  return d ? `\uFF08\u5F53\u524D\u76F4\u64AD\u753B\u9762\uFF1A${d}\uFF09` : "";
}
export {
  LOG_TAG,
  Perception,
  buildScreenPrompt,
  createVisionClient,
  shouldCaptureScreen
};
//# sourceMappingURL=perception.js.map
