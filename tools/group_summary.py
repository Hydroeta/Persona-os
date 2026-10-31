# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 群聊潜水总结（P2）

群聊太多回不过来：她潜水一段时间后，在合适时机总结一句「刚才大家在聊 X」。
滑动窗口攒消息（内存态，不落盘），规则提取高频词当话题（零 LLM 默认；
要更自然可选走 llm_client group_summary 场景，日配额 5000，超预算自动
退回规则版）。频率上限：默认 30 分钟最多总结一次。

挂接方式：Tulpa/SnowLuma 侧收到群消息时调 Window.add()；要说话时调
Window.summarize()。本模块只做逻辑，不侵入那两个链路。

CLI：
    python tools/group_summary.py demo
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

STOP = set("的了是在我你他她它们这那有没不也都和就啊吗呢吧啦哦么什怎"
           "这个那个什么怎么没有可以不是")
MIN_MSGS = 8            # 窗口里至少这么多条才值得总结
SPEAK_GAP = 1800.0      # 两次总结最少间隔（30 分钟）


class Window:
    """一个群的潜水窗口。线程不安全就够（单消费者）。"""

    def __init__(self, max_msgs: int = 200):
        self.msgs: list = []        # [(ts, who, text)]
        self.max_msgs = max_msgs
        self.last_spoke = 0.0

    def add(self, who: str, text: str, ts: float | None = None) -> None:
        self.msgs.append((ts or time.time(), (who or "")[:16], (text or "")[:200]))
        if len(self.msgs) > self.max_msgs:
            self.msgs = self.msgs[-self.max_msgs:]

    def topics(self, topn: int = 3) -> list:
        """高频词当话题：2~4 字中文词，去掉停用字，按出现次数排序。"""
        cnt: dict = {}
        for _ts, _who, text in self.msgs:
            for w in re.findall(r"[一-龥]{2,4}", text):
                if any(ch in STOP for ch in w):
                    continue
                cnt[w] = cnt.get(w, 0) + 1
        return [w for w, _c in sorted(cnt.items(), key=lambda kv: -kv[1])
                [:topn] if cnt.get(w, 0) >= 2]

    def due(self, now: float | None = None) -> bool:
        """攒够了 + 冷却期过了 → 可以总结一句。"""
        now = time.time() if now is None else now
        return (len(self.msgs) >= MIN_MSGS
                and now - self.last_spoke >= SPEAK_GAP)

    def summarize(self, use_llm: bool = False) -> str:
        """规则版：高频话题拼接；可选 LLM 润色（走 group_summary 配额）。"""
        if not self.due():
            return ""
        topics = self.topics()
        who_cnt = len({w for _t, w, _x in self.msgs})
        text = ""
        if use_llm and topics:
            try:
                import llm_client
                sample = "；".join(t for _ts, _w, t in self.msgs[-15:])
                text = llm_client.chat(
                    [{"role": "user", "content":
                      "你是群友鲸鲸，潜水半天了。用一句口语总结大家刚才在聊什么"
                      "（30 字内，像真人插话，不要列点）。聊天记录：" + sample}],
                    scene="group_summary", max_tokens=80, temperature=0.7)
            except Exception:
                text = ""
        if not text:
            text = ("瞄了一眼，刚才 %d 位在聊%s" %
                    (who_cnt, "、".join(topics) if topics else "日常"))
        self.last_spoke = time.time()
        self.msgs = []
        return text


def _demo() -> None:
    w = Window()
    now = time.time()
    w.last_spoke = now - SPEAK_GAP - 1
    sample = [("阿明", "今晚吃火锅吧"), ("小红", "火锅好呀，哪家店"),
              ("阿明", "海底捞怎么样"), ("老李", "火锅火锅"),
              ("阿明", "周末聚会就火锅了"), ("小红", "聚会还有谁来"),
              ("老王", "聚会带我一个"), ("老李", "行，周末见")]
    for who, t in sample:
        w.add(who, t, ts=now - 60)
    print(w.summarize())


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "demo":
        _demo()
    else:
        print(__doc__)
