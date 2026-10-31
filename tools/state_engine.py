# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 作息 + 情绪 / 精力引擎

一切「她今天状态如何」的判断都从这里来：陪伴静默、读屏发言频率、日报口吻、
selfwake 是否打扰，都读同一个 state.json，避免各插件各算一套。

模型（刻意简单、可解释，不做玄学）：
  · 精力 energy：睡眠时段内每小时 +0.10（8 小时回满）；清醒每小时 -0.045（约 22 小时耗尽）
  · 情绪 mood：0~1 的愉悦度，向基线 0.55 每天回落 10%；事件可加减
  · 作息 sleep：默认 23:30 ~ 08:00，可在角色 state.json 改

存档路径：多角色模式下读写 config/personas/<激活角色>/state.json，
并同步物化 config/state.json 视图；无 personas/ 时回退旧版单文件。

CLI：
    python tools/state_engine.py status            # 当前状态（含中文标签与建议）
    python tools/state_engine.py tick              # 只结算一次（cron/控制台调用）
    python tools/state_engine.py event call_ok     # 记一个事件（见 EVENTS）
    python tools/state_engine.py set-sleep 23:30 08:00
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STATE_FILE = ROOT / "config" / "state.json"
# 测试/调用方可直接补丁本常量覆盖存档路径；默认时按激活角色解析
STATE_FILE = DEFAULT_STATE_FILE


def _state_file() -> Path:
    """解析当前应读写的 state 文件：显式覆盖 > 激活角色存档 > 旧版单文件。"""
    if STATE_FILE != DEFAULT_STATE_FILE:
        return STATE_FILE
    try:
        import persona_switch
        act = persona_switch.active_id()
        if act:
            return persona_switch.persona_dir(act) / "state.json"
    except Exception:
        pass
    return STATE_FILE

DEFAULT = {
    "updated": 0.0,
    "energy": 0.70,
    "mood": 0.60,
    "sleep": {"start": "23:30", "end": "08:00"},
    "last_event": "",
    "last_event_ts": 0.0,
}

# 事件对情绪的影响（正向加、负向减），都在 forget 时随审计可查
EVENTS = {
    "call_ok": +0.05, "call_fail": -0.05, "praised": +0.10, "scolded": -0.10,
    "error": -0.03, "companion_accepted": +0.03, "companion_ignored": -0.02,
    "screen_praise": +0.04, "screen_complain": -0.06, "task_done": +0.04,
}

SLEEP_RECOVER_PER_H = 0.10
AWAKE_DECAY_PER_H = 0.045
MOOD_BASELINE = 0.55
MOOD_DECAY_PER_DAY = 0.10


def _load() -> dict:
    try:
        d = json.loads(_state_file().read_text("utf-8"))
    except Exception:
        d = {}
    st = dict(DEFAULT)
    st.update({k: v for k, v in d.items() if k in DEFAULT})
    st["sleep"] = {**DEFAULT["sleep"], **(d.get("sleep") or {})}
    return st


def _save(st: dict) -> None:
    st["updated"] = time.time()
    target = _state_file()
    text = json.dumps(st, ensure_ascii=False, indent=2)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, "utf-8")
    except OSError:
        return
    # 写入角色存档时，同步物化 config/state.json 视图（persona_snapshot 等读视图）
    if target != STATE_FILE:
        try:
            STATE_FILE.write_text(text, "utf-8")
        except OSError:
            pass


def _hm(s: str) -> int:
    """'23:30' → 分钟数；解析失败回退 0。"""
    try:
        h, m = str(s).split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return 0


def in_sleep(ts: float | None = None, sleep: dict | None = None) -> bool:
    """是否在睡眠时段（支持跨零点，如 23:30~08:00）。"""
    ts = time.time() if ts is None else ts
    sleep = sleep or _load()["sleep"]
    t = time.localtime(ts)
    now = t.tm_hour * 60 + t.tm_min
    a, b = _hm(sleep.get("start")), _hm(sleep.get("end"))
    if a == b:
        return False
    return (a <= now < b) if a < b else (now >= a or now < b)


_last_pet_bucket = None


def _pet_publish(st: dict) -> None:
    """桌宠联动：精力/情绪桶（0.05）变化才发一条，避免每 tick 刷屏。永不抛错。"""
    global _last_pet_bucket
    try:
        bucket = (int(float(st.get("energy", 0)) * 20), int(float(st.get("mood", 0)) * 20))
        if bucket == _last_pet_bucket:
            return
        _last_pet_bucket = bucket
        import pet_bus
        lb = labels(st)
        pet_bus.publish("state_change", energy=round(bucket[0] / 20.0, 2),
                        mood=round(bucket[1] / 20.0, 2),
                        energy_label=lb["energy"], mood_label=lb["mood"],
                        sleeping=lb["sleeping"])
    except Exception:  # noqa: BLE001
        pass


def tick(ts: float | None = None) -> dict:
    """按经过时间结算精力/情绪，返回最新状态。"""
    ts = time.time() if ts is None else ts
    st = _load()
    last = float(st.get("updated") or 0)
    if last and ts > last:
        hours = min(24.0, (ts - last) / 3600.0)  # 停了很久也只按一天算，不许一觉睡到满血
        if in_sleep(ts, st["sleep"]) and in_sleep(last, st["sleep"]):
            st["energy"] = min(1.0, st["energy"] + SLEEP_RECOVER_PER_H * hours)
        elif in_sleep(ts, st["sleep"]):
            # 刚入睡：按睡眠速率补一半，剩下交给后续 tick
            st["energy"] = min(1.0, st["energy"] + SLEEP_RECOVER_PER_H * hours * 0.5)
        else:
            st["energy"] = max(0.0, st["energy"] - AWAKE_DECAY_PER_H * hours)
        days = hours / 24.0
        mood = st["mood"] + (MOOD_BASELINE - st["mood"]) * min(1.0, MOOD_DECAY_PER_DAY * days)
        st["mood"] = max(0.0, min(1.0, mood))
    _save(st)
    _pet_publish(st)
    return st


def event(kind: str, ts: float | None = None) -> dict:
    """记一个事件并结算。未知事件不报错，只忽略（插件升级期容错）。"""
    st = tick(ts)
    delta = EVENTS.get(kind, 0.0)
    if delta:
        st["mood"] = max(0.0, min(1.0, st["mood"] + delta))
    st["last_event"] = kind
    st["last_event_ts"] = time.time() if ts is None else ts
    _save(st)
    _pet_publish(st)
    return st


def labels(st: dict) -> dict:
    e, m = st["energy"], st["mood"]
    energy = ("很困" if e < 0.25 else "有点累" if e < 0.45
              else "正常" if e < 0.75 else "充沛")
    mood = ("低落" if m < 0.35 else "有点闷" if m < 0.5
            else "平静" if m < 0.7 else "开心")
    return {"energy": energy, "mood": mood,
            "sleeping": in_sleep(sleep=st["sleep"]),
            "should_rest": e < 0.25 or in_sleep(sleep=st["sleep"])}


def status() -> dict:
    st = tick()
    lb = labels(st)
    advice = []
    if lb["should_rest"]:
        advice.append("该休息了，少主动搭话")
    if st["mood"] < 0.4:
        advice.append("情绪偏低，回复尽量短而温和")
    return {"energy": round(st["energy"], 3), "mood": round(st["mood"], 3),
            "energy_label": lb["energy"], "mood_label": lb["mood"],
            "sleeping": lb["sleeping"], "sleep": st["sleep"],
            "last_event": st.get("last_event", ""), "advice": advice}


def allow_voice(per_10min_budget: int = 1) -> bool:
    """给读屏/搭话用：状态差就不允许开口（不写审计，调用方自己记）。"""
    st = tick()
    return not labels(st)["should_rest"] and st["mood"] > 0.25


def _main(argv: list[str]) -> int:
    if not argv or argv[0] == "status":
        print(json.dumps(status(), ensure_ascii=False, indent=2))
    elif argv[0] == "tick":
        print(json.dumps(status(), ensure_ascii=False))
    elif len(argv) >= 2 and argv[0] == "event":
        event(argv[1])
        print(json.dumps(status(), ensure_ascii=False))
    elif len(argv) >= 3 and argv[0] == "set-sleep":
        st = _load()
        st["sleep"] = {"start": argv[1], "end": argv[2]}
        _save(st)
        print(json.dumps(status(), ensure_ascii=False))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
