# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 她自己的小目标（P2）

自主性不只对主人，也对自己：每天给自己定 1~3 个小目标（学个新梗、
问主人一件事、整理一层记忆），完成打勾，失败不惩罚。
纯模板池生成、零 LLM 成本；控制台可手动打勾，日报展示完成情况。

CLI：
    python tools/goals.py today       # 今天的小目标（没有就现场生成）
    python tools/goals.py gen         # 强制重新生成今天的
    python tools/goals.py done g1     # 打勾
    python tools/goals.py settle      # 结算昨天（完成记状态事件，失败不惩罚）
"""
from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOALS_FILE = ROOT / "data" / "goals.json"

# 目标模板池：都是她自己能做到的小事，不依赖美术/外部资源
POOL = [
    "学一个新梗，找个机会用给主人看",
    "问主人一件以前没问过的事",
    "翻翻旧记忆，挑一条快忘记的跟主人确认",
    "写一篇不讲正事、只讲心情的日记",
    "观察主人今天最常打开的三个应用",
    "给某个好久没来电话的人准备一句开场白",
    "把今天听到的好玩的话记进黑话本",
    "练一句更自然的接电话开场",
    "数数主人今天笑了几次（猜的也算）",
    "给自己挑一个明天想完成的小目标",
    "整理一层记忆，把重复的东西并一并",
    "想一句晚安，今晚说给主人听",
]


def _load() -> dict:
    try:
        return json.loads(GOALS_FILE.read_text("utf-8"))
    except Exception:
        return {}


def _save(d: dict) -> None:
    try:
        GOALS_FILE.parent.mkdir(parents=True, exist_ok=True)
        GOALS_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), "utf-8")
    except OSError:
        pass


def generate(day: str | None = None, n: int | None = None) -> dict:
    """给某天生成 1~3 个小目标（按日期做种子，同一天重生成结果稳定）。"""
    day = day or time.strftime("%Y-%m-%d")
    rng = random.Random(day)  # 同一天重生成结果一致，不抽风
    n = n or rng.randint(1, 3)
    items = [{"id": "g%d" % (i + 1), "text": t, "done": False, "done_ts": 0.0}
             for i, t in enumerate(rng.sample(POOL, min(n, len(POOL))))]
    d = _load()
    d[day] = {"items": items, "generated": time.time()}
    _save(d)
    return {"date": day, "items": items}


def today() -> dict:
    """今天的小目标；没有就现场生成。"""
    day = time.strftime("%Y-%m-%d")
    d = _load()
    if day not in d:
        return generate(day)
    return {"date": day, "items": d[day]["items"]}


def complete(goal_id: str, day: str | None = None) -> dict:
    """打勾。返回当天目标；没找到该 id 时 found=False。"""
    day = day or time.strftime("%Y-%m-%d")
    d = _load()
    items = (d.get(day) or {}).get("items", [])
    found = False
    for it in items:
        if it["id"] == goal_id:
            it["done"] = True
            it["done_ts"] = time.time()
            found = True
    if found:
        _save(d)
    return {"date": day, "items": items, "found": found}


def settle(day: str | None = None) -> dict:
    """结算：完成 ≥1 个就给状态引擎记一次 task_done；失败不惩罚。"""
    day = day or time.strftime("%Y-%m-%d", time.localtime(time.time() - 86400))
    items = (_load().get(day) or {}).get("items", [])
    done = sum(1 for it in items if it.get("done"))
    if done:
        try:
            import state_engine
            state_engine.event("task_done")
        except Exception:
            pass
    return {"date": day, "total": len(items), "done": done,
            "rate": (done / len(items)) if items else 0.0}


def _main(argv: list[str]) -> int:
    if not argv or argv[0] == "today":
        print(json.dumps(today(), ensure_ascii=False, indent=2))
    elif argv[0] == "gen":
        print(json.dumps(generate(), ensure_ascii=False, indent=2))
    elif len(argv) >= 2 and argv[0] == "done":
        print(json.dumps(complete(argv[1]), ensure_ascii=False, indent=2))
    elif argv[0] == "settle":
        print(json.dumps(settle(), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
