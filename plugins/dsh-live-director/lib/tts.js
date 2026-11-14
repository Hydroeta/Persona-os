import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/tts.ts
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
var LOG_TAG = "[dsh-live-director/tts]";
var DEFAULT_REF_CANDIDATES = [
  process.env.WHALE_REF_AUDIO || "",
  join(homedir(), "Documents", "douyin-whale", "out", "ref_video", "ref_190.wav"),
  join(homedir(), "Desktop", "\u65B0\u5EFA\u6587\u4EF6\u5939 (2)", "ohwhale-deploy", "assets", "voice", "states", "ref_calm.wav")
].filter(Boolean);
function resolveDefaultRef() {
  for (const p of DEFAULT_REF_CANDIDATES) {
    try {
      if (p && existsSync(p)) return p;
    } catch {
    }
  }
  return "";
}
var DEFAULT_PLAYER = process.platform === "win32" ? `powershell -NoProfile -Command "(New-Object Media.SoundPlayer '{file}').PlaySync()"` : "ffplay -autoexit -nodisp -loglevel quiet {file}";
function readTtsConfig(env = process.env) {
  if (String(env.TTS_ENABLED || "") === "0") return null;
  const base = String(env.TTS_SERVICE_URL || "http://127.0.0.1:9881").trim().replace(/\/+$/, "").replace(/\/tts$/, "");
  if (!base) return null;
  const refAudio = String(env.TTS_REF_AUDIO || "").trim() || resolveDefaultRef();
  const t = Number(env.TTS_TIMEOUT_MS);
  return {
    base,
    refAudio,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 6e4,
    player: String(env.TTS_PLAYER || DEFAULT_PLAYER)
  };
}
function buildTtsUrl(base, text, refAudio) {
  const q = new URLSearchParams({ text, ref_audio_path: refAudio, media_type: "wav" });
  return `${base.replace(/\/+$/, "")}/tts?${q.toString()}`;
}
function buildPlayerArgv(template, file) {
  const tokens = [];
  let cur = "";
  let quote = "";
  for (const ch of template.trim()) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  if (!tokens.length) throw new Error("\u64AD\u653E\u5668\u547D\u4EE4\u4E3A\u7A7A");
  const cmd = tokens[0];
  const args = tokens.slice(1).map((p) => p === "{file}" ? file : p.replace("{file}", file));
  return { cmd, args };
}
var speaking = false;
function isSpeaking() {
  return speaking;
}
function __resetSpeakingForTest() {
  speaking = false;
}
async function speakViaTts(text, cfg = readTtsConfig()) {
  const content = String(text || "").trim();
  if (!content) return false;
  if (!cfg) {
    console.log(`${LOG_TAG} [TTS\u964D\u7EA7] \u672A\u542F\u7528`);
    return false;
  }
  if (!cfg.refAudio) {
    console.log(`${LOG_TAG} [TTS\u964D\u7EA7] \u672A\u914D\u7F6E\u53C2\u8003\u97F3\u8DEF\u5F84\uFF08TTS_REF_AUDIO\uFF09`);
    return false;
  }
  if (!existsSync(cfg.refAudio)) {
    console.log(`${LOG_TAG} [TTS\u964D\u7EA7] \u53C2\u8003\u97F3\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${cfg.refAudio}`);
    return false;
  }
  if (speaking) {
    console.log(`${LOG_TAG} [TTS\u964D\u7EA7] \u4E0A\u4E00\u53E5\u8FD8\u5728\u64AD\uFF0C\u4E22\u5F03\uFF1A${content.slice(0, 20)}`);
    return false;
  }
  speaking = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let dir = "";
  try {
    const url = buildTtsUrl(cfg.base, content, cfg.refAudio);
    const r = await fetch(url, { method: "GET", signal: ctrl.signal });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status} ${body.slice(0, 120)}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100) throw new Error(`\u8FD4\u56DE\u97F3\u9891\u8FC7\u5C0F\uFF08${buf.length} \u5B57\u8282\uFF09`);
    dir = await mkdtemp(join(tmpdir(), "dsh-tts-"));
    const file = join(dir, "speak.wav");
    await writeFile(file, buf);
    const { cmd, args } = buildPlayerArgv(cfg.player, file);
    await new Promise((resolve) => {
      execFile(cmd, args, { windowsHide: true }, (err) => {
        if (err) console.error(`${LOG_TAG} [TTS\u964D\u7EA7] \u64AD\u653E\u5931\u8D25: ${err.message}`);
        resolve();
      });
    });
    void rm(dir, { recursive: true, force: true }).catch(() => {
    });
    console.log(`${LOG_TAG} \u{1F50A} \u64AD\u62A5\u5B8C\u6210\uFF08${buf.length} \u5B57\u8282\uFF09\uFF1A${content}`);
    return true;
  } catch (e) {
    const msg = e.name === "AbortError" ? `\u8D85\u65F6\uFF08${cfg.timeoutMs}ms\uFF09` : e.message;
    console.error(`${LOG_TAG} [TTS\u964D\u7EA7] \u64AD\u653E\u5931\u8D25: ${msg}`);
    if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {
    });
    return false;
  } finally {
    clearTimeout(timer);
    speaking = false;
  }
}
async function warmupTts(cfg = readTtsConfig()) {
  if (!cfg || !cfg.refAudio || !existsSync(cfg.refAudio)) return false;
  if (String(process.env.TTS_WARMUP || "") === "0") return false;
  try {
    const r = await fetch(buildTtsUrl(cfg.base, "\u55EF", cfg.refAudio), {
      method: "GET",
      signal: AbortSignal.timeout(cfg.timeoutMs)
    });
    console.log(`${LOG_TAG} \u{1F525} \u9884\u70ED${r.ok ? "\u6210\u529F" : `\u5931\u8D25 HTTP ${r.status}`}`);
    return r.ok;
  } catch (e) {
    console.log(`${LOG_TAG} \u9884\u70ED\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u64AD\u62A5\uFF09\uFF1A${e.message}`);
    return false;
  }
}
export {
  __resetSpeakingForTest,
  buildPlayerArgv,
  buildTtsUrl,
  isSpeaking,
  readTtsConfig,
  resolveDefaultRef,
  speakViaTts,
  warmupTts
};
//# sourceMappingURL=tts.js.map
