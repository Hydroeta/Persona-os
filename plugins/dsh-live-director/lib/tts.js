import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// src/tts.ts
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
var LOG_TAG = "[dsh-live-director/tts]";
var DEFAULT_PLAYER = process.platform === "win32" ? `powershell -NoProfile -Command "(New-Object Media.SoundPlayer '{file}').PlaySync()"` : "ffplay -autoexit -nodisp -loglevel quiet {file}";
function readTtsConfig(env = process.env) {
  if (String(env.TTS_ENABLED || "") === "0") return null;
  const url = String(env.TTS_SERVICE_URL || "http://127.0.0.1:9881/tts").trim();
  if (!url) return null;
  const t = Number(env.TTS_TIMEOUT_MS);
  return {
    url,
    voice: env.TTS_VOICE ? String(env.TTS_VOICE) : void 0,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 3e3,
    player: String(env.TTS_PLAYER || DEFAULT_PLAYER)
  };
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
async function speakViaTts(text, cfg = readTtsConfig()) {
  const content = String(text || "").trim();
  if (!content) return false;
  if (!cfg) {
    console.log(`${LOG_TAG} [TTS\u964D\u7EA7] \u672A\u542F\u7528`);
    return false;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let dir = "";
  try {
    const r = await fetch(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: content, ...cfg.voice ? { voice: cfg.voice } : {} }),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100) throw new Error(`\u8FD4\u56DE\u97F3\u9891\u8FC7\u5C0F\uFF08${buf.length} \u5B57\u8282\uFF09`);
    dir = await mkdtemp(join(tmpdir(), "dsh-tts-"));
    const file = join(dir, "speak.wav");
    await writeFile(file, buf);
    const { cmd, args } = buildPlayerArgv(cfg.player, file);
    execFile(cmd, args, { windowsHide: true }, (err) => {
      if (err) console.error(`${LOG_TAG} [TTS\u964D\u7EA7] \u64AD\u653E\u5931\u8D25: ${err.message}`);
      void rm(dir, { recursive: true, force: true }).catch(() => {
      });
    });
    console.log(`${LOG_TAG} \u{1F50A} \u5DF2\u4EA4\u7ED9\u64AD\u653E\u5668\uFF08${buf.length} \u5B57\u8282\uFF09\uFF1A${content}`);
    return true;
  } catch (e) {
    const msg = e.name === "AbortError" ? `\u8D85\u65F6\uFF08${cfg.timeoutMs}ms\uFF09` : e.message;
    console.error(`${LOG_TAG} [TTS\u964D\u7EA7] \u64AD\u653E\u5931\u8D25: ${msg}`);
    if (dir) void rm(dir, { recursive: true, force: true }).catch(() => {
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
export {
  buildPlayerArgv,
  readTtsConfig,
  speakViaTts
};
//# sourceMappingURL=tts.js.map
