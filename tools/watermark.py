# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 语音水印 / 防滥用（P2）

声音克隆是双刃剑。本模块做两件最低成本的事：
  1. 每段合成语音写 sidecar 元数据（.wav.json）：AI 生成标识、时间、
     文本 SHA256（不存原文），出事可自证「这是合成音」。
  2. logs/tts_watermark.jsonl 记合成台账：谁合成的、什么时候、文本哈希。

不做音频级水印（要改合成管线，成本不配）；元数据 + 台账先把「态度」立住。

CLI：
    python tools/watermark.py verify data/voice_mail/xxxx.wav
    python tools/watermark.py log
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_FILE = ROOT / "logs" / "tts_watermark.jsonl"
AI_MARK = "AI-generated voice (小鲸鱼/鲸鲸, local GPT-SoVITS)"


def stamp(text: str, wav_path: Path | None = None, source: str = "tools") -> dict:
    """给一段合成语音打标：sidecar 元数据（有文件时）+ 台账。永不抛错。"""
    entry = {"ts": round(time.time(), 3),
             "file": Path(wav_path).name if wav_path else "",
             "text_sha256": hashlib.sha256((text or "").encode("utf-8")).hexdigest(),
             "chars": len(text or ""), "ai": True, "source": source}
    if wav_path:
        try:
            side = Path(wav_path).with_suffix(Path(wav_path).suffix + ".json")
            side.write_text(json.dumps({**entry, "mark": AI_MARK},
                                       ensure_ascii=False, indent=2), "utf-8")
        except OSError:
            pass
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return entry


def verify(wav_path: Path) -> dict:
    """核对 sidecar 是否存在、与台账是否一致（按文件名+哈希）。"""
    wav_path = Path(wav_path)
    side = wav_path.with_suffix(wav_path.suffix + ".json")
    if not side.is_file():
        return {"file": wav_path.name, "marked": False}
    try:
        meta = json.loads(side.read_text("utf-8"))
    except Exception:
        return {"file": wav_path.name, "marked": False}
    in_log = False
    if LOG_FILE.is_file():
        try:
            with open(LOG_FILE, encoding="utf-8") as f:
                for line in f:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if (d.get("file") == meta.get("file")
                            and d.get("text_sha256") == meta.get("text_sha256")):
                        in_log = True
                        break
        except OSError:
            pass
    return {"file": wav_path.name, "marked": True, "in_log": in_log,
            "text_sha256": meta.get("text_sha256"), "ts": meta.get("ts")}


def log(limit: int = 50) -> list:
    rows = []
    if LOG_FILE.is_file():
        try:
            with open(LOG_FILE, encoding="utf-8") as f:
                for line in f:
                    try:
                        rows.append(json.loads(line))
                    except Exception:
                        continue
        except OSError:
            pass
    return rows[-limit:]


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "verify":
        print(json.dumps(verify(sys.argv[2]), ensure_ascii=False, indent=2))
    elif len(sys.argv) >= 2 and sys.argv[1] == "log":
        print(json.dumps(log(), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
