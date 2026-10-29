# -*- coding: utf-8 -*-
"""小鲸鱼 · DeepSeek Search/Fetch 统一网关（P0-3 计费闸门 + P1-5 缓存/限流/权威过滤/隐私）

背景：2026-11-01 00:00 起，DeepSeek Search/Fetch 按次计费，¥5 / 1000 次成功请求。
所有组件（Tulpa 接梗、bili-whale 选题核实、meow-memory 反思回填、直播弹幕）必须
经由本模块调用，禁止绕过。

用法：
    from search_gate import search, fetch, GateError, stats
    try:
        hits = search("某个梗是什么意思", scene="tulpa")
    except GateError as e:
        ...  # 被禁止 / 超预算 / 超上限，按场景降级处理

    python tools/search_gate.py search "query" --scene tulpa
    python tools/search_gate.py stats
    python tools/search_gate.py audit        # 未审核缓存条目列表

场景白名单（其他一律 GateError）：
    memory_reflect   meow-memory 反思回填（异步，最安全）
    bili_whale       选题雷达 + 日记事实核实
    tulpa            群聊接梗（只用 search，不用 fetch）
    live_danmaku     直播弹幕
硬性禁止（即使调用方传入也拒绝）：voice_call / selfwake / companion / chitchat
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

GATE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = GATE_DIR / "search_gate.config.json"
DB_FILE = GATE_DIR / "search_gate.db"

PRICE_PER_1000 = 5.0  # 元 / 1000 次成功请求

DEFAULT_CONFIG = {
    "enabled": True,
    "billing_starts": "2026-11-01",          # 之前免费但仍走闸门（养成统计习惯）
    "daily_call_cap": 100,                   # 每日总调用上限（成功+失败都计尝试数）
    "daily_cost_cap_yuan": 0.5,              # 每日预估费用上限
    "monthly_cost_cap_yuan": 10.0,           # 每月预估费用上限
    "cache_ttl_hours": 6,                    # 同一实体/话题 TTL 内只查一次
    "authority_min": 3,                      # 权威度门槛（3=极权威）
    "rerank_score_min": 1.5,                 # 优质分门槛
    "rate_limit_per_min": 6,                 # 限流：每分钟最多调用次数
    "allowed_scenes": ["memory_reflect", "bili_whale", "tulpa", "live_danmaku"],
    "forbidden_scenes": ["voice_call", "selfwake", "companion", "chitchat"],
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "timeout_sec": 20,
}

# 隐私扫描：手机号 / 身份证 / QQ号(独立出现) / 邮箱 一律拦下，不进缓存不进记忆
_PRIVACY = [
    re.compile(r"1[3-9]\d{9}"),
    re.compile(r"\d{17}[\dXx]"),
    re.compile(r"\b[1-9]\d{4,10}\b"),  # 可能误伤数字话题，宁严勿宽
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),
]


class GateError(RuntimeError):
    """闸门拒绝：调用方应做场景降级（不接梗/标注不确定），而不是重试。"""


# ---------- 配置与持久层 ----------

def load_config() -> dict:
    if CONFIG_FILE.is_file():
        try:
            cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
        except Exception:
            cfg = {}
        merged = dict(DEFAULT_CONFIG)
        merged.update(cfg)
        return merged
    CONFIG_FILE.write_text(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2),
                           "utf-8")
    return dict(DEFAULT_CONFIG)


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_FILE))
    conn.execute("""CREATE TABLE IF NOT EXISTS cache(
        key TEXT PRIMARY KEY, scene TEXT, query TEXT, payload TEXT,
        ts REAL, audited INTEGER DEFAULT 0)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS calls(
        ts REAL, scene TEXT, kind TEXT, query TEXT, ok INTEGER,
        cached INTEGER, cost REAL, note TEXT)""")
    return conn


# ---------- 闸门检查 ----------

def _today() -> str:
    return time.strftime("%Y-%m-%d")


def _month() -> str:
    return time.strftime("%Y-%m")


def _check_gate(cfg: dict, scene: str) -> None:
    if not cfg["enabled"]:
        raise GateError("网关已停用（search_gate.config.json: enabled=false）")
    if scene in cfg["forbidden_scenes"]:
        raise GateError("场景 %s 被硬性禁止（通话/自唤醒/黏人/闲聊不调 Search/Fetch）" % scene)
    if scene not in cfg["allowed_scenes"]:
        raise GateError("场景 %s 不在白名单 %s" % (scene, cfg["allowed_scenes"]))

    conn = _db()
    try:
        d0 = time.mktime(time.strptime(_today(), "%Y-%m-%d"))
        n_today = conn.execute(
            "SELECT COUNT(*) FROM calls WHERE ts>=? AND cached=0", (d0,)).fetchone()[0]
        if n_today >= cfg["daily_call_cap"]:
            raise GateError("今日调用已达上限 %d 次" % cfg["daily_call_cap"])

        cost_today = conn.execute(
            "SELECT COALESCE(SUM(cost),0) FROM calls WHERE ts>=?", (d0,)).fetchone()[0]
        if cost_today >= cfg["daily_cost_cap_yuan"]:
            raise GateError("今日预估费用已达上限 ¥%.2f" % cfg["daily_cost_cap_yuan"])

        m0 = time.mktime(time.strptime(_month() + "-01", "%Y-%m-%d"))
        cost_month = conn.execute(
            "SELECT COALESCE(SUM(cost),0) FROM calls WHERE ts>=?", (m0,)).fetchone()[0]
        if cost_month >= cfg["monthly_cost_cap_yuan"]:
            raise GateError("本月预估费用已达上限 ¥%.2f" % cfg["monthly_cost_cap_yuan"])

        recent = conn.execute(
            "SELECT COUNT(*) FROM calls WHERE ts>=?", (time.time() - 60,)).fetchone()[0]
        if recent >= cfg["rate_limit_per_min"]:
            raise GateError("触发限流：每分钟最多 %d 次" % cfg["rate_limit_per_min"])
    finally:
        conn.close()


def _record(scene: str, kind: str, query: str, ok: bool, cached: bool,
            billed: bool, note: str = "") -> None:
    cost = PRICE_PER_1000 / 1000.0 if (ok and billed and not cached) else 0.0
    conn = _db()
    try:
        conn.execute("INSERT INTO calls VALUES(?,?,?,?,?,?,?,?)",
                     (time.time(), scene, kind, query[:200], int(ok), int(cached),
                      cost, note[:200]))
        conn.commit()
    finally:
        conn.close()


def _billed_now(cfg: dict) -> bool:
    return _today() >= cfg["billing_starts"]


# ---------- 缓存 ----------

def _cache_key(kind: str, query: str) -> str:
    return hashlib.sha256(("%s|%s" % (kind, query.strip().lower())).encode()).hexdigest()


def _cache_get(kind: str, query: str, ttl_h: float):
    conn = _db()
    try:
        row = conn.execute("SELECT payload, ts FROM cache WHERE key=?",
                           (_cache_key(kind, query),)).fetchone()
        if row and time.time() - row[1] < ttl_h * 3600:
            return json.loads(row[0])
    finally:
        conn.close()
    return None


def _cache_put(kind: str, scene: str, query: str, payload) -> None:
    conn = _db()
    try:
        conn.execute("INSERT OR REPLACE INTO cache(key,scene,query,payload,ts,audited)"
                     " VALUES(?,?,?,?,?,0)",
                     (_cache_key(kind, query), scene, query[:200],
                      json.dumps(payload, ensure_ascii=False), time.time()))
        conn.commit()
    finally:
        conn.close()


# ---------- 隐私与质量过滤 ----------

def privacy_scan(text: str) -> bool:
    """True = 干净；False = 命中隐私特征，禁止入缓存/记忆/回复。"""
    return not any(p.search(text) for p in _PRIVACY)


def filter_results(results: list, cfg: dict) -> list:
    """authority ≥ 3 且 rerank_score ≥ 1.5 才放行；低质结果宁可不接梗。"""
    out = []
    for r in results or []:
        if (r.get("authority", 0) >= cfg["authority_min"] and
                r.get("rerank_score", 0) >= cfg["rerank_score_min"]):
            out.append(r)
    return out


# ---------- DeepSeek 调用 ----------

def _api_key() -> str:
    v = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if v:
        return v
    # 保险库（明文 .env 已占位符化，这里兜底）
    try:
        import key_vault
        v = (key_vault.get_key("DEEPSEEK_API_KEY") or "").strip()
        if v:
            return v
    except Exception:
        pass
    raise GateError("未找到 DEEPSEEK_API_KEY（先存进保险库：python tools/key_vault.py set DEEPSEEK_API_KEY）")


def _call_search_api(query: str, cfg: dict) -> list:
    """经 chat.completions 的 server 端 web_search 工具检索，返回结果列表。
    结果字段以 DeepSeek 文档为准：title/snippet/url/authority/rerank_score。"""
    body = json.dumps({
        "model": cfg["model"],
        "messages": [{"role": "user",
                      "content": "搜索并仅返回与以下问题最相关的事实结果：%s" % query}],
        "tools": [{"type": "web_search"}],
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        cfg["base_url"].rstrip("/") + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + _api_key()})
    with urllib.request.urlopen(req, timeout=cfg["timeout_sec"]) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    msg = (data.get("choices") or [{}])[0].get("message", {})
    # 优先结构化结果；无结构化字段时退化为单条摘要
    results = msg.get("search_results") or []
    if not results and msg.get("content"):
        results = [{"title": "summary", "snippet": msg["content"][:500],
                    "url": "", "authority": 0, "rerank_score": 0}]
    return results


# ---------- 对外接口 ----------

def search(query: str, scene: str) -> list:
    """检索。返回过滤后的结果列表（可能为空，调用方据此降级）。"""
    cfg = load_config()
    _check_gate(cfg, scene)
    if not privacy_scan(query):
        _record(scene, "search", query, False, False, False, "privacy_block")
        raise GateError("查询内容命中隐私特征，已拦截")

    cached = _cache_get("search", query, cfg["cache_ttl_hours"])
    if cached is not None:
        _record(scene, "search", query, True, True, False, "cache_hit")
        return cached

    try:
        raw = _call_search_api(query, cfg)
    except Exception as e:
        _record(scene, "search", query, False, False, False, type(e).__name__)
        raise GateError("Search 调用失败（%s）：按场景降级，不要重试" % type(e).__name__)

    results = filter_results(raw, cfg)
    clean = [r for r in results
             if privacy_scan("%s %s" % (r.get("title", ""), r.get("snippet", "")))]
    _cache_put("search", scene, query, clean)
    _record(scene, "search", query, True, False, _billed_now(cfg),
            "raw=%d kept=%d" % (len(raw), len(clean)))
    return clean


def fetch(url: str, scene: str) -> str:
    """取某 URL 正文。Tulpa 接梗禁止用本函数（Search 已够）。"""
    if scene == "tulpa":
        raise GateError("tulpa 场景只允许 search，不允许 fetch（成本与延迟考量）")
    cfg = load_config()
    _check_gate(cfg, scene)

    cached = _cache_get("fetch", url, cfg["cache_ttl_hours"])
    if cached is not None:
        _record(scene, "fetch", url, True, True, False, "cache_hit")
        return cached

    body = json.dumps({
        "model": cfg["model"],
        "messages": [{"role": "user", "content": "抓取并总结该页面正文要点：%s" % url}],
        "tools": [{"type": "web_fetch"}],
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        cfg["base_url"].rstrip("/") + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + _api_key()})
    try:
        with urllib.request.urlopen(req, timeout=cfg["timeout_sec"]) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        text = ((data.get("choices") or [{}])[0].get("message", {}) or {}).get("content", "")
    except Exception as e:
        _record(scene, "fetch", url, False, False, False, type(e).__name__)
        raise GateError("Fetch 调用失败（%s）：跳过该事实或标注不确定" % type(e).__name__)

    if not privacy_scan(text):
        _record(scene, "fetch", url, False, False, False, "privacy_block")
        raise GateError("抓取内容命中隐私特征，已拦截")
    _cache_put("fetch", scene, url, text)
    _record(scene, "fetch", url, True, False, _billed_now(cfg), "len=%d" % len(text))
    return text


def mark_audited(query: str, kind: str = "search") -> int:
    """人工审核通过后调用；未审核缓存不应写入长期记忆（knowledge-canvas 等）。"""
    conn = _db()
    try:
        cur = conn.execute("UPDATE cache SET audited=1 WHERE key=?",
                           (_cache_key(kind, query),))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def stats() -> dict:
    conn = _db()
    try:
        d0 = time.mktime(time.strptime(_today(), "%Y-%m-%d"))
        m0 = time.mktime(time.strptime(_month() + "-01", "%Y-%m-%d"))
        row = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(cost),0), SUM(ok), SUM(cached)"
            " FROM calls WHERE ts>=?", (d0,)).fetchone()
        rowm = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(cost),0) FROM calls WHERE ts>=?",
            (m0,)).fetchone()
        by_scene = dict(conn.execute(
            "SELECT scene, COUNT(*) FROM calls WHERE ts>=? GROUP BY scene",
            (d0,)).fetchall())
        pending = conn.execute(
            "SELECT COUNT(*) FROM cache WHERE audited=0").fetchone()[0]
    finally:
        conn.close()
    return {"today_calls": row[0], "today_cost": round(row[1], 4),
            "today_ok": row[2] or 0, "today_cache_hit": row[3] or 0,
            "month_calls": rowm[0], "month_cost": round(rowm[1], 4),
            "by_scene_today": by_scene, "pending_audit": pending}


# ---------- CLI ----------

def main(argv) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "search" and len(argv) >= 3:
        scene = "bili_whale"
        if "--scene" in argv:
            i = argv.index("--scene")
            scene = argv[i + 1]
            argv = argv[:i] + argv[i + 2:]
        try:
            for r in search(" ".join(argv[2:]), scene):
                print("- [%s] %s\n  %s (authority=%s score=%s)" % (
                    r.get("title", ""), r.get("snippet", "")[:160], r.get("url", ""),
                    r.get("authority", "?"), r.get("rerank_score", "?")))
        except GateError as e:
            print("GateError:", e)
            return 2
    elif cmd == "stats":
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
    elif cmd == "audit":
        conn = _db()
        try:
            for scene, query, ts in conn.execute(
                    "SELECT scene, query, ts FROM cache WHERE audited=0 ORDER BY ts DESC"):
                print("[%s] %s  %s" % (scene, time.strftime("%m-%d %H:%M",
                                        time.localtime(ts)), query))
        finally:
            conn.close()
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
