# -*- coding: utf-8 -*-
"""直播高光打标存储（Task 5）。

订阅 console 事件总线（event_bus 的进程内回调），对高光事件记录高精度时间戳：
  - game_stuck（游戏破防）：默认始终打标
  - superchat：金额 ≥ superchat_price_min
  - gift：金额 ≥ gift_price_min 或 数量 ≥ gift_num_min

标记落盘 data/highlights/<session>.jsonl（每行一条 JSON），供 Task 6 自动切片
与前端查询。session 与 live_events / recorder 同源（live_events._ensure_session）。

设计原则（观测组件不能崩业务）：
  - 所有异常吞掉只打印，绝不影响事件总线 / console 主进程。
  - 文件追加用独立锁，线程安全（回调可能在 tail 线程或 emit 调用方线程执行）。
  - 配置热加载：按文件 mtime 缓存，改 config/highlights.json 即时生效。
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]   # persona-os 根
HL_DIR = ROOT / "data" / "highlights"
CFG_FILE = ROOT / "config" / "highlights.json"

_DEFAULTS = {
    "mark_game_stuck": True,     # game_stuck 破防是否打标
    "superchat_price_min": 1.0,  # SC 金额阈值（元），≥ 则打标
    "gift_price_min": 10.0,      # 礼物金额阈值（元），≥ 则打标
    "gift_num_min": 0,           # 礼物数量阈值，≥ 则打标（0=不按数量）
    "before_sec": 5.0,           # 切片默认前窗口（秒），Task 6 用
    "after_sec": 10.0,           # 切片默认后窗口（秒），Task 6 用
    "cooldown_sec": 2.0,         # 同 session 同类型打标冷却（去重，避免刷屏）
}

_lock = threading.Lock()          # 保护文件追加 + 冷却表 + 配置缓存
_started = False
_last_mark: dict = {}             # {(session, type): last_ts} 冷却去重
_cfg: dict = {}
_cfg_mtime: float = 0.0


def _config() -> dict:
    """读取配置（按 mtime 热加载，缺失回退默认值）。"""
    global _cfg, _cfg_mtime
    try:
        mtime = CFG_FILE.stat().st_mtime if CFG_FILE.is_file() else 0.0
    except Exception:
        mtime = 0.0
    if _cfg and mtime == _cfg_mtime:
        return _cfg
    cfg = dict(_DEFAULTS)
    if mtime:
        try:
            user = json.loads(CFG_FILE.read_text(encoding="utf-8"))
            if isinstance(user, dict):
                cfg.update(user)
        except Exception as e:
            try:
                print(f"[highlights] 配置解析失败，用默认值: {e!r}")
            except Exception:
                pass
    with _lock:
        _cfg = cfg
        _cfg_mtime = mtime
    return cfg


def reload_config() -> dict:
    """强制重读配置（供 console 热刷新路由调用）。"""
    global _cfg_mtime
    _cfg_mtime = 0.0
    return _config()


def _path(session: str) -> Path:
    return HL_DIR / ("%s.jsonl" % session)


def _append(session: str, mark: dict) -> None:
    try:
        HL_DIR.mkdir(parents=True, exist_ok=True)
        with _lock:
            with open(_path(session), "a", encoding="utf-8") as f:
                f.write(json.dumps(mark, ensure_ascii=False) + "\n")
    except Exception as e:
        try:
            print(f"[highlights] 写盘失败: {e!r}")
        except Exception:
            pass


def _classify(ev: dict, cfg: dict) -> tuple[str | None, dict]:
    """判断事件是否为高光，返回 (reason, details)；非高光返回 (None, {})。"""
    etype = ev.get("type")
    if etype == "game_stuck" and cfg.get("mark_game_stuck", True):
        return "游戏破防", {
            "game": ev.get("game", ""),
            "stuck_count": ev.get("stuck_count", 0),
        }
    if etype == "superchat":
        price = float(ev.get("price", 0) or 0)
        if price >= float(cfg.get("superchat_price_min", 1.0)):
            return "SC 打赏 ¥%.2f" % price, {
                "price": price,
                "nick_name": ev.get("nick_name", ""),
                "content": ev.get("content", ""),
            }
    if etype == "gift":
        price = float(ev.get("price", 0) or 0)
        num = int(ev.get("gift_num", 0) or 0)
        hit_price = price >= float(cfg.get("gift_price_min", 10.0))
        num_min = int(cfg.get("gift_num_min", 0))
        hit_num = num_min > 0 and num >= num_min
        if hit_price or hit_num:
            return "礼物 %s×%s ¥%.2f" % (ev.get("gift_name", ""), num, price), {
                "price": price,
                "gift_name": ev.get("gift_name", ""),
                "gift_num": num,
                "nick_name": ev.get("nick_name", ""),
            }
    return None, {}


def _on_event(ev: dict) -> None:
    """事件总线回调：过滤高光事件并打标。"""
    try:
        if not isinstance(ev, dict):
            return
        cfg = _config()
        reason, details = _classify(ev, cfg)
        if not reason:
            return
        session = ev.get("session")
        ts = ev.get("ts")
        if not session or ts is None:
            return
        etype = ev.get("type")
        now = time.time()
        cd = float(cfg.get("cooldown_sec", 2.0))
        key = (str(session), str(etype))
        with _lock:
            last = _last_mark.get(key, 0.0)
            if now - last < cd:
                return
            _last_mark[key] = now
        mark = {
            "ts": float(ts),
            "ts_local": time.strftime("%Y-%m-%d %H:%M:%S",
                                      time.localtime(float(ts))),
            "session": str(session),
            "type": etype,
            "reason": reason,
            "before_sec": float(cfg.get("before_sec", 5.0)),
            "after_sec": float(cfg.get("after_sec", 10.0)),
            "details": details,
        }
        _append(str(session), mark)
    except Exception as e:
        try:
            print(f"[highlights] 回调异常: {e!r}")
        except Exception:
            pass


def start() -> bool:
    """订阅事件总线，开始打标。幂等；任何失败都不抛异常。"""
    global _started
    if _started:
        return True
    try:
        import event_bus
    except Exception:
        print("[highlights] event_bus 不可用，高光打标未启用")
        return False
    try:
        _config()  # 预热配置缓存
        event_bus.subscribe(_on_event)
        _started = True
        print("[highlights] 已订阅事件总线，高光打标已启用")
        return True
    except Exception as e:
        try:
            print(f"[highlights] start failed: {e!r}")
        except Exception:
            pass
        return False


def query(session: str, limit: int = 0) -> list[dict]:
    """查询某 session 的高光标记（按 ts 升序）。limit=0 表示全部。"""
    out: list[dict] = []
    try:
        p = _path(session)
        if not p.is_file():
            return out
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
        out.sort(key=lambda x: x.get("ts", 0))
        if limit and len(out) > limit:
            out = out[-limit:]
    except Exception:
        pass
    return out


def list_sessions() -> list[str]:
    """列出有高光标记的 session（倒序）。"""
    try:
        if not HL_DIR.is_dir():
            return []
        return sorted((p.stem for p in HL_DIR.glob("*.jsonl")), reverse=True)
    except Exception:
        return []


def status() -> dict:
    sessions = list_sessions()
    return {
        "started": _started,
        "sessions": sessions,
        "count_by_session": {s: len(query(s)) for s in sessions[:50]},
    }
