# -*- coding: utf-8 -*-
"""小鲸鱼 · 角色成长 / 技能树（P3）

她学会新技能要有可见进度：第一次成功用检索闸门、第一次直播攒批、
第一次读完一本书……都是解锁事件。无数值氪金，纯纪念性质。
事件由各链路 emit（不主动扫描），控制台技能树页展示。

CLI：
    python tools/growth.py list
    python tools/growth.py emit search_ok
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILLS_FILE = ROOT / "data" / "skills.json"

# 技能表：事件 → 技能。文案用她的口吻。
SKILLS = {
    "search_ok":    {"name": "学会查资料", "line": "我会自己查证再说话啦"},
    "first_call":   {"name": "第一次通话", "line": "第一次听到主人的声音"},
    "first_dream":  {"name": "会做梦了", "line": "整理记忆的时候睡着了"},
    "danmu_batch":  {"name": "直播攒批", "line": "弹幕再多也不慌"},
    "first_forget": {"name": "学会遗忘", "line": "忘掉也是一种温柔"},
    "diary_7":      {"name": "坚持写日记", "line": "连续写了七天"},
    "snapshot":     {"name": "认识自己", "line": "第一次给自己拍快照"},
    "story_told":   {"name": "会讲故事", "line": "第一次哄主人睡觉"},
    "first_mail":   {"name": "会留语音", "line": "没接到电话也能传话"},
    "review_ok":    {"name": "回忆复习", "line": "第一次主动复习旧记忆"},
}


def _load() -> dict:
    try:
        return json.loads(SKILLS_FILE.read_text("utf-8"))
    except Exception:
        return {}


def _save(d: dict) -> None:
    try:
        SKILLS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SKILLS_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), "utf-8")
    except OSError:
        pass


def emit(event: str) -> dict:
    """记一次解锁事件。未知事件忽略（插件升级期容错）。"""
    if event not in SKILLS:
        return {"ok": False, "msg": "未知事件"}
    d = _load()
    if event in d:
        d[event]["count"] = d[event].get("count", 1) + 1
        _save(d)
        return {"ok": True, "already": True, "skill": SKILLS[event]["name"]}
    d[event] = {"unlocked": time.strftime("%Y-%m-%d %H:%M"), "count": 1}
    _save(d)
    return {"ok": True, "already": False, "skill": SKILLS[event]["name"],
            "line": SKILLS[event]["line"]}


def list_all() -> list:
    d = _load()
    return [{"event": ev, "name": s["name"], "line": s["line"],
             "unlocked": ev in d,
             "unlocked_at": (d.get(ev) or {}).get("unlocked", ""),
             "count": (d.get(ev) or {}).get("count", 0)}
            for ev, s in SKILLS.items()]


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "list":
        print(json.dumps(list_all(), ensure_ascii=False, indent=2))
    elif len(argv) >= 2 and argv[0] == "emit":
        print(json.dumps(emit(argv[1]), ensure_ascii=False))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
