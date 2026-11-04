# -*- coding: utf-8 -*-
"""直播事件上报与读取的单一真源。

live_bot（ohwhale-deploy/scripts/live_bot.py）在事件汇集点调用 report()，
把归一化弹幕 dict 追加写盘；console 的事件总线 / WebSocket 服务（Task 2）
通过 latest()/read_newer_than() 消费。

文件格式：data/live_events.jsonl，每行一个 JSON 事件，含字段：
    type        danmu / superchat / gift / live_start / live_end / ...
    ts          秒级浮点（round(x, 3)，毫秒精度）
    session     直播会话 id（一次开播一个）
    platform    bilibili / douyin
    user_id / nick_name / content
    is_super / is_gift / gift_name / gift_num
    price       金额（元，SC/礼物有值；普通弹幕 0）
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]   # persona-os 根（tools/ 的父目录）
EVENTS_FILE = ROOT / "data" / "live_events.jsonl"
SESSION_FILE = ROOT / "data" / "live_session.json"

_LOCK = threading.Lock()
_SESSION_ID: str | None = None


def _ensure_session() -> str:
    """获取当前直播会话 id；不存在则新建并落盘。"""
    global _SESSION_ID
    if _SESSION_ID:
        return _SESSION_ID
    try:
        if SESSION_FILE.exists():
            d = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
            sid = d.get("session_id")
            if sid:
                _SESSION_ID = sid
                return sid
    except Exception:
        pass
    _SESSION_ID = time.strftime("%Y%m%d-%H%M%S")
    try:
        SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        SESSION_FILE.write_text(
            json.dumps({"session_id": _SESSION_ID, "started": round(time.time(), 3)},
                       ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass
    return _SESSION_ID


def reset_session() -> str:
    """强制开启新会话（如下播后再次开播）。返回新 session id。"""
    global _SESSION_ID
    _SESSION_ID = None
    return _ensure_session()


def _derive(msg: dict) -> tuple[str, float]:
    """从归一化弹幕 dict 推导事件类型与金额。"""
    if msg.get("is_super"):
        etype = "superchat"
    elif msg.get("is_gift"):
        etype = "gift"
    else:
        etype = "danmu"
    price = 0.0
    raw = msg.get("price")
    if isinstance(raw, (int, float)):
        price = float(raw)
    else:
        pg = msg.get("pay_grade")
        if isinstance(pg, dict):
            price = float(pg.get("level", 0) or 0)
        elif isinstance(pg, (int, float)):
            price = float(pg)
    return etype, price


def report(msg: dict, event_type: str | None = None, **extra) -> bool:
    """上报一个直播事件到 data/live_events.jsonl。

    msg 是 live_bot 归一化后的弹幕 dict；event_type 显式指定时覆盖自动推导。
    extra 中的额外字段（如 game/stuck_count）会合并进 payload，供下游消费。
    任何异常都被吞掉（只打印），绝不影响调用方主流程。
    """
    try:
        if event_type:
            etype = event_type
            price = 0.0
        else:
            etype, price = _derive(msg)
        payload = {
            "type": etype,
            "ts": round(time.time(), 3),
            "session": _ensure_session(),
            "platform": str(msg.get("platform", "")),
            "user_id": str(msg.get("user_id", "")),
            "nick_name": str(msg.get("nick_name", "")),
            "content": str(msg.get("content", "")),
            "is_super": bool(msg.get("is_super", False)),
            "is_gift": bool(msg.get("is_gift", False)),
            "gift_name": str(msg.get("gift_name", "")),
            "gift_num": int(msg.get("gift_num", 0) or 0),
            "price": price,
        }
        if extra:
            payload.update(extra)
        line = json.dumps(payload, ensure_ascii=False)
        with _LOCK:
            EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(EVENTS_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        return True
    except Exception as e:  # noqa: BLE001
        try:
            print(f"[live_events] report failed: {e!r}")
        except Exception:
            pass
        return False


def report_lifecycle(event_type: str, **extra) -> bool:
    """上报生命周期事件（live_start / live_end），不依赖弹幕 dict。"""
    try:
        payload = {
            "type": event_type,
            "ts": round(time.time(), 3),
            "session": _ensure_session(),
        }
        payload.update(extra)
        line = json.dumps(payload, ensure_ascii=False)
        with _LOCK:
            EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(EVENTS_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        return True
    except Exception as e:  # noqa: BLE001
        try:
            print(f"[live_events] lifecycle report failed: {e!r}")
        except Exception:
            pass
        return False


def latest(limit: int = 50) -> list[dict]:
    """取最近 limit 条事件（从文件尾部）。"""
    out: list[dict] = []
    try:
        if not EVENTS_FILE.exists():
            return out
        with open(EVENTS_FILE, "r", encoding="utf-8") as f:
            lines = f.readlines()
        for line in lines[-limit:]:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    except Exception:
        pass
    return out


def read_newer_than(since_ts: float, limit: int = 200) -> list[dict]:
    """读取 ts > since_ts 的事件，供 console 轮询/增量 tail。"""
    out: list[dict] = []
    try:
        if not EVENTS_FILE.exists():
            return out
        with open(EVENTS_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if ev.get("ts", 0) > since_ts:
                    out.append(ev)
                    if len(out) >= limit:
                        break
    except Exception:
        pass
    return out
