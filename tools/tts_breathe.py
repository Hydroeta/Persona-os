# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 呼吸感与停顿（P2，纯文本后处理）

TTS 出来的句子太「朗读腔」：一口气说完、没有停顿。这里在送进 GPT-SoVITS
之前做纯文本层面的处理（不碰音频管线，零风险）：
  · 长句在天然分句点（逗号/顿号）插入省略号，合成出来就是一次短停顿
  · 按句长自适应：短句不动，越长插得越多（有上限，别变成结巴）
  · 句间停顿建议值（毫秒），供播放端在两句之间 sleep

CLI：
    python tools/tts_breathe.py "本来想说的话很长很长，长到一口气说不完的那种"
"""
from __future__ import annotations

import re
import sys

LONG_SENTENCE = 16     # 超过这个长度才考虑插停顿
MAX_INSERTS = 2        # 单句最多插几处，防结巴
PAUSE_MARK = "……"     # SoVITS 会把省略号合成成短暂停顿


def insert_pauses(sentence: str) -> str:
    """给单句插停顿标记。短句原样返回。"""
    s = (sentence or "").strip()
    if len(s) < LONG_SENTENCE or PAUSE_MARK in s:
        return s
    # 候选停顿点：逗号/顿号/「然后」「但是」这类连接词之前
    points = [m.start() for m in re.finditer(r"[，、]", s)]
    if not points:
        return s
    # 均匀取最多 MAX_INSERTS 个点（避开句首句尾 3 字）
    inner = [p for p in points if 3 < p < len(s) - 3]
    if not inner:
        return s
    step = max(1, len(inner) // MAX_INSERTS)
    picks = set(inner[::step][:MAX_INSERTS])
    out = []
    for i, ch in enumerate(s):
        out.append(ch)
        if i in picks:
            out.append(PAUSE_MARK)
    return "".join(out)


def humanize(text: str) -> str:
    """整段回复：逐句插停顿。标点后换行拆句逻辑与 call_loop 一致。"""
    parts = re.split(r"(?<=[。！？!?；;\n])", text or "")
    return "".join(insert_pauses(p) for p in parts)


def pace_ms(text: str) -> int:
    """句间停顿建议（毫秒）：按句长 120~600ms，说话像真人一样换气。"""
    n = len(text or "")
    return max(120, min(600, 120 + n * 12))


def split_with_pace(text: str) -> list:
    """返回 [(句子, 建议句后停顿ms)]，供需要精细控制节奏的链路（睡前故事）。"""
    parts = [p.strip() for p in re.split(r"(?<=[。！？!?；;\n])", text or "")
             if p.strip()]
    return [(insert_pauses(p), pace_ms(p)) for p in parts]


if __name__ == "__main__":
    if len(sys.argv) >= 2:
        print(humanize(sys.argv[1]))
        print(split_with_pace(sys.argv[1]))
    else:
        print(__doc__)
