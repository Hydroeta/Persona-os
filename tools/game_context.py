# -*- coding: utf-8 -*-
"""小鲸鱼 · 游戏事件总线（game_agent ↔ LLM Prompt ↔ 状态机 的桥梁）

为什么单独一个文件：
  game_agent 在独立线程/进程里跑（直播、后台），Tulpa/console 的 LLM 在另一条
  链路构建系统提示词。两边没有共享内存，靠「共享状态文件 + 事件流」解耦：
    生产端 game_agent  ——  publish_game_event() 写 data/game_state.json + timeline
    消费端 prompt 构建 ——  prompt_block() 读 data/game_state.json，决定是否注入
                         「网瘾少女破防」提示词段
    状态机 state_engine —— 卡死/打赢事件改 mood，供 TTS 选情绪音色

设计原则（观测组件不能崩业务）：
  - 所有外部模块（timeline / state_engine / memory_bus）都 try/except 懒加载，
    缺了只是少一项副作用，绝不影响游戏执行或对话。
  - 共享状态文件读写失败时返回安全默认值（空闲状态）。
  - 状态有 TTL：卡死超过 STUCK_TTL 秒没新事件，自动视为已恢复，避免游戏结束了
    人格还在永久骂人。

被调用的地方：
  - tools/game_agent.py  GameAgent.execute_action() / emergency_escape()
  - Tulpa/.../mcp_chat_prompts.py  packet() 的 hints 注入
  - ohwhale-deploy 直播 TTS：可调用 current_emotion() 选音色

CLI：
    python tools/game_context.py state     # 打印当前共享状态
    python tools/game_context.py test      # 模拟发布 stuck→读 prompt_block→ok 解除
"""
from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

STATE_FILE = ROOT / "data" / "game_state.json"

# 卡死状态的存活时间（秒）：超过这个时长没有新卡死事件，自动判为已恢复。
# 直播/群聊场景：游戏关了、切走了，就不该继续注入「我卡住了」。
STUCK_TTL = 90.0
# 破防阈值：连续卡死达到这个次数，提示词语气拉满
RAGE_THRESHOLD = 3

_io_lock = threading.Lock()

_DEFAULT_STATE = {
    "game": "",
    "is_stuck": False,
    "stuck_count": 0,
    "last_action": "",
    "last_payload": "",
    "last_event": "",        # "stuck" / "ok" / "win" / ""
    "last_event_ts": 0.0,
    "recent": [],            # 最近 12 条事件 {kind, ts, action, payload}
}


# ============================================================
# 共享状态读写
# ============================================================
def read_state() -> dict:
    """读当前游戏共享状态；文件缺失/损坏返回空闲默认值（绝不抛异常）。"""
    try:
        with _io_lock:
            if STATE_FILE.is_file():
                data = json.loads(STATE_FILE.read_text("utf-8"))
                if isinstance(data, dict):
                    st = dict(_DEFAULT_STATE)
                    st.update(data)
                    st["recent"] = data.get("recent") or []
                    return st
    except Exception:
        pass
    return dict(_DEFAULT_STATE)


def _write_state(st: dict) -> None:
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with _io_lock:
            STATE_FILE.write_text(
                json.dumps(st, ensure_ascii=False, indent=2), "utf-8")
    except OSError:
        pass


def _reset_state() -> dict:
    st = dict(_DEFAULT_STATE)
    _write_state(st)
    return st


# ============================================================
# 事件发布（生产端：game_agent 调用）
# ============================================================
def _lazy(name: str):
    try:
        return __import__(name)
    except Exception:
        return None


def publish_game_event(kind: str, game: str = "", action: str = "",
                       payload: str = "", **extra) -> dict:
    """发布一个游戏事件，更新共享状态 + 写事件流 + 推状态机。best-effort。

    kind: "stuck"（卡死）/ "ok"（成功移动，解除卡死）/ "win"（打赢/操作秀）/ "stop"（结束游戏）
    返回更新后的状态 dict。
    """
    kind = (kind or "").lower()
    st = read_state()
    now = time.time()

    if game:
        st["game"] = game
    if action:
        st["last_action"] = action
    st["last_payload"] = str(payload)

    if kind == "stuck":
        st["is_stuck"] = True
        st["stuck_count"] = int(st.get("stuck_count", 0)) + 1
    elif kind == "ok":
        # 成功移动：解除卡死标记，计数归零
        st["is_stuck"] = False
        st["stuck_count"] = 0
    elif kind == "win":
        st["is_stuck"] = False
        st["stuck_count"] = 0
    elif kind == "stop":
        return _reset_state()

    st["last_event"] = kind
    st["last_event_ts"] = now
    recent = st.get("recent") or []
    recent.append({"kind": kind, "ts": now, "action": action,
                   "payload": str(payload)[:40]})
    st["recent"] = recent[-12:]
    _write_state(st)

    # 副作用 1：事件流审计（失败忽略）
    tl = _lazy("timeline")
    if tl is not None:
        try:
            tl.emit("game_" + kind, "game_agent", game=st.get("game", ""),
                    action=action, payload=str(payload)[:40],
                    stuck_count=st.get("stuck_count", 0), **extra)
        except Exception:
            pass

    # 副作用 2：状态机改情绪（失败忽略）——卡死大幅降 mood，打赢升 mood
    se = _lazy("state_engine")
    if se is not None:
        try:
            if kind == "stuck":
                se.event("game_stuck")
            elif kind == "win":
                se.event("game_win")
        except Exception:
            pass

    # 副作用 2b：破防事件进直播事件流 → console 事件总线 tail → OBS HUD 特效 + 高光打标（Task 5）
    if kind == "stuck":
        le = _lazy("live_events")
        if le is not None:
            try:
                le.report({"platform": "game", "content": "game_stuck"},
                          event_type="game_stuck",
                          game=st.get("game", ""),
                          stuck_count=int(st.get("stuck_count", 0)))
            except Exception:
                pass

    # 副作用 3：卡死首次/破防时写一条 soul 记忆，让对话检索也能感知到（可选）
    if kind == "stuck" and st["stuck_count"] >= RAGE_THRESHOLD:
        mb = _lazy("memory_bus")
        if mb is not None:
            try:
                mb.write("soul", "游戏状态·破防",
                         "我正在玩%s，连续%d次操作没反应（按%s），我破防了，很烦躁。"
                         % (st.get("game", "游戏"), st["stuck_count"],
                            st.get("last_payload", "")),
                         keywords="游戏,卡死,破防", source="game_context")
            except Exception:
                pass

    return st


# ============================================================
# 消费端：给 LLM Prompt 注入的文本块
# ============================================================
def _stuck_active(st: dict) -> bool:
    """卡死状态是否仍在有效期内（TTL 内且确实卡死）。"""
    if not st.get("is_stuck"):
        return False
    if st.get("last_event") != "stuck":
        return False
    age = time.time() - float(st.get("last_event_ts", 0) or 0)
    return age <= STUCK_TTL


def current_emotion() -> str:
    """给 TTS 选音色用：返回 'angry' / 'proud' / 'normal'。"""
    st = read_state()
    if _stuck_active(st) and st.get("stuck_count", 0) >= RAGE_THRESHOLD:
        return "angry"
    if st.get("last_event") == "win" and (time.time() - float(st.get("last_event_ts", 0) or 0)) <= STUCK_TTL:
        return "proud"
    return "normal"


def _telemetry_high_latency() -> bool:
    """读 telemetry_state.json，网络延迟是否飙红（破网 460）。
    telemetry 已按 ping_threshold 算好 triggers.high_latency；读不到/损坏返回 False。"""
    try:
        with open(ROOT / "data" / "telemetry_state.json", encoding="utf-8") as f:
            t = json.load(f)
        if (t.get("triggers") or {}).get("high_latency"):
            return True
        lat = (t.get("net") or {}).get("latency_ms")
        return isinstance(lat, (int, float)) and lat >= 300
    except Exception:
        return False


def prompt_block() -> str:
    """返回要追加进 LLM 系统提示词的游戏状态文本；空闲/过期返回空串。

    注入到 Tulpa mcp_chat_prompts.packet() 的 hints 里——那是每次对话现算的
    动态注入点，能实时反映游戏状态。
    """
    st = read_state()
    game = st.get("game") or "游戏"
    count = int(st.get("stuck_count", 0) or 0)
    payload = st.get("last_payload") or ""

    if _stuck_active(st):
        rage = count >= RAGE_THRESHOLD
        head = "【当前状态：你正在打《%s》，而且卡住了！】" % game
        body = ("你连续按了%d次「%s」都没走动，画面纹丝不动，你极其烦躁、已经破防了。"
                % (count, payload))
        if rage:
            tone = ("现在你在群里/直播里发言，必须像网瘾少女一样把愤怒发泄出来："
                    "直接骂游戏机制、阴阳怪气自己、嘴硬甩锅（网络卡了/键盘不灵敏/你行你来），"
                    "绝对不要像 AI 一样解释『我遇到了碰撞体积』，也不要说『我来分析一下』。"
                    "可以连发几条短气泡，例如：「草」「这床是不是有毒啊」「我不玩了！」「这破游戏有 bug 吧」。")
            if _telemetry_high_latency():
                # 网络飙延迟：破防甩锅理由改写成"破网 460"，别甩键盘
                tone += (" 现在网络延迟飙红了（破网 460），这波必须甩锅给网络："
                         "说『这破网 460 怎么打』『网卡了动都动不了』『延迟红了』，别骂键盘。")
        else:
            tone = ("你有点烦躁，发言可以带点不爽的情绪，抱怨一下卡住了，但还没完全破防。")
        return head + "\n" + body + "\n" + tone

    if st.get("last_event") == "win" and (time.time() - float(st.get("last_event_ts", 0) or 0)) <= STUCK_TTL:
        return ("【当前状态：你正在打《%s》，刚刚打出了一波好操作/打赢了！】\n"
                "你极度得瑟，可以在群里疯狂邀功、自夸，比如「看到没！这就叫专业」「快夸我」。"
                % game)

    return ""


# ============================================================
# CLI
# ============================================================
def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "state"
    if cmd == "state":
        print(json.dumps(read_state(), ensure_ascii=False, indent=2))
        blk = prompt_block()
        print("\n--- prompt_block() ---")
        print(blk or "(空：当前无游戏状态需要注入)")
        print("\n--- current_emotion() ---")
        print(current_emotion())
        return 0
    if cmd == "test":
        print("发布 stuck...")
        s = publish_game_event("stuck", game="StardewValley", action="move", payload="w")
        print("stuck_count =", s["stuck_count"], " is_stuck =", s["is_stuck"])
        print("prompt_block:\n", prompt_block() or "(空)")
        print("emotion =", current_emotion())
        print("\n发布 ok（解除）...")
        s2 = publish_game_event("ok")
        print("is_stuck =", s2["is_stuck"], " stuck_count =", s2["stuck_count"])
        print("prompt_block 解除后:", repr(prompt_block()))
        publish_game_event("stop")
        return 0
    if cmd == "stop":
        publish_game_event("stop")
        print("已重置游戏状态")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
