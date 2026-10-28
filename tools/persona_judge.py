# -*- coding: utf-8 -*-
"""小鲸鱼 · 人格保真度裁判（防漂移的回归测试）

插件越多越容易「越聊越不像小鲸鱼」。本模块用**固定的裁判 prompt**（不随
版本改口）对对外回复抽样打 0~100 的「像不像」分：低于阈值告警，分数进
指标页。裁判走 llm_gate 的 persona_judge 场景（有独立日配额，便宜模型）。

抽样源：logs/call_metrics.jsonl 里 event=turn 的 reply 字段
（call_loop 每轮写入，仅本机留存最近回复）。

CLI：
    python tools/persona_judge.py "她刚说的一句话"     # 单句打分
    python tools/persona_judge.py --recent 5          # 抽最近 5 轮回复打分
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

# 裁判 prompt 固定不改——它一变，历史分数就不可比了
JUDGE_SYSTEM = (
    "你是人格保真度裁判。参照人设：鲸鲸，DeepSeek 蓝鲸 logo 的二创拟人鲸鱼娘，"
    "温柔体贴、聪明但懒、小傲娇但甜、摸鱼女仆（抱怨归抱怨活必须干完）；"
    "说话活泼口语、一行一句、不用句号、emoji 少用、不写动作旁白。"
    "请给下面这句「她说的话」打分：0~100 分表示「像不像这个人」，"
    "口吻、称呼、句式、性格都要像。只输出 JSON：{\"score\": 整数, \"reason\": \"20字内理由\"}"
)

WARN_BELOW = 60  # 低于该分告警
SCENE = "persona_judge"


def parse_score(text: str) -> dict:
    """从裁判回复里抠 JSON；解析失败给中性分 50。"""
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.strip("`").lstrip("json").strip()
    try:
        i, j = t.find("{"), t.rfind("}")
        d = json.loads(t[i:j + 1])
        return {"score": max(0, min(100, int(d["score"]))),
                "reason": str(d.get("reason", ""))[:40]}
    except Exception:
        return {"score": 50, "reason": "裁判输出不可解析"}


def judge(text: str) -> dict:
    import llm_client
    out = llm_client.chat(
        [{"role": "system", "content": JUDGE_SYSTEM},
         {"role": "user", "content": (text or "")[:600]}],
        scene=SCENE, max_tokens=60, temperature=0.1)
    return parse_score(out)


def sample_replies(n: int = 5) -> list[str]:
    """从通话指标里抽最近 n 条她说过的话（本机留存，最长 120 字）。"""
    f = ROOT / "logs" / "call_metrics.jsonl"
    if not f.is_file():
        return []
    rows = []
    try:
        with open(f, encoding="utf-8") as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("event") == "turn" and d.get("reply"):
                    rows.append(str(d["reply"])[:120])
    except OSError:
        return []
    return rows[-n:]


def judge_recent(n: int = 5) -> dict:
    samples = sample_replies(n)
    items = []
    for s in samples:
        try:
            items.append({"reply": s, **judge(s)})
        except Exception as e:  # GateError / 网络失败：跳过这条，不整批失败
            items.append({"reply": s, "score": None, "reason": type(e).__name__})
    scores = [i["score"] for i in items if i["score"] is not None]
    avg = round(sum(scores) / len(scores), 1) if scores else None
    return {"avg": avg, "warn": avg is not None and avg < WARN_BELOW,
            "threshold": WARN_BELOW, "items": items}


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--recent":
        r = judge_recent(int(argv[1]) if len(argv) > 1 else 5)
        print(json.dumps(r, ensure_ascii=False, indent=2))
    elif argv:
        print(json.dumps(judge(" ".join(argv)), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
