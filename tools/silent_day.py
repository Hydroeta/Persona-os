# -*- coding: utf-8 -*-
"""小鲸鱼 · 一键静默日（P2）

她完全不出声一天：通话不主动搭话、读屏不发言、日报照跑但不播报。
尊重用户边界，避免「被陪伴绑架」。跨天自动失效（只管「那一天」）。

CLI：
    python tools/silent_day.py on       # 今天静默
    python tools/silent_day.py off
    python tools/silent_day.py status
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = ROOT / "config" / "silent_day.json"


def _load() -> dict:
    try:
        return json.loads(STATE_FILE.read_text("utf-8"))
    except Exception:
        return {}


def _save(d: dict) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), "utf-8")
    except OSError:
        pass


def enable() -> dict:
    d = {"date": time.strftime("%Y-%m-%d"), "set_at": time.time()}
    _save(d)
    return {"silent": True, "date": d["date"]}


def disable() -> dict:
    _save({})
    return {"silent": False}


def is_silent() -> bool:
    """只在「被开启的那一天」生效，第二天自动恢复。"""
    return _load().get("date") == time.strftime("%Y-%m-%d")


def status() -> dict:
    d = _load()
    return {"silent": is_silent(), "date": d.get("date", "")}


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "on":
        print(json.dumps(enable(), ensure_ascii=False))
    elif argv and argv[0] == "off":
        print(json.dumps(disable(), ensure_ascii=False))
    else:
        print(json.dumps(status(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
