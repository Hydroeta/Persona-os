# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · LLM Token 闸门（成本主战场：通话/搭话/直播/定时任务全是 LLM 消耗）

search_gate 闸的是按次计费的 Search/Fetch；本模块闸按 token 计费的 LLM 对话本身。
没有精确 tokenizer，按 2 字符 ≈ 1 token 估算（中文场景偏保守，宁多勿少）。

用法（调用方）：
    import llm_gate
    try:
        llm_gate.allow("call", est_input_tokens=800)
        ... 调 LLM ...
        llm_gate.record("call", input_chars=1600, output_chars=60)
    except llm_gate.GateError:
        ... 场景降级：固定应答 / 静默 / 缩短回复

场景与降级策略（超预算时调用方照做，不要重试）：
    call          通话      → 固定应答（"我信号不好，待会说"）
    companion     梯度搭话  → 静默（这轮不搭话）
    selfwake      自唤醒    → 跳过本次
    live_danmaku  直播弹幕  → 跳过该条弹幕
    cron          定时任务  → 缩短输出/改模板文案
    other         其他      → 调用方自定

CLI：
    python tools/llm_gate.py stats            # 用量与单位经济
    python tools/llm_gate.py check call 800   # 试算某场景是否放行
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

GATE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = GATE_DIR / "llm_gate.config.json"
DB_FILE = GATE_DIR / "llm_gate.db"

DEFAULT_CONFIG = {
    "enabled": True,
    "daily_token_cap": 200000,               # 全场景每日 token 总上限（入+出）
    "monthly_cost_cap_yuan": 30.0,           # 每月 LLM 预估费用上限
    # DeepSeek 标准时段单价（元 / 百万 token），按实际账单调整
    "price_input_per_m": 2.0,
    "price_output_per_m": 8.0,
    "scene_daily_tokens": {                  # 按场景配额，防单一场景吃光预算
        "call": 60000, "companion": 20000, "selfwake": 10000,
        "live_danmaku": 30000, "cron": 20000, "screen": 15000,
        "persona_judge": 8000, "rewrite": 15000, "other": 10000,
        "capsule": 2000, "guard": 2000, "group_summary": 5000,
    },
}


class GateError(RuntimeError):
    """预算/配额超限：调用方按场景降级，不要重试。"""


def load_config() -> dict:
    if CONFIG_FILE.is_file():
        try:
            cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
        except Exception:
            cfg = {}
        merged = dict(DEFAULT_CONFIG)
        merged.update(cfg)
        merged["scene_daily_tokens"] = {**DEFAULT_CONFIG["scene_daily_tokens"],
                                        **cfg.get("scene_daily_tokens", {})}
        return merged
    try:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2),
                               "utf-8")
    except OSError:
        pass   # 配置目录不可写就用内存默认值，别让预算模块反过来崩业务
    return dict(DEFAULT_CONFIG)


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_FILE))
    conn.execute("""CREATE TABLE IF NOT EXISTS usage(
        ts REAL, scene TEXT, in_tok INTEGER, out_tok INTEGER, cost REAL)""")
    # 多厂商资金看板需要按 provider 精算：老库补列，存量记录归 deepseek
    cols = [r[1] for r in conn.execute("PRAGMA table_info(usage)")]
    if "provider" not in cols:
        conn.execute("ALTER TABLE usage ADD COLUMN provider TEXT NOT NULL DEFAULT 'deepseek'")
    return conn


def est_tokens(chars: int) -> int:
    """2 字符 ≈ 1 token（中文偏保守）。"""
    return max(1, int(chars) // 2 + 1)


def _today0() -> float:
    return time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d"))


def _month0() -> float:
    return time.mktime(time.strptime(time.strftime("%Y-%m") + "-01", "%Y-%m-%d"))


def allow(scene: str, est_input_tokens: int = 0) -> bool:
    """调用前检查。超限抛 GateError。"""
    cfg = load_config()
    if not cfg["enabled"]:
        return True
    conn = _db()
    try:
        row = conn.execute(
            "SELECT COALESCE(SUM(in_tok+out_tok),0), COALESCE(SUM(cost),0) "
            "FROM usage WHERE ts>=?", (_today0(),)).fetchone()
        tok_today, cost_today = row
        if tok_today + est_input_tokens > cfg["daily_token_cap"]:
            raise GateError("今日 token 总预算 %d 已用尽" % cfg["daily_token_cap"])
        scene_cap = cfg["scene_daily_tokens"].get(scene,
                                                  cfg["scene_daily_tokens"]["other"])
        st = conn.execute(
            "SELECT COALESCE(SUM(in_tok+out_tok),0) FROM usage WHERE ts>=? AND scene=?",
            (_today0(), scene)).fetchone()[0]
        if st + est_input_tokens > scene_cap:
            raise GateError("场景 %s 今日配额 %d token 已用尽" % (scene, scene_cap))
        mc = conn.execute("SELECT COALESCE(SUM(cost),0) FROM usage WHERE ts>=?",
                          (_month0(),)).fetchone()[0]
        if mc >= cfg["monthly_cost_cap_yuan"]:
            raise GateError("本月 LLM 预估费用已达上限 ¥%.2f" % cfg["monthly_cost_cap_yuan"])
    finally:
        conn.close()
    return True


def record(scene: str, input_chars: int, output_chars: int,
           provider: str = "deepseek") -> dict:
    """调用后记账。返回本次估算 {in_tok, out_tok, cost}。"""
    cfg = load_config()
    it, ot = est_tokens(input_chars), est_tokens(output_chars)
    cost = (it * cfg["price_input_per_m"] + ot * cfg["price_output_per_m"]) / 1e6
    conn = _db()
    try:
        conn.execute("INSERT INTO usage VALUES(?,?,?,?,?,?)",
                     (time.time(), scene, it, ot, cost, provider))
        conn.commit()
    finally:
        conn.close()
    return {"in_tok": it, "out_tok": ot, "cost": round(cost, 6)}


def monthly_usage_by_provider() -> dict:
    """本月各 provider 的 token 消耗：{provider: {in_tok, out_tok}}。
    供 balance_monitor 对无余额接口的厂商（GLM/Qwen）做本地精算。"""
    conn = _db()
    try:
        rows = conn.execute(
            "SELECT provider, COALESCE(SUM(in_tok),0), COALESCE(SUM(out_tok),0) "
            "FROM usage WHERE ts>=? GROUP BY provider", (_month0(),)).fetchall()
    finally:
        conn.close()
    return {p: {"in_tok": int(i), "out_tok": int(o)} for p, i, o in rows}


def stats() -> dict:
    """用量 + 单位经济（每轮通话/每次搭话成本）。"""
    cfg = load_config()
    conn = _db()
    try:
        d0, m0 = _today0(), _month0()
        dt, dc = conn.execute(
            "SELECT COALESCE(SUM(in_tok+out_tok),0), COALESCE(SUM(cost),0) "
            "FROM usage WHERE ts>=?", (d0,)).fetchone()
        mt, mc = conn.execute(
            "SELECT COALESCE(SUM(in_tok+out_tok),0), COALESCE(SUM(cost),0) "
            "FROM usage WHERE ts>=?", (m0,)).fetchone()
        per_scene = {}
        for scene, tok, cost, n in conn.execute(
                "SELECT scene, SUM(in_tok+out_tok), SUM(cost), COUNT(*) "
                "FROM usage WHERE ts>=? GROUP BY scene", (d0,)):
            per_scene[scene] = {"tokens": tok, "cost": round(cost, 4), "calls": n,
                                "cost_per_call": round(cost / n, 5) if n else 0}
    finally:
        conn.close()
    return {"today_tokens": dt, "today_cost": round(dc, 4),
            "month_tokens": mt, "month_cost": round(mc, 4),
            "daily_token_cap": cfg["daily_token_cap"],
            "monthly_cost_cap": cfg["monthly_cost_cap_yuan"],
            "per_scene_today": per_scene}


def budget_warn() -> str:
    """用量达 80% 时返回告警文案，否则空串（控制台/alert 用）。"""
    s = stats()
    if s["month_cost"] >= s["monthly_cost_cap"] * 0.8:
        return "LLM 本月费用 ¥%.2f 已达月上限 80%%" % s["month_cost"]
    if s["today_tokens"] >= s["daily_token_cap"] * 0.8:
        return "LLM 今日 token %d 已达日上限 80%%" % s["today_tokens"]
    return ""


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "stats":
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
    elif len(sys.argv) >= 4 and sys.argv[1] == "check":
        try:
            allow(sys.argv[2], int(sys.argv[3]))
            print("放行")
        except GateError as e:
            print("拦截:", e)
    else:
        print(__doc__)
