# -*- coding: utf-8 -*-
"""小鲸鱼 · 口头禅 / 语言指纹检测（P3）

人格保真度裁判管「像不像」，这个管「哪里变了」：统计她最近回复的
句长、语气词频率、emoji 密度，跟基线对比，偏离就提醒（比如
「最近变啰嗦了」）。数据源：logs/call_metrics.jsonl 的 reply 字段。

CLI：
    python tools/fingerprint.py analyze      # 与基线对比
    python tools/fingerprint.py baseline     # 把当前统计存为基线
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
METRICS = ROOT / "logs" / "call_metrics.jsonl"
BASELINE_FILE = ROOT / "data" / "fingerprint_baseline.json"

PARTICLES = ("呢", "呀", "啦", "嘛", "哦", "哼", "诶", "欸")
MIN_SAMPLES = 20   # 样本太少不评，免得一两句就「漂移」


def _replies(limit: int = 300) -> list:
    rows = []
    if not METRICS.is_file():
        return rows
    try:
        with open(METRICS, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                r = d.get("reply")
                if r:
                    rows.append(r)
    except OSError:
        pass
    return rows[-limit:]


def measure(replies: list) -> dict:
    """纯统计：平均句长 / 每句语气词 / 每句 emoji。"""
    if not replies:
        return {"samples": 0}
    lens = [len(r) for r in replies]
    particles = sum(sum(r.count(p) for p in PARTICLES) for r in replies)
    emojis = sum(len(re.findall(
        r"[\U0001F300-\U0001FAFF☀-➿\U0001F000-\U0001F0FF]", r)) for r in replies)
    n = len(replies)
    return {"samples": n, "avg_len": round(sum(lens) / n, 1),
            "particles_per_msg": round(particles / n, 2),
            "emoji_per_msg": round(emojis / n, 2)}


def analyze() -> dict:
    """与基线对比。没有基线就先存一份当基线。"""
    cur = measure(_replies())
    if cur["samples"] < MIN_SAMPLES:
        return {"ok": False, "msg": "样本不足 %d 条，暂不评估" % MIN_SAMPLES,
                **cur}
    if not BASELINE_FILE.is_file():
        BASELINE_FILE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE_FILE.write_text(json.dumps(cur, ensure_ascii=False, indent=2),
                                 "utf-8")
        return {"ok": True, "baseline_created": True, "current": cur,
                "drift": []}
    base = json.loads(BASELINE_FILE.read_text("utf-8"))
    drift = []
    if base.get("avg_len") and cur["avg_len"] > base["avg_len"] * 1.4:
        drift.append("最近变啰嗦了（句长 %.1f → %.1f）"
                     % (base["avg_len"], cur["avg_len"]))
    if base.get("avg_len") and cur["avg_len"] < base["avg_len"] * 0.6:
        drift.append("最近话变少了（句长 %.1f → %.1f）"
                     % (base["avg_len"], cur["avg_len"]))
    if base.get("particles_per_msg") is not None and \
            cur["particles_per_msg"] < base["particles_per_msg"] * 0.5:
        drift.append("语气词变少了，听起来有点生硬")
    return {"ok": True, "baseline_created": False, "current": cur,
            "baseline": base, "drift": drift}


def set_baseline() -> dict:
    cur = measure(_replies())
    if cur["samples"] < MIN_SAMPLES:
        return {"ok": False, "msg": "样本不足"}
    BASELINE_FILE.parent.mkdir(parents=True, exist_ok=True)
    BASELINE_FILE.write_text(json.dumps(cur, ensure_ascii=False, indent=2),
                             "utf-8")
    return {"ok": True, "baseline": cur}


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "baseline":
        print(json.dumps(set_baseline(), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(analyze(), ensure_ascii=False, indent=2))
