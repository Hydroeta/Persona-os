# -*- coding: utf-8 -*-
"""直播事件总线 + WebSocket 广播服务（console 进程内）。

订阅者（OBS HUD 网页 / 前端面板）连上 WS 后，收到所有 emit 的事件 JSON。
事件来源：
  1) tail 线程按字节偏移轮询 data/live_events.jsonl（live_bot 上报，Task 1）
  2) 内部 emit() —— state_engine 破防 / console 手动注入等

所有异常吞掉只打印，绝不影响 console 主进程（TR-2.4 容错）。
websockets 库缺失时，tail 与 emit 仍工作，仅 WS 广播不可用。
"""
from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[1]   # persona-os 根

try:
    import live_events
except Exception:
    live_events = None

try:
    import websockets
except Exception:  # 缺库不崩，WS 广播降级
    websockets = None

DEFAULT_WS_PORT = 8901
TAIL_INTERVAL = 0.5          # tail 轮询间隔（秒）
RECENT_LIMIT = 200           # 新订阅者补发的最近事件数
QUEUE_MAX = 500              # 单订阅者队列上限，满了丢最旧未读外的新事件

_lock = threading.Lock()
_subscribers: set = set()     # 元素为 asyncio.Queue
_recent: list[dict] = []
_callbacks: list = []         # 进程内回调（高光打标/人格切换等内部消费者）
_loop: asyncio.AbstractEventLoop | None = None
_ws_port: int | None = None
_ws_available = False
_started = False
_TOKEN = ""


def _port_free(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _safe_put(q: asyncio.Queue, ev: dict) -> None:
    """在事件循环线程内执行：满队列丢弃本条（慢消费者不拖垮广播）。"""
    try:
        q.put_nowait(ev)
    except Exception:
        pass


def emit(event: dict) -> bool:
    """向所有 WS 订阅者 + 进程内回调广播一条事件，并写入最近事件缓冲。线程安全。"""
    if not isinstance(event, dict):
        return False
    with _lock:
        _recent.append(event)
        if len(_recent) > RECENT_LIMIT:
            del _recent[:-RECENT_LIMIT]
        subs = list(_subscribers)
        cbs = list(_callbacks)
        loop = _loop
    if loop:
        for q in subs:
            try:
                loop.call_soon_threadsafe(_safe_put, q, event)
            except Exception:
                pass
    # 进程内回调在调用方线程同步执行；每个回调独立 try/except，互不影响
    for cb in cbs:
        try:
            cb(event)
        except Exception:
            pass
    return True


def subscribe(callback) -> None:
    """注册进程内回调：每条 emit 的事件都会调用 callback(event)。

    用于高光打标（Task 5）、人格切换触发（Task 7）等 console 进程内消费者，
    避免重复 tail 文件。回调须快速返回且自身容错（外层已兜底不抛）。
    """
    with _lock:
        if callback not in _callbacks:
            _callbacks.append(callback)


def unsubscribe(callback) -> None:
    with _lock:
        try:
            _callbacks.remove(callback)
        except ValueError:
            pass


def _tail_worker() -> None:
    """按字节偏移 tail data/live_events.jsonl，新行 → emit。启动时跳过历史。"""
    if live_events is None:
        return
    path = live_events.EVENTS_FILE
    offset = 0
    try:
        if path.exists():
            offset = path.stat().st_size   # 跳过已有历史，只追新
    except Exception:
        pass
    while True:
        try:
            if path.exists():
                size = path.stat().st_size
                if size < offset:           # 文件被截断/轮转，从头读
                    offset = 0
                if size > offset:
                    with open(path, "r", encoding="utf-8") as f:
                        f.seek(offset)
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                ev = json.loads(line)
                            except Exception:
                                continue
                            emit(ev)
                        offset = f.tell()
        except Exception as e:
            try:
                print(f"[event_bus] tail error: {e!r}")
            except Exception:
                pass
        time.sleep(TAIL_INTERVAL)


async def _ws_handler(ws) -> None:
    global _TOKEN
    try:
        qs = parse_qs(urlparse(ws.request.path).query)
        tok = qs.get("token", [""])[0]
        if not tok or tok != _TOKEN:
            await ws.close(code=1008, reason="bad token")
            return
    except Exception:
        try:
            await ws.close(code=1011, reason="auth error")
        except Exception:
            pass
        return
    q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
    with _lock:
        _subscribers.add(q)
        snapshot = list(_recent)

    async def _pump():
        for ev in snapshot:                 # 补发最近事件，避免新订阅者空白
            await ws.send(json.dumps(ev, ensure_ascii=False))
        while True:
            ev = await q.get()              # 消费订阅队列 → 推送
            await ws.send(json.dumps(ev, ensure_ascii=False))

    async def _drain():
        async for _ in ws:                  # 忽略客户端消息，保活并检测断开
            pass

    try:
        await asyncio.gather(_pump(), _drain())
    except Exception:
        pass
    finally:
        with _lock:
            _subscribers.discard(q)


async def _serve(port: int) -> None:
    async with websockets.serve(_ws_handler, "127.0.0.1", port):
        await asyncio.Future()              # 永久运行


def _run_loop(port: int) -> None:
    global _loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _loop = loop
    try:
        loop.run_until_complete(_serve(port))
    except Exception as e:
        try:
            print(f"[event_bus] ws serve stopped: {e!r}")
        except Exception:
            pass
    finally:
        try:
            loop.close()
        except Exception:
            pass


def start(token: str, ws_port: int = DEFAULT_WS_PORT) -> dict:
    """启动 tail 线程与 WS 服务线程。幂等；任何失败都不抛异常。"""
    global _started, _ws_port, _ws_available, _TOKEN
    if _started:
        return status()
    _TOKEN = token or ""
    port = ws_port
    for _ in range(10):
        if _port_free(port):
            break
        port += 1
    _ws_port = port
    try:
        threading.Thread(target=_tail_worker, daemon=True).start()
    except Exception as e:
        print(f"[event_bus] tail thread start failed: {e!r}")
    if websockets is None:
        print("[event_bus] websockets 库未安装，WS 广播不可用（emit/tail 仍工作）")
        _ws_available = False
    else:
        try:
            threading.Thread(target=_run_loop, args=(port,), daemon=True).start()
            _ws_available = True
            print(f"[event_bus] WebSocket 已启动 ws://127.0.0.1:{port}/?token=...")
        except Exception as e:
            print(f"[event_bus] ws thread start failed: {e!r}")
            _ws_available = False
    _started = True
    return status()


def status() -> dict:
    with _lock:
        n = len(_subscribers)
    return {
        "ws_available": _ws_available,
        "ws_port": _ws_port,
        "ws_url": ("ws://127.0.0.1:%d/" % _ws_port) if _ws_available else "",
        "subscribers": n,
        "recent": len(_recent),
    }
