# -*- coding: utf-8 -*-
"""小鲸鱼 · 成本沙盘（上线新行为前先模拟「今天大概花多少」）

把成本判断前移：跑一个新场景（读屏/直播/更多通话）前，先用历史均价 ×
预设次数算出「一天/一月大概花多少」，纯本地计算，不花一分钱。

数据源：
  tools/llm_gate.db 的 usage 表 → 各场景平均每次 token 与费用（真实历史价）
  config/cost_sandbox.json     → 各场景每天预期次数（缺省用内置假设）

CLI：
    python tools/cost_sandbox.py                 # 按当前假设模拟
    python tools/cost_sandbox.py call:50         # 覆盖单个场景：通话一天 50 轮
    python tools/cost_sandbox.py screen:100 companion:40
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
CONFIG_FILE = ROOT / "config" / "cost_sandbox.json"

# 内置假设（可被 config/cost_sandbox.json 覆盖）：
#   turns=每天预期调用次数, in_chars/out_chars=单次输入/输出字符量
DEFAULT_SCENARIOS = {
    "call":          {"turns": 30, "in_chars": 1500, "out_chars": 40},
    "companion":     {"turns": 10, "in_chars": 900, "out_chars": 30},
    "selfwake":      {"turns": 6, "in_chars": 800, "out_chars": 60},
    "live_danmaku":  {"turns": 20, "in_chars": 700, "out_chars": 60},
    "cron":          {"turns": 8, "in_chars": 1200, "out_chars": 200},
    "screen":        {"turns": 4, "in_chars": 600, "out_chars": 40},
    "persona_judge": {"turns": 5, "in_chars": 500, "out_chars": 40},
    "rewrite":       {"turns": 4, "in_chars": 900, "out_chars": 300},
}


def load_scenarios() -> dict:
    base = {k: dict(v) for k, v in DEFAULT_SCENARIOS.items()}
    if CONFIG_FILE.is_file():
        try:
            cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
            for k, v in cfg.items():
                if k in base and isinstance(v, dict):
                    base[k].update(v)
        except Exception:
            pass
    return base


def _avg_per_call() -> dict:
    """从 llm_gate 真实账本取各场景平均单次 token（有数据才准）。"""
    out: dict[str, dict] = {}
    try:
        import llm_gate
        if not llm_gate.DB_FILE.is_file():
            return out
        import sqlite3
        conn = sqlite3.connect(str(llm_gate.DB_FILE))
        rows = conn.execute(
            "SELECT scene, COUNT(*), AVG(in_tok), AVG(out_tok) FROM usage GROUP BY scene"
        ).fetchall()
        conn.close()
        for scene, n, it, ot in rows:
            if n:
                out[scene] = {"calls": n, "avg_in": int(it), "avg_out": int(ot)}
    except Exception:
        pass
    return out


def simulate(overrides: dict[str, int] | None = None) -> dict:
    """返回按场景拆分的日成本/月成本预估（元）。"""
    import llm_gate
    cfg = llm_gate.load_config()
    price_in, price_out = cfg["price_input_per_m"], cfg["price_output_per_m"]
    caps = cfg["scene_daily_tokens"]
    scen = load_scenarios()
    hist = _avg_per_call()
    rows, total_day = [], 0.0
    for scene, s in scen.items():
        turns = int((overrides or {}).get(scene, s["turns"]))
        # 优先用真实均价；没有历史数据才用假设的字符量
        h = hist.get(scene)
        in_tok = h["avg_in"] if h else llm_gate.est_tokens(s["in_chars"])
        out_tok = h["avg_out"] if h else llm_gate.est_tokens(s["out_chars"])
        day_cost = turns * (in_tok * price_in + out_tok * price_out) / 1e6
        cap = caps.get(scene, caps.get("other", 0))
        day_tok = turns * (in_tok + out_tok)
        rows.append({"scene": scene, "turns": turns,
                     "tokens_per_day": day_tok,
                     "cost_per_day": round(day_cost, 3),
                     "cost_per_month": round(day_cost * 30, 2),
                     "over_cap": bool(cap and day_tok > cap)})
        total_day += day_cost
    total_day = round(total_day, 3)
    return {"price_input_per_m": price_in, "price_output_per_m": price_out,
            "scenes": rows, "total_per_day": total_day,
            "total_per_month": round(total_day * 30, 2),
            "daily_token_cap": cfg["daily_token_cap"],
            "monthly_cost_cap": cfg["monthly_cost_cap_yuan"],
            "note": "按历史均价×预设次数本地推算，未发生任何真实调用"}


def _parse_overrides(args: list[str]) -> dict:
    out = {}
    for a in args:
        if ":" in a:
            k, v = a.split(":", 1)
            try:
                out[k] = int(v)
            except ValueError:
                pass
    return out


if __name__ == "__main__":
    r = simulate(_parse_overrides(sys.argv[1:]))
    print("%-14s %8s %12s %12s %8s" % ("场景", "次数/天", "成本/天¥", "成本/月¥", "超配额"))
    for s in r["scenes"]:
        print("%-14s %8d %12.3f %12.2f %8s" % (
            s["scene"], s["turns"], s["cost_per_day"], s["cost_per_month"],
            "是" if s["over_cap"] else ""))
    print("合计：每天 ¥%.3f ｜ 每月 ¥%.2f（月上限 ¥%.0f）"
          % (r["total_per_day"], r["total_per_month"], r["monthly_cost_cap"]))
