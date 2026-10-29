# -*- coding: utf-8 -*-
"""小鲸鱼 · 环境上下文引擎：时间/节假日/天气的本地快照（零依赖）。

不是微服务——只读快照模块 + 每日两次计划任务刷新：
  时段/星期/节假日：纯本地计算，0 成本
  天气：wttr.in 免 key，3 小时本地缓存，断网静默用旧缓存
  config/env.json 可覆盖城市、补充农历/调休节日：
    {"city": "Shanghai", "holidays": {"2026-02-17": "春节"}}

注入主链路不靠 Prompt 组装器：note 命令把「今日环境」写 meow soul
层（每天最多一条），现有记忆注入机制自然会带进对话；梦境蒸馏直接
读 snapshot 作为素材。QQ 聊天链路（Tulpa/DSH）零改动。

CLI：
    python tools/context_engine.py snapshot   # 打印当前环境快照
    python tools/context_engine.py note       # 刷新天气 + 写今日环境记忆
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

DATA_DIR = ROOT / "data"
CACHE_FILE = DATA_DIR / "env_weather.json"
STAMP_FILE = DATA_DIR / "env_note.json"
CONFIG_FILE = ROOT / "config" / "env.json"
WEATHER_TTL = 3 * 3600
# 公历固定法定节假日（月-日 → 名）；农历/调休走 config/env.json 覆盖
HOLIDAYS = {"01-01": "元旦", "05-01": "劳动节",
            "10-01": "国庆节", "10-02": "国庆节", "10-03": "国庆节"}
WEEKDAYS = "一二三四五六日"
# wttr 翻译缺失时的常见天气词兜底
_ZH = {"sunny": "晴", "clear": "晴", "partly cloudy": "多云",
       "cloudy": "阴", "overcast": "阴", "mist": "薄雾", "fog": "雾",
       "haze": "霾", "smoky haze": "霾", "light rain": "小雨",
       "moderate rain": "中雨", "heavy rain": "大雨", "rain": "雨",
       "thunderstorm": "雷阵雨", "light snow": "小雪", "snow": "雪"}


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


def _fetch_weather(city: str) -> dict:
    """wttr.in 免 key 实时天气；失败返回 {}。"""
    import urllib.request
    try:
        url = "https://wttr.in/%s?format=j1&lang=zh" % city
        req = urllib.request.Request(
            url, headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=10) as r:
            cur = (json.loads(r.read().decode("utf-8", "replace"))
                   .get("current_condition") or [{}])[0]
        desc = (cur.get("lang_zh") or cur.get("weatherDesc") or [{}])[0]
        text = str(desc.get("value", "")).strip()
        return {"temp": int(float(cur.get("temp_C", 0))),
                "text": _ZH.get(text.lower(), text)}
    except Exception:
        return {}


def weather(fetch: bool = False) -> dict:
    """天气快照。fetch=False 只读缓存（绝不联网）；fetch=True 先尝试刷新。"""
    cache = {}
    try:
        cache = json.loads(CACHE_FILE.read_text("utf-8"))
    except Exception:
        pass
    if fetch and time.time() - float(cache.get("ts", 0)) > WEATHER_TTL:
        data = _fetch_weather(_config().get("city", "Shanghai"))
        if data:
            cache = {"ts": time.time(), "data": data}
            try:
                CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
                CACHE_FILE.write_text(
                    json.dumps(cache, ensure_ascii=False), "utf-8")
            except OSError:
                pass
    return dict(cache.get("data") or {})


def snapshot(now: float | None = None) -> dict:
    """环境快照：纯本地计算 + 天气缓存，永不联网。"""
    t = time.localtime(now)
    cfg = _config()
    date = time.strftime("%Y-%m-%d", t)
    md = time.strftime("%m-%d", t)
    holiday = (cfg.get("holidays") or {}).get(date) or HOLIDAYS.get(md, "")
    w = weather(fetch=False)
    wd = t.tm_wday
    line = "今天是%s 星期%s（%s%s）。" % (
        date, WEEKDAYS[wd], holiday or ("周末" if wd >= 5 else "工作日"),
        period(t.tm_hour))
    if w:
        line += "%s天气%s，%s°C。" % (
            _config().get("city", "上海"), w.get("text", ""), w.get("temp", "?"))
    snap = {"date": date, "period": period(t.tm_hour),
            "weekday": "星期" + WEEKDAYS[wd], "weekend": wd >= 5,
            "holiday": holiday, "weather": w, "line": line}
    try:
        import state_engine
        st = state_engine.status()
        snap["energy"] = st.get("energy_label", "")
        snap["mood"] = st.get("mood_label", "")
    except Exception:
        pass
    return snap


def note() -> dict:
    """刷新天气缓存 + 把「今日环境」写 meow soul 层（每天最多一条）。"""
    w = weather(fetch=True)
    snap = snapshot()
    try:
        stamp = json.loads(STAMP_FILE.read_text("utf-8"))
    except Exception:
        stamp = {}
    if stamp.get("date") == snap["date"]:
        return {"skipped": True, "weather": bool(w)}
    import memory_bus
    import timeline
    text = snap["line"]
    if snap.get("energy"):
        text += "我今天%s。" % snap["energy"]
    memory_bus.write("soul", "今日环境·%s" % snap["date"], text,
                     keywords="环境", source="context_engine")
    timeline.emit("env_note", "context_engine",
                  date=snap["date"], holiday=snap["holiday"],
                  weather=(w or {}).get("text", ""))
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
