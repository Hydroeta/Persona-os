# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 跨平台一致性检测（P2）

「一个灵魂」最硬的验收：同一件事，群里说喜欢、电话里说讨厌，就是
人格裂缝。这里抽取各平台当日的事实陈述（我喜欢/我讨厌/我怕……），
按「同主题、极性相反」检测冲突。只提示，不自动改。

数据源（全本地）：通话回复 logs/call_metrics.jsonl、内容工坊产出
data/content_out/*.md、日记 diary/*.md。

CLI：
    python tools/consistency.py check
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
METRICS = ROOT / "logs" / "call_metrics.jsonl"
CONTENT_OUT = ROOT / "data" / "content_out"
DIARY_DIR = ROOT / "diary"

POS = ("我喜欢", "我爱", "我超喜欢", "我想", "我要")
NEG = ("我讨厌", "我不爱", "我不喜欢", "我怕", "我不想", "我不要")
# 抽取「我喜欢/讨厌 X」的主题词（2~6 字），跨平台对比极性
PAT = re.compile(r"我(?:超)?(?:喜欢|爱|讨厌|怕|想(?:要)?|不要|不喜欢|不爱)"
                 r"([一-龥]{1,6})")


def _today0() -> float:
    return time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d"))


def _statements() -> list:
    """[(platform, text)]：今日各平台她说过的话。"""
    out = []
    cut = _today0()
    if METRICS.is_file():
        try:
            with open(METRICS, encoding="utf-8") as f:
                for line in f:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get("ts", 0) >= cut and d.get("reply"):
                        out.append(("phone", d["reply"]))
        except OSError:
            pass
    if CONTENT_OUT.is_dir():
        for f in CONTENT_OUT.glob("*.md"):
            try:
                if f.stat().st_mtime >= cut:
                    out.append((f.stem.split("-")[0], f.read_text("utf-8",
                                                                  errors="replace")))
            except OSError:
                continue
    if DIARY_DIR.is_dir():
        for f in DIARY_DIR.glob("*.md"):
            try:
                if f.stat().st_mtime >= cut:
                    out.append(("diary", f.read_text("utf-8", errors="replace")))
            except OSError:
                continue
    return out


def check() -> dict:
    """返回 {statements, conflicts:[{topic, pos, neg}]}。只提示不改。"""
    likes, dislikes = {}, {}
    n = 0
    for platform, text in _statements():
        n += 1
        for m in PAT.finditer(text):
            topic = m.group(1)
            head = m.group(0)[: m.group(0).find(topic)]
            if any(w in head for w in ("讨厌", "不喜欢", "不爱", "怕", "不想", "不要")):
                dislikes.setdefault(topic, set()).add(platform)
            else:
                likes.setdefault(topic, set()).add(platform)
    conflicts = []
    for topic in set(likes) & set(dislikes):
        if likes[topic] != dislikes[topic] or len(topic) >= 2:
            conflicts.append({"topic": topic,
                              "pos": sorted(likes[topic]),
                              "neg": sorted(dislikes[topic])})
    return {"statements": n, "conflicts": conflicts,
            "note": "只提示不自动改；人工确认后走 memory_bus 求证/遗忘"}


if __name__ == "__main__":
    print(json.dumps(check(), ensure_ascii=False, indent=2))
