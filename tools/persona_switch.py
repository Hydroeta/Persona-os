# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 多角色静默热切换（零 LLM 调用，纯工程切换）

目录约定（正本在角色目录，config/ 下是激活角色的物化视图）：
  config/personas/active.json          {"active_id": "ohwhale", "updated": ...}
  config/personas/<id>/persona.json    该角色的人格+声音+记忆指针正本
  config/personas/<id>/state.json      该角色的情绪/精力/作息存档
  config/persona.json                  激活角色 persona.json 的物化视图（自动生成，勿手改）
  config/state.json                    激活角色 state.json 的物化视图（state_engine 保存时同步）

现有读取方（call_loop / voice_mail / persona_override / persona_snapshot）全部
继续读物化视图，零改动；state_engine 每次保存时把角色 state 同步到视图。

切换是静默的：不调 LLM、不生成交接词。分层生效速度：
  · 通话/语音邮件：下次调用自动用新参考音（每次都读视图，真热切换）
  · DSH 会话：建议开新会话（短期上下文按角色隔离，避免新角色带旧语气）
  · Tulpa（QQ）：闭源，会话缓存人格快照，需重启 Tulpa 会话才换人格
  · dsh-pet（桌宠）：闭源 exe，WebM 素材与人设需重启桌宠进程切换

切换事件追加到 data/persona_events.jsonl，dsh-pet bridge / 控制台可 tail 消费。

CLI：
    python tools/persona_switch.py list              # 所有角色
    python tools/persona_switch.py active            # 当前激活
    python tools/persona_switch.py switch <id>       # 切换
    python tools/persona_switch.py migrate           # 首次迁移：config/persona.json → personas/ohwhale/
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PERSONAS_DIR = ROOT / "config" / "personas"
ACTIVE_FILE = PERSONAS_DIR / "active.json"
VIEW_PERSONA = ROOT / "config" / "persona.json"
VIEW_STATE = ROOT / "config" / "state.json"
EVENTS_FILE = ROOT / "data" / "persona_events.jsonl"

# 切换后需要人工/控制台跟进的组件（闭源或会话缓存，无法真正热重载）
RESTART_HINTS = {
    "call": "通话/语音邮件：下次调用自动生效（真热切换）",
    "dsh": "DSH：建议开新会话，短期上下文按角色隔离",
    "tulpa": "Tulpa（QQ）：需重启 Tulpa 会话加载新人格卡（闭源，prompt 快照缓存）",
    "pet": "dsh-pet（桌宠）：需重启桌宠进程切换 WebM 素材与人设",
}


def persona_dir(char_id: str) -> Path:
    return PERSONAS_DIR / char_id


def list_characters() -> list[dict]:
    """列出全部角色（目录里有 persona.json 的才算）。"""
    out = []
    if not PERSONAS_DIR.is_dir():
        return out
    act = active_id()
    for d in sorted(PERSONAS_DIR.iterdir()):
        pj = d / "persona.json"
        if not d.is_dir() or not pj.is_file():
            continue
        try:
            p = json.loads(pj.read_text("utf-8"))
            name = (p.get("identity") or {}).get("self_name", d.name)
        except Exception:
            name = d.name
        out.append({"id": d.name, "name": name, "is_active": d.name == act,
                    "has_state": (d / "state.json").is_file()})
    return out


def active_id() -> str | None:
    try:
        return json.loads(ACTIVE_FILE.read_text("utf-8")).get("active_id")
    except Exception:
        return None


def _log_event(kind: str, **kw) -> None:
    try:
        EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        rec = {"event": kind, "ts": time.time(),
               "time": time.strftime("%Y-%m-%d %H:%M:%S")}
        rec.update(kw)
        with open(EVENTS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def materialize(char_id: str) -> None:
    """把角色正本拷贝为 config/ 下的物化视图（带 _view_of 标记）。"""
    src_p = persona_dir(char_id) / "persona.json"
    p = json.loads(src_p.read_text("utf-8"))
    p["_view_of"] = char_id
    p["_view_note"] = "物化视图，由 persona_switch 自动生成；改人设请编辑 config/personas/%s/persona.json" % char_id
    VIEW_PERSONA.write_text(json.dumps(p, ensure_ascii=False, indent=2), "utf-8")
    src_s = persona_dir(char_id) / "state.json"
    if src_s.is_file():
        shutil.copy2(src_s, VIEW_STATE)
    elif VIEW_STATE.is_file():
        VIEW_STATE.unlink()  # 新角色没有状态存档，清掉旧视图防止误读


def switch_character(char_id: str) -> dict:
    """静默热切换：写指针 → 物化视图 → 记事件。不调 LLM，不生成交接词。"""
    if not (persona_dir(char_id) / "persona.json").is_file():
        raise RuntimeError("角色 %s 不存在（缺 config/personas/%s/persona.json）"
                           % (char_id, char_id))
    prev = active_id()
    if prev == char_id:
        return {"ok": True, "active_id": char_id, "changed": False}
    ACTIVE_FILE.parent.mkdir(parents=True, exist_ok=True)
    ACTIVE_FILE.write_text(json.dumps(
        {"active_id": char_id, "updated": time.time()},
        ensure_ascii=False, indent=2), "utf-8")
    materialize(char_id)
    _log_event("character_switch", **{"from": prev, "to": char_id})
    return {"ok": True, "active_id": char_id, "changed": True, "from": prev,
            "restart_hints": RESTART_HINTS}


def ensure_migrated(default_id: str = "ohwhale") -> dict:
    """首次迁移：现有 config/persona.json + state.json 收编为第一个角色。"""
    if ACTIVE_FILE.is_file():
        return {"ok": True, "migrated": False, "active_id": active_id()}
    if not VIEW_PERSONA.is_file():
        raise RuntimeError("config/persona.json 不存在，无角色可迁移")
    d = persona_dir(default_id)
    d.mkdir(parents=True, exist_ok=True)
    p = json.loads(VIEW_PERSONA.read_text("utf-8"))
    p.setdefault("id", default_id)
    p.setdefault("pet", {"character": "shenshen", "persona_preset": "whale_maid",
                         "note": "闭源 exe，切换角色需重启桌宠进程"})
    (d / "persona.json").write_text(
        json.dumps(p, ensure_ascii=False, indent=2), "utf-8")
    if VIEW_STATE.is_file():
        shutil.copy2(VIEW_STATE, d / "state.json")
    r = switch_character(default_id)
    r["migrated"] = True
    return r


def _main(argv: list[str]) -> int:
    if not argv or argv[0] == "list":
        chars = list_characters()
        if not chars:
            print("（还没有角色，先跑 migrate）")
        for c in chars:
            mark = "▶" if c["is_active"] else " "
            print("%s %s（%s）%s" % (mark, c["id"], c["name"],
                                     "" if c["has_state"] else " [无状态存档]"))
    elif argv[0] == "active":
        print(active_id() or "（未设置）")
    elif argv[0] == "migrate":
        r = ensure_migrated()
        print(json.dumps(r, ensure_ascii=False, indent=2))
    elif len(argv) >= 2 and argv[0] == "switch":
        r = switch_character(argv[1])
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
