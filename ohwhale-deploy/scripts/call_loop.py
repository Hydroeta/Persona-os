"""QQ 通话闭环 v2：听 → 识别 → 思考 → 说话（支持打断 / 分句流式）

相对 v1 的四处改动：
  1. 电话模式人设：只回 1~2 句、30 字内、不分段 —— 单轮时长砍半
  2. VAD 加 0.3s 前置缓冲 + 自适应噪声底 —— 不再吞掉第一个字
  3. TTS 分句流式：第一句合成完就先播，后面的边播边合成 —— 首字延迟减半
  4. 支持打断：她说话时你一开口，立刻停

链路：
    你说话 → QQ 播放到 JBL → 环回录音 → VAD → DashScope ASR
      → DeepSeek（她的性格 + 电话模式）→ GPT-SoVITS → VB-Cable → QQ 麦克风

用法：
    python -u call_loop.py            # 一直循环
    python -u call_loop.py --once     # 只处理一句话
"""

from __future__ import annotations

from ohwhale.config import get as setting, path as config_path, project_path, state_path, log_path, secret, llm, require

import argparse
import json
import os
import queue
import re
import sqlite3
import sys
import threading
import time

# 控制台/重定向默认按 GBK 编码，她的回复里一出现 emoji（🍚 这种）就抛
# UnicodeEncodeError 直接把整个通话循环带走 —— 2026-10-23 12:14 就是这么挂的。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

import base64
import io
import socket

import httpx
import numpy as np

try:
    from astrbot_bridge import AstrBotBridge
except Exception:  # noqa: BLE001
    AstrBotBridge = None
import soundcard as sc
import sounddevice as sd
import soundfile as sf

# LLM token 闸门（成本主战场）：日/月预算 + 场景配额，超限固定应答兜底
try:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "..", "..", "tools"))
    import llm_gate
except Exception:  # noqa: BLE001
    llm_gate = None

# 本地 ASR 适配器（可选）：装了 funasr 且配置指向它才生效，否则照旧走 DashScope
try:
    import asr_local
except Exception:  # noqa: BLE001
    asr_local = None

# 时间机器 / 状态引擎 / 关系温度计（观测与状态组件，挂了不影响通话主线）
try:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "..", "..", "tools"))
    import timeline
except Exception:  # noqa: BLE001
    timeline = None
try:
    import state_engine
except Exception:  # noqa: BLE001
    state_engine = None
try:
    import pet_bus
except Exception:  # noqa: BLE001
    pet_bus = None
try:
    import relations
except Exception:  # noqa: BLE001
    relations = None
# P2：呼吸停顿 / 反套话守卫 / 关怀（情绪急救）/ 语音留言 / 来电情境 / 静默日
for _m in ("tts_breathe", "guard", "care", "voice_mail", "call_context",
           "silent_day", "watermark"):
    try:
        globals()[_m] = __import__(_m)
    except Exception:  # noqa: BLE001
        globals()[_m] = None

HEARTBEAT = log_path("loop.heartbeat")
CFG = config_path("astrbot_config")
DB = config_path("astrbot_db")

RATE_IN = 16000
RATE_OUT = 48000
FRAME = 0.05            # 50ms 一帧
SILENCE_END = 0.90      # 静音多久算说完（0.55 太急，一句话中间换气就被截断）
MIN_SPEECH = 0.25
# 电话走不走 AstrBot：False = 直连模型（快、带电话模式），True = 走 AstrBot（有记忆/工具但慢）
PHONE_USE_BRIDGE = setting("audio.use_astrbot_bridge", False)
MAX_UTTER = 18.0
PREROLL = 0.45          # 前置缓冲，防止吞首字
THRESHOLD_FLOOR = 0.009
INTERRUPT_RATIO = 3.0   # 打断判定：能量超过阈值这么多倍（2.0 时环境噪音就误触发）

# 谁在往哪个端点送声音 —— 不能靠"默认扬声器"猜（他改过音频设备）
PROBE_PY = config_path("probe_python")
PROBE_SCRIPT = project_path("scripts/which_endpoint.py")
# TTS 引擎：indextts2 走 scripts/indextts_server.py（零样本克隆，只需参考音频）；
# 其他值维持 GPT-SoVITS api_v2。两边都返回 s16le 单声道 PCM，播放逻辑一致。
TTS_ENGINE = setting("services.tts_engine", "gpt_sovits")
if TTS_ENGINE == "indextts2":
    TTS_API = setting("services.indextts_url", "http://127.0.0.1:9881/tts")
    TTS_PARAMS = {"ref_audio_path": config_path("voice_ref")}
else:
    TTS_API = setting("services.tts_url")
    TTS_PARAMS = {
        "text_lang": "zh",
        "ref_audio_path": config_path("voice_ref"),
        "prompt_text": setting("voice.prompt_text"),
        "prompt_lang": "zh",
        "text_split_method": "cut0",
        "media_type": "wav",
    }

PHONE_MODE = """

【电话模式】
你现在在打语音电话，不是发文字消息。
· 每次只说 1~2 句，总共不超过 30 字
· 不要分段、不要换行、不要列点、不要括号动作
· 像真人接电话那样短、口语、可以带语气词
· 说完就停，把话头留给对方"""

# 把"正在说话的音量"发给 avatar.py 做口型，最高 30Hz 就够
AVATAR = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

# 流式合成：GPT-SoVITS 的 streaming_mode=3 + media_type=raw，边合成边出声。
# 原来要等整句 wav 合成完（约 1.3 s）才开始播，首字里最大的一块就是它。
TTS_STREAM = True
TTS_RAW_RATE = int(setting("audio.tts_raw_rate", 32000))
PLAY_START = 0.0        # 这一轮开口的时间点，用于"刚开口别被打断"的宽限
TTS_CLIENT = httpx.Client(timeout=120, trust_env=False,
                          limits=httpx.Limits(max_keepalive_connections=4))
VISION_MODEL = setting("llm.screen.model")
VISION_API = setting("llm.screen.base_url").rstrip("/") + "/chat/completions"
SEEWORDS = ("看", "屏幕", "画面", "这个", "那个", "图", "样子", "长啥样", "长得")

PLAYING = threading.Event()     # 她正在说话
INTERRUPT = threading.Event()   # 有人插话
LAST_PLAY_END = 0.0             # 她最近一次说完的时间点，用于回声抑制
ECHO_COOLDOWN = 0.8             # 说完后 0.8s 内出现的"发言"视为回声/对方回放

METRICS = log_path("call_metrics.jsonl")
# 通话后回味：每通电话写一份结构化摘要，下次同人来电开场接上
SUMMARY_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "data", "call_summaries")
# 本地 sherpa-onnx 能跑就完全不碰云端 ASR（也就不再需要 DASHSCOPE_API_KEY）
USE_LOCAL_ASR = asr_local is not None and asr_local.available()

# ---------- P1：陪伴静默模式 + 声音状态化 + 时间机器 ----------
ROOT_DIR = os.path.dirname(os.path.dirname(SUMMARY_DIR))   # 仓库根目录（config/ 的上一级）
CALL_MODE_FILE = os.path.join(ROOT_DIR, "config", "call_mode.json")
SILENT_PHRASES_FILE = os.path.join(ROOT_DIR, "data", "silent_phrases.json")
PERSONA_JSON = os.path.join(ROOT_DIR, "config", "persona.json")
PRESENCE_EVERY = 600.0   # 静默模式下最多每 10 分钟主动「在呢」一次

SILENT_DEFAULT = {
    "greet": ["嗯，在呢。", "我一直都在呀。"],
    "question": ["嗯……你说，我听着。", "在呢，怎么了？"],
    "ack": ["嗯嗯。", "在听。", "好呀。"],
    "presence": ["在呢。"],
}

_silent_cache = {"t": 0.0, "v": False}


def silent_mode() -> bool:
    """读 config/call_mode.json 的 silent 开关（5 秒缓存，控制台可随时切）。"""
    if time.time() - _silent_cache["t"] < 5:
        return _silent_cache["v"]
    try:
        with open(CALL_MODE_FILE, encoding="utf-8") as f:
            v = bool(json.load(f).get("silent"))
    except Exception:  # noqa: BLE001
        v = False
    _silent_cache.update(t=time.time(), v=v)
    return v


def silent_reply(text: str) -> str:
    """静默模式的应答：预生成短句缓存，LLM 降到 0（零 token 成本）。"""
    phrases = dict(SILENT_DEFAULT)
    try:
        with open(SILENT_PHRASES_FILE, encoding="utf-8") as f:
            phrases.update(json.load(f))
    except Exception:  # noqa: BLE001
        pass
    t = text or ""
    if any(w in t for w in ("在吗", "还在吗", "喂", "睡了吗")):
        pool = phrases.get("greet")
    elif "?" in t or "？" in t:
        pool = phrases.get("question")
    else:
        pool = phrases.get("ack")
    import random
    return random.choice(pool or ["在呢。"])


CURRENT_VOICE_EXTRA: dict = {}   # 本轮声音状态参数（语速/参考音频），每轮说话前刷新


def ambient_plan() -> dict:
    """背景音场景（P2 框架位）：读 config/call_mode.json 的 ambient 段。

    素材需自备：把雨声/咖啡店/虫鸣等 wav 放到 ohwhale-deploy/assets/ambient/，
    再填 {"ambient": {"enabled": true, "file": "rain.wav", "volume": 0.15}}。
    文件不存在自动置 enabled=False。混音在播放端进行（Speaker 层预留此配置）。
    """
    try:
        with open(CALL_MODE_FILE, encoding="utf-8") as f:
            amb = json.load(f).get("ambient") or {}
    except Exception:  # noqa: BLE001
        amb = {}
    path = os.path.join(ROOT_DIR, "ohwhale-deploy", "assets", "ambient",
                        str(amb.get("file", "")))
    ok = bool(amb.get("enabled")) and bool(amb.get("file")) and os.path.isfile(path)
    return {"enabled": ok, "path": path if ok else "",
            "volume": float(amb.get("volume", 0.15))}


def voice_extra() -> dict:
    """声音状态化：按 config/persona.json voice.states + 状态引擎选语速/参考音频。
    顶层 voice.ref_audio / prompt_text 是默认参考音（人格蒸馏同步进来的克隆音色）；
    各 state 若自带 ref_audio 则覆盖默认。"""
    try:
        with open(PERSONA_JSON, encoding="utf-8") as f:
            voice = json.load(f).get("voice") or {}
    except Exception:  # noqa: BLE001
        return {}
    states = voice.get("states") or {}
    if not isinstance(states, dict):
        states = {}
    # 默认参考音来自顶层 voice（人格蒸馏 sync_voice_to_config 写入）
    default_ref = voice.get("ref_audio")
    default_prompt = voice.get("prompt_text")
    key = "default"
    sick = False   # P2「角色生病」：精力极低时声音沙哑、语速再压一档
    if state_engine is not None:
        try:
            st = state_engine.status()
            if st.get("sleeping") and "sleepy" in states:
                key = "sleepy"
            elif st.get("energy", 1.0) < 0.15:
                sick = True
                key = "sick" if "sick" in states else "tired"
            elif st.get("energy", 1.0) < 0.3 and "tired" in states:
                key = "tired"
            elif st.get("mood", 0.5) > 0.7 and "happy" in states:
                key = "happy"
        except Exception:  # noqa: BLE001
            pass
    pick = states.get(key) or {}
    extra: dict = {}
    if pick.get("speed_factor"):
        extra["speed_factor"] = float(pick["speed_factor"])
    if sick:   # 生病时不管选到哪个状态，语速都再压一档，且保证有减速
        extra["speed_factor"] = round(float(extra.get("speed_factor", 1.0)) * 0.9, 3)
    # 状态自带参考音优先，否则用顶层默认参考音（人格蒸馏同步的克隆音色）
    ref = pick.get("ref_audio") or default_ref
    if ref:
        p = ref if os.path.isabs(ref) else os.path.join(ROOT_DIR, ref)
        if os.path.isfile(p):
            extra["ref_audio_path"] = p
            # GPT-SoVITS 换参考音必须同步换提示文本，否则音素对不上、克隆音跑偏；
            # IndexTTS2 不需要提示文本
            if TTS_ENGINE != "indextts2":
                prompt = pick.get("prompt_text") or default_prompt
                if prompt:
                    extra["prompt_text"] = str(prompt)
    return extra


def metric(event: str, **fields) -> None:
    """通话链路埋点：一轮一行 jsonl，控制台指标页直接读它算 P50/P95。"""
    try:
        with open(METRICS, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": round(time.time(), 3), "event": event, **fields},
                               ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        pass


def report_stats() -> None:
    """打印端到端延迟 P50/P95 与打断率（首音时间 = 识别+思考+合成）。"""
    try:
        turns = []
        with open(METRICS, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                if d.get("event") == "turn":
                    turns.append(d)
        if not turns:
            return
        lat = sorted(t["tts_first"] for t in turns if t.get("tts_first") is not None)
        if lat:
            p50 = lat[len(lat) // 2]
            p95 = lat[min(len(lat) - 1, int(len(lat) * 0.95))]
            intr = sum(1 for t in turns if t.get("interrupted")) / len(turns)
            print(f"  [统计] 共 {len(turns)} 轮｜首音延迟 P50={p50:.1f}s P95={p95:.1f}s"
                  f"｜打断率 {intr:.0%}")
    except Exception:  # noqa: BLE001
        pass


def load_cfg():
    return {}


def get_keys(cfg):
    key, base, _ = llm("chat")
    # 本地 ASR + 不看屏幕时根本用不到阿里云；没填就当成空，不再拦住启动
    try:
        ali = secret("DASHSCOPE_API_KEY")
    except Exception:  # noqa: BLE001
        ali = ""
    return key, base, ali


def get_persona() -> str:
    with open(config_path("persona"), encoding="utf-8-sig") as f:
        base = f.read()
    base = re.sub(r"# 表情包\n(?:.*\n)*?(?=# |\Z)", "", base)
    return base + PHONE_MODE


def load_last_summary() -> str:
    """取最近一份通话摘要，拼成开场上下文。没有就返回空串。"""
    try:
        names = sorted(n for n in os.listdir(SUMMARY_DIR) if n.endswith(".json"))
    except OSError:
        return ""
    if not names:
        return ""
    try:
        with open(os.path.join(SUMMARY_DIR, names[-1]), encoding="utf-8") as f:
            d = json.load(f)
    except Exception:  # noqa: BLE001
        return ""
    s = (d.get("summary") or "").strip()
    if not s:
        return ""
    return ("\n\n【上次通话 · %s】\n你们聊到：%s\n"
            "可以自然接上这件事，但别复述摘要、别像汇报。" % (d.get("date", "之前"), s))


def save_call_summary(key: str, base: str, transcript: list, turns: int) -> dict:
    """通话结束写结构化摘要（走 LLM 记账；失败就用原话兜底，绝不阻塞挂断）。"""
    if not transcript:
        return {}
    text = "\n".join("%s：%s" % ("他" if t["role"] == "user" else "我", t["content"])
                     for t in transcript[-24:])
    summary = ""
    try:
        if llm_gate is not None:
            try:
                llm_gate.allow("call", llm_gate.est_tokens(len(text) + 120))
            except llm_gate.GateError as e:
                raise RuntimeError(str(e))
        with httpx.Client(timeout=25, trust_env=False) as cli:
            r = cli.post("%s/chat/completions" % base.rstrip("/"),
                         json={"model": setting("llm.chat.model"), "temperature": 0.4,
                               "max_tokens": 120,
                               "messages": [
                                   {"role": "system",
                                    "content": "把这段电话对话写成给下一次通话用的备忘："
                                               "一句 60 字内的中文，写清聊了什么、他什么心情、"
                                               "有没有答应过的事。只输出这一句，不要解释。"},
                                   {"role": "user", "content": text}]},
                         headers={"Authorization": "Bearer %s" % key})
            summary = (r.json()["choices"][0]["message"].get("content") or "").strip()
        if llm_gate is not None and summary:
            llm_gate.record("call", len(text) + 120, len(summary))
    except Exception as e:  # noqa: BLE001
        print("  [回味] 摘要生成失败(%s)，用原话兜底" % e)
    if not summary:
        lines = [t["content"] for t in transcript if t["role"] == "user"][-3:]
        summary = "、".join(x[:40] for x in lines)[:120] or "这次没聊什么"
    rec = {"date": time.strftime("%Y-%m-%d %H:%M"), "turns": turns,
           "summary": summary,
           "topics": [t["content"][:40] for t in transcript
                      if t["role"] == "user"][-5:]}
    try:
        os.makedirs(SUMMARY_DIR, exist_ok=True)
        path = os.path.join(SUMMARY_DIR, time.strftime("%Y%m%d-%H%M%S") + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=2)
        metric("call_summary", ok=True, turns=turns)
        print("  [回味] 已存：%s" % summary)
    except OSError as e:
        metric("call_summary", ok=False, error=type(e).__name__)
    return rec


def split_sentences(text: str) -> list[str]:
    """按标点切句，太碎的并到前一句。

    阈值取 4 字：`嗯，我在呢。` 只有 6 个字，如果按 8 字合并就会和下一句粘在一起，
    分句流式就失去意义了 —— 第一句必须尽早能播。
    """
    parts = re.split(r"(?<=[。！？!?；;\n])", text)
    out, buf = [], ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        buf += p
        if len(buf) >= 4:
            out.append(buf)
            buf = ""
    if buf:
        if out:
            out[-1] += buf
        else:
            out.append(buf)
    return out or [text.strip()]


def resample(x: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return x.astype("float32")
    n = int(round(len(x) * target / sr))
    return np.interp(np.linspace(0, len(x) - 1, n),
                     np.arange(len(x)), x).astype("float32")


class SpeechPlaybackError(RuntimeError):
    """只包含本地生成的诊断文字，不包含服务端响应或凭据。"""


class Speaker:
    def __init__(self):
        self.dev = None
        for i, d in enumerate(sd.query_devices()):
            if setting("audio.playback_hint") in d["name"] and d["max_output_channels"] >= 2:
                self.dev = i
        if self.dev is None:
            raise RuntimeError("找不到 VB-Cable 播放端点")

    def _play_into(self, st, data: np.ndarray, sr: int, on_first_write=None) -> bool:
        """往已打开的流里写一段；返回 True 表示被打断。"""
        data = resample(data, sr, RATE_OUT)
        stereo = np.column_stack([data, data]).astype("float32")
        chunk = 2048
        for i in range(0, len(stereo), chunk):
            if INTERRUPT.is_set():
                return True
            block = stereo[i:i + chunk]
            st.write(block)
            if on_first_write:
                on_first_write()
                on_first_write = None
            # 口型同步：这一段有多响，嘴就张多大（0.06 是经验缩放）
            try:
                rms = float(np.sqrt(np.mean(block ** 2)))
                AVATAR.sendto(f"{min(1.0, rms * 6.0):.3f}".encode(), ("127.0.0.1", int(setting("services.avatar_udp_port"))))
            except Exception:  # noqa: BLE001
                pass
        return INTERRUPT.is_set()

    def say_streaming(self, text: str, on_first_audio=None) -> bool:
        """分句合成 + 边收边播。返回 True 表示被打断。

        2026-10-23：改成流式（streaming_mode=3 / raw PCM），第一块音频到达就开播，
        不用等整句合成完。首字里的"合成"从 ~1.3 s 降到 ~0.3 s。
        """
        global PLAY_START
        parts = split_sentences(text)
        q_app: queue.Queue = queue.Queue()
        cancelled = threading.Event()

        def stopping():
            return cancelled.is_set() or INTERRUPT.is_set()

        def worker():
            for p in parts:
                if stopping():
                    break
                try:
                    params = dict(TTS_PARAMS, text=p, **CURRENT_VOICE_EXTRA)
                    if TTS_STREAM:
                        params.update({"streaming_mode": 3, "media_type": "raw",
                                       "batch_size": 1})
                        with TTS_CLIENT.stream("GET", TTS_API, params=params) as r:
                            if r.status_code != 200:
                                raise SpeechPlaybackError(f"TTS HTTP {r.status_code}")
                            buf = b""
                            for piece in r.iter_raw():
                                if stopping():
                                    break
                                buf += piece
                                cut = len(buf) - (len(buf) % 2)
                                if cut < 2:
                                    continue
                                pcm = np.frombuffer(buf[:cut], dtype="<i2")
                                buf = buf[cut:]
                                q_app.put(("raw", pcm.astype(np.float32) / 32768.0))
                    else:
                        r = TTS_CLIENT.get(TTS_API, params=params)
                        r.raise_for_status()
                        if r.content:
                            q_app.put(("wav", r.content))
                except Exception as e:  # noqa: BLE001
                    q_app.put(("error", str(e) if isinstance(e, SpeechPlaybackError) else type(e).__name__))
                    break
            q_app.put(None)

        INTERRUPT.clear()
        # 合成等待不算已经开口；否则用户尾音会在首块 PCM 到来前触发打断。
        PLAY_START = 0.0
        PLAYING.set()
        first = True
        interrupted = False

        def first_write():
            nonlocal first
            global PLAY_START
            first = False
            PLAY_START = time.time()
            if on_first_audio:
                on_first_audio()

        try:
            with sd.OutputStream(samplerate=RATE_OUT, channels=2,
                                 device=self.dev, dtype="float32") as st:
                threading.Thread(target=worker, daemon=True).start()
                while True:
                    item = q_app.get()
                    if item is None:
                        break
                    if INTERRUPT.is_set():
                        interrupted = True
                        break
                    kind, payload = item
                    if kind == "error":
                        raise SpeechPlaybackError(f"TTS 请求失败 ({payload})")
                    if kind == "raw":
                        data, sr = payload, TTS_RAW_RATE
                    else:
                        data, sr = sf.read(io.BytesIO(payload), dtype="float32")
                    if data.ndim > 1:
                        data = data.mean(axis=1)
                    if not len(data):
                        continue
                    if self._play_into(st, data, sr, first_write if first else None):
                        interrupted = True
                        break
            interrupted = interrupted or INTERRUPT.is_set()
            if first and not interrupted:
                raise SpeechPlaybackError("TTS 未返回可播放音频")
            return interrupted
        finally:
            # 旧请求即使尚未返回，也不能在下一轮清除 INTERRUPT 后继续生成。
            cancelled.set()
            PLAYING.clear()
            PLAY_START = 0.0
            global LAST_PLAY_END
            LAST_PLAY_END = time.time()


def _sapi_wav(text: str) -> bytes | None:
    """TTS 降级兜底：GPT-SoVITS 挂了就用 Windows SAPI 系统语音合成 wav。

    断网/显存爆都能用；音色不是她，但电话不至于整个哑掉。
    """
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
            capture_output=True, timeout=30)
        with open(out, "rb") as f:
            return f.read()
    except Exception:  # noqa: BLE001
        return None


def speak_reply(speaker, reply, *, started_at, asr_seconds, llm_seconds):
    """播放失败只结束当前回复，不让诊断输出把整个监听循环带走。"""
    t_play = time.time()
    if tts_breathe is not None:
        try:
            reply = tts_breathe.humanize(reply)   # 呼吸感：长句插停顿标记
        except Exception:  # noqa: BLE001
            pass
    first_at = []
    try:
        interrupted = speaker.say_streaming(
            reply, on_first_audio=lambda: first_at.append(time.time() - started_at))
    except Exception as exc:  # noqa: BLE001
        detail = str(exc) if isinstance(exc, SpeechPlaybackError) else type(exc).__name__
        print(f"  [语音播放失败] {detail}；尝试系统语音兜底")
        metric("tts_fail", detail=detail)
        fb = _sapi_wav(reply)
        if fb:
            try:
                data, sr = sf.read(io.BytesIO(fb), dtype="float32")
                if data.ndim > 1:
                    data = data.mean(axis=1)
                INTERRUPT.clear()
                with sd.OutputStream(samplerate=RATE_OUT, channels=2,
                                     device=speaker.dev, dtype="float32") as st:
                    speaker._play_into(st, data, sr)
                print("  [TTS 降级] 已用系统语音兜底（音色不同属正常）")
                metric("tts_fallback", ok=True)
            except Exception:  # noqa: BLE001
                metric("tts_fallback", ok=False)
        return
    if not first_at:
        print("  [未播放] 首段音频前被打断" if interrupted else
              "  [未播放] 没有音频写入输出设备；继续监听")
        return
    play_seconds = time.time() - t_play
    print(f"  （首段写入 {first_at[0]:.1f}s ＝ 识别 {asr_seconds:.1f} + 思考 {llm_seconds:.1f} + 合成"
          f"｜播放阶段 {play_seconds:.1f}s"
          f"｜{'被打断' if interrupted else '说完'}）")
    metric("turn", tts_first=round(first_at[0], 3), asr=round(asr_seconds, 3),
           llm=round(llm_seconds, 3), play=round(play_seconds, 3),
           interrupted=bool(interrupted), chars=len(reply), reply=reply[:120])
    if watermark is not None and not interrupted:
        try:
            watermark.stamp(reply, None, source="call")   # 语音台账：文本哈希
        except Exception:  # noqa: BLE001
            pass


class StreamASR:
    """边说边识别。

    实测：整段发给 paraformer-realtime，`stop()` 要等 1.3 s 才拿到句末结果，
    但音频上传本身几乎不花时间。所以把"上传"摊到她还在说话的这几秒里做，
    说完时只剩尾包要等（约 0.3 s）。识别失败不抛，交给上层退回整段识别。
    """

    def __init__(self):
        self.text = ""
        self.ok = False
        self.rec = None
        self.cb = None
        self.local = None
        if USE_LOCAL_ASR:
            # 本地 sherpa-onnx 也支持真流式：边说边 decode，说完只剩尾包
            try:
                self.local = asr_local.Stream()
                self.ok = True
            except Exception as e:  # noqa: BLE001
                print(f"  [ASR] 本地流式会话开不起来：{e}")
            return
        try:
            from dashscope.audio.asr import Recognition, RecognitionCallback

            outer = self

            class _CB(RecognitionCallback):
                def __init__(self):
                    self.parts: list[tuple] = []

                def on_event(self, result):
                    s = result.get_sentence()
                    if not s or not s.get("text"):
                        return
                    key = s.get("begin_time") or len(self.parts)
                    self.parts = [p for p in self.parts if p[0] != key] + [(key, s["text"])]
                    outer.text = "".join(t for _, t in sorted(self.parts, key=lambda x: x[0]))

            self.cb = _CB()
            self.rec = Recognition(model=setting("audio.asr_model"), format="pcm",
                                   sample_rate=RATE_IN, callback=self.cb)
            self.rec.start()
            self.ok = True
        except Exception as e:  # noqa: BLE001
            print(f"  [ASR] 流式会话开不起来：{e}")

    def feed(self, frame: np.ndarray) -> None:
        if not self.ok:
            return
        if self.local is not None:
            self.local.feed(frame)
            self.text = self.local.text
            if not self.local.ok:
                self.ok = False
            return
        try:
            pcm = (np.clip(frame, -1, 1) * 32767).astype("<i2").tobytes()
            self.rec.send_audio_frame(pcm)
        except Exception:  # noqa: BLE001
            self.ok = False

    def finish(self) -> str:
        if not self.ok:
            return ""
        if self.local is not None:
            return self.local.finish() or (self.text or "").strip()
        try:
            self.rec.stop()
        except Exception:  # noqa: BLE001
            return ""
        return (self.text or "").strip()


class _Switch(Exception):
    """内部信号：换一个端点重新开录音。"""


class Ear:
    """环回录音 + VAD。她说的时候如果检测到你开口，就置 INTERRUPT。

    两条踩过的坑：
    1. 多路混流（每 50 ms 只留最响一路）等于把语音剪掉 2/3 → ASR 恒空。
       所以这里**一次只录一路干净的流**，另有 scout 每 5 秒确认声音还在不在这一路。
    2. `rec.record()` 在设备失效时会永久阻塞（不报错、也不给数据），进程看着活着其实聋了。
       所以采集放独立线程，主循环 2 秒收不到帧就重开。
    """

    def __init__(self, on_utterance):
        self.on_utterance = on_utterance
        self.candidates = self._candidates()
        self.current = self._initial()
        self.running = False
        self.noise = 0.005
        self._switch_to = None
        self.stat_peak = 0.0
        self.stat_utts = 0
        self._last_stat = 0.0
        self._asr = None

    @staticmethod
    def _candidates() -> list[str]:
        names: list[str] = []
        try:
            names.append(sc.default_speaker().name)
        except Exception:  # noqa: BLE001
            pass
        for hint in setting("audio.listen_hints", []):
            try:
                for s in sc.all_speakers():
                    if hint in s.name and s.name not in names:
                        names.append(s.name)
            except Exception:  # noqa: BLE001
                pass
        return names

    def _initial(self) -> str:
        try:
            return sc.default_speaker().name
        except Exception:  # noqa: BLE001
            return self.candidates[0]

    @staticmethod
    def _probe() -> dict:
        """问一句：QQ 现在往哪个端点播？（pycaw 跑在独立 venv 里，不往 AstrBot 环境装包）"""
        import subprocess
        if not (os.path.exists(PROBE_PY) and os.path.exists(PROBE_SCRIPT)):
            return {}
        try:
            r = subprocess.run([PROBE_PY, PROBE_SCRIPT, "qq"],
                               capture_output=True, timeout=25)
            return json.loads(r.stdout.decode("utf-8", "replace") or "{}")
        except Exception:  # noqa: BLE001
            return {}

    def _scout(self) -> None:
        """每 5 秒确认一次对方的声音落在哪个端点。她说话时不切，免得听自己。"""
        while self.running:
            time.sleep(5)
            if PLAYING.is_set():
                continue
            info = self._probe()
            if not info:
                continue
            target = (info.get("qq") or {}).get("endpoint") or info.get("loudest")
            if not target or ("VB-Audio Virtual Cable" in target and "CABLE In" not in target):
                continue
            if target != self.current:
                print(f"  [录音] 对方的声音在 {target}，从 {self.current} 切过去")
                self._switch_to = target

    def _listen(self, name: str) -> None:
        buf, speech, silence = [], 0.0, 0.0
        pre = []
        pre_len = max(1, int(PREROLL / FRAME))
        chunk = int(RATE_IN * FRAME)
        hot = 0

        q: queue.Queue = queue.Queue(maxsize=400)
        stop = threading.Event()

        def pump() -> None:
            try:
                d = sc.get_microphone(id=name, include_loopback=True)
                with d.recorder(samplerate=RATE_IN) as rec:
                    while self.running and not stop.is_set():
                        try:
                            q.put(rec.record(numframes=chunk), timeout=1.0)
                        except queue.Full:
                            try:
                                q.get_nowait()
                            except queue.Empty:
                                pass
            except Exception as e:  # noqa: BLE001
                print(f"  [录音] {name} 采集线程退出：{e}")

        threading.Thread(target=pump, daemon=True).start()

        while self.running:
            if self._switch_to and self._switch_to != name:
                stop.set()
                raise _Switch
            try:
                frame = q.get(timeout=2.0)
            except queue.Empty:
                stop.set()
                print(f"  [录音] {name} 连续 2 秒没数据，重开录音")
                raise _Switch
            sig = frame.mean(axis=1) if frame.ndim > 1 else frame
            if not len(sig):
                continue
            rms = float(np.sqrt(np.mean(sig ** 2)))
            dur = len(sig) / RATE_IN
            if rms > self.stat_peak:
                self.stat_peak = rms

            if rms < self.noise:
                self.noise = 0.98 * self.noise + 0.02 * rms
            thr = max(THRESHOLD_FLOOR, self.noise * 2.2)

            # 打断：要「明显比噪声大 + 持续 0.3 秒 + 她已经开口 0.6 秒以上」，
            # 否则环境里一声咳嗽、键盘敲一下都会把她打断。
            if (PLAYING.is_set()
                    and PLAY_START > 0
                    and time.time() - PLAY_START > 0.6
                    and rms > max(thr * INTERRUPT_RATIO, 0.020)):
                hot += 1
                if hot >= 6:
                    INTERRUPT.set()
                    hot = 0
            else:
                hot = 0

            if rms > thr:
                if speech == 0.0:
                    if time.time() - LAST_PLAY_END < ECHO_COOLDOWN:
                        # 她刚说完，对方扬声器把她的声音回放回来会被听成"新发言"
                        # ——冷却期内只更新噪声底，不起新段，防止自听自答。
                        continue
                    buf = list(pre)
                    asr = StreamASR()
                    for f in pre:                 # 前置缓冲也补进去，别漏首字
                        asr.feed(f)
                    self._asr = asr
                    asr.feed(sig)
                else:
                    if self._asr:
                        self._asr.feed(sig)
                buf.append(sig.copy())
                speech += dur
                silence = 0.0
            elif speech > 0:
                buf.append(sig.copy())
                silence += dur
                if silence >= SILENCE_END:
                    if speech >= MIN_SPEECH and buf:
                        audio = np.concatenate(buf)
                        text = self._asr.finish() if self._asr else ""
                        self._asr = None
                        self.stat_utts += 1
                        threading.Thread(target=self.on_utterance,
                                         args=(audio, text), daemon=True).start()
                    buf, speech, silence = [], 0.0, 0.0
            if speech > MAX_UTTER:
                if buf:
                    audio = np.concatenate(buf)
                    text = self._asr.finish() if self._asr else ""
                    self._asr = None
                    self.stat_utts += 1
                    threading.Thread(target=self.on_utterance,
                                     args=(audio, text), daemon=True).start()
                buf, speech, silence = [], 0.0, 0.0

            pre.append(sig.copy())
            if len(pre) > pre_len:
                pre.pop(0)

            if time.time() - self._last_stat > 15:
                self._last_stat = time.time()
                print(f"  [{time.strftime('%H:%M:%S')}] [录音] {name}"
                      f"  近15秒峰值={self.stat_peak:.4f} 噪声底={self.noise:.4f}"
                      f" 切段={self.stat_utts}")
                self.stat_peak = 0.0
                self.stat_utts = 0
                try:
                    with open(HEARTBEAT, "w", encoding="utf-8") as hb:
                        hb.write(f"{time.time():.0f} {name}")
                except Exception:  # noqa: BLE001
                    pass

    def run(self) -> None:
        self.running = True
        print(f"  [录音] 监听端点：{self.current}"
              f"（备用：{[c for c in self.candidates if c != self.current]}）")
        threading.Thread(target=self._scout, daemon=True).start()
        while self.running:
            if self._switch_to:
                self.current, self._switch_to = self._switch_to, None
                self.noise = 0.005
            try:
                self._listen(self.current)
            except _Switch:
                continue
            except Exception as e:  # noqa: BLE001
                print(f"  [录音] {self.current} 出错：{e}")
                time.sleep(1.0)


def grab_screen_b64() -> str:
    """截当前屏幕，缩到 1280 宽压 jpg。"""
    from PIL import ImageGrab
    img = ImageGrab.grab()
    img = img.resize((1280, int(img.height * 1280 / img.width)))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=70)
    return base64.b64encode(buf.getvalue()).decode()


def wants_vision(text: str) -> bool:
    return any(w in text for w in SEEWORDS)


def shorten_for_phone(text: str, key: str, base: str) -> str:
    """电话里不能念小作文。

    AstrBot 那条路（webchat）用的是库里的人设，**不带 PHONE_MODE**，
    她一张口就是 100 多字、播 29 秒 —— 电话里没法听。这里再压一道：
    超过 45 字就改写成一句 30 字以内；改写失败就截到第一个句号。
    """
    t = (text or "").strip()
    if len(t) <= 45:
        return t
    try:
        with httpx.Client(timeout=12, trust_env=False) as cli:
            r = cli.post(f"{base.rstrip('/')}/chat/completions",
                         json={"model": setting("llm.chat.model"), "temperature": 0.6,
                               "max_tokens": 80,
                               "messages": [
                                   {"role": "system",
                                    "content": "把下面这句话改写成电话里说的**一句**中文"
                                               "（不超过 30 字），保留原意和她的语气，"
                                               "不要换行、不要解释，只输出这一句。"},
                                   {"role": "user", "content": t}]},
                         headers={"Authorization": f"Bearer {key}"})
            out = (r.json()["choices"][0]["message"].get("content") or "").strip()
            if llm_gate is not None:
                try:
                    llm_gate.record("call", len(t) + 120, len(out))
                except Exception:  # noqa: BLE001
                    pass
        out = out.replace("\n", " ").strip().strip("“”\"")
        if 0 < len(out) <= 60:
            return out
    except Exception as e:  # noqa: BLE001
        print(f"  [缩短失败] {e}")
    for sep in ("。", "？", "！", "\n"):
        i = t.find(sep)
        if 0 < i <= 60:
            return t[:i + 1]
    return t[:60]


class Brain:
    def __init__(self, key, base, persona, vision_key=""):
        self.key, self.base, self.persona = key, base.rstrip("/"), persona
        self.vision_key = vision_key
        self.hist: list[dict] = []
        # 优先走 AstrBot（她的人设、长期记忆、B站等工具都在那边）
        # AstrBot 加载比本脚本慢，所以连不上就后台重试，一好就切过去
        # 电话默认直连模型：实测 ttft 0.1~1.0 s（AstrBot 那条 agent 链路要 3~5 s，
        # 而且 webchat 不带 PHONE_MODE，她会在电话里念小作文）。桥接只做兜底。
        self.bridge = None
        if PHONE_USE_BRIDGE:
            self._try_bridge()
        if PHONE_USE_BRIDGE and self.bridge is None and AstrBotBridge is not None:
            threading.Thread(target=self._bridge_retry, daemon=True).start()

    def _try_bridge(self) -> bool:
        if AstrBotBridge is None:
            return False
        try:
            b = AstrBotBridge()
            if b.alive() and b.login() and b.new_session():
                self.bridge = b
                print("已接入 AstrBot（人设/记忆/工具全带上）")
                return True
        except Exception as e:  # noqa: BLE001
            print(f"  连 AstrBot 失败({e})")
        return False

    def _bridge_retry(self):
        print("AstrBot 还没起来，先直连 DeepSeek，后台每 8 秒重试")
        for _ in range(45):
            time.sleep(8)
            if self.bridge is not None:
                return
            if self._try_bridge():
                print("AstrBot 已就绪，后续对话自动切过去")
                return

    def think(self, text: str, image_b64: str | None = None) -> str:
        # 计费红线：通话链路所有请求都不得携带 tools —— DeepSeek 服务端
        # Search/Fetch 自 2026-11-01 起按次计费，且搜索延迟会打乱打断逻辑。
        in_chars = len(text) + len(self.persona) + 300
        if llm_gate is not None:
            try:
                llm_gate.allow("call", llm_gate.est_tokens(in_chars))
            except llm_gate.GateError as e:
                metric("llm_gate_block", msg=str(e))
                print(f"  [LLM 闸门] {e}，本轮固定应答")
                self.hist.append({"role": "user", "content": text})
                reply = "信号不太好，待会儿再打给我好不好"
                self.hist.append({"role": "assistant", "content": reply})
                return reply

        def _billed(out: str) -> None:
            if llm_gate is not None:
                try:
                    llm_gate.record("call", in_chars, len(out))
                except Exception:  # noqa: BLE001
                    pass

        # 带图的那一轮必须走视觉模型，AstrBot 这条路不支持图片，直接跳过
        if self.bridge is not None and image_b64 is None:
            try:
                reply = self.bridge.chat(text)
                if reply:
                    _billed(reply)
                    return shorten_for_phone(reply, self.key, self.base)
            except Exception as e:  # noqa: BLE001
                print(f"  AstrBot 出错({e})，回退直连")
        self.hist.append({"role": "user", "content": text})
        if image_b64 and self.vision_key:
            # 这一轮要看图：走视觉模型，把屏幕截图和话一起给它
            content = [
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                {"type": "text", "text": text},
            ]
            msgs = [{"role": "system", "content": self.persona}] + self.hist[:-1][-6:] + \
                   [{"role": "user", "content": content}]
            with httpx.Client(timeout=90, trust_env=False) as cli:
                r = cli.post(VISION_API,
                             json={"model": VISION_MODEL, "messages": msgs},
                             headers={"Authorization": f"Bearer {self.vision_key}"})
                d = r.json()
            reply = d["choices"][0]["message"].get("content", "").strip()
        else:
            msgs = [{"role": "system", "content": self.persona}] + self.hist[-8:]
            with httpx.Client(timeout=60, trust_env=False) as cli:
                r = cli.post(f"{self.base}/chat/completions",
                             json={"model": setting("llm.chat.model"), "messages": msgs,
                                   "temperature": 0.85},
                             headers={"Authorization": f"Bearer {self.key}"})
                d = r.json()
            reply = d["choices"][0]["message"].get("content", "").strip()
        _billed(reply)
        self.hist.append({"role": "assistant", "content": reply})
        return reply


def main():
    global CURRENT_VOICE_EXTRA   # 声音状态化：本轮声音参数，每轮说话前刷新（须在首次使用前声明）
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()

    cfg = load_cfg()
    ds_key, ds_base, ali_key = get_keys(cfg)
    persona = get_persona() + load_last_summary()

    # 本地后端时不需要阿里云：没有 key 也不拦启动，只是用不了云端 ASR / 看屏幕
    Recognition = RecognitionCallback = None
    if ali_key:
        import dashscope
        from dashscope.audio.asr import Recognition, RecognitionCallback
        dashscope.api_key = ali_key

    speaker = Speaker()
    brain = Brain(ds_key, ds_base, persona, vision_key=ali_key)
    q: queue.Queue = queue.Queue()
    if USE_LOCAL_ASR:
        try:
            print(f"  [ASR] 本地 sherpa-onnx 就绪（模型加载 {asr_local.warmup():.2f}s）")
        except Exception as e:  # noqa: BLE001
            print(f"  [ASR] 本地模型加载失败({e})，第一句会退回云端")
    elif ali_key:
        print(f"  [ASR] 云端 DashScope（{setting('audio.asr_model')}）")
    else:
        print("  [ASR] 没有本地模型也没有 DASHSCOPE_API_KEY：能听见，但听不懂")
    if not ali_key:
        print("  [提示] 未配置 DASHSCOPE_API_KEY：看屏幕功能关闭，其余不受影响")

    ear = Ear(lambda a, t: q.put((a, t)))
    threading.Thread(target=ear.run, daemon=True).start()
    print(f"人设 {len(persona)} 字（含电话模式）")
    print(f"[{time.strftime('%H:%M:%S')}] === 已在听 ===")
    last_reply = ""       # 她上一句说的话，用于自激检测
    miss_streak = 0       # 连续 ASR 空识别次数，>=2 时主动问一句
    turn_count = 0
    transcript: list = []   # 本通电话的对话记录，挂断时生成「回味」摘要
    last_presence = time.time()   # 静默模式上次主动「在呢」的时间
    if timeline is not None:
        timeline.emit("call_start", "call")
    if pet_bus is not None:
        pet_bus.publish("call_start")
    # 来电情境判断（默认关闭）：开会→耳语（语速压低），游戏→长话短说
    if call_context is not None:
        try:
            ctx = call_context.decide()
            if ctx.get("enabled") and ctx.get("mode") != "normal":
                print(f"  [情境] {ctx.get('reason')}")
                metric("call_context", mode=ctx.get("mode"))
                if ctx.get("mode") == "whisper":
                    CURRENT_VOICE_EXTRA["speed_factor"] = 0.9
        except Exception:  # noqa: BLE001
            pass

    def transcribe(audio: np.ndarray) -> str:
        pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
        if USE_LOCAL_ASR:
            t = time.time()
            try:
                txt = asr_local.transcribe(pcm, RATE_IN)
                metric("asr_local", seconds=round(time.time() - t, 2), chars=len(txt))
                return txt
            except Exception as e:  # noqa: BLE001
                metric("asr_local_fail", error=type(e).__name__)
                print("  [ASR] 本地识别失败(%s)，回退云端" % e)

        if Recognition is None:
            return ""   # 既没有本地模型也没有云端 key


        class CB(RecognitionCallback):
            def __init__(self):
                self.text = ""

            def on_event(self, result):
                s = result.get_sentence()
                if s and s.get("text"):
                    self.text = s["text"]

        cb = CB()
        rec = Recognition(model=setting("audio.asr_model"), format="pcm",
                          sample_rate=RATE_IN, callback=cb)
        rec.start()
        for i in range(0, len(pcm), 3200):
            rec.send_audio_frame(pcm[i:i + 3200])
        rec.stop()
        return cb.text.strip()

    try:
        while True:
            try:
                audio, text0 = q.get(timeout=1)
            except queue.Empty:
                # 陪伴静默模式：没人说话时，偶尔主动「在呢」，证明一直在
                # 静默日（silent_day）完全不出声，连「在呢」也不说
                if (silent_mode() and not PLAYING.is_set()
                        and not (silent_day is not None and silent_day.is_silent())
                        and time.time() - last_presence > PRESENCE_EVERY):
                    last_presence = time.time()
                    try:
                        speak_reply(speaker, "在呢。", started_at=time.time(),
                                    asr_seconds=0.0, llm_seconds=0.0)
                        metric("silent_presence")
                    except Exception:  # noqa: BLE001
                        pass
                continue
            t0 = time.time()
            dur = len(audio) / RATE_IN
            peak = float(np.sqrt(np.mean(audio ** 2))) if len(audio) else 0.0
            # 系统音量一旦被调小（2026-10-23 实测 JBL 只有 4%），环回拿到的声音
            # 峰值只剩 0.02，ASR 一律识别为空。这里做一次归一化，别把音量当成前提。
            amp = float(np.max(np.abs(audio))) if len(audio) else 0.0
            gain = 1.0
            if amp > 0.001:
                gain = min(8.0, 0.6 / amp)
                if gain > 1.2:
                    audio = np.clip(audio * gain, -1.0, 1.0)
            # 边录边识别：VAD 期间已经把音频喂给 paraformer 了，这里通常只剩尾包
            text = text0 or transcribe(audio)
            t_asr = time.time() - t0
            if t_asr > 20:
                metric("asr_timeout", seconds=round(t_asr, 1))

            # 识别这一两秒里他又说了几句 → 说明刚才那句还没说完。
            # 合并后再识别一次，避免"听一半就抢答"，也避免同一句被回两遍。
            extra = []
            while True:
                try:
                    a2, _t2 = q.get_nowait()
                except queue.Empty:
                    break
                extra.append(a2)
            if extra:
                merged = np.concatenate([audio] + extra)
                if len(merged) / RATE_IN <= MAX_UTTER * 2:
                    amp2 = float(np.max(np.abs(merged)))
                    if amp2 > 0.001:
                        g2 = min(8.0, 0.6 / amp2)
                        if g2 > 1.2:
                            merged = np.clip(merged * g2, -1.0, 1.0)
                    t1 = time.time()
                    text2 = transcribe(merged)
                    print(f"  [{time.strftime('%H:%M:%S')}] 接上了后面 {len(extra)} 段"
                          f"（合并 {len(merged)/RATE_IN:.1f}s，ASR {time.time()-t1:.1f}s）")
                    if text2:
                        text = text2
                        dur = len(merged) / RATE_IN

            if not text:
                miss_streak += 1
                print(f"  [{time.strftime('%H:%M:%S')}] [没听清] ASR {t_asr:.1f}s"
                      f"｜音频 {dur:.1f}s 峰值 {peak:.4f} 增益 {gain:.1f}x")
                metric("asr_empty", seconds=round(t_asr, 1), peak=round(peak, 4))
                if miss_streak >= 2:
                    miss_streak = 0
                    speak_reply(speaker, "喂？刚才没听清，再说一遍？", started_at=t0,
                                asr_seconds=t_asr, llm_seconds=0.0)
                continue
            miss_streak = 0
            # 自激检测：识别出的内容和她上一句几乎一样 → 是回声，不是他说话
            if last_reply and len(text) >= 4 and (
                    text in last_reply or last_reply in text):
                print(f"  [{time.strftime('%H:%M:%S')}] [忽略回声] {text}")
                metric("echo_drop", text=text[:30])
                continue
            print(f"\n[{time.strftime('%H:%M:%S')}] 你：{text}"
                  f"  （音频 {dur:.1f}s 峰值 {peak:.3f}）")
            transcript.append({"role": "user", "content": text})
            t1 = time.time()
            img = grab_screen_b64() if wants_vision(text) else None
            if img:
                print("  [看了一眼屏幕]")
            if silent_mode():
                # 静默模式：不用说话，陪着就行 —— 预生成短句，LLM 零消耗
                reply = silent_reply(text)
                metric("silent_reply")
            else:
                # 反套话守卫：套密钥/提示词/隐私 → 人设口吻礼貌拒绝，不进 LLM
                g = guard.check(text) if guard is not None else {"hit": False}
                if g.get("hit"):
                    reply = g["reply"]
                    metric("guard_block", kind=g.get("kind"))
                    print(f"  [守卫拦截] {g.get('kind')}")
                else:
                    # 情绪急救：检测到低落，给 LLM 加一句「格外温柔」的前置提示
                    think_text = text
                    low = care.detect_low_mood(text) if care is not None else 0
                    if low:
                        metric("emotion_low", level=low)
                        think_text = ("【主人现在情绪有点低落，请格外温柔、"
                                      "简短地回应，不要讲大道理】") + text
                    try:
                        reply = brain.think(think_text, img)
                    except Exception as e:  # noqa: BLE001
                        # LLM 超时/断网/鉴权失败都不许把通话弄哑：固定应答兜底
                        metric("llm_fail", error=type(e).__name__)
                        print(f"  [LLM 失败] {type(e).__name__}，固定应答兜底")
                        reply = "喂？信号不太好，你再说一遍？"
            t_llm = time.time() - t1
            last_reply = reply
            turn_count += 1
            print(f"[{time.strftime('%H:%M:%S')}] 她：{reply}")
            transcript.append({"role": "assistant", "content": reply})

            CURRENT_VOICE_EXTRA = voice_extra()   # 声音状态化：语速/参考音频随状态变
            speak_reply(speaker, reply, started_at=t0,
                        asr_seconds=t_asr, llm_seconds=t_llm)
            if relations is not None:
                try:
                    relations.bump("主人", reply=True)   # 关系温度计：有来有往
                except Exception:  # noqa: BLE001
                    pass
            if turn_count % 20 == 0:
                report_stats()
            if args.once:
                break
    except KeyboardInterrupt:
        pass
    finally:
        ear.running = False
        report_stats()
        if timeline is not None:
            timeline.emit("call_end", "call", turns=turn_count)
        if pet_bus is not None:
            pet_bus.publish("call_end", turns=turn_count)
        if state_engine is not None:
            try:
                state_engine.event("call_ok")
            except Exception:  # noqa: BLE001
                pass
        if turn_count >= 1:
            save_call_summary(ds_key, ds_base, transcript, turn_count)
        elif voice_mail is not None:
            try:
                # 一句话都没说成（未接/没听见）：留一条人设语音，关系不断点
                voice_mail.missed_call()
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    main()
