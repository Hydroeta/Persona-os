# -*- coding: utf-8 -*-
r"""persona-os · Game Bot 微服务（任务 6 / dsh-game-agent 底层）

职责：把 TS 端（dsh-game-agent）发来的宏观动作 JSON，翻译成 vgamepad 虚拟 Xbox 360
手柄的摇杆 / 按键信号，注入到 ViGEmBus 驱动，从而操控 PC 游戏。

混合架构：
    TS 插件（大脑）  : 看画面 → VLM 决策 → 发 HTTP 动作 JSON 到这里
    Python 微服务（手）: 接收动作 → 调 vgamepad → 虚拟手柄信号 → 游戏

接口（端口默认 8003，可用 GAME_BOT_PORT 覆盖）：
    GET  /health     健康 + 驱动就绪状态
    POST /reset      立即松开所有按键 / 摇杆回中
    POST /action     执行一个动作
                         {"type":"move","direction":"forward","duration":1.0}
                         {"type":"press","button":"A","duration":0.2}
                         {"type":"release","button":"B"}
                         {"type":"reset"}

安全闸门（核心）：
    看门狗线程每 0.25s 检查一次；若距上一次有效动作超过 GAME_BOT_WATCHDOG_S（默认 2.0s），
    自动执行一次全复位（松键 + 摇杆回中），防止 TS 崩溃 / 网络中断后角色一直按着方向
    走到悬崖里。看门狗可通过 GAME_BOT_WATCHDOG_S=0 关闭（不推荐）。

运行（复用源项目 ohwhale-deploy 虚拟环境，已含 fastapi/uvicorn；vgamepad 需预装）：
    & "c:\Users\user\Desktop\projects (2)\ohwhale-deploy\.venv\Scripts\python.exe" ^
      "c:\Users\user\Desktop\projects (2)\github-release\persona-os\core-services\game-bot\main.py"

前置（系统级，非 pip）：ViGEmBus 驱动已安装并重启（用户已完成）。
降级：vgamepad 库 / 驱动缺失时，服务仍启动，/health 返回 driver_ready=false，
      /action 返回 503，绝不崩溃；TS 端据此安全降级。
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

LOG_TAG = "[game-bot]"

DEFAULT_PORT = int(os.environ.get("GAME_BOT_PORT", "8003"))
WATCHDOG_S = float(os.environ.get("GAME_BOT_WATCHDOG_S", "2.0"))
WATCHDOG_TICK_S = 0.25

STICK_MAX = 32767
STICK_MIN = -32768
TRIGGER_MAX = 255

# 用户面向的按钮名 → vgamepad 常量名（getattr 防御式取，缺失则该键不可用但不崩）
# 注意：vgamepad 0.2.0 把按钮常量收敛为 IntEnum vg.XUSB_BUTTON，成员名是
# XUSB_GAMEPAD_A（无 _BUTTON 中缀）；0.1.x 则是顶层 vg.XUSB_BUTTON_GAMEPAD_A。
# 这里存"无中缀"的成员名，_resolve_button 会依次尝试新枚举 API 与旧顶层 API。
BUTTON_ALIASES = {
    "a": "XUSB_GAMEPAD_A",
    "b": "XUSB_GAMEPAD_B",
    "x": "XUSB_GAMEPAD_X",
    "y": "XUSB_GAMEPAD_Y",
    "lb": "XUSB_GAMEPAD_LEFT_SHOULDER",
    "rb": "XUSB_GAMEPAD_RIGHT_SHOULDER",
    "start": "XUSB_GAMEPAD_START",
    "back": "XUSB_GAMEPAD_BACK",
    "l3": "XUSB_GAMEPAD_LEFT_THUMB",
    "r3": "XUSB_GAMEPAD_RIGHT_THUMB",
    "dpad_up": "XUSB_GAMEPAD_DPAD_UP",
    "dpad_down": "XUSB_GAMEPAD_DPAD_DOWN",
    "dpad_left": "XUSB_GAMEPAD_DPAD_LEFT",
    "dpad_right": "XUSB_GAMEPAD_DPAD_RIGHT",
    "guide": "XUSB_GAMEPAD_GUIDE",
}

# move direction → (左摇杆 X, 左摇杆 Y)
DIRECTION_VECTORS = {
    "forward": (0, STICK_MAX),
    "backward": (0, STICK_MIN),
    "backwards": (0, STICK_MIN),
    "left": (STICK_MIN, 0),
    "right": (STICK_MAX, 0),
}

# ---------------------------------------------------------------------------
# vgamepad 懒加载（缺失不崩，记录原因）
# ---------------------------------------------------------------------------

_vg = None
_vg_import_error: Optional[str] = None
try:
    import vgamepad as vg  # type: ignore
    _vg = vg
except Exception as e:  # pragma: no cover - 环境相关
    _vg = None
    _vg_import_error = f"{type(e).__name__}: {e}"


def _resolve_button(name: str):
    """把用户按钮名解析成 vgamepad 常量值；找不到返回 None。

    兼容两套 API：
      - 新（vgamepad>=0.2.0）：常量在 IntEnum vg.XUSB_BUTTON 里，成员名 XUSB_GAMEPAD_A
      - 旧（vgamepad 0.1.x）  ：常量在顶层 vg.XUSB_BUTTON_GAMEPAD_A（带 _BUTTON 中缀）
    两套都试一遍，哪个命中用哪个，都不命中则该键不可用但不崩。
    """
    if _vg is None:
        return None
    const_name = BUTTON_ALIASES.get(str(name).strip().lower())
    if not const_name:
        return None
    # 1) 新枚举 API：vg.XUSB_BUTTON.XUSB_GAMEPAD_A
    xusb_enum = getattr(_vg, "XUSB_BUTTON", None)
    if xusb_enum is not None:
        val = getattr(xusb_enum, const_name, None)
        if val is not None:
            return val
    # 2) 旧顶层 API：vg.XUSB_BUTTON_GAMEPAD_A（把无中缀名补回 _BUTTON 中缀）
    old_name = const_name.replace("XUSB_GAMEPAD_", "XUSB_BUTTON_GAMEPAD_", 1)
    return getattr(_vg, old_name, None)


# ---------------------------------------------------------------------------
# 手柄控制器（可注入 fake gamepad 以便无驱动环境测试）
# ---------------------------------------------------------------------------


class GamepadController:
    """线程安全地包装一个 vgamepad.VX360Gamepad，记录当前按下状态供看门狗复位。"""

    def __init__(self, gamepad=None):
        self._lock = threading.Lock()
        self._gp = gamepad
        self._last_action_ts = 0.0
        self._held_buttons: set = set()
        self._sticks = {"lx": 0, "ly": 0, "rx": 0, "ry": 0}
        self._triggers = {"lt": 0, "rt": 0}
        if self._gp is None and _vg is not None:
            try:
                self._gp = _vg.VX360Gamepad()
            except Exception as e:  # pragma: no cover - 驱动相关
                self._gp = None
                print(f"{LOG_TAG} 创建虚拟手柄失败：{type(e).__name__}: {e}", file=sys.stderr)

    @property
    def ready(self) -> bool:
        return self._gp is not None

    @property
    def import_error(self) -> Optional[str]:
        return _vg_import_error

    def age_s(self) -> float:
        """距上一次有效动作的秒数；从未动作返回一个很大的值。"""
        if self._last_action_ts <= 0:
            return 1e9
        return time.monotonic() - self._last_action_ts

    # ---- 底层硬件写（必须持锁）----
    def _hw_press(self, btn_val) -> None:
        self._gp.press_button(button=btn_val)
        self._held_buttons.add(btn_val)

    def _hw_release(self, btn_val) -> None:
        self._gp.release_button(button=btn_val)
        self._held_buttons.discard(btn_val)

    def _hw_stick(self, lx: int, ly: int) -> None:
        self._gp.left_joystick(x_value=int(lx), y_value=int(ly))
        self._sticks["lx"], self._sticks["ly"] = int(lx), int(ly)

    def _hw_update(self) -> None:
        self._gp.update()

    def _feed(self) -> None:
        self._last_action_ts = time.monotonic()

    # ---- 公开动作 ----
    def reset(self) -> bool:
        """松开所有按键 + 摇杆回中 + 扳机归零。成功返回 True。"""
        with self._lock:
            if self._gp is None:
                return False
            try:
                for b in list(self._held_buttons):
                    self._gp.release_button(button=b)
                self._held_buttons.clear()
                self._gp.left_joystick(x_value=0, y_value=0)
                self._gp.right_joystick(x_value=0, y_value=0)
                self._gp.left_trigger(value=0)
                self._gp.right_trigger(value=0)
                self._sticks = {"lx": 0, "ly": 0, "rx": 0, "ry": 0}
                self._triggers = {"lt": 0, "rt": 0}
                self._gp.update()
                return True
            except Exception as e:
                print(f"{LOG_TAG} reset 异常：{type(e).__name__}: {e}", file=sys.stderr)
                return False

    def do_move(self, direction: str, duration: float) -> dict:
        """摇杆推向 direction，保持 duration 秒后回中。"""
        vec = DIRECTION_VECTORS.get(str(direction).strip().lower())
        if vec is None:
            return {"ok": False, "error": f"未知方向: {direction}"}
        lx, ly = vec
        with self._lock:
            if self._gp is None:
                return {"ok": False, "error": "vgamepad 未就绪"}
            try:
                self._hw_stick(lx, ly)
                self._hw_update()
                self._feed()
            except Exception as e:
                return {"ok": False, "error": f"摇杆写入失败: {type(e).__name__}: {e}"}
        # 保持（不持锁，允许看门狗并发复位）
        time.sleep(max(0.0, min(duration, 10.0)))
        with self._lock:
            if self._gp is None:
                return {"ok": False, "error": "vgamepad 未就绪"}
            try:
                self._hw_stick(0, 0)
                self._hw_update()
                return {"ok": True, "executed": "move", "direction": direction, "duration": duration}
            except Exception as e:
                return {"ok": False, "error": f"摇杆回中失败: {type(e).__name__}: {e}"}

    def do_press(self, button: str, duration: float) -> dict:
        """按下 button，保持 duration 秒后松开。"""
        btn_val = _resolve_button(button)
        if btn_val is None:
            return {"ok": False, "error": f"未知或不可用按钮: {button}"}
        with self._lock:
            if self._gp is None:
                return {"ok": False, "error": "vgamepad 未就绪"}
            try:
                self._hw_press(btn_val)
                self._hw_update()
                self._feed()
            except Exception as e:
                return {"ok": False, "error": f"按键失败: {type(e).__name__}: {e}"}
        time.sleep(max(0.0, min(duration, 10.0)))
        with self._lock:
            if self._gp is None:
                return {"ok": False, "error": "vgamepad 未就绪"}
            try:
                self._hw_release(btn_val)
                self._hw_update()
                return {"ok": True, "executed": "press", "button": button, "duration": duration}
            except Exception as e:
                return {"ok": False, "error": f"松键失败: {type(e).__name__}: {e}"}

    def do_release(self, button: str) -> dict:
        btn_val = _resolve_button(button)
        if btn_val is None:
            return {"ok": False, "error": f"未知按钮: {button}"}
        with self._lock:
            if self._gp is None:
                return {"ok": False, "error": "vgamepad 未就绪"}
            try:
                self._hw_release(btn_val)
                self._hw_update()
                self._feed()
                return {"ok": True, "executed": "release", "button": button}
            except Exception as e:
                return {"ok": False, "error": f"松键失败: {type(e).__name__}: {e}"}

    def snapshot(self) -> dict:
        """当前手柄状态快照（供 /health / 测试断言）。"""
        with self._lock:
            return {
                "held_buttons": sorted(str(b) for b in self._held_buttons),
                "sticks": dict(self._sticks),
                "triggers": dict(self._triggers),
                "last_action_age_s": round(self.age_s(), 3),
            }


# ---------------------------------------------------------------------------
# 看门狗：超时自动全复位
# ---------------------------------------------------------------------------

controller = GamepadController()
_watchdog_stop = threading.Event()


def watchdog_loop() -> None:
    while not _watchdog_stop.is_set():
        try:
            if WATCHDOG_S > 0 and controller.ready and controller.age_s() > WATCHDOG_S:
                # 只有在确实有按下状态时才复位（避免空转刷屏）
                snap = controller.snapshot()
                if snap["held_buttons"] or any(snap["sticks"].values()) or any(snap["triggers"].values()):
                    controller.reset()
                    print(f"{LOG_TAG} 看门狗：{WATCHDOG_S}s 无新指令，已自动复位手柄", file=sys.stderr)
        except Exception as e:  # pragma: no cover
            print(f"{LOG_TAG} 看门狗异常：{type(e).__name__}: {e}", file=sys.stderr)
        _watchdog_stop.wait(WATCHDOG_TICK_S)


_watchdog_thread = threading.Thread(target=watchdog_loop, name="game-bot-watchdog", daemon=True)
_watchdog_thread.start()

# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------

app = FastAPI(title="persona-os game-bot", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ActionIn(BaseModel):
    type: str = Field(..., description="move | press | release | reset")
    direction: Optional[str] = Field(None, description="move: forward/backward/left/right")
    button: Optional[str] = Field(None, description="press/release: A/B/X/Y/LB/RB/start/back/dpad_*")
    duration: float = Field(0.2, ge=0, le=10, description="保持秒数")


@app.get("/health")
def api_health():
    return {
        "ok": True,
        "driver_ready": controller.ready,
        "vgamepad_loaded": _vg is not None,
        "vgamepad_error": _vg_import_error,
        "watchdog_s": WATCHDOG_S,
        "state": controller.snapshot(),
    }


@app.post("/reset")
def api_reset():
    ok = controller.reset()
    return {"ok": ok, "state": controller.snapshot()}


@app.post("/action")
def api_action(body: ActionIn):
    if not controller.ready:
        raise HTTPException(
            status_code=503,
            detail={
                "ok": False,
                "error": "vgamepad 未就绪：请确认 vgamepad 库已安装且 ViGEmBus 驱动已安装并重启",
                "vgamepad_error": _vg_import_error,
            },
        )
    t0 = time.monotonic()
    t = (body.type or "").strip().lower()
    if t == "move":
        res = controller.do_move(body.direction or "", body.duration if body.duration != 0.2 else 1.0)
    elif t == "press":
        res = controller.do_press(body.button or "", body.duration)
    elif t == "release":
        res = controller.do_release(body.button or "")
    elif t == "reset":
        ok = controller.reset()
        res = {"ok": ok, "executed": "reset"}
    else:
        raise HTTPException(status_code=400, detail={"ok": False, "error": f"未知动作类型: {body.type}"})
    res.setdefault("elapsed_s", round(time.monotonic() - t0, 3))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res)
    return res


# ---------------------------------------------------------------------------
# 端口防冲突 + 启动
# ---------------------------------------------------------------------------

def port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main() -> int:
    if port_in_use(DEFAULT_PORT):
        print(f"{LOG_TAG} 端口 {DEFAULT_PORT} 已被占用，game-bot 未启动（可能已有实例在跑）", file=sys.stderr)
        return 1
    print(f"{LOG_TAG} 驱动就绪={controller.ready}（vgamepad_loaded={_vg is not None}）"
          + (f"，加载错误: {_vg_import_error}" if _vg_import_error else ""))
    print(f"{LOG_TAG} 看门狗超时={WATCHDOG_S}s（0=关闭）")
    import uvicorn
    print(f"{LOG_TAG} starting on http://127.0.0.1:{DEFAULT_PORT}")
    uvicorn.run(app, host="127.0.0.1", port=DEFAULT_PORT, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
