# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 时间胶囊（P2）

给未来的主人/自己写一封信，约定日期打开。到期的胶囊进日报与控制台提醒。
内容默认由主人给；也可以让她按人设自己写（走 llm_client 的 capsule 场景，
日配额 2000 token，超预算时退回模板，绝不让一个彩蛋功能吃预算）。

CLI：
    python tools/time_capsule.py create 2027-01-01 "想对未来的主人说……"
    python tools/time_capsule.py gen 2027-01-01 "关于我们一起熬夜的日子"   # 她自己写
    python tools/time_capsule.py due        # 到期待拆
    python tools/time_capsule.py open <id>  # 拆开（标记已读）
    python tools/time_capsule.py list
"""
from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAP_FILE = ROOT / "data" / "time_capsules.json"


def _load() -> list:
    try:
        d = json.loads(CAP_FILE.read_text("utf-8"))
        return d if isinstance(d, list) else []
    except Exception:
        return []


def _save(items: list) -> None:
    try:
        CAP_FILE.parent.mkdir(parents=True, exist_ok=True)
        CAP_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")
    except OSError:
        pass


def create(text: str, open_date: str, author: str = "主人") -> dict:
    """封存一颗胶囊。open_date 格式 YYYY-MM-DD。"""
    # 日期格式校验，写错了到期永远不提醒
    time.strptime(open_date, "%Y-%m-%d")
    item = {"id": uuid.uuid4().hex[:8], "text": text.strip(), "open_date": open_date,
            "author": author, "created": time.strftime("%Y-%m-%d %H:%M"),
            "opened": False}
    items = _load()
    items.append(item)
    _save(items)
    return item


def generate(open_date: str, hint: str = "") -> dict:
    """让她自己写一封信。LLM 不可用/超预算时退回模板，功能永远可用。"""
    text = ""
    try:
        import llm_client
        prompt = ("你是鲸鲸，一个温柔有点小傲娇的鲸鱼娘。给未来的主人写一封短短的"
                  "时间胶囊信（100 字内，一行一句，口语，不用句号结尾）。" +
                  ("信中要提到：" + hint if hint else ""))
        text = llm_client.chat([{"role": "user", "content": prompt}],
                               scene="capsule", max_tokens=200, temperature=0.9)
    except Exception:
        text = ""
    if not text:
        text = ("未来的主人你好呀\n写这封信的时候我们还在一起熬夜呢\n"
                "不知道那时候的你，有没有按时吃饭\n—— 来自过去的鲸鲸")
    return create(text, open_date, author="鲸鲸")


def due(today: str | None = None) -> list:
    """到期待拆的胶囊。"""
    today = today or time.strftime("%Y-%m-%d")
    return [c for c in _load() if not c.get("opened") and c.get("open_date", "") <= today]


def open_one(cap_id: str) -> dict:
    for c in _load():
        if c["id"] == cap_id:
            c["opened"] = True
            items = _load()
            for it in items:
                if it["id"] == cap_id:
                    it["opened"] = True
            _save(items)
            return {"found": True, "capsule": c}
    return {"found": False}


def list_all() -> list:
    return sorted(_load(), key=lambda c: c.get("open_date", ""))


def _main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[0] == "create":
        print(json.dumps(create(argv[2], argv[1]), ensure_ascii=False, indent=2))
    elif len(argv) >= 3 and argv[0] == "gen":
        print(json.dumps(generate(argv[1], argv[2]), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "due":
        print(json.dumps(due(), ensure_ascii=False, indent=2))
    elif len(argv) >= 2 and argv[0] == "open":
        print(json.dumps(open_one(argv[1]), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "list":
        print(json.dumps(list_all(), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
