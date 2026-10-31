# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 桌宠适配器契约 + 工厂

事件源只认 pet_bus；本层负责「桌宠是谁、怎么表现」，切换实现只改 config/pet.json。
所有方法都必须容忍失败：内部异常一律吞掉并返回 False，绝不抛给调用方。

实现：tools/pet_adapters/<name>.py，暴露 build() 或 Adapter。
    null.py     未安装/关闭时的空实现
    dsh_pet.py  第三方 exe：本地 bridge jsonl（dsh-{pid}.jsonl）

CLI：
    python tools/pet_adapter.py status
"""
from __future__ import annotations

import importlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "config" / "pet.json"

_INSTANCE = None
_INSTANCE_NAME = ""


class PetAdapter:
    """最小契约：能力探测 + 状态 + 事件 + 动作 + 播报。"""

    name = "base"

    def available(self) -> bool:
        return False

    def send_state(self, state: dict) -> bool:
        return False

    def send_event(self, kind: str, payload: dict) -> bool:
        return False

    def play(self, action: str) -> bool:
        return False

    def say(self, text: str) -> bool:
        return False

    # 统一兜底：任何实现方法都不允许把异常抛给事件源
    def safe(self, method: str, *args) -> bool:
        try:
            return bool(getattr(self, method)(*args))
        except Exception:  # noqa: BLE001
            return False


def config() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
        return cfg if isinstance(cfg, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def get(force: bool = False) -> PetAdapter:
    """按 config/pet.json 解析适配器；载入失败一律回退 null。"""
    global _INSTANCE, _INSTANCE_NAME
    name = str(config().get("adapter") or "null").strip() or "null"
    if _INSTANCE is not None and _INSTANCE_NAME == name and not force:
        return _INSTANCE

    inst = None
    try:
        mod = importlib.import_module("pet_adapters.%s" % name)
        inst = mod.build() if hasattr(mod, "build") else mod.Adapter()
    except Exception:  # noqa: BLE001
        inst = None
    if inst is None:
        try:
            mod = importlib.import_module("pet_adapters.null")
            inst = mod.build() if hasattr(mod, "build") else mod.Adapter()
            name = "null"
        except Exception:  # noqa: BLE001
            inst = PetAdapter()
            name = "null"

    _INSTANCE, _INSTANCE_NAME = inst, name
    return inst


def status() -> dict:
    cfg = config()
    ad = get()
    bridge = ""
    try:
        bridge = str(getattr(ad, "bridge_dir")() or "")
    except Exception:  # noqa: BLE001
        bridge = ""
    return {"enabled": bool(cfg.get("enabled", True)),
            "adapter": getattr(ad, "name", _INSTANCE_NAME),
            "available": ad.safe("available"),
            "bridge_dir": bridge}


if __name__ == "__main__":
    st = status()
    print("enabled: %s" % st["enabled"])
    print("adapter: %s (available=%s)" % (st["adapter"], st["available"]))
    print("bridge_dir: %s" % (st["bridge_dir"] or "-"))
