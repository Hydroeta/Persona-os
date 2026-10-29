# -*- coding: utf-8 -*-
"""小鲸鱼 · 桌面整理提醒（P2）

桌宠本职：桌面乱了她提醒整理，ddl 文件高亮提示。只读扫描，
永不自动移动/删除任何文件。

CLI：
    python tools/desk_tidy.py scan
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = Path.home() / "Desktop"
MESSY_COUNT = 30       # 桌面超过这么多项算「乱」
OLD_DAYS = 30          # 超过 30 天没动的文件视为「可能该归档」
DDL_WORDS = ("ddl", "deadline", "截止", "期末", "报告", "论文", "答辩",
             "作业", "汇报")


def scan(desktop: Path | None = None) -> dict:
    """返回桌面概况与建议。只读。找不到桌面返回 ok=False。"""
    desk = desktop or DESKTOP
    if not desk.is_dir():
        return {"ok": False, "msg": "找不到桌面目录"}
    now = __import__("time").time()
    items, old, ddl = [], [], []
    try:
        for p in desk.iterdir():
            try:
                st = p.stat()
            except OSError:
                continue
            items.append(p.name)
            age_d = (now - st.st_mtime) / 86400.0
            if p.is_file() and age_d >= OLD_DAYS:
                old.append(p.name)
            low = p.name.lower()
            if p.is_file() and any(w in low for w in DDL_WORDS):
                ddl.append(p.name)
    except OSError as e:
        return {"ok": False, "msg": type(e).__name__}
    suggestions = []
    if len(items) >= MESSY_COUNT:
        suggestions.append("桌面有 %d 项了，要不要收拾一下？" % len(items))
    if old:
        suggestions.append("有 %d 个文件超过 %d 天没动过，也许可以归档"
                           % (len(old), OLD_DAYS))
    if ddl:
        suggestions.append("这几个文件名看着像有期限：%s"
                           % "、".join(ddl[:5]))
    return {"ok": True, "count": len(items), "old": len(old),
            "ddl_like": ddl[:10], "suggestions": suggestions,
            "note": "只读扫描，不会移动任何文件"}


if __name__ == "__main__":
    import json
    print(json.dumps(scan(), ensure_ascii=False, indent=2))
