# -*- coding: utf-8 -*-
"""小鲸鱼 · 虚拟零花钱（P2）

给她设一份「虚拟预算」（不是真钱，只是把她每月 LLM 预估花费人格化）：
花超了她自己用撒娇的口吻提醒「省着点」。比冷冰冰的限额条更有动力，
也更好玩。数据全部来自 llm_gate 账本，零新增埋点。

CLI：
    python tools/allowance.py              # 当前零花钱状况（含她的口吻提示）
    python tools/allowance.py set 20       # 设月预算 ¥20
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
CONFIG_FILE = ROOT / "config" / "allowance.json"
DEFAULT = {"monthly_yuan": 10.0}


def load_config() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
    except Exception:
        cfg = {}
    merged = dict(DEFAULT)
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT})
    return merged


def status() -> dict:
    """返回 {budget, spent, left, over, line}。line 是她的口吻提示。"""
    budget = float(load_config()["monthly_yuan"])
    try:
        import llm_gate
        spent = float(llm_gate.stats().get("month_cost", 0.0))
    except Exception:
        spent = 0.0
    left = round(budget - spent, 3)
    over = left < 0
    ratio = spent / budget if budget > 0 else 0.0
    if over:
        line = "主人……零花钱花超啦，接下来我们省着点好不好"
    elif ratio >= 0.8:
        line = "零花钱只剩一点点了，我这几天少说点话省钱"
    elif ratio >= 0.5:
        line = "零花钱花了一半啦，还行还行"
    else:
        line = "零花钱还很充足，主人放心"
    return {"budget": budget, "spent": round(spent, 3), "left": left,
            "over": over, "line": line, "note": "虚拟预算，不是真钱"}


def set_budget(yuan: float) -> dict:
    cfg = load_config()
    cfg["monthly_yuan"] = float(yuan)
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    return status()


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "set":
        print(json.dumps(set_budget(float(sys.argv[2])), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(status(), ensure_ascii=False, indent=2))
