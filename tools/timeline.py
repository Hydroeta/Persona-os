# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 时间机器（统一事件流，按天分片回放）

选任意一天按时间轴回放全部事件：消息、通话、状态、花费、日记——
这是「她是一个意识」最直观的证据，也是调试/复盘/内容三用的底座。

事件流 schema（logs/timeline/YYYY-MM-DD.jsonl，append-only）：
    {"ts": 1698000000.1, "type": "call_turn", "source": "call",
     "payload": {"user": "...", "reply": "..."}}

写入方（谁有料谁 emit，量要克制）：
    call_loop   call_start / call_turn / call_end
    daily_report    report_done
    memory_bus      forget / dream（顺带进 timeline，审计另有专账）
    console         svc_action 启停

CLI：
    python tools/timeline.py day 2026-10-28
    python tools/timeline.py days
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "logs" / "timeline"


def _file(ts: float | None = None) -> Path:
    return DIR / ("%s.jsonl" % time.strftime("%Y-%m-%d", time.localtime(ts or time.time())))


def emit(etype: str, source: str, **payload) -> None:
    """追加一条事件。永不抛错（观测组件不能反过来弄崩业务）。"""
    try:
        f = _file()
        f.parent.mkdir(parents=True, exist_ok=True)
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": round(time.time(), 3), "type": etype,
                                 "source": source, "payload": payload},
                                ensure_ascii=False) + "\n")
    except OSError:
        pass


def day(date: str) -> list[dict]:
    f = DIR / ("%s.jsonl" % date)
    if not f.is_file():
        return []
    rows = []
    try:
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
    except OSError:
        pass
    return rows


def days() -> list[str]:
    if not DIR.is_dir():
        return []
    return sorted((p.stem for p in DIR.glob("*.jsonl")), reverse=True)


def recent(limit: int = 100) -> list[dict]:
    """跨天取最近 limit 条（按 ts 升序返回，供逐帧回放）。"""
    out: list[dict] = []
    for d in days():
        out = day(d) + out
        if len(out) >= limit:
            break
    return out[-limit:]


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[0] == "day":
        rows = day(sys.argv[1] if len(sys.argv) > 1 else time.strftime("%Y-%m-%d"))
        for r in rows:
            t = time.strftime("%H:%M:%S", time.localtime(r["ts"]))
            print("%s  %-14s %-10s %s" % (t, r["type"], r["source"],
                                          json.dumps(r["payload"], ensure_ascii=False)[:100]))
        if not rows:
            print("这一天没有事件")
    elif sys.argv[1:2] == ["days"]:
        print("\n".join(days()) or "还没有事件")
    else:
        print(__doc__)
