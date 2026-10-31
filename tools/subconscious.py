# -*- coding: utf-8 -*-
"""小鲸鱼 · 潜意识规则引擎：把事件流蒸成「想法」（零 LLM）。

不开常驻进程、不维护内存队列——timeline.jsonl 本身就是事件总线。
本模块是批处理吸水器：每次运行把「上次游标之后」的新事件过一遍
纯代码规则，命中的写成一条想法。

产物：
  data/thoughts.jsonl        想法流（梦境蒸馏的第 5 路素材）
  meow soul 层               仅 importance>=2 的想法上浮，供对话引用

调度：任务计划程序每 15 分钟跑 `python tools/subconscious.py tick`。

CLI：
    python tools/subconscious.py tick    # 处理新事件（幂等）
    python tools/subconscious.py list    # 今天的想法
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

THOUGHTS_FILE = ROOT / "data" / "thoughts.jsonl"
CURSOR_FILE = ROOT / "data" / "thoughts.cursor.json"
DEDUP_HOURS = 2          # 同规则同活动 2 小时内不重复产生想法
SURFACE_MIN = 2          # importance>=2 才写 meow soul 层


def _load_cursor() -> dict:
    try:
        return json.loads(CURSOR_FILE.read_text("utf-8"))
    except Exception:
        return {"ts": time.time() - 86400, "surfaced": []}   # 首跑只看最近一天


def _save_cursor(c: dict) -> None:
    try:
        CURSOR_FILE.parent.mkdir(parents=True, exist_ok=True)
        CURSOR_FILE.write_text(json.dumps(c, ensure_ascii=False), "utf-8")
    except OSError:
        pass


def _recent_thoughts(hours: float = DEDUP_HOURS) -> list[dict]:
    if not THOUGHTS_FILE.is_file():
        return []
    cut = time.time() - hours * 3600
    out = []
    try:
        for ln in THOUGHTS_FILE.read_text("utf-8").splitlines():
            try:
                t = json.loads(ln)
                if t.get("ts", 0) >= cut:
                    out.append(t)
            except Exception:
                continue
    except OSError:
        pass
    return out


# ---------- 规则（纯代码，一条命中产一条想法） ----------

def _rules(events: list[dict], recent: list[dict]) -> list[dict]:
    """events: 游标之后的新事件（按 ts 升序）。返回想法列表。"""
    import state_engine
    thoughts = []
    acts = [(e["ts"], e["payload"].get("activity", ""), e["payload"].get("proc", ""))
            for e in events if e.get("type") == "activity"]
    seen_keys = {(t.get("rule"), t.get("key")) for t in recent}

    def add(rule: str, key: str, text: str, importance: int, ts: float) -> None:
        if (rule, key) not in seen_keys:
            thoughts.append({"ts": ts, "rule": rule, "key": key,
                             "text": text, "importance": importance})
            seen_keys.add((rule, key))

    energy = state_engine.status().get("energy", 0.5)
    for i, (ts, act, proc) in enumerate(acts):
        hour = time.localtime(ts).tm_hour
        dur_min = ((acts[i + 1][0] - ts) / 60.0) if i + 1 < len(acts) else 0
        if act == "gaming" and energy > 0.5:
            add("gaming_relaxed", "gaming", "主人在玩游戏，看起来挺放松的。", 1, ts)
        if act == "coding_error":
            add("coding_error", "coding_error", "主人写代码又报错了，有点担心他卡住。", 1, ts)
        if 1 <= hour < 5:
            add("late_night", time.strftime("%Y-%m-%d", time.localtime(ts)),
                "都这个点了，他还没睡。", 2, ts)
        if act in ("coding", "writing") and dur_min >= 120:
            add("long_focus", time.strftime("%Y-%m-%d", time.localtime(ts)) + act,
                "他连续专注两个小时多了，想提醒他喝口水。", 2, ts)
    # 报错连发：1 小时内 >=3 次 coding_error 升级为担心
    err_ts = [ts for ts, act, _ in acts if act == "coding_error"]
    for i, ts in enumerate(err_ts):
        if len([t for t in err_ts if ts <= t < ts + 3600]) >= 3:
            add("error_burst", time.strftime("%Y-%m-%d-%H", time.localtime(ts)),
                "他今天下午报错好多次了，也不知道头疼不疼。", 2, ts)
            break
    # 通话：每天最多记一条；云端模型切换：她察觉到"换了备用脑子"
    for e in events:
        if e.get("type") == "call_end":
            day = time.strftime("%Y-%m-%d", time.localtime(e["ts"]))
            add("call_happened", day, "今天和主人通了话，开心。", 1, e["ts"])
        elif e.get("type") == "llm_fallback":
            day = time.strftime("%Y-%m-%d", time.localtime(e["ts"]))
            add("llm_fallback", day,
                "云端脑子今天不太顺，主人给我切了备用脑子，转得有点慢。",
                1, e["ts"])
    return thoughts


def tick() -> dict:
    """把游标之后的新事件过一遍规则。幂等，可反复跑。"""
    import timeline
    cur = _load_cursor()
    since = float(cur.get("ts", 0))
    days = {time.strftime("%Y-%m-%d", time.localtime(since)),
            time.strftime("%Y-%m-%d")}                     # 跨午夜只读两天
    events = [e for d in days for e in timeline.day(d) if e.get("ts", 0) > since]
    events.sort(key=lambda e: e.get("ts", 0))
    if not events:
        return {"new_events": 0, "thoughts": 0}
    recent = _recent_thoughts()
    thoughts = _rules(events, recent)
    max_ts = max(e.get("ts", 0) for e in events)
    if thoughts:
        try:
            THOUGHTS_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(THOUGHTS_FILE, "a", encoding="utf-8") as f:
                for t in thoughts:
                    t["date"] = time.strftime("%Y-%m-%d", time.localtime(t["ts"]))
                    f.write(json.dumps(t, ensure_ascii=False) + "\n")
        except OSError:
            pass
    # 高重要度想法上浮到 soul 层（按 date+rule 去重，只浮一次）
    import memory_bus
    surfaced = set(cur.get("surfaced", []))
    for t in thoughts:
        mark = "%s:%s" % (t["date"], t["rule"])
        if t["importance"] >= SURFACE_MIN and mark not in surfaced:
            try:
                memory_bus.write("soul", "想法·%s" % mark, t["text"],
                                 keywords="潜意识", source="subconscious")
                surfaced.add(mark)
            except Exception:
                pass
    _save_cursor({"ts": max_ts, "surfaced": sorted(surfaced)})
    return {"new_events": len(events), "thoughts": len(thoughts),
            "surfaced": len(surfaced)}


def list_thoughts(day: str | None = None) -> list[dict]:
    day = day or time.strftime("%Y-%m-%d")
    if not THOUGHTS_FILE.is_file():
        return []
    out = []
    for ln in THOUGHTS_FILE.read_text("utf-8").splitlines():
        try:
            t = json.loads(ln)
            if t.get("date") == day:
                out.append(t)
        except Exception:
            continue
    return out


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "tick":
        print(json.dumps(tick(), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "list":
        day = argv[1] if len(argv) > 1 else None
        print(json.dumps(list_thoughts(day), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
