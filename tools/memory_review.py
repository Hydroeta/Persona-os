# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 记忆求证队列 + 间隔重复复习 + 日记导出（P2）

三件事共用「让记忆活起来」的入口：
  1. 求证队列：memory_bus.health() 发现的矛盾不静默覆盖，排队等她找机会
     自然问一句「你上次说喜欢猫，后来变了吗？」
  2. 间隔重复：按遗忘曲线挑「该复习」的旧记忆，低频提示（越重要间隔越长）。
  3. 日记导出：把她写过的日记合成一本 Markdown 合集，支持脱敏。

CLI：
    python tools/memory_review.py queue            # 待求证队列
    python tools/memory_review.py rebuild          # 从记忆体检重建队列
    python tools/memory_review.py asked "标题"      # 标记已问过
    python tools/memory_review.py review           # 今天该复习的旧记忆
    python tools/memory_review.py export [out.md] [--mask]
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
QUEUE_FILE = ROOT / "data" / "memory_review_queue.json"
DIARY_DIR = ROOT / "diary"
REVIEW_MIN_DAYS = 7   # 最短复习间隔；importance 每多 1 间隔再加 7 天


# ---------- 求证队列 ----------

def _loadq() -> list:
    try:
        d = json.loads(QUEUE_FILE.read_text("utf-8"))
        return d if isinstance(d, list) else []
    except Exception:
        return []


def _saveq(items: list) -> None:
    try:
        QUEUE_FILE.parent.mkdir(parents=True, exist_ok=True)
        QUEUE_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), "utf-8")
    except OSError:
        pass


def rebuild_queue() -> dict:
    """从记忆体检的冲突样本重建求证队列（已入队的不重复加）。"""
    import memory_bus
    h = memory_bus.health(limit=10)
    items = _loadq()
    known = {i["title"] for i in items if not i.get("asked")}
    added = 0
    for c in h.get("conflict_samples", []):
        if c["title"] in known:
            continue
        items.append({"title": c["title"], "where": c.get("where", []),
                      "asked": False, "ts": time.time(),
                      "question": "你上次提到「%s」，后来有变化吗？" % c["title"]})
        added += 1
    _saveq(items)
    return {"total": len(items), "added": added}


def pending() -> list:
    return [i for i in _loadq() if not i.get("asked")]


def mark_asked(title: str) -> dict:
    items = _loadq()
    n = 0
    for i in items:
        if i["title"] == title and not i.get("asked"):
            i["asked"] = True
            i["asked_ts"] = time.time()
            n += 1
    _saveq(items)
    return {"marked": n}


# ---------- 间隔重复复习 ----------

def review_candidates(n: int = 3, now: float | None = None) -> list:
    """挑「该复习」的旧记忆：active 且 距今 >= max(7, importance*7) 天。
    只读；返回的提示语由调用方（selfwake/日报）择机使用。"""
    import memory_bus
    now = time.time() if now is None else now
    out = []
    for db in memory_bus._meow_dbs():
        try:
            conn = memory_bus._connect(db)
            for tbl in memory_bus.MEOW_TABLES:
                try:
                    rows = conn.execute(
                        f"SELECT title, importance, updated_at FROM {tbl} "
                        "WHERE status='active'").fetchall()
                except Exception:
                    continue
                for title, imp, upd in rows:
                    age_d = (now - (upd or 0)) / 86400.0
                    need = max(REVIEW_MIN_DAYS, (imp or 1) * 7)
                    if age_d >= need and title:
                        out.append({"title": title, "age_days": int(age_d),
                                    "where": "meow:%s" % tbl,
                                    "cue": "还记得吗，你之前说过「%s」……" % title})
            conn.close()
        except Exception:
            continue
    out.sort(key=lambda x: -x["age_days"])
    return out[:n]


# ---------- 日记导出 ----------

_MASK_PATTERNS = [
    (re.compile(r"1[3-9]\d{9}"), "1**********"),          # 手机号
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "***@***"),  # 邮箱
    (re.compile(r"\b\d{17}[\dXx]\b"), "******************"),  # 身份证
]


def export_diaries(out_file: Path | None = None, mask: bool = False) -> dict:
    """把 diary/*.md 合成一本合集（跳过 _forgotten/ 与 dream 以外的隐藏目录）。"""
    out_file = out_file or (ROOT / "data" / "diary_export.md")
    parts = ["# 鲸鲸的日记合集", "",
             "> 导出于 %s%s" % (time.strftime("%Y-%m-%d %H:%M"),
                                "（已脱敏）" if mask else ""), ""]
    n = 0
    if DIARY_DIR.is_dir():
        for f in sorted(DIARY_DIR.glob("*.md")):
            try:
                txt = f.read_text("utf-8", errors="replace")
            except OSError:
                continue
            if mask:
                for pat, rep in _MASK_PATTERNS:
                    txt = pat.sub(rep, txt)
            parts += ["---", "", txt.strip(), ""]
            n += 1
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text("\n".join(parts) + "\n", "utf-8")
    return {"path": str(out_file), "entries": n, "masked": mask}


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "queue":
        print(json.dumps(pending(), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "rebuild":
        print(json.dumps(rebuild_queue(), ensure_ascii=False, indent=2))
    elif len(argv) >= 2 and argv[0] == "asked":
        print(json.dumps(mark_asked(argv[1]), ensure_ascii=False))
    elif argv and argv[0] == "review":
        print(json.dumps(review_candidates(), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "export":
        out = Path(argv[1]) if len(argv) >= 2 and not argv[1].startswith("--") else None
        print(json.dumps(export_diaries(out, mask="--mask" in argv),
                         ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
