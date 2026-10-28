# -*- coding: utf-8 -*-
"""小鲸鱼 · 来电情境判断（P3，默认关闭）

复用读屏陪伴的能力但更轻：只看前台窗口标题/进程名，判断主人是不是
在开会/打游戏，决定来电时她正常说话、压低声音（耳语）、还是先不接。

隐私边界（与读屏一致）：默认关闭；本地处理，标题不出本机；
不看聊天正文，只认「在开会/在游戏」这个级别的事件。

CLI：
    python tools/call_context.py status      # 当前判断（调试用）
    python tools/call_context.py on / off
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
CONFIG_FILE = ROOT / "config" / "call_context.json"
DEFAULT_CONFIG = {"enabled": False}   # 默认关闭，明确告知后才开

MEETING_WORDS = ("会议", "meeting", "zoom", "teams", "腾讯会议", "飞书会议")
GAME_WORDS = ("游戏", "steam", "原神", "英雄", "game")


def load_config() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
    except Exception:
        cfg = {}
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    return merged


def save_config(cfg: dict) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")


def foreground() -> tuple:
    """前台 (进程名, 窗口标题)。拿不到返回 ("", "")。仅 Windows。"""
    try:
        import ctypes
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        if not hwnd:
            return "", ""
        length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
        pid = ctypes.c_ulong()
        ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        exe = ""
        try:
            import psutil  # 偶发可用；没有就只按标题判断
            exe = psutil.Process(pid.value).name()
        except Exception:
            exe = ""
        return exe.lower(), buf.value
    except Exception:
        return "", ""


def decide(exe: str | None = None, title: str | None = None) -> dict:
    """返回 {enabled, mode: normal|whisper|busy, reason}。关闭时恒 normal。"""
    cfg = load_config()
    if not cfg["enabled"]:
        return {"enabled": False, "mode": "normal", "reason": "情境判断未开启"}
    if exe is None or title is None:
        exe, title = foreground()
    blob = ("%s %s" % (exe, title)).lower()
    if any(w in blob for w in MEETING_WORDS):
        return {"enabled": True, "mode": "whisper", "reason": "检测到在开会，压低声音"}
    if any(w in blob for w in GAME_WORDS):
        return {"enabled": True, "mode": "busy", "reason": "检测到在游戏中，长话短说"}
    return {"enabled": True, "mode": "normal", "reason": "无特殊情境"}


def _main(argv: list[str]) -> int:
    if argv and argv[0] in ("on", "off"):
        cfg = load_config()
        cfg["enabled"] = argv[0] == "on"
        save_config(cfg)
        print(json.dumps(cfg, ensure_ascii=False))
    elif argv and argv[0] == "status":
        print(json.dumps(decide(), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
