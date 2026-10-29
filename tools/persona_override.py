# -*- coding: utf-8 -*-
"""小鲸鱼 · 平台人格微差（P2）

承认「对不同平台说不同话」是合理的：核心人设共享（identity/speech_rules），
平台只放白名单微调（tone 等）。读取方拿合并结果，避免各端各改一份导致漂移。

CLI：
    python tools/persona_override.py show qq
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PERSONA_FILE = ROOT / "config" / "persona.json"
# 白名单：只有这些键允许被平台覆盖（人设红线不可覆盖）
OVERRIDABLE = ("tone",)


def load() -> dict:
    try:
        return json.loads(PERSONA_FILE.read_text("utf-8"))
    except Exception:
        return {}


def for_platform(platform: str) -> dict:
    """返回该平台的有效人格视图：identity + 该平台的白名单覆盖。"""
    p = load()
    identity = p.get("identity") or {}
    overrides = p.get("platform_overrides") or {}
    ov = overrides.get(platform) or {}
    view = dict(identity)
    view["platform"] = platform
    view["tone"] = ov.get("tone", "")
    return view


def diff() -> dict:
    """列出各平台与核心的差异（控制台展示用）。"""
    overrides = load().get("platform_overrides") or {}
    return {k: {kk: vv for kk, vv in v.items() if kk in OVERRIDABLE}
            for k, v in overrides.items() if isinstance(v, dict)}


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "show":
        print(json.dumps(for_platform(sys.argv[2]), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(diff(), ensure_ascii=False, indent=2))
