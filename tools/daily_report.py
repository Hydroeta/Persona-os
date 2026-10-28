# -*- coding: utf-8 -*-
"""小鲸鱼 · 「她的一天」日报

无人值守时页面红条没人看，所以每天固定产出一份可读的日报：
四平台做了什么、花了多少、有没有异常、明天要做什么。口吻用角色而不是监控面板。

数据全部来自已有账本，不新增埋点：
  logs/call_metrics.jsonl、tools/llm_gate.db、tools/search_gate.db、
  logs/resource.jsonl、logs/console_health.jsonl、data/call_summaries/、dsh/Users/YourName

CLI：
    python tools/daily_report.py            # 生成今天的日报（异常会外发告警）
    python tools/daily_report.py --no-alert
    python tools/daily_report.py show       # 打印最新一份
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

REPORT_DIR = ROOT / "data" / "reports"
CALL_METRICS = ROOT / "logs" / "call_metrics.jsonl"
HEALTH_LOG = ROOT / "logs" / "console_health.jsonl"
CRON_FILE = ROOT / "dsh" / "home" / "cron-jobs.json"
SUMMARY_DIR = ROOT / "data" / "call_summaries"
DIARY_DIR = ROOT / "diary"
AUDIT_FILE = ROOT / "logs" / "memory_audit.jsonl"


def _today0() -> float:
    return time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d"))


def _jsonl_today(path: Path) -> list[dict]:
    rows = []
    if not path.is_file():
        return rows
    cut = _today0()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("ts", 0) >= cut:
                    rows.append(d)
    except OSError:
        pass
    return rows


def _calls() -> dict:
    rows = _jsonl_today(CALL_METRICS)
    turns = [r for r in rows if r.get("event") == "turn"]
    lat = sorted(t["tts_first"] for t in turns if t.get("tts_first") is not None)
    p50 = lat[len(lat) // 2] if lat else None
    p95 = lat[min(len(lat) - 1, int(len(lat) * 0.95))] if lat else None
    degrade = sum(1 for r in rows if r.get("event") in
                  ("llm_fail", "tts_fallback", "asr_timeout", "llm_gate_block"))
    summaries = 0
    if SUMMARY_DIR.is_dir():
        for f in SUMMARY_DIR.glob("*.json"):
            try:
                if f.stat().st_mtime >= _today0():
                    summaries += 1
            except OSError:
                pass
    return {"turns": len(turns), "p50": p50, "p95": p95,
            "interrupt_rate": (sum(1 for t in turns if t.get("interrupted")) / len(turns)
                               if turns else 0.0),
            "degrades": degrade, "summaries": summaries,
            "last_summary": _last_summary()}


def _last_summary() -> str:
    try:
        names = sorted(n for n in SUMMARY_DIR.glob("*.json"))
    except OSError:
        return ""
    if not names:
        return ""
    try:
        return (json.loads(names[-1].read_text("utf-8")).get("summary") or "")[:120]
    except Exception:
        return ""


def _cron() -> dict:
    try:
        d = json.loads(CRON_FILE.read_text("utf-8"))
    except Exception:
        return {"enabled": 0, "total": 0, "names": []}
    jobs = d.get("jobs", d) if isinstance(d, dict) else d
    if not isinstance(jobs, list):
        jobs = []
    on = [j for j in jobs if j.get("enabled")]
    return {"enabled": len(on), "total": len(jobs),
            "names": [j.get("name") or j.get("id") or "?" for j in on]}


def _forget_today() -> int:
    return sum(1 for r in _jsonl_today(AUDIT_FILE) if r.get("action") == "forget")


def _diary_today() -> int:
    if not DIARY_DIR.is_dir():
        return 0
    n = 0
    for f in DIARY_DIR.glob("*.md"):
        try:
            if f.stat().st_mtime >= _today0():
                n += 1
        except OSError:
            pass
    return n


def collect() -> dict:
    out = {"date": time.strftime("%Y-%m-%d"), "generated": time.strftime("%H:%M")}
    out["calls"] = _calls()
    out["cron"] = _cron()
    out["diary_today"] = _diary_today()
    out["forget_today"] = _forget_today()
    try:
        import llm_gate
        out["llm"] = llm_gate.stats()
    except Exception:
        out["llm"] = {}
    try:
        import search_gate
        out["search"] = search_gate.stats()
    except Exception:
        out["search"] = {}
    try:
        import resource_gate
        out["resource"] = resource_gate.status()
    except Exception:
        out["resource"] = {}
    try:
        import state_engine
        out["state"] = state_engine.status()
    except Exception:
        out["state"] = {}
    try:
        import relations
        out["relations"] = relations.anniversaries_today()
    except Exception:
        out["relations"] = []
    try:
        import memory_bus
        h = memory_bus.health()
        out["memory_health"] = {k: len(v) for k, v in h.items() if isinstance(v, list)}
    except Exception:
        out["memory_health"] = {}
    # P2 陪伴数据：全部软挂，挂了不挡日报
    try:
        import care
        out["observe"] = care.observe_day()
    except Exception:
        out["observe"] = ""
    try:
        import goals
        out["goals"] = goals.today().get("items", [])
    except Exception:
        out["goals"] = []
    try:
        import time_capsule
        out["capsules_due"] = len(time_capsule.due())
    except Exception:
        out["capsules_due"] = 0
    try:
        import calendar_watch
        out["schedule"] = calendar_watch.upcoming(days=1)
    except Exception:
        out["schedule"] = []
    crashes = [r for r in _jsonl_today(HEALTH_LOG)
               if r.get("event") in ("crash", "restart_cap")]
    out["crashes"] = len(crashes)
    anomalies = []
    c = out["calls"]
    if c["p95"] and c["p95"] > 8:
        anomalies.append("通话首音 P95 %.1f 秒，超过 8 秒阈值" % c["p95"])
    if c["degrades"] >= 3:
        anomalies.append("通话降级 %d 次（LLM/TTS/ASR 有异常）" % c["degrades"])
    if out["crashes"]:
        anomalies.append("服务崩溃/重启触顶 %d 次" % out["crashes"])
    r = out["resource"]
    if r.get("warn"):
        anomalies.append("显存 %s MB 接近 4GB 上限" % r.get("vram_used_mb"))
    llm = out["llm"]
    if llm and llm.get("today_tokens", 0) >= llm.get("daily_token_cap", 1) * 0.8:
        anomalies.append("LLM 今日 token 已用 %.0f%%"
                         % (100.0 * llm["today_tokens"] / max(1, llm["daily_token_cap"])))
    out["anomalies"] = anomalies
    return out


def _voice_summary(d: dict) -> str:
    c = d["calls"]
    st = d.get("state") or {}
    parts = []
    if c["turns"]:
        parts.append("今天接了 %d 轮电话（%d 通）" % (c["turns"], max(1, c["summaries"])))
    else:
        parts.append("今天没接到电话")
    if d["cron"]["enabled"]:
        parts.append("跑了 %d 个定时任务" % d["cron"]["enabled"])
    if d["diary_today"]:
        parts.append("写了 %d 篇日记" % d["diary_today"])
    if st:
        parts.append("现在的我是「%s、%s」" % (st.get("energy_label", ""),
                                              st.get("mood_label", "")))
    return "，".join(parts) + "。"


def render(d: dict) -> str:
    c, llm, sr = d["calls"], d.get("llm") or {}, d.get("search") or {}
    st = d.get("state") or {}
    L = ["# 她的一天 · %s" % d["date"], "",
         "> %s" % _voice_summary(d), "",
         "## 电话", "",
         "- 轮次 %d｜首音 P50 %s｜P95 %s｜打断率 %.0f%%" % (
             c["turns"],
             "—" if c["p50"] is None else "%.1fs" % c["p50"],
             "—" if c["p95"] is None else "%.1fs" % c["p95"],
             c["interrupt_rate"] * 100),
         "- 降级 %d 次｜今日新增回味摘要 %d 份" % (c["degrades"], c["summaries"])]
    if c["last_summary"]:
        L.append("- 最近一次聊到：%s" % c["last_summary"])
    L += ["", "## 花费", "",
          "- LLM：今日 %d token / ¥%.2f（月 ¥%.2f / 上限 ¥%.0f）" % (
              llm.get("today_tokens", 0), llm.get("today_cost", 0),
              llm.get("month_cost", 0), llm.get("monthly_cost_cap", 0)),
          "- Search/Fetch：今日 %d 次 / ¥%.2f（月 %d 次 / ¥%.2f）" % (
              sr.get("today_calls", 0), sr.get("today_cost", 0),
              sr.get("month_calls", 0), sr.get("month_cost", 0))]
    per = llm.get("per_scene_today") or {}
    if per:
        L.append("- 分场景：" + "；".join(
            "%s %d 次 ¥%.3f/次" % (k, v.get("calls", 0), v.get("cost_per_call", 0))
            for k, v in sorted(per.items(), key=lambda kv: -kv[1].get("cost", 0))[:5]))
    L += ["", "## 状态", "",
          "- 精力 %s（%.2f）｜情绪 %s（%.2f）｜作息 %s~%s" % (
              st.get("energy_label", "—"), st.get("energy", 0),
              st.get("mood_label", "—"), st.get("mood", 0),
              (st.get("sleep") or {}).get("start", "—"),
              (st.get("sleep") or {}).get("end", "—")),
          "- 显存 %s MB / %s MB（7 日峰值 %s）｜GPU 租约 %s" % (
              (d.get("resource") or {}).get("vram_used_mb", "—"),
              (d.get("resource") or {}).get("vram_total_mb", "—"),
              (d.get("resource") or {}).get("vram_peak_7d_mb") or "—",
              (d.get("resource") or {}).get("lease") or "无"),
          "- 今日遗忘请求 %d 次｜日记 %d 篇" % (d["forget_today"], d["diary_today"])]
    rel = d.get("relations") or []
    if rel:
        L.append("- 纪念日：" + "；".join(
            "%s %s" % (r.get("name", "?"), r.get("label", "")) for r in rel))
    mh = d.get("memory_health") or {}
    if mh:
        L.append("- 记忆体检：将过期 %d｜冷门 %d｜矛盾 %d" % (
            mh.get("expiring", 0), mh.get("cold", 0), mh.get("conflict", 0)))
    comp = []
    if d.get("observe"):
        comp.append("- 她眼中的你：%s" % d["observe"])
    gl = d.get("goals") or []
    if gl:
        comp.append("- 小目标：" + "；".join(
            "%s %s" % ("✔" if g.get("done") else "·", g.get("text", "")) for g in gl))
    if d.get("capsules_due"):
        comp.append("- 有 %d 封时光胶囊到期，去控制台拆开看看" % d["capsules_due"])
    sch = d.get("schedule") or []
    if sch:
        comp.append("- 今明日程：" + "；".join(
            "%s（%s）" % (e.get("title", "?"),
                        time.strftime("%m-%d %H:%M", time.localtime(e.get("start", 0))))
            for e in sch[:3]))
    if comp:
        L += ["", "## 陪伴", ""] + comp
    L += ["", "## 明天", "",
          "- 启用中的定时任务 %d/%d：%s" % (
              d["cron"]["enabled"], d["cron"]["total"],
              "、".join(d["cron"]["names"]) or "无"),
          "", "## 异常", ""]
    L += ["- " + a for a in d["anomalies"]] or ["- 一切正常，没什么要操心的"]
    return "\n".join(L) + "\n"


def run(notify: bool = True) -> dict:
    try:
        import memory_bus
        memory_bus.dream()   # 记忆整理顺手产出一篇「她昨晚的梦」
    except Exception:
        pass
    d = collect()
    d["voice"] = _voice_summary(d)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    md = render(d)
    path = REPORT_DIR / ("%s.md" % d["date"])
    path.write_text(md, "utf-8")
    (REPORT_DIR / "latest.json").write_text(
        json.dumps({**d, "path": str(path)}, ensure_ascii=False, indent=2), "utf-8")
    # 只保留最近 30 份
    try:
        files = sorted(REPORT_DIR.glob("*.md"))
        for old in files[:-30]:
            old.unlink(missing_ok=True)
    except OSError:
        pass
    if notify:
        try:
            import alert
            title = "她的一天 · %s" % d["date"]
            if d["anomalies"]:
                text = "⚠ " + "；".join(d["anomalies"]) + "\n" + _voice_summary(d)
            else:
                text = _voice_summary(d) + " 一切正常。"
            alert.send(title, text, key="daily_report")
        except Exception:
            pass
    return {**d, "path": str(path)}


def latest() -> dict:
    p = REPORT_DIR / "latest.json"
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return {}


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "show":
        p = REPORT_DIR / ("%s.md" % time.strftime("%Y-%m-%d"))
        print(p.read_text("utf-8") if p.is_file() else "今天还没生成日报")
        return 0
    res = run(notify="--no-alert" not in argv)
    print("日报已生成：%s" % res["path"])
    if res["anomalies"]:
        print("异常：" + "；".join(res["anomalies"]))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
