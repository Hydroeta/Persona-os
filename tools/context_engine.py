# -*- coding: utf-8 -*-
"""小鲸鱼 · 环境上下文引擎：时间/节假日的本地快照（零依赖）。

不是微服务——只读快照模块 + 每日两次计划任务刷新：
  时段/星期/节假日：纯本地计算，0 成本
  config/env.json 可补充农历/调休节日：
    {"holidays": {"2026-02-17": "春节"}}

注入主链路不靠 Prompt 组装器：note 命令把「今日环境」写 meow soul
层（每天最多一条），现有记忆注入机制自然会带进对话；梦境蒸馏直接
读 snapshot 作为素材。QQ 聊天链路（Tulpa/DSH）零改动。

CLI：
    python tools/context_engine.py snapshot   # 打印当前环境快照
    python tools/context_engine.py note       # 写今日环境记忆
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

DATA_DIR = ROOT / "data"
STAMP_FILE = DATA_DIR / "env_note.json"
CONFIG_FILE = ROOT / "config" / "env.json"
# 公历固定法定节假日（月-日 → 名）；农历/调休走 config/env.json 覆盖
HOLIDAYS = {"01-01": "元旦", "05-01": "劳动节",
            "10-01": "国庆节", "10-02": "国庆节", "10-03": "国庆节"}
WEEKDAYS = "一二三四五六日"


def _config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text("utf-8"))
    except Exception:
        return {}


def period(hour: int) -> str:
    if 5 <= hour < 8:
        return "清晨"
    if 8 <= hour < 11:
        return "上午"
    if 11 <= hour < 13:
        return "中午"
    if 13 <= hour < 18:
        return "下午"
    if 18 <= hour < 22:
        return "晚上"
    if 22 <= hour < 24:
        return "深夜"
    return "凌晨"


def snapshot(now: float | None = None) -> dict:
    """环境快照：纯本地计算，永不联网。"""
    t = time.localtime(now)
    cfg = _config()
    date = time.strftime("%Y-%m-%d", t)
    md = time.strftime("%m-%d", t)
    holiday = (cfg.get("holidays") or {}).get(date) or HOLIDAYS.get(md, "")
    wd = t.tm_wday
    line = "今天是%s 星期%s（%s%s）。" % (
        date, WEEKDAYS[wd], holiday or ("周末" if wd >= 5 else "工作日"),
        period(t.tm_hour))
    snap = {"date": date, "period": period(t.tm_hour),
            "weekday": "星期" + WEEKDAYS[wd], "weekend": wd >= 5,
            "holiday": holiday, "line": line}
    try:
        import state_engine
        st = state_engine.status()
        snap["energy"] = st.get("energy_label", "")
        snap["mood"] = st.get("mood_label", "")
    except Exception:
        pass
    return snap


def note() -> dict:
    """把「今日环境」写 meow soul 层（每天最多一条）。"""
    snap = snapshot()
    try:
        stamp = json.loads(STAMP_FILE.read_text("utf-8"))
    except Exception:
        stamp = {}
    if stamp.get("date") == snap["date"]:
        return {"skipped": True}
    import memory_bus
    import timeline
    text = snap["line"]
    if snap.get("energy"):
        text += "我今天%s。" % snap["energy"]
    memory_bus.write("soul", "今日环境·%s" % snap["date"], text,
                     keywords="环境", source="context_engine")
    timeline.emit("env_note", "context_engine",
                  date=snap["date"], holiday=snap["holiday"])
    try:
        STAMP_FILE.parent.mkdir(parents=True, exist_ok=True)
        STAMP_FILE.write_text(json.dumps({"date": snap["date"]}), "utf-8")
    except OSError:
        pass
    return {"date": snap["date"], "line": text}


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "note":
        print(json.dumps(note(), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(snapshot(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
