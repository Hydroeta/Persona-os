# -*- coding: utf-8 -*-
"""小鲸鱼 · 隐私仪表盘（只读：哪些数据外发了、发给了谁、多少条）

自托管项目的信任基石。不新增任何埋点，只汇总已有账本：
  llm_gate.db     → LLM 请求（发往 DeepSeek，token 与费用按场景）
  search_gate.db  → Search/Fetch 外发（发往搜索引擎聚合服务）
  logs/memory_audit.jsonl     → 记忆写入/遗忘审计
  logs/screen_audit.jsonl     → 读屏模块审计（截图是否外发等）
  config/screen_buddy.json    → 读屏开关 / 原图外发开关
  key_vault                   → 是否还有明文密钥残留

只读不改，任何条目都不含密钥或对话明文（只有计数与摘要长度）。

CLI：
    python tools/privacy_dashboard.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))


def summary() -> dict:
    out = {"generated": time.strftime("%Y-%m-%d %H:%M"), "sections": []}

    def sec(name, ok, lines):
        out["sections"].append({"name": name, "ok": bool(ok), "lines": lines})

    # 1) LLM 外发（DeepSeek）
    try:
        import llm_gate
        s = llm_gate.stats()
        per = "；".join("%s %d 次" % (k, v.get("calls", 0))
                        for k, v in sorted((s.get("per_scene_today") or {}).items()))
        sec("LLM 对话外发", True, [
            "去向：DeepSeek API（api.deepseek.com）",
            "今日 %d 次调用 / %d token / ¥%.3f" % (
                sum(v.get("calls", 0) for v in (s.get("per_scene_today") or {}).values()),
                s.get("today_tokens", 0), s.get("today_cost", 0)),
            "本月费用 ¥%.2f / 上限 ¥%.0f" % (s.get("month_cost", 0),
                                             s.get("monthly_cost_cap", 0)),
            "分场景：" + (per or "今日无"),
            "内容：对话文本（不含屏幕原图；读屏仅发事件摘要）"])
    except Exception as e:
        sec("LLM 对话外发", False, ["读取失败: %s" % type(e).__name__])

    # 2) Search/Fetch 外发
    try:
        import search_gate
        s = search_gate.stats()
        sec("Search/Fetch 外发", True, [
            "去向：搜索/网页抓取服务",
            "今日 %d 次（缓存命中 %d）/ ¥%.3f" % (
                s.get("today_calls", 0), s.get("today_cache_hit", 0),
                s.get("today_cost", 0)),
            "本月 %d 次 / ¥%.2f" % (s.get("month_calls", 0), s.get("month_cost", 0)),
            "内容：检索关键词与网页摘要，经 privacy_scan 过滤后外发"])
    except Exception as e:
        sec("Search/Fetch 外发", False, ["读取失败: %s" % type(e).__name__])

    # 3) 读屏模块（本地处理为默认）
    try:
        import screen_buddy
        cfg = screen_buddy.load_config()
        n_audit = 0
        if screen_buddy.AUDIT_FILE.is_file():
            n_audit = len(screen_buddy.AUDIT_FILE.read_text("utf-8").splitlines())
        sec("读屏陪伴", True, [
            "开关：%s（默认关闭）" % ("开启" if cfg.get("enabled") else "关闭"),
            "原图外发：%s" % ("允许（不推荐）" if cfg.get("allow_image_upload") else "禁止——画面只在本机内存处理"),
            "OCR：%s" % ("本地" if cfg.get("ocr_local", True) else "未知"),
            "审计条目 %d 条（可一键清空）" % n_audit,
            "黑名单应用 %d 个（密码管理器/银行/聊天默认排除）" % len(cfg.get("blacklist", []))])
    except Exception as e:
        sec("读屏陪伴", False, ["读取失败: %s" % type(e).__name__])

    # 4) 记忆审计（本地 SQLite/文件，不出本机）
    try:
        import memory_bus
        acts: dict[str, int] = {}
        for a in memory_bus.audit(500):
            acts[a.get("action", "?")] = acts.get(a.get("action", "?"), 0) + 1
        sec("记忆与遗忘（不出本机）", True, [
            "存储：本机 SQLite + Markdown 文件",
            "审计：" + ("；".join("%s %d 次" % kv for kv in sorted(acts.items()))
                       or "暂无记录"),
            "遗忘为软删除，审计日志不可删"])
    except Exception as e:
        sec("记忆与遗忘（不出本机）", False, ["读取失败: %s" % type(e).__name__])

    # 5) 密钥安全
    try:
        import key_vault
        plain = key_vault.plaintext_remaining()
        sec("密钥安全", not plain, [
            "密钥存 DPAPI 保险库（本机加密，不打印、不外发）",
            "明文残留：" + ("、".join(plain) if plain else "无（.env 均为占位符）")])
    except Exception as e:
        sec("密钥安全", False, ["读取失败: %s" % type(e).__name__])

    return out


if __name__ == "__main__":
    r = summary()
    print("# 隐私仪表盘 · %s" % r["generated"])
    for s in r["sections"]:
        print("\n## %s %s" % ("✓" if s["ok"] else "✗", s["name"]))
        for ln in s["lines"]:
            print("  - %s" % ln)
