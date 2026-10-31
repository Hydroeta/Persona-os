# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 桌宠事件总线（唯一入口，永不抛错）

所有组件只调 publish()，谁都不直接碰桌宠：
    state_engine   state_change（精力/情绪桶变化）
    call_loop      call_start / call_end
    console        svc_start / svc_stop
    alert          alert（P1 预留）

链路：publish → data/pet_events.jsonl（永远落盘） → PetAdapter（可选，失败静默）
配置：config/pet.json（enabled / adapter / bridge_dir / persona）

CLI：
    python tools/pet_bus.py status
    python tools/pet_bus.py test
    python tools/pet_bus.py tail [n]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "config" / "pet.json"
EVENT_FILE = ROOT / "data" / "pet_events.jsonl"

KINDS = ("state_change", "call_start", "call_end", "svc_start", "svc_stop", "alert", "say")


def config() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
        return cfg if isinstance(cfg, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _persona_allows(cfg: dict) -> bool:
    """桌宠只对应固定角色：cfg.persona 非空时，仅该角色激活才推送；
    读不到激活角色视为不匹配（不推送）。空 persona 表示不做角色门控。"""
    want = str(cfg.get("persona") or "").strip()
    if not want:
        return True
    try:
        import persona_switch
        return persona_switch.active_id() == want
    except Exception:  # noqa: BLE001
        return False


def publish(kind: str, **payload) -> None:
    """写一条事件并转发给适配器。永不抛错：观测组件不能反过来弄崩业务。"""
    try:
        EVENT_FILE.parent.mkdir(parents=True, exist_ok=True)
        rec = {"ts": round(time.time(), 3),
               "time": time.strftime("%Y-%m-%d %H:%M:%S"),
               "kind": kind, "payload": payload}
        with open(EVENT_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass

    cfg = config()
    if not cfg.get("enabled", True) or not _persona_allows(cfg):
        return
    try:
        import pet_adapter
        pet_adapter.get().send_event(kind, payload)
    except Exception as exc:  # noqa: BLE001
        try:
            import timeline
            timeline.emit("pet_error", "pet_bus", kind=kind, detail=str(exc)[:200])
        except Exception:  # noqa: BLE001
            pass


def tail(limit: int = 20) -> list[dict]:
    if not EVENT_FILE.is_file():
        return []
    rows = []
    try:
        with open(EVENT_FILE, encoding="utf-8") as fh:
            for line in fh:
                try:
                    rows.append(json.loads(line))
                except Exception:  # noqa: BLE001
                    continue
    except OSError:
        pass
    return rows[-limit:]


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else "status"
    if arg == "test":
        publish("say", text="桌宠通道自检：总线已接通")
        print("已发布测试事件 -> %s" % EVENT_FILE)
        return
    if arg == "tail":
        n = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 10
        for r in tail(n):
            print("%s  %-12s %s" % (r.get("time", ""), r.get("kind", ""),
                                    json.dumps(r.get("payload", {}), ensure_ascii=False)[:120]))
        return
    import pet_adapter
    st = pet_adapter.status()
    print("enabled: %s" % st["enabled"])
    want = str(config().get("persona") or "").strip()
    if want:
        try:
            import persona_switch
            act = persona_switch.active_id()
        except Exception:  # noqa: BLE001
            act = None
        print("persona: %s (active=%s, push=%s)" % (want, act or "-",
                                                    "on" if act == want else "off"))
    print("adapter: %s (available=%s)" % (st["adapter"], st["available"]))
    print("bridge_dir: %s" % (st["bridge_dir"] or "-"))
    print("bus_file: %s" % EVENT_FILE)
    for r in tail(5):
        print("  %s  %-12s %s" % (r.get("time", ""), r.get("kind", ""),
                                  json.dumps(r.get("payload", {}), ensure_ascii=False)[:80]))


if __name__ == "__main__":
    main()
