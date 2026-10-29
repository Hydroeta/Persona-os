# -*- coding: utf-8 -*-
"""小鲸鱼 · 语音留言（P2）

没接到电话时，把「未接」变成关系延续：自动留一条符合人设的语音。
也支持主人主动留言。文本先落盘；TTS 在线（:9880）时才合成 wav，
否则只留文本——功能永远可用，不硬依赖 GPU。

防骚扰：默认每天最多 3 条主动留言。合成走 watermark.stamp 记文本哈希。

CLI：
    python tools/voice_mail.py leave "晚安，做个好梦"
    python tools/voice_mail.py missed           # 未接来电自动回一条
    python tools/voice_mail.py list
    python tools/voice_mail.py synth <id>       # 补合成（TTS 起来后）
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sys
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
MAIL_DIR = ROOT / "data" / "voice_mail"
CONFIG_FILE = ROOT / "config" / "voice_mail.json"
TTS_URL = "http://127.0.0.1:9880/tts"
DEFAULT_CONFIG = {"max_per_day": 3, "missed_reply":
                  "喂？我刚才没接着电话……看到留言记得回我哦"}

# 与 ohwhale TTS_PARAMS 对齐的最小参数（参考音频走 persona.json 正本指针）
TTS_BASE = {"text_lang": "zh", "prompt_lang": "zh", "media_type": "wav",
            "text_split_method": "cut0"}


def load_config() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
    except Exception:
        cfg = {}
    merged = dict(DEFAULT_CONFIG)
    merged.update(cfg)
    return merged


def _load() -> list:
    try:
        d = json.loads((MAIL_DIR / "index.json").read_text("utf-8"))
        return d if isinstance(d, list) else []
    except Exception:
        return []


def _save(items: list) -> None:
    MAIL_DIR.mkdir(parents=True, exist_ok=True)
    (MAIL_DIR / "index.json").write_text(
        json.dumps(items, ensure_ascii=False, indent=2), "utf-8")


def _today_count() -> int:
    day = time.strftime("%Y-%m-%d")
    return sum(1 for m in _load() if m.get("created", "").startswith(day))


def tts_up() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:9880/", timeout=2):
            return True
    except Exception:
        return False


def _tts_params() -> dict:
    """从 persona.json 正本取参考音频与提示文本。"""
    p = dict(TTS_BASE)
    try:
        persona = json.loads((ROOT / "config" / "persona.json").read_text("utf-8"))
        voice = persona.get("voice") or {}
        ref = voice.get("ref_audio")
        if ref:
            rp = Path(ref) if Path(ref).is_absolute() else ROOT / ref
            if rp.is_file():
                p["ref_audio_path"] = str(rp)
        if voice.get("prompt_text"):
            p["prompt_text"] = voice["prompt_text"]
    except Exception:
        pass
    return p


def synth(mail_id: str) -> dict:
    """给一条留言补合成。TTS 不在线时返回 ok=False，不抛错。"""
    items = _load()
    for m in items:
        if m["id"] != mail_id:
            continue
        if not tts_up():
            return {"ok": False, "msg": "TTS 不在线（:9880）"}
        body = dict(_tts_params(), text=m["text"])
        try:
            req = urllib.request.Request(
                TTS_URL, data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                wav = r.read()
        except Exception as e:
            return {"ok": False, "msg": type(e).__name__}
        out = MAIL_DIR / ("%s.wav" % mail_id)
        out.write_bytes(wav)
        m["wav"] = out.name
        _save(items)
        try:
            import watermark
            watermark.stamp(m["text"], out)
        except Exception:
            pass
        return {"ok": True, "wav": str(out)}
    return {"ok": False, "msg": "找不到该留言"}


def leave(text: str, kind: str = "manual") -> dict:
    """留一条语音留言。超每日上限拒绝（防骚扰）。"""
    text = (text or "").strip()
    if not text:
        return {"ok": False, "msg": "内容为空"}
    if _today_count() >= load_config()["max_per_day"]:
        return {"ok": False, "msg": "今天的留言额度用完了（防骚扰上限）"}
    m = {"id": uuid.uuid4().hex[:8], "text": text, "kind": kind,
         "created": time.strftime("%Y-%m-%d %H:%M"), "wav": ""}
    items = _load()
    items.append(m)
    _save(items)
    if tts_up():
        synth(m["id"])
        m = [x for x in _load() if x["id"] == m["id"]][0]
    return {"ok": True, "mail": m}


def missed_call() -> dict:
    """未接来电自动回一条（call_loop 挂点：turn_count==0 时调用）。"""
    return leave(load_config()["missed_reply"], kind="missed")


def list_all() -> list:
    return sorted(_load(), key=lambda m: m.get("created", ""), reverse=True)


def _main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "leave":
        print(json.dumps(leave(" ".join(argv[1:])), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "missed":
        print(json.dumps(missed_call(), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "list":
        print(json.dumps(list_all(), ensure_ascii=False, indent=2))
    elif len(argv) >= 2 and argv[0] == "synth":
        print(json.dumps(synth(argv[1]), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
