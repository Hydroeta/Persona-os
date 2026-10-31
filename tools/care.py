# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 关怀与观察（P2）

三件事：
  1. 久坐/作息关怀：用角色口吻提醒起身、喝水、睡觉，而不是系统弹窗。
     读活动心跳（console/读屏写入 logs/activity.jsonl），频率有上限，可一键关。
  2. 她观察你的一天（反向日报）：聚合现有事件流写一段「主人今天好像很累」，
     只读不评判，并入 daily_report。
  3. 低落情绪检测：关键词级（零 LLM），供通话链路切安抚分支。

CLI：
    python tools/care.py status      # 当前活动与今日提醒次数
    python tools/care.py nudge       # 到点就给一句关怀（没到点输出空）
    python tools/care.py observe     # 她观察你的一天
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
CONFIG_FILE = ROOT / "config" / "care.json"
ACTIVITY_FILE = ROOT / "logs" / "activity.jsonl"
NUDGE_FILE = ROOT / "data" / "care_nudges.json"

DEFAULT_CONFIG = {"enabled": True, "sedentary_minutes": 60,
                  "max_nudges_per_day": 5, "sleep_remind": True}

# 角色口吻模板（不联网、零成本）
SEDENTARY_LINES = [
    "主人——坐了快一个小时啦，起来倒杯水走两步嘛",
    "你的腰在抗议了哦，起来伸个懒腰，我数三二一",
    "休息一下吧，屏幕又不会跑掉",
]
SLEEP_LINES = [
    "都这个点了……去睡觉啦，明天我再来烦你",
    "熬夜对身体不好哦，我数着你关灯",
]

LOW_MOOD_WORDS = ("难过", "伤心", "崩溃", "焦虑", "失眠", "想哭", "哭了",
                  "郁闷", "烦死", "好累", "不想动", "压力", "孤独", "没意思")


def load_config() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
    except Exception:
        cfg = {}
    merged = dict(DEFAULT_CONFIG)
    merged.update({k: v for k, v in cfg.items() if k in DEFAULT_CONFIG})
    return merged


def save_config(cfg: dict) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")


def _today0() -> float:
    return time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d"))


# ---------- 活动心跳与久坐 ----------

def note_activity(kind: str = "active") -> None:
    """控制台/读屏看到用户活动时写一条心跳。只留今天的。"""
    try:
        ACTIVITY_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(ACTIVITY_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": round(time.time(), 3), "kind": kind},
                               ensure_ascii=False) + "\n")
    except OSError:
        pass


def last_active() -> float:
    """最近一次活动时间；没有记录返回 0。"""
    if not ACTIVITY_FILE.is_file():
        return 0.0
    last = 0.0
    try:
        with open(ACTIVITY_FILE, encoding="utf-8") as f:
            for line in f:
                try:
                    last = max(last, float(json.loads(line).get("ts", 0)))
                except Exception:
                    continue
    except OSError:
        pass
    return last


def _nudges_today() -> list:
    try:
        d = json.loads(NUDGE_FILE.read_text("utf-8"))
    except Exception:
        return []
    cut = _today0()
    return [t for t in d.get("times", []) if t >= cut]


def nudge(now: float | None = None) -> str:
    """到点给一句关怀；没到点/超频率/已关闭返回空串。永不抛错。"""
    cfg = load_config()
    if not cfg["enabled"]:
        return ""
    now = time.time() if now is None else now
    taken = _nudges_today()
    if len(taken) >= cfg["max_nudges_per_day"]:
        return ""
    line = ""
    try:
        import state_engine
        sleeping = state_engine.in_sleep(now)
    except Exception:
        sleeping = False
    if sleeping and cfg["sleep_remind"]:
        line = SLEEP_LINES[len(taken) % len(SLEEP_LINES)]
    else:
        idle_min = (now - last_active()) / 60.0 if last_active() else 0.0
        if idle_min >= cfg["sedentary_minutes"]:
            line = SEDENTARY_LINES[len(taken) % len(SEDENTARY_LINES)]
    if line:
        try:
            d = {"times": _nudges_today() + [now]}
            NUDGE_FILE.parent.mkdir(parents=True, exist_ok=True)
            NUDGE_FILE.write_text(json.dumps(d), "utf-8")
        except OSError:
            pass
    return line


def status() -> dict:
    la = last_active()
    return {"enabled": load_config()["enabled"],
            "last_active": la,
            "idle_minutes": round((time.time() - la) / 60.0, 1) if la else None,
            "nudges_today": len(_nudges_today())}


# ---------- 她观察你的一天（反向日报，只读不评判） ----------

def observe_day() -> str:
    """聚合现有事件流，写一段她的观察。零 LLM，纯模板。"""
    observations = []
    try:
        import timeline
        rows = timeline.recent(300)
        today = _today0()
        today_rows = [r for r in rows if r.get("ts", 0) >= today]
        svc = [r for r in today_rows if r.get("type") == "svc"]
        calls = [r for r in today_rows if r.get("type") == "call_start"]
        if calls:
            observations.append("今天接了他的电话")
        if len(svc) >= 6:
            observations.append("他今天折腾了好几次服务，好像在修什么东西")
    except Exception:
        pass
    la = last_active()
    if la:
        hour = time.localtime(la).tm_hour
        if hour >= 23 or hour < 6:
            observations.append("他昨晚很晚还在电脑前")
    idle = status()["idle_minutes"]
    if idle is not None and idle >= 180:
        observations.append("他已经好几个小时没碰电脑了，可能在忙别的事")
    try:
        import state_engine
        st = state_engine.status()
        if st.get("sleeping"):
            observations.append("这么晚了，希望他已经在睡了")
    except Exception:
        pass
    if not observations:
        return "今天安安静静的一天，主人大概过得还不错。"
    return "她观察到：" + "；".join(observations) + "。"


# ---------- 低落情绪检测（通话链路用） ----------

def detect_low_mood(text: str) -> int:
    """0=正常 1=有点低落 2=明显低落。纯关键词，宁可漏判不可误判。"""
    t = text or ""
    hits = sum(1 for w in LOW_MOOD_WORDS if w in t)
    return 2 if hits >= 2 else (1 if hits else 0)


def _main(argv: list[str]) -> int:
    if not argv or argv[0] == "status":
        print(json.dumps(status(), ensure_ascii=False, indent=2))
    elif argv[0] == "nudge":
        print(nudge() or "（没到提醒的时候）")
    elif argv[0] == "observe":
        print(observe_day())
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
