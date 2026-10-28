# -*- coding: utf-8 -*-
"""小鲸鱼 · 关系时间轴 + 纪念日 + 关系温度计

「陪伴有纵深」的两件事收在一个文件里：
  1. 时间轴与纪念日：与每个常互动的人的「第一次」（相识/第一通电话）和
     「第 N 天」里程碑（7/30/100/365…），到点主动提起。四个平台可各说一句
     不同的话，但日期只算一处。
  2. 温度计：综合互动频率、搭话接受率、情绪分算亲密度（0~100），
     反过来调节 companion 的黏人程度——把固定梯度变成关系驱动。

数据：SQLite 单库（data/relations.db），三张表：
  persons  每个人：first_seen / note（时间轴起点）
  events   自定义事件：birthday / anniversary / custom（按月日匹配提醒）
  daily    按天聚合：互动次数 / 回复数 / 接受率 / 情绪分（温度计原始数据）

设计约束：只对「有来有往」的联系人触发提醒（bump 过的人才会出现在结果里）；
纯标准库；不做数值氪金，温度计只有展示与建议用途。

CLI：
    python tools/relations.py touch 主人 "第一次聊天"
    python tools/relations.py bump 主人 --accept 1 --sentiment 0.3
    python tools/relations.py everyone        # 温度计排行
    python tools/relations.py today          # 今天的纪念日/里程碑
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_FILE = ROOT / "data" / "relations.db"

# 温度计权重：频率 40 + 接受率 30 + 情绪 30
W_FREQ, W_ACCEPT, W_MOOD = 40.0, 30.0, 30.0
# 频率打分基准：日均 5 次互动即拿满（超过不加分，防刷）
FREQ_FULL_PER_DAY = 5.0
# 里程碑天数：7/30/100/365 与整百、周年
MILESTONES = {7, 30, 100, 200, 300, 365, 500, 730, 1000}
LOOKBACK_DAYS = 7  # 温度计只看最近 7 天


def _db() -> "object":
    import sqlite3
    conn = sqlite3.connect(str(DB_FILE))
    conn.execute("""CREATE TABLE IF NOT EXISTS persons(
        name TEXT PRIMARY KEY, first_seen REAL, note TEXT DEFAULT '')""")
    conn.execute("""CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT,
        note TEXT DEFAULT '', ts REAL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS daily(
        name TEXT, day TEXT, interactions INTEGER DEFAULT 0, replies INTEGER DEFAULT 0,
        accepts INTEGER DEFAULT 0, rejects INTEGER DEFAULT 0, sentiment REAL DEFAULT 0.0,
        PRIMARY KEY(name, day))""")
    return conn


def _day0(ts: float | None = None) -> float:
    t = time.localtime(ts or time.time())
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))


# ---------- 时间轴 ----------

def touch(name: str, note: str = "", ts: float | None = None) -> dict:
    """登记一个人（或更新备注）。first_seen 只记第一次，不改。"""
    ts = time.time() if ts is None else ts
    conn = _db()
    try:
        row = conn.execute("SELECT first_seen FROM persons WHERE name=?",
                           (name,)).fetchone()
        if row:
            conn.execute("UPDATE persons SET note=? WHERE name=?",
                         (note or "", name))
            first = row[0]
        else:
            conn.execute("INSERT INTO persons(name, first_seen, note) VALUES(?,?,?)",
                         (name, ts, note))
            first = ts
        conn.commit()
    finally:
        conn.close()
    return {"name": name, "first_seen": first}


def add_event(name: str, kind: str, note: str = "", ts: float | None = None) -> int:
    """加自定义事件。kind: birthday（生日，按月日提醒）/ anniversary / custom。"""
    ts = time.time() if ts is None else ts
    conn = _db()
    try:
        cur = conn.execute("INSERT INTO events(name, kind, note, ts) VALUES(?,?,?,?)",
                           (name, kind, note, ts))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def days_known(name: str, ts: float | None = None) -> int | None:
    """相识第几天（从 0 起算）；没登记过返回 None。"""
    conn = _db()
    try:
        row = conn.execute("SELECT first_seen FROM persons WHERE name=?", (name,)).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return max(0, int((_day0(ts) - _day0(row[0])) // 86400))


# ---------- 互动（温度计数据源） ----------

def bump(name: str, reply: bool = False, accept: bool | None = None,
         sentiment: float = 0.0, ts: float | None = None) -> None:
    """记一次互动。accept: 搭话被接受 True / 被无视 False / 不适用 None；
    sentiment: 这轮互动的情绪 −1~1（正=开心，负=低落/吵架）。"""
    ts = time.time() if ts is None else ts
    day = time.strftime("%Y-%m-%d", time.localtime(ts))
    conn = _db()
    try:
        conn.execute("INSERT OR IGNORE INTO persons(name, first_seen, note) VALUES(?,?,?)",
                     (name, ts, ""))
        conn.execute("""INSERT INTO daily(name, day) VALUES(?,?)
                        ON CONFLICT(name, day) DO NOTHING""", (name, day))
        sets = ["interactions=interactions+1", "sentiment=sentiment+?"]
        args: list = [sentiment]
        if reply:
            sets.append("replies=replies+1")
        if accept is True:
            sets.append("accepts=accepts+1")
        elif accept is False:
            sets.append("rejects=rejects+1")
        conn.execute("UPDATE daily SET %s WHERE name=? AND day=?" % ",".join(sets),
                     (*args, name, day))
        conn.commit()
    finally:
        conn.close()


def _recent(name: str, conn, days: int = LOOKBACK_DAYS) -> dict:
    cut = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
    row = conn.execute(
        "SELECT SUM(interactions), SUM(accepts), SUM(rejects), SUM(sentiment), SUM(replies) "
        "FROM daily WHERE name=? AND day>=?", (name, cut)).fetchone()
    return {"interactions": row[0] or 0, "accepts": row[1] or 0,
            "rejects": row[2] or 0, "sentiment": row[3] or 0.0, "replies": row[4] or 0}


def warmth(name: str) -> dict:
    """关系温度 0~100：频率 40 + 接受率 30 + 情绪 30（最近 7 天）。"""
    conn = _db()
    try:
        r = _recent(name, conn)
    finally:
        conn.close()
    per_day = r["interactions"] / LOOKBACK_DAYS
    f = min(1.0, per_day / FREQ_FULL_PER_DAY) * W_FREQ
    attempts = r["accepts"] + r["rejects"]
    a = (r["accepts"] / attempts) * W_ACCEPT if attempts else W_ACCEPT * 0.6
    avg_s = r["sentiment"] / r["interactions"] if r["interactions"] else 0.0
    m = ((avg_s + 1.0) / 2.0) * W_MOOD
    return {"score": round(f + a + m, 1),
            "interactions_7d": r["interactions"],
            "accept_rate": round(r["accepts"] / attempts, 2) if attempts else None,
            "mood_avg": round(avg_s, 2)}


def everyone(limit: int = 20) -> list[dict]:
    """按温度排行的关系清单（供控制台与 companion 参考）。"""
    conn = _db()
    try:
        names = [r[0] for r in conn.execute(
            "SELECT p.name FROM persons p JOIN daily d ON d.name=p.name "
            "GROUP BY p.name ORDER BY SUM(d.interactions) DESC LIMIT ?", (limit,))]
    finally:
        conn.close()
    out = []
    for n in names:
        w = warmth(n)
        d = days_known(n)
        out.append({"name": n, "days": d, **w})
    out.sort(key=lambda x: -x["score"])
    return out


# ---------- 纪念日 ----------

def anniversaries_today(ts: float | None = None) -> list[dict]:
    """今天值得主动提起的日子：相识里程碑 + 生日 + 自定义纪念日。"""
    ts = ts or time.time()
    t = time.localtime(ts)
    today_mmdd = "%02d-%02d" % (t.tm_mon, t.tm_mday)
    out: list[dict] = []
    conn = _db()
    try:
        for name, first in conn.execute("SELECT name, first_seen FROM persons"):
            d = max(0, int((_day0(ts) - _day0(first)) // 86400))
            if d > 0 and (d in MILESTONES or (d > 365 and d % 365 == 0)
                          or (d >= 100 and d % 100 == 0)):
                out.append({"name": name, "kind": "milestone", "days": d,
                            "label": "今天是我们认识的第 %d 天" % d})
        for name, kind, note, ets in conn.execute(
                "SELECT name, kind, note, ts FROM events"):
            if not ets:
                continue
            e = time.localtime(ets)
            if "%02d-%02d" % (e.tm_mon, e.tm_mday) == today_mmdd:
                label = {"birthday": "今天是 %s 的生日" % name,
                         "anniversary": "今天是 %s：%s" % (name, note or "纪念日"),
                         "custom": note or name}.get(kind, note)
                out.append({"name": name, "kind": kind, "days": None, "label": label})
    finally:
        conn.close()
    return out


# ---------- CLI ----------

def _main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "touch":
        print(json.dumps(touch(argv[1], argv[2] if len(argv) > 2 else ""),
                         ensure_ascii=False, indent=2))
    elif len(argv) >= 2 and argv[0] == "bump":
        name = argv[1]
        accept = None
        senti = 0.0
        for i, a in enumerate(argv):
            if a == "--accept" and i + 1 < len(argv):
                accept = bool(int(argv[i + 1]))
            if a == "--sentiment" and i + 1 < len(argv):
                senti = float(argv[i + 1])
        bump(name, accept=accept, sentiment=senti)
        print(json.dumps(warmth(name), ensure_ascii=False))
    elif argv and argv[0] == "everyone":
        print(json.dumps(everyone(), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "today":
        print(json.dumps(anniversaries_today(), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
