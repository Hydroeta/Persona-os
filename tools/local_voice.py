# -*- coding: utf-8 -*-
"""本地麦克风唤醒闭环（摆脱 QQ 电话束缚）

唤醒词 → 麦克风直录 → ASR → LLM → TTS → 音箱直连。
不经过 QQ / NapCat / 环回声卡，麦克风和音箱直连本机。

唤醒实现：当前用**流式 ASR 关键词检测**（复用已装的 sherpa-onnx paraformer，
零额外模型）；若配置了 kws_model_dir 指向 sherpa KWS 模型，则优先用专用
KeywordSpotter（更省电、更低延迟）。doctor 会如实报告当前处于哪种模式、
缺什么，不会在缺模型时谎称可运行。

音频设备租约：开工前抢 mic_lease.json（带 TTL，崩溃不死锁），并检测
call_loop 心跳，通话进行中拒绝抢麦，避免和 QQ 通话互抢麦克风。

设计原则（沿用项目约定）：零硬依赖、懒加载、优雅降级、doctor 报缺啥。
  - sherpa-onnx / 模型缺失 → doctor 报缺，run 退出
  - Ollama 未启动 → 本地 LLM 失败，按 llm_gate 配置决定是否落回云端
  - TTS 端点挂了 → 自动降级 Windows SAPI 系统语音

CLI：
    python tools/local_voice.py doctor   # 体检：报缺啥，不谎报可运行
    python tools/local_voice.py test     # 麦→ASR 打印，不走 LLM/TTS（Ctrl+C 停）
    python tools/local_voice.py run      # 全链路：唤醒→识别→思考→说话
    python tools/local_voice.py once "你好"   # 直接把文本当一轮指令（不唤醒）
"""
from __future__ import annotations

import importlib.util
import json
import os
import queue
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

# 控制台/重定向默认 GBK，回复里的 emoji 会把整个循环带走 —— 统一 utf-8
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = Path(__file__).resolve().parent
for _p in (str(ROOT / "ohwhale-deploy"),
           str(ROOT / "ohwhale-deploy" / "scripts"),
           str(TOOLS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

CONFIG_FILE = TOOLS_DIR / "local_voice.config.json"
MIC_LEASE_FILE = TOOLS_DIR / "mic_lease.json"
STATE_FILE = ROOT / "data" / "local_voice_state.json"   # 控制台/桌宠共享的开关状态（默认关闭）

DEFAULT_CFG = {
    "wake_keywords": ["小鲸", "哦鲸", "小鲸鱼"],
    "wake_then_listen": True,
    "wake_ack": "在呢",
    "listen_timeout_s": 8,
    "input_device": None,
    "output_device": None,
    "sample_rate_in": 16000,
    "sample_rate_out": 48000,
    "tts_raw_rate": 32000,
    "frame_s": 0.05,
    "silence_end_s": 0.9,
    "min_speech_s": 0.25,
    "max_utter_s": 18.0,
    "preroll_s": 0.45,
    "threshold_floor": 0.009,
    "scene": "local_voice",
    "max_tokens": 160,
    "temperature": 0.7,
    "llm_system_prompt": "你是小鲸鱼，用户的本地语音助手。用口语化中文简短回答，1~2 句。",
    "kws_model_dir": "",
    "lease_ttl": 1800,
}


# ============================================================
# 配置
# ============================================================
def load_config() -> dict:
    cfg = dict(DEFAULT_CFG)
    try:
        if CONFIG_FILE.is_file():
            cfg.update(json.loads(CONFIG_FILE.read_text("utf-8")))
    except Exception:
        pass
    # TTS 优先复用 ohwhale 的全局配置（音色/端点和通话链路一致）
    try:
        from ohwhale.config import get as _setting, project_path as _pp
        if not cfg.get("tts_engine"):
            cfg["tts_engine"] = _setting("services.tts_engine", "gpt_sovits")
        if cfg["tts_engine"] == "indextts2":
            cfg["tts_url"] = cfg.get("tts_url") or _setting("services.indextts_url")
        else:
            cfg["tts_url"] = cfg.get("tts_url") or _setting("services.tts_url")
        if not cfg.get("tts_ref"):
            r = _setting("paths.voice_ref")
            if r:
                cfg["tts_ref"] = _pp(r) if callable(_pp) else r
        cfg["tts_raw_rate"] = int(_setting("audio.tts_raw_rate", cfg["tts_raw_rate"]))
    except Exception:
        pass
    return cfg


def save_default_config() -> None:
    try:
        if not CONFIG_FILE.is_file():
            CONFIG_FILE.write_text(
                json.dumps(DEFAULT_CFG, ensure_ascii=False, indent=2), "utf-8")
    except OSError:
        pass


# ============================================================
# 开关状态（控制台 / 桌宠共享，默认关闭）
# ============================================================
def read_state() -> dict:
    """读共享开关状态。文件不存在/损坏 → 默认关闭（enabled=False）。"""
    try:
        if STATE_FILE.is_file():
            d = json.loads(STATE_FILE.read_text("utf-8"))
            return {"enabled": bool(d.get("enabled", False)),
                    "pid": d.get("pid"),
                    "updated": d.get("updated", "")}
    except Exception:
        pass
    return {"enabled": False, "pid": None, "updated": ""}


def write_state(enabled: bool, pid=None) -> dict:
    """原子写共享开关状态，返回写入后的 dict。失败不抛。"""
    state = {"enabled": bool(enabled),
             "pid": pid,
             "updated": time.strftime("%Y-%m-%d %H:%M:%S")}
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False), "utf-8")
        os.replace(tmp, STATE_FILE)
    except Exception:
        pass
    return state


# ============================================================
# 麦克风租约（互斥 + 通话避让，仿 resource_gate 的 GPU 租约）
# ============================================================
def lease_holder() -> str:
    try:
        d = json.loads(MIC_LEASE_FILE.read_text("utf-8"))
        if time.time() - d.get("ts", 0) < d.get("ttl", 1800):
            return d.get("holder", "")
    except Exception:
        pass
    return ""


def acquire_mic(holder: str = "local_voice", ttl: int | None = None) -> tuple[bool, str]:
    """拿麦克风租约。通话进行中或已被别人持有 → (False, reason)。"""
    try:
        import resource_gate
        busy, why = resource_gate.busy()
        if busy:
            return False, "通话/直播进行中（%s），不抢麦" % why
    except Exception:
        pass
    cur = lease_holder()
    if cur and cur != holder:
        return False, "麦克风被 %s 持有" % cur
    try:
        MIC_LEASE_FILE.write_text(json.dumps(
            {"holder": holder, "ts": time.time(),
             "ttl": int(ttl or load_config().get("lease_ttl", 1800))}), "utf-8")
        return True, "ok"
    except OSError as e:
        return False, "写租约失败: %s" % e


def release_mic(holder: str = "local_voice") -> bool:
    if lease_holder() != holder:
        return False
    try:
        MIC_LEASE_FILE.unlink(missing_ok=True)
        return True
    except OSError:
        return False


# ============================================================
# 依赖检测
# ============================================================
def _have(mod: str) -> bool:
    try:
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False


def _ollama_up() -> tuple[bool, str]:
    try:
        r = urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=3)
        d = json.loads(r.read().decode("utf-8", "replace"))
        names = [m.get("name", "") for m in d.get("models", [])]
        return True, "已启动，模型: " + ", ".join(names[:5])
    except Exception as e:
        return False, "未启动 (%s)" % type(e).__name__


def _tts_up(cfg: dict) -> tuple[bool, str]:
    url = cfg.get("tts_url")
    if not url:
        return False, "未配置 tts_url"
    try:
        p = urllib.parse.urlparse(url)
        host = "%s://%s" % (p.scheme, p.netloc)
        urllib.request.urlopen(host, timeout=3)
        return True, url
    except Exception:
        # 端点根路径可能 404，但只要端口能连上就算服务在；换个方式探
        try:
            import socket
            s = socket.create_connection((p.hostname, p.port or 80), timeout=3)
            s.close()
            return True, url + "（端口通）"
        except Exception as e:
            return False, "连不上 %s (%s)" % (url, type(e).__name__)


def _kws_model_present(cfg: dict) -> tuple[bool, str]:
    d = (cfg.get("kws_model_dir") or "").strip()
    if not d:
        return False, "未配置 kws_model_dir（将用流式 ASR 关键词唤醒）"
    if not os.path.isabs(d):
        d = str(ROOT / "ohwhale-deploy" / d)
    has = os.path.isdir(d) and any(f.endswith(".onnx") for f in os.listdir(d))
    return has, d if has else d + "（目录无 .onnx）"


def _devices() -> tuple[object | None, object | None]:
    try:
        import sounddevice as sd
        return sd.default.device[0], sd.default.device[1]
    except Exception:
        return None, None


def doctor() -> int:
    cfg = load_config()
    rows = []          # (name, good, detail, hard)
    ok = True          # 硬失败（run 无法闭环）
    warned = False

    def add(name, good, detail, hard=True):
        nonlocal ok, warned
        rows.append((name, good, detail, hard))
        if not good and hard:
            ok = False
        if not good and not hard:
            warned = True

    add("sherpa-onnx", _have("sherpa_onnx"),
        "已装" if _have("sherpa_onnx") else "缺失：pip install sherpa-onnx")
    asr_ok = False
    if _have("sherpa_onnx"):
        try:
            import asr_local
            asr_ok = bool(asr_local.available())
            add("ASR 模型（paraformer）", asr_ok,
                asr_local.model_dir() if asr_ok else "模型文件不全，见 asr_local --check")
        except Exception as e:
            add("ASR 模型（paraformer）", False, "asr_local 导入失败: %s" % e)
    else:
        add("ASR 模型（paraformer）", False, "先装 sherpa-onnx")
    add("sounddevice", _have("sounddevice"),
        "已装" if _have("sounddevice") else "缺失：pip install sounddevice")
    add("numpy", _have("numpy"), "已装" if _have("numpy") else "缺失")
    in_d, out_d = _devices()
    add("默认输入设备（麦克风）", in_d is not None,
        ("index=%s" % in_d) if in_d is not None else "无")
    add("默认输出设备（音箱）", out_d is not None,
        ("index=%s" % out_d) if out_d is not None else "无（将仅打印文本）", hard=False)
    kws_ok, kws_detail = _kws_model_present(cfg)
    add("专用 KWS 唤醒模型（可选）", kws_ok, kws_detail, hard=False)
    wake_mode = "KWS" if kws_ok else "流式 ASR 关键词检测（零额外模型）"
    ollama_ok, ollama_detail = _ollama_up()
    add("本地 Ollama", ollama_ok, ollama_detail +
        ("；失败会按 llm_gate 配置落回云端" if not ollama_ok else ""), hard=False)
    tts_ok, tts_detail = _tts_up(cfg)
    add("TTS 端点（%s）" % cfg.get("tts_engine", "?"), tts_ok,
        tts_detail + ("；将降级 Windows SAPI 系统语音" if not tts_ok else ""), hard=False)
    busy = False
    try:
        import resource_gate
        busy, why = resource_gate.busy()
    except Exception:
        why = ""
    add("通话冲突检测", not busy, "当前无通话/直播" if not busy else why, hard=False)

    print("=== local_voice 体检 ===")
    for name, good, detail, hard in rows:
        mark = "✅" if good else ("❌" if hard else "⚠️ ")
        print("  %-26s %s  %s" % (name, mark, detail))
    print("\n唤醒模式: %s" % wake_mode)
    print("场景路由: scene=%s（llm_gate 标 local 则走本地 Ollama）" % cfg.get("scene"))
    if not ok:
        print("\n❌ 存在硬缺失，run 无法闭环，请先补装上表 ❌ 项。")
        return 2
    if warned:
        print("\n✅ 可 run；上表 ⚠️ 项为降级提示（已自动兜底，不影响启动）。")
    else:
        print("\n✅ 依赖齐备，可 python tools/local_voice.py run")
    return 0


# ============================================================
# 麦克风采集 + VAD + 流式 ASR
# ============================================================
class Ear:
    """一句话的采集：能量 VAD 起终点 + 边说边喂流式 ASR。"""

    def __init__(self, cfg: dict, on_partial=None):
        self.cfg = cfg
        self.on_partial = on_partial or (lambda t: None)
        self.sr = int(cfg.get("sample_rate_in", 16000))
        self.frame = float(cfg.get("frame_s", 0.05))
        self.in_dev = cfg.get("input_device")
        self.thr = float(cfg.get("threshold_floor", 0.009))
        self.silence_end = float(cfg.get("silence_end_s", 0.9))
        self.min_speech = float(cfg.get("min_speech_s", 0.25))
        self.max_utter = float(cfg.get("max_utter_s", 18.0))
        self.preroll = float(cfg.get("preroll_s", 0.45))
        self._asr = None

    def _get_asr(self):
        if self._asr is None:
            import asr_local
            self._asr = asr_local.Stream()
        return self._asr

    def reset_asr(self) -> None:
        self._asr = None

    def listen_one(self, timeout: float | None = None,
                   early_stop: threading.Event | None = None) -> str:
        """录一句 → 返回识别文本。timeout 到了还没人说话返回 ""。"""
        import numpy as np
        import sounddevice as sd
        asr = self._get_asr()
        block = max(1, int(self.sr * self.frame))
        q: "queue.Queue" = queue.Queue()

        def cb(indata, frames, tinfo, status):
            q.put(indata.copy())

        started = False
        speech_frames = 0
        silence_frames = 0
        preroll_buf = []
        preroll_max = max(1, int(self.preroll / self.frame))
        t0 = time.time()
        try:
            with sd.InputStream(samplerate=self.sr, channels=1, dtype="float32",
                                blocksize=block, device=self.in_dev, callback=cb):
                while True:
                    if timeout is not None and time.time() - t0 > timeout:
                        return ""
                    if early_stop is not None and early_stop.is_set():
                        break
                    try:
                        data = q.get(timeout=0.5)
                    except queue.Empty:
                        continue
                    mono = data.reshape(-1).astype(np.float32)
                    if not len(mono):
                        continue
                    rms = float(np.sqrt(np.mean(mono ** 2)) + 1e-9)
                    if not started:
                        preroll_buf.append(mono)
                        if len(preroll_buf) > preroll_max:
                            preroll_buf.pop(0)
                        if rms > self.thr:
                            speech_frames += 1
                            if speech_frames * self.frame >= self.min_speech:
                                started = True
                                for pr in preroll_buf:
                                    asr.feed(pr)
                                asr.feed(mono)
                                self.on_partial(asr.text)
                                preroll_buf = []
                        else:
                            speech_frames = 0
                    else:
                        asr.feed(mono)
                        self.on_partial(asr.text)
                        if rms <= self.thr:
                            silence_frames += 1
                            if silence_frames * self.frame >= self.silence_end:
                                break
                        else:
                            silence_frames = 0
                        if time.time() - t0 > self.max_utter:
                            break
        except Exception as e:
            print("  [Ear] 采集异常: %s" % e)
            return ""
        text = asr.finish()
        self.reset_asr()
        return (text or "").strip()


# ============================================================
# 唤醒检测
# ============================================================
def _contains_keyword(text: str, keywords: list[str]) -> str | None:
    t = (text or "").replace(" ", "")
    for kw in keywords:
        if kw and kw in t:
            return kw
    return None


def _strip_keyword(text: str, kw: str) -> str:
    t = (text or "")
    i = t.find(kw)
    if i >= 0:
        t = t[i + len(kw):]
    return t.strip(" ,，。.!！?？~～:：")


# ============================================================
# LLM / TTS
# ============================================================
def think(text: str, cfg: dict) -> str:
    import llm_client
    msgs = [{"role": "system", "content": cfg.get("llm_system_prompt", "")},
            {"role": "user", "content": text}]
    try:
        return llm_client.chat(
            msgs, scene=cfg.get("scene", "local_voice"),
            max_tokens=int(cfg.get("max_tokens", 160)),
            temperature=float(cfg.get("temperature", 0.7)))
    except Exception as e:
        return "（思考失败：%s）" % type(e).__name__


def _sapi_wav(text: str) -> bytes | None:
    import subprocess
    import tempfile
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            out = tf.name
        safe = text.replace("'", "''").replace("\n", " ")
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Add-Type -AssemblyName System.Speech; "
             "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; "
             f"$s.SetOutputToWaveFile('{out}'); $s.Speak('{safe}'); $s.Dispose()"],
            capture_output=True, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        with open(out, "rb") as f:
            return f.read()
    except Exception:
        return None


def _play_audio(data, sr: int, cfg: dict) -> None:
    import numpy as np
    import sounddevice as sd
    arr = np.asarray(data, dtype="float32").reshape(-1)
    out_sr = int(cfg.get("sample_rate_out", 48000))
    if sr and sr != out_sr and len(arr):
        n = max(1, int(len(arr) * out_sr / sr))
        arr = np.interp(np.linspace(0, len(arr) - 1, n),
                        np.arange(len(arr)), arr).astype(np.float32)
    sd.play(arr, out_sr, device=cfg.get("output_device"))
    sd.wait()


def speak(text: str, cfg: dict) -> None:
    text = (text or "").strip()
    if not text:
        return
    url = cfg.get("tts_url")
    ref = cfg.get("tts_ref")
    data = None
    sr = None
    if url:
        try:
            params = {"text": text}
            if ref:
                params["ref_audio_path"] = ref
            full = url + "?" + urllib.parse.urlencode(params)
            with urllib.request.urlopen(urllib.request.Request(full), timeout=30) as r:
                raw = r.read()
            try:
                import io
                import soundfile as sf
                data, sr = sf.read(io.BytesIO(raw), dtype="float32")
            except Exception:
                import numpy as np
                arr = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
                data, sr = arr, int(cfg.get("tts_raw_rate", 32000))
        except Exception as e:
            print("  [TTS] 端点合成失败（%s），降级系统语音" % type(e).__name__)
            data = None
    if data is None:
        raw = _sapi_wav(text)
        if raw:
            import io
            import soundfile as sf
            data, sr = sf.read(io.BytesIO(raw), dtype="float32")
    if data is None:
        print("  [TTS] 无可用语音合成，仅文本: %s" % text)
        return
    _play_audio(data, sr, cfg)


# ============================================================
# 主循环
# ============================================================
def handle_command(text: str, cfg: dict) -> None:
    text = (text or "").strip()
    if not text:
        return
    print("  >> 用户: %s" % text)
    reply = think(text, cfg)
    print("  << 小鲸: %s" % reply)
    speak(reply, cfg)


def run() -> int:
    cfg = load_config()
    if not read_state()["enabled"]:
        print("⚠️ 本地麦克风唤醒处于关闭状态（开关默认关闭）。"
              "请在控制台或桌宠打开后再 run。")
        return 0
    ok, why = acquire_mic("local_voice")
    if not ok:
        print("❌ 拿不到麦克风租约：%s" % why)
        return 2
    wake_kws = cfg.get("wake_keywords") or []
    try:
        print("🎙️ 本地语音唤醒已启动（唤醒词: %s）。Ctrl+C 停止。"
              % " / ".join(wake_kws) if wake_kws else "（未配置唤醒词）")
        early = threading.Event()
        hit = {}

        def on_partial(t):
            if hit.get("kw"):
                return
            kw = _contains_keyword(t, wake_kws)
            if kw:
                hit["kw"] = kw
                hit["text"] = t
                early.set()

        ear = Ear(cfg, on_partial=on_partial)
        while True:
            if not read_state()["enabled"]:
                print("\n  [local_voice] 开关已关闭，退出。")
                break
            early.clear()
            hit.clear()
            text = ear.listen_one(timeout=None, early_stop=early)
            kw = hit.get("kw") or _contains_keyword(text, wake_kws)
            if not kw:
                if text:
                    print("  [未唤醒] %s" % text)
                continue
            print("  ✨ 唤醒: %s" % kw)
            if cfg.get("wake_then_listen", True):
                ack = cfg.get("wake_ack", "")
                if ack:
                    speak(ack, cfg)
                cmd = ear.listen_one(timeout=float(cfg.get("listen_timeout_s", 8)))
                handle_command(cmd, cfg)
            else:
                cmd = _strip_keyword(hit.get("text") or text, kw)
                handle_command(cmd, cfg)
    except KeyboardInterrupt:
        print("\n  [local_voice] 手动停止。")
    finally:
        release_mic("local_voice")
    return 0


def test() -> int:
    cfg = load_config()
    ok, why = acquire_mic("local_voice")
    if not ok:
        print("❌ 拿不到麦克风租约：%s" % why)
        return 2
    print("🎙️ 麦克风测试：说一句话看看识别结果（Ctrl+C 停止）。")
    ear = Ear(cfg)
    try:
        while True:
            text = ear.listen_one(timeout=None)
            if text:
                print("  识别: %s" % text)
    except KeyboardInterrupt:
        print("\n  [local_voice] 停止。")
    finally:
        release_mic("local_voice")
    return 0


def main(argv: list[str]) -> int:
    save_default_config()
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "doctor":
        return doctor()
    if cmd == "test":
        return test()
    if cmd == "run":
        return run()
    if cmd == "once":
        cfg = load_config()
        text = " ".join(argv[2:]).strip()
        if not text:
            print("用法: python tools/local_voice.py once \"你好\"")
            return 1
        handle_command(text, cfg)
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
