# -*- coding: utf-8 -*-
"""dsh_pet 适配器：把总线事件翻译成桌宠能吃的事件外壳（只写本地 jsonl）

契约来源（随桌宠分发的 DSH 桥，MIT）：
    dsh-pet/_internal/integrations/dsh-pet-bridge/index.js
      · 桥目录 win32 = %APPDATA%\\dsh-pet-bridge（不可配，本机可用 config/pet.json 的
        bridge_dir 覆盖）
      · 实例文件 dsh-{pid}.jsonl，消费端 glob dsh*.jsonl，byte-offset tail（不回放历史）
      · 记录外壳 {"ts","agent","event":"AgentStatus",...}

只写三种已核实外壳，其余事件不落桥，避免触发 bridge.unknown 兜底口播：
    call_start / svc_start / say  -> tool/call
    call_end   / svc_stop         -> tool/result
    alert                         -> execution/failed

上游格式若变更，坏的只是本文件。
"""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path

from pet_adapter import CONFIG_FILE, ROOT, PetAdapter

EXE_NAME = "dsh-pet-standalone-webm-chat.exe"
MAX_LINE = 4096


def _cfg() -> dict:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
        return cfg if isinstance(cfg, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def bridge_dir() -> Path:
    override = str(_cfg().get("bridge_dir") or "").strip()
    if override:
        return Path(os.path.expandvars(override)).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or Path.home()) / "dsh-pet-bridge"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "dsh-pet-bridge"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "dsh-pet-bridge"


class Adapter(PetAdapter):
    name = "dsh_pet"

    def __init__(self) -> None:
        self._step = 0
        self._active: dict[str, tuple[str, str]] = {}   # key -> (callId, tool)

    # ---------- 能力探测 ----------
    def available(self) -> bool:
        if not (ROOT / "dsh-pet" / EXE_NAME).is_file():
            return False
        try:
            d = bridge_dir()
            d.mkdir(parents=True, exist_ok=True)
            return os.access(str(d), os.W_OK)
        except Exception:  # noqa: BLE001
            return False

    def bridge_dir(self) -> str:
        return str(bridge_dir())

    # ---------- 落桥 ----------
    def _append(self, extra: dict) -> bool:
        rec = {"ts": round(time.time(), 3),
               "agent": "dsh",
               "event": "AgentStatus"}
        rec.update(extra)
        try:
            d = bridge_dir()
            d.mkdir(parents=True, exist_ok=True)
            line = json.dumps(rec, ensure_ascii=False)
            if len(line) > MAX_LINE:
                line = line[:MAX_LINE]
            with open(d / ("dsh-%d.jsonl" % os.getpid()), "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
            return True
        except Exception:  # noqa: BLE001
            return False

    def _agent(self, payload: dict) -> str:
        return str(payload.get("agent") or _cfg().get("agent") or "小鲸鱼")

    def _session(self) -> str:
        return str(_cfg().get("session") or "pet-bus")

    def _call(self, tool: str, payload: dict) -> tuple[str, str]:
        self._step += 1
        return ("petbus-%s" % uuid.uuid4().hex[:12], tool)

    # ---------- 契约 ----------
    def send_state(self, state: dict) -> bool:
        # 精力/情绪没有已核实的桌宠映射，P0 只落总线，不臆造桥事件
        return False

    def send_event(self, kind: str, payload: dict) -> bool:
        payload = payload or {}
        if kind in ("call_start", "svc_start", "say"):
            tool = self._label(kind, payload)
            call_id, _ = self._call(tool, payload)
            if kind in ("call_start", "svc_start"):
                # 只登记有配对结束的事件；say 无结束事件，不登记，避免字典无限增长
                self._active[self._key(kind, payload)] = (call_id, tool)
            return self._append({
                "event": "tool/call",
                "agentName": self._agent(payload),
                "tool": tool,
                "argsKey": "",
                "command": "",
                "callId": call_id,
                "step": self._step,
                "sessionId": self._session(),
            })

        if kind in ("call_end", "svc_stop"):
            key = self._key(kind, payload)
            call_id, _ = self._active.pop(key, ("", ""))
            tool = self._label(kind, payload)
            if not call_id:
                call_id, _ = self._call(tool, payload)
            return self._append({
                "event": "tool/result",
                "agentName": self._agent(payload),
                "tool": tool,
                "argsKey": "",
                "command": "",
                "callId": call_id,
                "ok": True,
                "timeout": False,
                "errorCode": "",
                "errorMessage": "",
                "evidenceStatus": "unavailable",
                "evidenceHash": "",
                "step": self._step,
                "sessionId": self._session(),
            })

        if kind == "alert":
            text = str(payload.get("text") or payload.get("title") or "异常")[:200]
            return self._append({
                "event": "execution/failed",
                "failureType": "tool_failed",
                "retryExhausted": False,
                "retries": 0,
                "errorCode": str(payload.get("code") or "PET_BUS_ALERT")[:48],
                "errorMessage": text,
            })

        return False

    def play(self, action: str) -> bool:
        # 动作/表情没有对外入口（需改 exe，违反隔离原则）
        return False

    def say(self, text: str) -> bool:
        text = str(text or "").strip()
        if not text:
            return False
        return self.send_event("say", {"text": text[:40]})

    # ---------- 内部 ----------
    @staticmethod
    def _key(kind: str, payload: dict) -> str:
        if kind == "call_start":
            return "call"
        if kind == "call_end":
            return "call"
        name = str(payload.get("service") or payload.get("name") or "")
        if kind == "svc_start":
            return "svc:%s" % name
        if kind == "svc_stop":
            return "svc:%s" % name
        return kind

    @staticmethod
    def _label(kind: str, payload: dict) -> str:
        if kind == "call_start":
            return "打电话"
        if kind == "call_end":
            return "电话挂断"
        if kind == "svc_start":
            name = str(payload.get("service") or payload.get("name") or "")
            return ("启动 %s" % name).strip()[:40]
        if kind == "svc_stop":
            name = str(payload.get("service") or payload.get("name") or "")
            return ("停止 %s" % name).strip()[:40]
        if kind == "say":
            return str(payload.get("text") or "说话")[:40]
        return kind[:40]


def build() -> Adapter:
    return Adapter()
