# -*- coding: utf-8 -*-
"""直播人格切换触发器（Task 7）。

订阅 console 事件总线（event_bus 的进程内回调），监听：
  - 弹幕指令：配置的 command（如 "!switch <persona>"）→ 切换到目标人格
  - 礼物 / SC：达到配置阈值（gift_price_min / gift_num_min / superchat_price_min）→ 切换

命中后联动（按顺序，每步独立 try/except，单步失败不影响其余）：
  1. persona_switch.switch_character(persona_id)   —— 写 active.json + 物化 config/persona.json
  2. 写 data/live_voice.json（跨进程共享文件）—— live_bot 下次 TTS 重读，切 IndexTTS 参考音
  3. 调 console 注入的 avatar_switch(persona_id, model) 回调 —— 桌宠形象切换
  4. emit 一条 persona_switched 事件到总线 —— OBS HUD 可反馈

跨进程说明：
  live_bot 是独立进程，模块导入时把 ohwhale-deploy/config.json 的 paths.voice_ref
  冻结进 _TTS_BASE，改 config.json 对已运行的 live_bot 无效。故这里写
  data/live_voice.json 让 live_bot 运行时热读（见 live_bot._live_voice_ref）。
  call_loop（电话）每次读 config/persona.json 的 voice.ref_audio，persona 切换后
  自动生效，无需额外处理。

所有异常吞掉只打印，绝不影响事件总线 / console 主进程（观测组件不能崩业务）。
"""
from __future__ import annotations

import copy
import json
import os
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # persona-os 根
CFG_FILE = ROOT / "config" / "persona_trigger.json"
LIVE_VOICE_FILE = ROOT / "data" / "live_voice.json"
PERSONAS_DIR = ROOT / "config" / "personas"

_DEFAULTS = {
    "enabled": True,
    "cooldown_sec": 15.0,       # 全局切换冷却（秒），避免刷屏反复切
    "rules": [
        {
            "name": "弹幕指令切换人格",
            "match": {"command": "!switch"},
            "target": {},       # persona_id 留空 = 用指令参数（!switch <id/别名>）
        },
        {
            "name": "大额礼物唤醒墨提斯",
            "match": {"gift_price_min": 100.0},
            "target": {"persona_id": "mortis", "avatar_model": "mortis"},
        },
    ],
}

_lock = threading.Lock()
_started = False
_cfg: dict = {}
_cfg_mtime: float = 0.0
_last_switch_ts: float = 0.0
_avatar_switch = None            # console 注入的桌宠切换回调 fn(persona_id, model) -> dict


def _config() -> dict:
    """读取配置（按 mtime 热加载；rules 用户给了就整体替换，其余键浅合并）。"""
    global _cfg, _cfg_mtime
    try:
        mtime = CFG_FILE.stat().st_mtime if CFG_FILE.is_file() else 0.0
    except Exception:
        mtime = 0.0
    if _cfg and mtime == _cfg_mtime:
        return _cfg
    cfg = copy.deepcopy(_DEFAULTS)
    if mtime:
        try:
            user = json.loads(CFG_FILE.read_text(encoding="utf-8"))
            if isinstance(user, dict):
                if isinstance(user.get("rules"), list):
                    cfg["rules"] = user["rules"]
                for k, v in user.items():
                    if k != "rules":
                        cfg[k] = v
        except Exception as e:
            try:
                print(f"[persona_trigger] 配置解析失败，用默认值: {e!r}")
            except Exception:
                pass
    with _lock:
        _cfg = cfg
        _cfg_mtime = mtime
    return cfg


def reload_config() -> dict:
    """强制重读配置（供 console 热刷新路由 / 测试调用）。"""
    global _cfg_mtime
    _cfg_mtime = 0.0
    return _config()


def set_avatar_switch(fn) -> None:
    """console 注入桌宠切换回调 fn(persona_id, model) -> {"ok","msg"}。"""
    global _avatar_switch
    _avatar_switch = fn


def _resolve_persona_by_arg(arg: str) -> str | None:
    """把指令参数解析成 persona id：匹配目录 id / self_name / alias（大小写不敏感）。"""
    arg = (arg or "").strip().lower()
    if not arg or not PERSONAS_DIR.is_dir():
        return None
    for d in sorted(PERSONAS_DIR.iterdir()):
        pj = d / "persona.json"
        if not d.is_dir() or not pj.is_file():
            continue
        if d.name.lower() == arg:
            return d.name
        try:
            p = json.loads(pj.read_text(encoding="utf-8"))
        except Exception:
            continue
        ident = p.get("identity") or {}
        names = [str(ident.get("self_name") or "")] + list(ident.get("alias") or [])
        if any(str(n).lower() == arg for n in names if n):
            return d.name
    return None


def _derive_avatar_model(persona_id: str) -> str:
    """从人格正本 pet.character 推导桌宠模型（mortis→mortis，鲸鲸→shenshen）。"""
    try:
        pj = PERSONAS_DIR / persona_id / "persona.json"
        if pj.is_file():
            p = json.loads(pj.read_text(encoding="utf-8"))
            return str((p.get("pet") or {}).get("character") or "")
    except Exception:
        pass
    return ""


def _resolve_ref_audio(persona_id: str, override) -> str:
    """返回参考音频绝对路径：override 优先，否则读人格正本 voice.ref_audio。"""
    ref = str(override or "")
    if not ref:
        try:
            pj = PERSONAS_DIR / persona_id / "persona.json"
            if pj.is_file():
                p = json.loads(pj.read_text(encoding="utf-8"))
                ref = str((p.get("voice") or {}).get("ref_audio") or "")
        except Exception:
            ref = ""
    if not ref:
        return ""
    p = Path(ref)
    if not p.is_absolute():
        p = ROOT / p
    return str(p)


def _match_rule(rule: dict, ev: dict) -> dict | None:
    """事件命中规则则返回填充好的 target（含 persona_id），否则 None。"""
    m = rule.get("match") or {}
    if not isinstance(m, dict):
        return None
    target = copy.deepcopy(rule.get("target") or {})
    etype = ev.get("type")

    cmd = str(m.get("command") or "")
    if cmd:
        if etype != "danmu":
            return None
        content = str(ev.get("content") or "").strip()
        if not content.startswith(cmd):
            return None
        if not target.get("persona_id"):
            arg = content[len(cmd):].strip()
            pid = _resolve_persona_by_arg(arg)
            if not pid:
                return None
            target["persona_id"] = pid
        return target

    if etype == "gift":
        want_name = str(m.get("gift_name") or "")
        price_min = float(m.get("gift_price_min") or 0)
        num_min = int(m.get("gift_num_min") or 0)
        if want_name and str(ev.get("gift_name") or "") != want_name:
            return None
        price = float(ev.get("price") or 0)
        num = int(ev.get("gift_num") or 0)
        hit = (price_min > 0 and price >= price_min) or (num_min > 0 and num >= num_min)
        return target if hit else None

    if etype == "superchat":
        price_min = float(m.get("superchat_price_min") or 0)
        if price_min > 0 and float(ev.get("price") or 0) >= price_min:
            return target
        return None

    return None


def _write_live_voice(persona_id: str, ref_abs: str) -> None:
    """原子写跨进程共享的 live 语音覆盖文件（live_bot 下次 TTS 读取）。"""
    try:
        LIVE_VOICE_FILE.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "persona": persona_id,
            "ref_audio": ref_abs,
            "ts": time.time(),
            "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        tmp = LIVE_VOICE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                       encoding="utf-8")
        os.replace(tmp, LIVE_VOICE_FILE)
    except Exception as e:
        try:
            print(f"[persona_trigger] 写 live_voice 失败: {e!r}")
        except Exception:
            pass


def _do_switch(target: dict, rule_name: str, ev: dict) -> None:
    """执行一次人格联动切换（匹配 + 冷却已在外层判定）。"""
    global _last_switch_ts
    persona_id = str(target.get("persona_id") or "")
    if not persona_id:
        return
    cfg = _config()
    cd = float(cfg.get("cooldown_sec", 15.0))
    now = time.time()
    with _lock:
        if now - _last_switch_ts < cd:
            return
        _last_switch_ts = now

    msgs = []
    # 1. 人格卡切换（失败则中止：人格没切，后面没意义）
    try:
        import persona_switch
        persona_switch.switch_character(persona_id)
        msgs.append("人格→%s" % persona_id)
    except Exception as e:
        try:
            print(f"[persona_trigger] 人格切换失败: {e!r}")
        except Exception:
            pass
        return

    # 2. 切 live_bot 参考音（写共享文件；参考音不存在则跳过，不崩）
    ref_abs = _resolve_ref_audio(persona_id, target.get("ref_audio"))
    if ref_abs and os.path.isfile(ref_abs):
        _write_live_voice(persona_id, ref_abs)
        msgs.append("参考音→%s" % os.path.basename(ref_abs))
    else:
        try:
            print(f"[persona_trigger] 参考音不存在，跳过语音切换: {ref_abs!r}")
        except Exception:
            pass

    # 3. 桌宠形象切换（console 注入的回调；无回调或未配 model 则跳过）
    model = str(target.get("avatar_model") or "") or _derive_avatar_model(persona_id)
    if _avatar_switch is not None and model:
        try:
            _avatar_switch(persona_id, model)
            msgs.append("桌宠→%s" % model)
        except Exception as e:
            try:
                print(f"[persona_trigger] 桌宠切换失败: {e!r}")
            except Exception:
                pass

    # 4. 反馈事件给总线（HUD 可渲染；不会回环——_on_event 只接 danmu/gift/superchat）
    try:
        import event_bus
        event_bus.emit({
            "type": "persona_switched", "ts": time.time(),
            "persona": persona_id, "rule": rule_name,
            "avatar_model": model, "ref_audio": ref_abs,
            "session": ev.get("session"),
        })
    except Exception:
        pass

    try:
        print(f"[persona_trigger] 命中「{rule_name}」: {'；'.join(msgs)}")
    except Exception:
        pass


def _on_event(ev: dict) -> None:
    """事件总线回调：匹配规则并触发切换。一条事件只命中第一条规则。"""
    try:
        if not isinstance(ev, dict):
            return
        cfg = _config()
        if not cfg.get("enabled", True):
            return
        if ev.get("type") not in ("danmu", "gift", "superchat"):
            return
        for rule in cfg.get("rules") or []:
            target = _match_rule(rule, ev)
            if target:
                _do_switch(target, str(rule.get("name") or "未命名"), ev)
                return
    except Exception as e:
        try:
            print(f"[persona_trigger] 回调异常: {e!r}")
        except Exception:
            pass


def start(avatar_switch=None) -> bool:
    """订阅事件总线。幂等；任何失败都不抛异常。avatar_switch 由 console 注入。"""
    global _started, _avatar_switch
    if avatar_switch is not None:
        _avatar_switch = avatar_switch
    if _started:
        return True
    try:
        import event_bus
    except Exception:
        print("[persona_trigger] event_bus 不可用，未启用")
        return False
    try:
        _config()                       # 预热配置缓存
        event_bus.subscribe(_on_event)
        _started = True
        print("[persona_trigger] 已订阅事件总线，人格切换触发已启用")
        return True
    except Exception as e:
        try:
            print(f"[persona_trigger] start failed: {e!r}")
        except Exception:
            pass
        return False


def _read_live_voice() -> dict:
    try:
        if LIVE_VOICE_FILE.is_file():
            return json.loads(LIVE_VOICE_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def status() -> dict:
    cfg = _config()
    return {
        "started": _started,
        "enabled": cfg.get("enabled", True),
        "cooldown_sec": cfg.get("cooldown_sec"),
        "rules": len(cfg.get("rules") or []),
        "last_switch_ts": _last_switch_ts,
        "live_voice": _read_live_voice(),
    }
