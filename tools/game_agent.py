# -*- coding: utf-8 -*-
"""小鲸鱼 · 通用游戏代理微服务（看画面 → VLM 决策 → 按键 → 帧差防卡死）

为什么通用：
  1. 输入法重置 —— Windows 下 Python 发 WASD 会被中文输入法拦截成拼音。
     这里用 ImmAssociateContext 把游戏窗口的 IME 脱挂（比裸调 SendMessageW
     切键盘布局可靠，见经验 2134265），失败再降级请求 en-US 布局。
  2. 帧差法防卡死 —— 执行了移动指令画面像素却没变，99% 是撞墙/卡模型/掉线。
  3. VLM 决策 —— 任何游戏本质都是「看画面 → 分析局势 → 按特定键」，
     截图发给视觉大模型即可。复用 key_vault 里现有的 ZHIPU / DASHSCOPE key
     （GLM-4V / Qwen-VL），无需新密钥；token 走 llm_gate 的 game_agent 场景。

依赖双路径（模块本身零三方依赖，可被任何 venv import）：
  截屏/编码/帧差：优先 mss + opencv + numpy（快）；缺失则用 PIL 兜底
                 （ImageGrab 截屏 + base64 + 纯 Python 帧差，当前环境已装 PIL）。
  按键输入：必须 pydirectinput（绕过游戏引擎按键拦截）；缺失时只决策不按键，
            并在 doctor/probe 里提示安装。

用法（库）：
    import game_agent
    ga = game_agent.GameAgent("StardewValley", tts=my_tts)
    ga.run_loop()                       # 持续：截图→VLM决策→按键→防卡死
    # 或单步：
    action = ga.decide()                # {'action':'move','payload':'w',...}
    result = ga.execute_action(action["action"], action.get("payload"))

用法（CLI 微服务）：
    python tools/game_agent.py doctor            # 检查依赖/key/配置，报缺啥
    python tools/game_agent.py probe             # 截屏→帧差→base64 编码，打印证据（不触网不按键）
    python tools/game_agent.py rules             # 打印合并后的游戏规则
    python tools/game_agent.py loop StardewValley   # 微观模式：每步 VLM 决策按键（需 pydirectinput 才真按键）
    python tools/game_agent.py macros StardewValley  # 打印该游戏的宏观宏列表
    python tools/game_agent.py loop-macro StardewValley  # 宏观模式：VLM 只选宏，按键写死（省 token、更精准）
    python tools/game_agent.py stats             # 今日游戏时长 / VLM 调用

安全：
  - API key 绝不写进代码 / 不打印，走 key_vault。
  - VLM 调用频率 / 每日游玩时长受 game_agent.config.json 限制。
  - 缺任何依赖都优雅降级，不崩调用方。
"""
from __future__ import annotations

import base64
import io
import json
import os
import random
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(GATE_DIR))  # 保证 import 得到同目录的 key_vault / llm_gate

CONFIG_FILE = GATE_DIR / "game_agent.config.json"
DB_FILE = GATE_DIR / "game_agent.db"

DEFAULT_CONFIG = {
    "enabled": True,
    # --- VLM（复用 key_vault 现有 key，无需新增）---
    "vlm": {
        "providers": {
            "glm": {"base": "https://open.bigmodel.cn/api/paas/v4",
                    "model": "glm-4v-flash", "key": "ZHIPU_API_KEY", "enabled": True},
            "qwen": {"base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                     "model": "qwen-vl-plus", "key": "DASHSCOPE_API_KEY", "enabled": True},
        },
        "primary": "glm",            # 主→备 顺序
        "max_tokens": 300,
        "temperature": 0.3,
        "timeout": 30,
        "jpeg_quality": 80,
        "max_dim": 1280,             # 截图最长边缩到该值以内再上传，省 token
    },
    # --- 截屏 ---
    "capture": {
        "monitor": 1,                # mss 显示器序号（1=主屏）；PIL 兜底固定主屏
        "region": None,              # [left, top, width, height] 或 null=全屏
    },
    # --- 时序 ---
    "timing": {
        "min_vlm_interval_s": 1.0,   # 1 秒内最多 1 次 VLM（蓝图要求）
        "move_duration_s": 0.6,
        "key_hold_s": 0.2,
        "post_action_settle_s": 0.3,  # 按键后等画面渲染再做帧差
        "loop_idle_s": 0.2,
    },
    # --- 防卡死 ---
    "stuck": {
        "diff_threshold": 1.5,       # 平均像素差低于此值视为静止
        "resize": [320, 240],
        "escape_after": 3,           # 连续卡死 N 次 → 触发 emergency_escape + TTS 吐槽
    },
    # --- 预算 ---
    "budgets": {
        "daily_play_minutes": 120,   # 每天最多玩 2 小时（蓝图要求）
    },
    # --- 给 VLM 注入的游戏常识 / 防卡死规矩（蓝图 rules.json）---
    "game_rules": {
        "safety_rule": "如果系统提示『画面未发生变化，你大概率卡住了』，绝对不许再向原方向移动。",
        "anti_stuck_strategy": ("遇到卡死提示时，你的自救优先级：1. 向反方向移动；"
                                "2. 随机向左右移动；3. 调用 emergency_escape（action=escape）。"),
        "stuck_lines": ["哎呀，我好像卡住了，动不了了……", "救命啊，我被卡住了！",
                        "这墙怎么回事，撞得我头疼。"],
        "game_specifics": {
            "StardewValley": "你被床卡住时通常是站在床正上方，先按 S 往下走一格，再按 A 或 D 绕开。",
            "Minecraft": "如果走路没反应说明撞到了方块，按空格跳跃，或用鼠标左键挖掉方块。",
        },
    },
}

_VALID_ACTIONS = {"move", "interact", "attack", "chat", "escape", "wait", "stop"}
_MOVE_KEYS = {"w", "a", "s", "d", "up", "down", "left", "right"}

_db_lock = threading.Lock()
_ime_lock = threading.Lock()
_ime_state = {"captured": False, "orig_ctx": 0, "hwnd": 0}


# ============================================================
# 配置
# ============================================================
def load_config() -> dict:
    if CONFIG_FILE.is_file():
        try:
            cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
        except Exception:
            cfg = {}
        merged = json.loads(json.dumps(DEFAULT_CONFIG))  # 深拷贝
        _deep_update(merged, cfg)
        return merged
    try:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2),
                               "utf-8")
    except OSError:
        pass
    return json.loads(json.dumps(DEFAULT_CONFIG))


def _deep_update(base: dict, over: dict) -> None:
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_update(base[k], v)
        else:
            base[k] = v


# ============================================================
# 预算账本（每日游玩时长 / VLM 调用次数）
# ============================================================
def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_FILE), timeout=5)
    conn.execute("""CREATE TABLE IF NOT EXISTS sessions(
        ts REAL, game TEXT, seconds REAL, vlm_calls INTEGER)""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_ts ON sessions(ts)")
    return conn


def _today0() -> float:
    return time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d"))


def today_play_seconds() -> float:
    conn = _db()
    try:
        return float(conn.execute(
            "SELECT COALESCE(SUM(seconds),0) FROM sessions WHERE ts>=?",
            (_today0(),)).fetchone()[0] or 0)
    finally:
        conn.close()


def _record_session(game: str, seconds: float, vlm_calls: int) -> None:
    with _db_lock:
        conn = _db()
        try:
            conn.execute("INSERT INTO sessions VALUES(?,?,?,?)",
                         (time.time(), game, float(seconds), int(vlm_calls)))
            conn.commit()
        finally:
            conn.close()


def play_budget_left(cfg: dict | None = None) -> float:
    """今日剩余可玩秒数；<=0 表示今日预算用尽。"""
    cfg = cfg or load_config()
    cap = float(cfg.get("budgets", {}).get("daily_play_minutes", 120)) * 60
    return max(0.0, cap - today_play_seconds())


# ============================================================
# 依赖探测（双路径：mss+cv2 优先，PIL 兜底）
# ============================================================
def _try_import(name: str):
    try:
        return __import__(name)
    except Exception:
        return None


def have_cv() -> bool:
    return _try_import("cv2") is not None and _try_import("numpy") is not None


def have_mss() -> bool:
    return _try_import("mss") is not None


def have_pdi() -> bool:
    return _try_import("pydirectinput") is not None


def dependency_report() -> dict:
    return {
        "mss": have_mss(), "opencv": have_cv(), "numpy": _try_import("numpy") is not None,
        "pydirectinput": have_pdi(), "PIL": _try_import("PIL") is not None,
        "windows_ime": os.name == "nt",
    }


# ============================================================
# 截屏 / 编码 / 帧差
# ============================================================
def get_screen_frame(cfg: dict | None = None):
    """返回 BGR ndarray（cv2 路径）或 PIL.Image（PIL 兜底路径）；失败返回 None。"""
    cfg = cfg or load_config()
    cap = cfg.get("capture", {})
    region = cap.get("region")
    monitor = int(cap.get("monitor", 1))
    if have_mss() and have_cv():
        import numpy as np
        mss = _try_import("mss")
        cv2 = _try_import("cv2")
        try:
            with mss.mss() as sct:
                mon = sct.monitors[monitor] if monitor < len(sct.monitors) else sct.monitors[1]
                box = mon
                if region and len(region) == 4:
                    box = {"left": mon["left"] + region[0], "top": mon["top"] + region[1],
                           "width": region[2], "height": region[3]}
                img = np.array(sct.grab(box))
                return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        except Exception as e:
            print("  [game_agent] mss 截屏失败: %s" % e)
            return None
    # PIL 兜底
    PIL = _try_import("PIL")
    if PIL is not None:
        try:
            from PIL import ImageGrab
            bbox = None
            if region and len(region) == 4:
                bbox = (region[0], region[1], region[0] + region[2], region[1] + region[3])
            return ImageGrab.grab(bbox=bbox)
        except Exception as e:
            print("  [game_agent] PIL 截屏失败: %s" % e)
    return None


def _to_jpeg_base64(frame, cfg: dict) -> str:
    """把帧压成 JPEG base64（data URL），超长边缩放。"""
    vcfg = cfg["vlm"]
    max_dim = int(vcfg.get("max_dim", 1280))
    q = int(vcfg.get("jpeg_quality", 80))
    cv2 = _try_import("cv2")
    np = _try_import("numpy")
    if cv2 is not None and np is not None and hasattr(frame, "shape"):
        h, w = frame.shape[:2]
        scale = min(1.0, max_dim / max(h, w)) if max(h, w) > max_dim else 1.0
        if scale < 1.0:
            frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, q])
        if not ok:
            raise RuntimeError("cv2 编码失败")
        data = buf.tobytes()
    else:
        # PIL 兜底
        img = frame
        if not hasattr(img, "convert"):
            raise RuntimeError("无法识别的帧类型")
        img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > max_dim:
            scale = max_dim / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=q)
        data = buf.getvalue()
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


def frame_diff_score(prev, curr, cfg: dict | None = None) -> float | None:
    """两帧平均像素差（灰度，缩放后）。无法计算返回 None。"""
    cfg = cfg or load_config()
    rw, rh = cfg.get("stuck", {}).get("resize", [320, 240])
    cv2 = _try_import("cv2")
    np = _try_import("numpy")
    if cv2 is not None and np is not None and hasattr(prev, "shape"):
        try:
            p = cv2.cvtColor(cv2.resize(prev, (rw, rh)), cv2.COLOR_BGR2GRAY)
            c = cv2.cvtColor(cv2.resize(curr, (rw, rh)), cv2.COLOR_BGR2GRAY)
            return float(np.mean(cv2.absdiff(p, c)))
        except Exception:
            return None
    # PIL 兜底：转灰度缩放后逐像素差（320x240≈7.7万像素，纯 Python 可接受）
    try:
        p = prev.convert("L").resize((rw, rh))
        c = curr.convert("L").resize((rw, rh))
        pa = p.tobytes()  # 灰度 L 模式：每字节 = 一个像素亮度（无 deprecate）
        ca = c.tobytes()
        n = len(pa)
        if n == 0:
            return None
        s = 0
        for a, b in zip(pa, ca):
            s += abs(a - b)
        return s / n
    except Exception:
        return None


def is_stuck(prev, curr, cfg: dict | None = None) -> bool:
    if prev is None or curr is None:
        return False
    cfg = cfg or load_config()
    thr = float(cfg.get("stuck", {}).get("diff_threshold", 1.5))
    score = frame_diff_score(prev, curr, cfg)
    if score is None:
        return False  # 算不出差异 → 保守视为没卡死，避免误判停摆
    return score < thr


# ============================================================
# 输入法：ImmAssociateContext 脱挂 IME（经验 2134265：显式 argtypes/restype + 状态机）
# ============================================================
def _setup_ime_api():
    """(懒加载) 声明 WinAPI 签名，64 位下防指针截断。返回 (user32, imm32) 或 (None,None)。"""
    if os.name != "nt":
        return None, None
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    imm32 = ctypes.windll.imm32
    try:
        user32.GetForegroundWindow.restype = wintypes.HWND
        imm32.ImmAssociateContext.argtypes = [wintypes.HWND, ctypes.c_void_p]
        imm32.ImmAssociateContext.restype = ctypes.c_void_p
    except Exception:
        pass
    return user32, imm32


def foreground_hwnd() -> int:
    user32, _ = _setup_ime_api()
    if user32 is None:
        return 0
    try:
        return int(user32.GetForegroundWindow() or 0)
    except Exception:
        return 0


def disable_ime(hwnd: int | None = None) -> bool:
    """把目标窗口的 IME 脱挂，WASD 不再变成拼音。best-effort，永不抛异常。

    返回是否成功拿到可恢复的原上下文（仅用于 restore_ime 的状态机判断，
    绝不靠 API 返回 None 推断『已禁用』——见经验 2134265）。
    """
    user32, imm32 = _setup_ime_api()
    if user32 is None:
        return False
    if hwnd is None:
        hwnd = foreground_hwnd()
    if not hwnd:
        return False
    captured = False
    orig_ctx = 0
    with _ime_lock:
        try:
            orig_ctx = imm32.ImmAssociateContext(hwnd, None) or 0
            captured = True  # 以自身调用路径为准，不以返回值推断
        except Exception:
            captured = False
        # 降级：顺便请求切到 en-US 键盘布局（0x04090409）
        try:
            user32.SendMessageW(hwnd, 0x0050, 0, 0x04090409)  # WM_INPUTLANGCHANGEREQUEST
        except Exception:
            pass
        _ime_state.update(captured=captured, orig_ctx=orig_ctx, hwnd=hwnd)
    return captured


def restore_ime() -> None:
    """恢复原 IME 上下文（best-effort）。未成功脱挂过则什么都不做。"""
    with _ime_lock:
        st = _ime_state
        if not st.get("captured") or not st.get("hwnd"):
            return
        _, imm32 = _setup_ime_api()
        try:
            if imm32 is not None:
                imm32.ImmAssociateContext(st["hwnd"], st.get("orig_ctx") or 0)
        except Exception:
            pass
        _ime_state.update(captured=False, orig_ctx=0, hwnd=0)


# ============================================================
# 按键输入（pydirectinput，绕过游戏引擎拦截）
# ============================================================
def _pdi():
    pdi = _try_import("pydirectinput")
    if pdi is None:
        return None
    try:
        pdi.PAUSE = 0  # 关闭库自带的按键后延时，由我们自己控时序
        pdi.FAILSAFE = False
    except Exception:
        pass
    return pdi


def press_key(key: str, duration: float = 0.2, cfg: dict | None = None) -> bool:
    cfg = cfg or load_config()
    disable_ime()  # 每次按键前都重置输入法（焦点可能切换）
    pdi = _pdi()
    if pdi is None:
        print("  [game_agent] 未安装 pydirectinput，跳过按键: %s" % key)
        return False
    try:
        pdi.keyDown(key)
        time.sleep(duration)
        pdi.keyUp(key)
        time.sleep(0.05)
        return True
    except Exception as e:
        print("  [game_agent] 按键失败 %s: %s" % (key, e))
        try:
            pdi.keyUp(key)
        except Exception:
            pass
        return False


def move_direction(direction: str, cfg: dict | None = None) -> bool:
    cfg = cfg or load_config()
    return press_key(direction, float(cfg["timing"]["move_duration_s"]), cfg)


def type_chat(text: str, cfg: dict | None = None) -> bool:
    cfg = cfg or load_config()
    disable_ime()
    pdi = _pdi()
    if pdi is None:
        print("  [game_agent] 未安装 pydirectinput，跳过打字")
        return False
    try:
        pdi.typewrite(text, interval=0.05)
        press_key("enter", float(cfg["timing"]["key_hold_s"]), cfg)
        return True
    except Exception as e:
        print("  [game_agent] 打字失败: %s" % e)
        return False


# ============================================================
# VLM 决策（截图 → base64 → 视觉大模型 → 解析动作 JSON）
# ============================================================
def _get_key(name: str) -> str:
    try:
        import key_vault
        return (key_vault.get_key(name) or "").strip()
    except Exception:
        return (os.environ.get(name) or "").strip()


def _http_json(url: str, data: dict, headers: dict, timeout: int) -> dict:
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        raise RuntimeError("HTTP %s %s" % (e.code, err_body[:500])) from None


def _build_vlm_messages(frame, game_name: str, rules: dict, recent: list[str], cfg: dict) -> tuple[list[dict], int]:
    """组装多模态 messages + 估算输入字符数（用于 llm_gate 预检）。"""
    img_b64 = _to_jpeg_base64(frame, cfg)
    specifics = rules.get("game_specifics", {}).get(game_name, "")
    history = "\n".join("- %s" % x for x in recent[-6:]) or "（无）"
    user_text = (
        f"你正在玩《{game_name}》。下面是当前游戏画面截图。\n"
        f"【防卡死规矩】{rules.get('safety_rule','')}\n"
        f"【自救策略】{rules.get('anti_stuck_strategy','')}\n"
        + (f"【本游戏技巧】{specifics}\n" if specifics else "")
        + f"【最近几步结果】\n{history}\n\n"
        "请只输出一个 JSON 对象，不要任何多余文字，字段：\n"
        '{"action":"move|interact|attack|chat|escape|wait|stop",'
        '"payload":"方向/按键/聊天内容（move 用 w/a/s/d）","reason":"简短原因"}\n'
        "不确定就 wait；要结束游戏就 stop。"
    )
    content = [{"type": "text", "text": user_text},
               {"type": "image_url", "image_url": {"url": img_b64}}]
    messages = [{"role": "user", "content": content}]
    # 估算字符：文本 + 图片 base64 长度按 1/80 折算成等价字符（粗估）
    est_chars = len(user_text) + len(img_b64) // 80 + 50
    return messages, est_chars


def _parse_action(text: str) -> dict:
    """从 VLM 输出里宽松解析 JSON 动作。"""
    if not text:
        return {"action": "wait", "reason": "VLM 空回复"}
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return {"action": "wait", "reason": "VLM 未返回 JSON: " + text[:80]}
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return {"action": "wait", "reason": "VLM JSON 解析失败"}
    action = str(obj.get("action", "wait")).lower()
    if action not in _VALID_ACTIONS:
        action = "wait"
    payload = obj.get("payload", "")
    if action == "move" and str(payload).lower() not in _MOVE_KEYS:
        # move 但 payload 非法 → 降级为 wait，避免按错键
        return {"action": "wait", "reason": "非法方向: %s" % payload}
    return {"action": action, "payload": str(payload)[:200],
            "reason": str(obj.get("reason", ""))[:120]}


def vlm_decide(frame, game_name: str, recent: list[str],
               cfg: dict | None = None) -> dict:
    """截图已就绪的前提下，问 VLM 下一步做什么。返回动作 dict。

    预算超限 → {"action":"stop","reason":"budget"}；
    无可用 key/网络 → {"action":"wait","reason":...}。
    """
    cfg = cfg or load_config()
    rules = cfg.get("game_rules", {})
    try:
        messages, est_chars = _build_vlm_messages(frame, game_name, rules, recent, cfg)
    except Exception as e:
        return {"action": "wait", "reason": "帧编码失败: %s" % e}

    # llm_gate 预检（game_agent 场景）
    try:
        import llm_gate
        llm_gate.allow("game_agent", llm_gate.est_tokens(est_chars))
    except Exception as e:  # GateError 或 llm_gate 不可用
        return {"action": "stop", "reason": "budget: %s" % e}

    vcfg = cfg["vlm"]
    order = [vcfg.get("primary", "glm")]
    for p in vcfg.get("providers", {}):
        if p not in order:
            order.append(p)
    tried, no_key = [], []
    for name in order:
        pc = (vcfg.get("providers", {}) or {}).get(name) or {}
        if not pc.get("enabled"):
            continue
        key = _get_key(pc.get("key", ""))
        if not key:
            no_key.append(name)
            continue
        try:
            resp = _http_json(
                pc["base"].rstrip("/") + "/chat/completions",
                {"model": pc["model"], "messages": messages,
                 "temperature": float(vcfg.get("temperature", 0.3)),
                 "max_tokens": int(vcfg.get("max_tokens", 300))},
                {"Content-Type": "application/json",
                 "Authorization": "Bearer %s" % key},
                int(vcfg.get("timeout", 30)))
        except Exception as e:
            print("  [game_agent] VLM %s 失败: %s" % (name, e))
            tried.append(name)
            continue
        text = (((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
        # 记账（game_agent 场景；图片 token 折算已含在 est_chars 粗估里）
        try:
            import llm_gate
            llm_gate.record("game_agent", est_chars, len(text), provider=name)
        except Exception:
            pass
        return _parse_action(text)
    if no_key and not tried:
        return {"action": "stop",
                "reason": "no_key: 视觉模型未配置 key (%s)，请在 key_vault 配置 %s"
                % (",".join(no_key), "/".join(no_key))}
    return {"action": "wait", "reason": "vlm_down: %s" % ",".join(tried)}


# ============================================================
# 宏观规划：VLM 只挑「下一个宏」，具体按键写死在宏里（降本 + 更精准）
# 每个宏只调用 1 次 VLM（而不是每步 1 次），卡死走硬编码脱困不让 VLM 瞎按。
# 原 loop 微观模式保持不变，loop-macro 是新增的宏观模式，向后兼容。
# ============================================================
DEFAULT_MACROS = {
    "StardewValley": [
        {"name": "leave_house", "desc": "下床走出房屋到户外",
         "steps": [{"op": "move", "payload": "s", "dur": 1.2},
                   {"op": "move", "payload": "s", "dur": 1.2},
                   {"op": "key", "payload": "enter", "dur": 0.3},
                   {"op": "wait", "payload": 1.0}]},
        {"name": "water_crops", "desc": "走到农田给作物浇水",
         "steps": [{"op": "move", "payload": "s", "dur": 2.0},
                   {"op": "key", "payload": "e", "dur": 0.3},
                   {"op": "move", "payload": "a", "dur": 0.6},
                   {"op": "key", "payload": "e", "dur": 0.3},
                   {"op": "move", "payload": "a", "dur": 0.6},
                   {"op": "key", "payload": "e", "dur": 0.3}]},
        {"name": "forage", "desc": "在地图上走动并采集",
         "steps": [{"op": "move", "payload": "d", "dur": 1.5},
                   {"op": "move", "payload": "w", "dur": 1.0},
                   {"op": "key", "payload": "e", "dur": 0.3},
                   {"op": "move", "payload": "d", "dur": 1.5},
                   {"op": "key", "payload": "e", "dur": 0.3}]},
        {"name": "return_sleep", "desc": "回家上床睡觉结束一天",
         "steps": [{"op": "move", "payload": "w", "dur": 1.2},
                   {"op": "move", "payload": "w", "dur": 1.2},
                   {"op": "key", "payload": "enter", "dur": 0.3},
                   {"op": "wait", "payload": 1.0},
                   {"op": "move", "payload": "w", "dur": 0.8},
                   {"op": "key", "payload": "e", "dur": 0.3}]},
    ],
}


def _macros_for(game_name: str, cfg: dict) -> list:
    """优先用配置里的 macros.<game>，没有则用内置 DEFAULT_MACROS。"""
    return (cfg.get("macros") or {}).get(game_name) or DEFAULT_MACROS.get(game_name) or []


def vlm_plan_macro(frame, game_name: str, macros: list, recent: list[str],
                   cfg: dict | None = None) -> dict:
    """每个宏只问一次 VLM：下一个该跑哪个宏。返回 {"macro": name, "reason"}；
    失败或选了非法名字 → {"macro": None}，调用方走顺序兜底。"""
    cfg = cfg or load_config()
    if not macros:
        return {"macro": None}
    try:
        img_b64 = _to_jpeg_base64(frame, cfg)
    except Exception as e:
        return {"macro": None, "reason": "帧编码失败: %s" % e}
    menu = "\n".join("- %s：%s" % (m["name"], m.get("desc", "")) for m in macros)
    history = "\n".join("- %s" % x for x in recent[-4:]) or "（无）"
    user_text = (
        f"你正在玩《{game_name}》，下面是当前画面。\n"
        f"你只能从下面的「宏观行动」里选一个执行（不要想具体按键，那由代码写死）：\n{menu}\n"
        f"【最近执行】\n{history}\n\n"
        "只输出一个 JSON 对象，不要任何多余文字："
        '{"macro":"上面列表里的某个名字","reason":"简短原因"}\n'
        "不确定就选列表第一个。"
    )
    est_chars = len(user_text) + len(img_b64) // 80 + 50
    try:
        import llm_gate
        llm_gate.allow("game_agent", llm_gate.est_tokens(est_chars))
    except Exception:
        return {"macro": None}
    vcfg = cfg["vlm"]
    order = [vcfg.get("primary", "glm")]
    for p in vcfg.get("providers", {}):
        if p not in order:
            order.append(p)
    names = {m["name"] for m in macros}
    for name in order:
        pc = (vcfg.get("providers", {}) or {}).get(name) or {}
        if not pc.get("enabled"):
            continue
        key = _get_key(pc.get("key", ""))
        if not key:
            continue
        try:
            resp = _http_json(
                pc["base"].rstrip("/") + "/chat/completions",
                {"model": pc["model"],
                 "messages": [{"role": "user", "content": [
                     {"type": "text", "text": user_text},
                     {"type": "image_url", "image_url": {"url": img_b64}}]}],
                 "temperature": float(vcfg.get("temperature", 0.3)),
                 "max_tokens": 80},
                {"Content-Type": "application/json",
                 "Authorization": "Bearer %s" % key},
                int(vcfg.get("timeout", 30)))
        except Exception:
            continue
        text = (((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
        try:
            import llm_gate
            llm_gate.record("game_agent", est_chars, len(text), provider=name)
        except Exception:
            pass
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                obj = json.loads(m.group(0))
                pick = str(obj.get("macro", "")).strip()
                if pick in names:
                    return {"macro": pick, "reason": str(obj.get("reason", ""))[:100]}
            except Exception:
                pass
        return {"macro": None}  # VLM 回了但没选合法项 → 顺序兜底，不再试别的 provider
    return {"macro": None}


# ============================================================
# GameAgent：决策执行闭环（微观模式，每步 VLM 决策）
# ============================================================
class GameAgent:
    def __init__(self, game_name: str = "StardewValley", tts=None,
                 on_event=None, cfg: dict | None = None):
        self.game_name = game_name
        self.cfg = cfg or load_config()
        self.tts = tts or (lambda t: None)
        self.on_event = on_event or (lambda **k: None)
        self.stuck_count = 0
        self.last_frame = None
        self.recent: list[str] = []
        self._last_vlm_ts = 0.0
        self._vlm_calls = 0
        self._session_start = 0.0
        self._lock = threading.Lock()

    # ---- 单步动作（蓝图 execute_action 契约）----
    def execute_action(self, action_type: str, payload: str = "") -> str:
        action_type = (action_type or "").lower()
        before = get_screen_frame(self.cfg)
        ok = False
        if action_type == "move":
            ok = move_direction(str(payload).lower(), self.cfg)
        elif action_type in ("interact", "attack"):
            ok = press_key(str(payload).lower(),
                           float(self.cfg["timing"]["key_hold_s"]), self.cfg)
        elif action_type == "chat":
            ok = type_chat(str(payload), self.cfg)
        elif action_type == "escape":
            ok = self.emergency_escape().startswith("已执行")
        elif action_type in ("wait", "stop"):
            ok = True  # 无需按键
        else:
            return "未知动作: %s" % action_type

        time.sleep(float(self.cfg["timing"]["post_action_settle_s"]))
        after = get_screen_frame(self.cfg)
        # wait/stop 不做帧差判定（没移动画面不变是正常的）
        if action_type in ("wait", "stop"):
            self.stuck_count = 0
            return "动作执行成功"
        if is_stuck(before, after, self.cfg):
            self.stuck_count += 1
            self._publish("stuck", action=action_type, payload=payload)
            self._maybe_complain()
            return "警告：画面未发生变化，你大概率卡住了。连续卡死次数：%d" % self.stuck_count
        self.stuck_count = 0
        self._publish("ok", action=action_type, payload=payload)
        return "动作执行成功，画面已更新"

    def _publish(self, kind: str, action: str = "", payload: str = "") -> None:
        """推游戏事件到事件总线（game_context），best-effort，失败不影响游戏。"""
        try:
            import game_context
            game_context.publish_game_event(
                kind, game=self.game_name, action=action, payload=payload)
        except Exception:
            pass

    def emergency_escape(self) -> str:
        disable_ime()
        pdi = _pdi()
        if pdi is None:
            return "未安装 pydirectinput，无法执行脱困按键"
        try:
            pdi.keyDown("s"); time.sleep(1); pdi.keyUp("s")
            press_key("space", 0.2, self.cfg)
            press_key("esc", 0.2, self.cfg)
            self.stuck_count = 0
            self._publish("ok", action="escape")  # 脱困后视为恢复
            return "已执行紧急脱困动作"
        except Exception as e:
            return "紧急脱困失败: %s" % e

    def _maybe_complain(self) -> None:
        thr = int(self.cfg.get("stuck", {}).get("escape_after", 3))
        if self.stuck_count < thr:
            return
        lines = self.cfg.get("game_rules", {}).get("stuck_lines", [])
        line = random.choice(lines) if lines else "哎呀，我卡住了！"
        try:
            self.tts(line)
        except Exception:
            pass
        self.on_event(type="stuck", game=self.game_name, count=self.stuck_count, line=line)
        # 触发一次自救（蓝图：卡死 → emergency_escape）
        try:
            self.emergency_escape()
        except Exception:
            pass

    # ---- 决策 ----
    def decide(self) -> dict:
        """截图 → 限频 → VLM 决策。"""
        frame = get_screen_frame(self.cfg)
        if frame is None:
            return {"action": "wait", "reason": "截屏失败"}
        now = time.monotonic()
        interval = float(self.cfg["timing"]["min_vlm_interval_s"])
        if now - self._last_vlm_ts < interval:
            return {"action": "wait", "reason": "vlm_rate_limit"}
        self._last_vlm_ts = now
        self._vlm_calls += 1
        action = vlm_decide(frame, self.game_name, self.recent, self.cfg)
        self.last_frame = frame
        return action

    def step(self) -> bool:
        """一次循环：决策 → 执行 → 记录。返回 False 表示应停止。"""
        if play_budget_left(self.cfg) <= 0:
            print("  [game_agent] 今日游玩预算已用尽，停止。")
            return False
        action = self.decide()
        if action["action"] == "stop":
            print("  [game_agent] VLM 要求停止: %s" % action.get("reason"))
            return False
        result = self.execute_action(action["action"], action.get("payload", ""))
        self.recent.append("%s %s → %s" % (action["action"], action.get("payload", ""), result))
        if len(self.recent) > 20:
            self.recent.pop(0)
        print("  [game_agent] %s %s | %s" % (
            action["action"], action.get("payload", ""), result))
        return True

    def run_loop(self, max_steps: int | None = None) -> None:
        self._session_start = time.time()
        self._vlm_calls = 0
        disable_ime()
        print("🎮 开始玩《%s》（Ctrl+C 停止）" % self.game_name)
        steps = 0
        try:
            while True:
                if max_steps is not None and steps >= max_steps:
                    break
                if not self.step():
                    break
                steps += 1
                time.sleep(float(self.cfg["timing"]["loop_idle_s"]))
        except KeyboardInterrupt:
            print("\n  [game_agent] 手动停止。")
        finally:
            elapsed = time.time() - self._session_start
            _record_session(self.game_name, elapsed, self._vlm_calls)
            restore_ime()
            self._publish("stop")  # 结束游戏：清空共享状态，人格停止注入"卡住了"
            print("  [game_agent] 本局 %.0f 秒，VLM 调用 %d 次。" % (elapsed, self._vlm_calls))


# ============================================================
# MacroPlanner：宏观模式（VLM 只挑「下一个宏」，按键写死在宏里）
# 相比微观 loop：VLM 调用从「每步 1 次」降到「每宏 1 次」，省 token；
# 卡死走硬编码 escape_walk 脱困，不让 VLM 瞎按。人格破防联动照常
# （execute_action 已 publish stuck/ok 到 game_context）。
# ============================================================
class MacroPlanner:
    def __init__(self, game_name: str = "StardewValley", tts=None,
                 on_event=None, cfg: dict | None = None):
        self.game_name = game_name
        self.cfg = cfg or load_config()
        self.agent = GameAgent(game_name, tts=tts, on_event=on_event, cfg=self.cfg)
        self.macros = _macros_for(game_name, self.cfg)
        self.idx = 0
        self.recent: list[str] = []
        self._vlm_calls = 0
        self._session_start = 0.0

    # ---- 硬编码脱困：不调 VLM，确定性按键 ----
    def escape_walk(self) -> str:
        disable_ime()
        pdi = _pdi()
        try:
            if pdi is not None:
                for k, dur in (("s", 0.8), ("a", 0.6), ("d", 0.6)):
                    pdi.keyDown(k); time.sleep(dur); pdi.keyUp(k)
            press_key("space", 0.2, self.cfg)
            press_key("esc", 0.2, self.cfg)
            self.agent.stuck_count = 0
            self.agent._publish("ok", action="escape_walk")
            return "已执行宏观脱困（硬编码按键，未调 VLM）"
        except Exception as e:
            return "宏观脱困失败: %s" % e

    # ---- 跑一个宏：遍历 steps，逐步调 execute_action（带帧差卡死检测）----
    def run_macro(self, macro: dict) -> None:
        name = macro.get("name", "?")
        desc = macro.get("desc", "")
        steps = macro.get("steps", []) or []
        print("  [macro] ▶ %s（%s）共 %d 步" % (name, desc, len(steps)))
        stuck_streak = 0
        thr = int(self.cfg.get("stuck", {}).get("escape_after", 3))
        for i, step in enumerate(steps, 1):
            op = str(step.get("op", "")).lower()
            payload = step.get("payload", "")
            if op == "wait":
                try:
                    time.sleep(float(payload))
                except Exception:
                    time.sleep(1.0)
                print("    [macro] %d/%d wait %ss" % (i, len(steps), payload))
                continue
            # move / key 走 execute_action：拿到帧差卡死检测 + 事件发布
            action_type = "move" if op == "move" else "interact"
            result = self.agent.execute_action(action_type, str(payload))
            print("    [macro] %d/%d %s %s | %s" % (i, len(steps), op, payload, result))
            if "画面未发生变化" in result:
                stuck_streak += 1
                if stuck_streak >= thr:
                    print("    [macro] 连续卡死 %d 次，触发硬编码脱困并中断本宏。" % thr)
                    self.escape_walk()
                    break
            else:
                stuck_streak = 0
        self.recent.append(name)
        if len(self.recent) > 12:
            self.recent.pop(0)
        self.agent._publish("ok", action="macro_done", payload=name)
        print("  [macro] ✓ %s 完成" % name)

    # ---- 选下一个宏：优先 VLM，失败/非法 → 顺序兜底 ----
    def pick_next(self) -> dict | None:
        if not self.macros:
            return None
        frame = get_screen_frame(self.cfg)
        plan = {"macro": None}
        if frame is not None:
            plan = vlm_plan_macro(frame, self.game_name, self.macros,
                                   self.recent, self.cfg)
            self._vlm_calls += 1
        pick = plan.get("macro")
        if pick:
            for m in self.macros:
                if m.get("name") == pick:
                    print("  [macro] VLM 选中: %s（%s）" % (pick, plan.get("reason", "")))
                    return m
            print("  [macro] VLM 选了非法宏名 %r，走顺序兜底。" % pick)
        # 顺序兜底：保证不卡住不动
        fallback = self.macros[self.idx % len(self.macros)]
        print("  [macro] 顺序兜底: %s" % fallback.get("name"))
        return fallback

    def run_loop(self, max_macros: int | None = None) -> None:
        if not self.macros:
            print("❌ 游戏《%s》没有可用宏（配置 macros.%s 或内置 DEFAULT_MACROS 均为空）。"
                  % (self.game_name, self.game_name))
            return
        self._session_start = time.time()
        self._vlm_calls = 0
        disable_ime()
        print("🎮 开始玩《%s》（宏观模式，Ctrl+C 停止）" % self.game_name)
        print("  宏列表: %s" % "、".join(m["name"] for m in self.macros))
        ran = 0
        try:
            while True:
                if max_macros is not None and ran >= max_macros:
                    break
                if play_budget_left(self.cfg) <= 0:
                    print("  [macro] 今日游玩预算已用尽，停止。")
                    break
                macro = self.pick_next()
                if macro is None:
                    break
                self.run_macro(macro)
                self.idx += 1
                ran += 1
                time.sleep(float(self.cfg["timing"].get("loop_idle_s", 1.0)))
        except KeyboardInterrupt:
            print("\n  [macro] 手动停止。")
        finally:
            elapsed = time.time() - self._session_start
            _record_session(self.game_name, elapsed, self._vlm_calls)
            restore_ime()
            self.agent._publish("stop")
            print("  [macro] 本局 %.0f 秒，执行 %d 个宏，VLM 调用 %d 次。"
                  % (elapsed, ran, self._vlm_calls))


# ============================================================
# CLI
# ============================================================
def _doctor() -> int:
    print("=== 依赖 ===")
    rep = dependency_report()
    need = []
    for k, v in rep.items():
        print("  %-14s %s" % (k, "✅" if v else "❌"))
    if not rep["pydirectinput"]:
        need.append("pydirectinput")
    if not (rep["mss"] and rep["opencv"] and rep["numpy"]):
        print("  （截屏/帧差将用 PIL 兜底，速度较慢；建议装 mss opencv-python numpy）")
        if not rep["PIL"]:
            need.append("Pillow")
    if need:
        print("\n缺少关键依赖，安装命令：")
        print("  pip install %s" % " ".join(need))
    print("\n=== Key ===")
    cfg = load_config()
    for name, pc in cfg["vlm"]["providers"].items():
        if not pc.get("enabled"):
            continue
        k = _get_key(pc.get("key", ""))
        print("  %-6s %-16s %s" % (name, pc.get("key", ""), "✅" if k else "❌ 未配置"))
    print("\n=== 预算 ===")
    left = play_budget_left(cfg)
    print("  今日剩余可玩: %.0f 分钟" % (left / 60))
    print("\n=== 规则文件 ===")
    print("  %s" % CONFIG_FILE)
    return 0 if not need else 2


def _probe() -> int:
    cfg = load_config()
    print("截屏中（%s 路径）…" % ("mss+cv2" if (have_mss() and have_cv()) else "PIL 兜底"))
    f1 = get_screen_frame(cfg)
    if f1 is None:
        print("❌ 截屏失败"); return 2
    shape = getattr(f1, "shape", None)
    size = getattr(f1, "size", None)
    print("✅ 捕获帧: shape=%s size=%s type=%s" % (shape, size, type(f1).__name__))
    # 同帧对比 → 应判定卡死（diff≈0）
    stuck_same = is_stuck(f1, f1, cfg)
    print("  同帧帧差 is_stuck = %s（预期 True，验证帧差链路通）" % stuck_same)
    score_same = frame_diff_score(f1, f1, cfg)
    print("  同帧 diff_score = %s" % score_same)
    # base64 编码（不触网）
    try:
        b64 = _to_jpeg_base64(f1, cfg)
        print("✅ base64 编码: %d 字符，前缀 %s" % (len(b64), b64[:30]))
    except Exception as e:
        print("❌ base64 编码失败: %s" % e); return 2
    # 决策消息组装（不发请求）
    try:
        msgs, est = _build_vlm_messages(f1, "StardewValley", cfg["game_rules"],
                                        ["move w → 画面已更新"], cfg)
        print("✅ VLM 消息组装: est_chars≈%d, 含 image_url=%s" %
              (est, any(c.get("type") == "image_url" for c in msgs[0]["content"])))
    except Exception as e:
        print("❌ VLM 消息组装失败: %s" % e); return 2
    print("\nprobe 通过：截屏→帧差→base64→VLM载荷 链路正常（未触网、未按键）。")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "doctor":
        return _doctor()
    if cmd == "probe":
        return _probe()
    if cmd == "rules":
        print(json.dumps(load_config()["game_rules"], ensure_ascii=False, indent=2))
        return 0
    if cmd == "stats":
        cfg = load_config()
        print(json.dumps({
            "today_play_seconds": round(today_play_seconds(), 1),
            "today_play_minutes": round(today_play_seconds() / 60, 1),
            "budget_left_minutes": round(play_budget_left(cfg) / 60, 1),
        }, ensure_ascii=False, indent=2))
        return 0
    if cmd == "loop":
        game = argv[2] if len(argv) >= 3 else "StardewValley"
        max_steps = None
        if "--max-steps" in argv:
            i = argv.index("--max-steps")
            max_steps = int(argv[i + 1])
        ga = GameAgent(game)
        ga.run_loop(max_steps=max_steps)
        return 0
    if cmd == "macros":
        game = argv[2] if len(argv) >= 3 else "StardewValley"
        print(json.dumps(_macros_for(game, load_config()), ensure_ascii=False, indent=2))
        return 0
    if cmd == "loop-macro":
        game = argv[2] if len(argv) >= 3 else "StardewValley"
        max_macros = None
        if "--max-macros" in argv:
            i = argv.index("--max-macros")
            max_macros = int(argv[i + 1])
        mp = MacroPlanner(game)
        mp.run_loop(max_macros=max_macros)
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
