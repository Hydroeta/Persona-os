# -*- coding: utf-8 -*-
"""小鲸鱼 · 直播观众画像（P3）

记住常来观众、喜好、梗，互动更有针对性。长期直播的复利。

隐私边界（写死）：
  · 只存本地 SQLite，永不外发；
  · 只记「昵称 + 互动次数 + 她给打的喜好标签」，不爬资料、不跨平台关联；
  · 一键遗忘走 memory_bus 同一套（昵称即关键词）。

CLI：
    python tools/audience.py top            # 常来观众
    python tools/audience.py note 阿明 喜欢猫
    python tools/audience.py seen 阿明 "弹幕内容"
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_FILE = ROOT / "data" / "audience.db"


def _db() -> sqlite3.Connection:
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_FILE))
    conn.execute("""CREATE TABLE IF NOT EXISTS fans(
        name TEXT PRIMARY KEY, visits INTEGER DEFAULT 0, last_ts REAL,
        notes TEXT DEFAULT '', tags TEXT DEFAULT '[]')""")
    return conn


def seen(name: str, msg: str = "") -> dict:
    """观众冒泡记一次。名字脱敏：超长截断，不存 UID。"""
    name = (name or "").strip()[:16]
    if not name:
        return {"ok": False}
    conn = _db()
    try:
        conn.execute("INSERT INTO fans(name,visits,last_ts) VALUES(?,?,?) "
                     "ON CONFLICT(name) DO UPDATE SET visits=visits+1,last_ts=?",
                     (name, 1, time.time(), time.time()))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "name": name}


def note(name: str, tag: str) -> dict:
    """给观众打个喜好标签（她自己的判断，如「喜欢猫」「爱点歌」）。"""
    name = (name or "").strip()[:16]
    conn = _db()
    try:
        row = conn.execute("SELECT tags FROM fans WHERE name=?", (name,)).fetchone()
        tags = json.loads(row[0]) if row else []
        if tag and tag not in tags:
            tags.append(tag[:20])
        conn.execute("INSERT INTO fans(name,visits,last_ts,tags) VALUES(?,0,?,?) "
                     "ON CONFLICT(name) DO UPDATE SET tags=?",
                     (name, time.time(), json.dumps(tags, ensure_ascii=False),
                      json.dumps(tags, ensure_ascii=False)))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "name": name, "tags": tags}


def top(n: int = 10) -> list:
    conn = _db()
    try:
        rows = conn.execute(
            "SELECT name, visits, last_ts, tags FROM fans "
            "ORDER BY visits DESC LIMIT ?", (n,)).fetchall()
    finally:
        conn.close()
    return [{"name": r[0], "visits": r[1],
             "last": time.strftime("%Y-%m-%d", time.localtime(r[2])) if r[2] else "",
             "tags": json.loads(r[3] or "[]")} for r in rows]


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "top":
        print(json.dumps(top(), ensure_ascii=False, indent=2))
    elif len(argv) >= 3 and argv[0] == "note":
        print(json.dumps(note(argv[1], argv[2]), ensure_ascii=False))
    elif len(argv) >= 2 and argv[0] == "seen":
        print(json.dumps(seen(argv[1], argv[2] if len(argv) >= 3 else ""),
                         ensure_ascii=False))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
