# -*- coding: utf-8 -*-
"""persona-os · game-bot 单测（脱离 uvicorn / 真实手柄，注入 fake gamepad）

覆盖：
  1. _resolve_button：vgamepad 0.2.0 新枚举 API（vg.XUSB_BUTTON.XUSB_GAMEPAD_A）全部别名命中；
     未知按钮 → None。
  2. do_move forward：摇杆推到 (0, 32767) 后回中 (0,0)，返回 ok。
  3. do_press A：按下后松开，fake held 最终为空，返回 ok。
  4. do_release / reset：正确清理状态。
  5. 看门狗：把 A 按住不松，超过 WATCHDOG_S（本测试设 0.4s）后被自动复位（held 清空）。
  6. 非法方向 / 非法按钮 → 返回 ok:False，不崩。

运行：
  & "c:\\Users\\user\\Desktop\\projects (2)\\ohwhale-deploy\\.venv\\Scripts\\python.exe" ^
    "c:\\Users\\user\\Desktop\\projects (2)\\github-release\\persona-os\\core-services\\game-bot\\test_gamepad.py"
"""
from __future__ import annotations

import os
import sys
import time

# 必须在 import main 之前设置，让模块级看门狗用短超时（0.4s），测试不用等 2s
os.environ["GAME_BOT_WATCHDOG_S"] = "0.4"

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import main  # noqa: E402  (import 后看门狗 daemon 线程已启动，目标是全局 controller)


# ---------------------------------------------------------------------------
# Fake gamepad：记录调用，不碰真实硬件
# ---------------------------------------------------------------------------
class FakeGamepad:
    def __init__(self) -> None:
        self.held: set = set()
        self.lx = self.ly = self.rx = self.ry = 0
        self.lt = self.rt = 0
        self.updates = 0

    def press_button(self, button) -> None:
        self.held.add(button)

    def release_button(self, button) -> None:
        self.held.discard(button)

    def left_joystick(self, x_value: int, y_value: int) -> None:
        self.lx, self.ly = int(x_value), int(y_value)

    def right_joystick(self, x_value: int, y_value: int) -> None:
        self.rx, self.ry = int(x_value), int(y_value)

    def left_trigger(self, value: int) -> None:
        self.lt = int(value)

    def right_trigger(self, value: int) -> None:
        self.rt = int(value)

    def update(self) -> None:
        self.updates += 1


# ---------------------------------------------------------------------------
# 测试骨架
# ---------------------------------------------------------------------------
PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    ok = bool(cond)
    if ok:
        PASS += 1
    else:
        FAIL += 1
    print(f"{'✅ PASS' if ok else '❌ FAIL'}  {name}{'  —  ' + detail if detail else ''}")


def main_test() -> int:
    global PASS, FAIL

    # 把全局 controller 的真实手柄换成 fake（看门狗线程会操作这个 fake）
    fake = FakeGamepad()
    ctrl = main.controller
    ctrl._gp = fake
    # 清理可能残留的真实状态
    with ctrl._lock:
        ctrl._held_buttons.clear()
        ctrl._sticks = {"lx": 0, "ly": 0, "rx": 0, "ry": 0}
        ctrl._triggers = {"lt": 0, "rt": 0}

    vg = main._vg
    assert vg is not None, "vgamepad 应已加载"

    print("\n--- 1. _resolve_button 映射（vgamepad 0.2.0 枚举 API）---")
    for alias in ["a", "b", "x", "y", "lb", "rb", "start", "back", "l3", "r3",
                  "dpad_up", "dpad_down", "dpad_left", "dpad_right", "guide"]:
        val = main._resolve_button(alias)
        check(f"alias '{alias}' 解析非空", val is not None)
        # 与真实枚举成员一致
        enum_name = main.BUTTON_ALIASES[alias]
        expected = getattr(vg.XUSB_BUTTON, enum_name, None)
        check(f"alias '{alias}' == vg.XUSB_BUTTON.{enum_name}", val == expected)
    check("未知按钮 'foo' → None", main._resolve_button("foo") is None)
    check("大小写/空白容忍", main._resolve_button("  A ") is not None)

    print("\n--- 2. do_move forward ---")
    res = ctrl.do_move("forward", 0.1)
    check("do_move forward 返回 ok", res.get("ok") is True, str(res))
    check("结束后摇杆回中 (ly==0)", fake.ly == 0, f"ly={fake.ly}")
    check("held 为空", len(fake.held) == 0)
    bad = ctrl.do_move("diagonal", 0.1)
    check("未知方向 → ok:False", bad.get("ok") is False, str(bad))

    print("\n--- 3. do_press A ---")
    a_val = main._resolve_button("a")
    res = ctrl.do_press("a", 0.1)
    check("do_press A 返回 ok", res.get("ok") is True, str(res))
    check("结束后 A 已松开（held 为空）", a_val not in fake.held, f"held={fake.held}")
    bad = ctrl.do_press("zzz", 0.1)
    check("未知按钮 → ok:False", bad.get("ok") is False, str(bad))

    print("\n--- 4. do_release / reset ---")
    # 手动按一个键保持，再 release
    with ctrl._lock:
        ctrl._hw_press(a_val)
        ctrl._hw_update()
    check("press 后 held 含 A", a_val in fake.held)
    ctrl.do_release("a")
    check("release 后 held 不含 A", a_val not in fake.held)
    # 再按一个 + 推摇杆，reset 全清
    with ctrl._lock:
        ctrl._hw_press(a_val)
        ctrl._hw_stick(0, 32767)
        ctrl._hw_update()
    check("reset 前：held+stick 非零", a_val in fake.held and fake.ly == 32767)
    ok = ctrl.reset()
    check("reset 返回 True", ok is True)
    check("reset 后 held 为空", len(fake.held) == 0)
    check("reset 后摇杆回中", fake.ly == 0 and fake.lx == 0)
    snap = ctrl.snapshot()
    check("snapshot held_buttons 为空", len(snap["held_buttons"]) == 0)

    print("\n--- 5. 看门狗 2s 自动复位（本测试用 0.4s）---")
    # 按住 A 不松，喂狗（记录最后动作时间），然后等待超过看门狗阈值
    with ctrl._lock:
        ctrl._hw_press(a_val)
        ctrl._hw_update()
        ctrl._feed()
    check("按住后 held 含 A", a_val in fake.held)
    # 睡 0.7s > 0.4s 看门狗阈值，看门狗应自动复位
    time.sleep(0.7)
    check("看门狗超时后 held 自动清空", a_val not in fake.held, f"held={fake.held}（watchdog_s={main.WATCHDOG_S}）")
    check("看门狗超时后摇杆回中", fake.ly == 0)

    print("\n--- 6. controller.ready 注入后为 True ---")
    check("ready == True", ctrl.ready is True)
    check("import_error 为空", ctrl.import_error is None)

    print(f"\n=== 结果：{PASS} 通过 / {FAIL} 失败（共 {PASS + FAIL}）===\n")
    return 1 if FAIL > 0 else 0


if __name__ == "__main__":
    sys.exit(main_test())
