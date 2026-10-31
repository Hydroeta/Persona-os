# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""小鲸鱼 · 读屏陪伴模式（默认关闭 · 本地处理 · 可见指示 · 一键全停）

定位是「她偶尔抬头看你一眼，说一句合适的话」，不是屏幕监控。四条硬约束：
  1. 默认关闭；开启必须显式确认（enable --yes / 控制台二次确认）
  2. 常驻可见指示（小眼睛窗口，不可隐藏；暂停也显示「已暂停」）
  3. 全局快捷键 Ctrl+Alt+P 一键暂停，暂停后立即停止捕获
  4. 画面不出内存、不落盘；OCR 本地做；日志只留事件摘要，不留原文

链路：
    前台窗口(进程名+标题) → 是否需要看(白/黑名单) → 稀疏采样(默认 4s) →
    帧差(哈希) → 本地 Windows OCR → 事件抽象(写代码/浏览/聊天/会议...) →
    规则判要不要说 → 状态引擎+预算闸 → 气泡(TTS 留给后续)

CLI：
    python tools/screen_buddy.py status
    python tools/screen_buddy.py enable --yes
    python tools/screen_buddy.py disable
    python tools/screen_buddy.py run            # 起一个带指示窗的常驻实例
    python tools/screen_buddy.py once           # 只采一次并打印抽象结果（调试）
"""
from __future__ import annotations

import ctypes
import json
import os
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "config" / "screen_buddy.json"
AUDIT_FILE = ROOT / "logs" / "screen_audit.jsonl"
SAY_LOG = ROOT / "logs" / "screen_says.jsonl"

DEFAULT = {
    "enabled": False,
    "mode": "companion",              # companion 安静偶尔点评 / narrator 更活跃
    "interval_sec": 4,
    "max_say_per_10min": 1,
    "retention_days": 7,
    "ocr": True,
    "allow_image_upload": False,      # 原图外发：恒为 false 才符合当前隐私承诺
    "whitelist": [],                  # 空 = 不限；填写后只在这些进程里看
    "blacklist": ["keepass", "1password", "bitwarden", "lastpass", "authenticator",
                  "bank", "alipay", "wallet", "wechat", "weixin", "qq", "telegram",
                  "discord", "slack", "teams"],
    "hotkey": "ctrl+alt+p",
}

ERROR_WORDS = ("error", "traceback", "exception", "报错", "失败", "无法", "崩溃")

# 事件 → 台词模板（规则优先，零 LLM 成本；narrator 模式才走模型）
LINES = {
    "coding": ["又在写代码呀，我陪你一会儿", "这段看着有点费劲，慢慢来",
               "敲这么久键盘，手不酸吗"],
    "coding_error": ["报错了？先深呼吸，别急", "这个红色的字看着好凶",
                     "要不要我帮你看看日志"],
    "browsing": ["在翻什么呢，看到好玩的记得讲给我听", "网页开这么多，别迷路啦"],
    "video": ["在看视频呀，那我不吵你", "看到好笑的可以笑出声，不用憋着"],
    "meeting": ["在开会吧，我先安静", "会开完了记得喝水"],
    "gaming": ["玩得开心点，输了也别生气", "打游戏的时候我就看着不说话"],
    "writing": ["写得挺顺的嘛", "慢慢写，我在"],
    "other": ["在忙呀，我在旁边", "要不要歇一会儿"],
    "long_focus": ["已经专注好久了，起来动一下吧", "坐这么久，腰会抗议的"],
    "rest": ["很晚啦，早点睡好不好", "眼睛该休息了，真的"],
}


# ---------- 配置 ----------

def load_config() -> dict:
    try:
        d = json.loads(CONFIG_FILE.read_text("utf-8"))
    except Exception:
        d = {}
    cfg = dict(DEFAULT)
    cfg.update({k: v for k, v in d.items() if k in DEFAULT})
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_FILE.parent.mkdir(exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")


def _audit(action: str, **fields) -> None:
    try:
        AUDIT_FILE.parent.mkdir(exist_ok=True)
        with open(AUDIT_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": round(time.time(), 1), "action": action, **fields},
                               ensure_ascii=False) + "\n")
    except OSError:
        pass


def _prune_audit(days: int) -> None:
    """审计只留 N 天（音频/摘要级隐私），但 forget 类审计由 memory_bus 单独保管。"""
    if not AUDIT_FILE.is_file():
        return
    cut = time.time() - days * 86400
    try:
        lines = AUDIT_FILE.read_text("utf-8").splitlines()
        keep = []
        for ln in lines:
            try:
                if json.loads(ln).get("ts", 0) >= cut:
                    keep.append(ln)
            except Exception:
                continue
        AUDIT_FILE.write_text("\n".join(keep) + ("\n" if keep else ""), "utf-8")
    except OSError:
        pass


# ---------- 前台窗口 ----------

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
gdi32 = ctypes.windll.gdi32


def foreground() -> tuple[str, str]:
    """(进程名, 窗口标题)，都转小写，取不到给空串。"""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return "", ""
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    title = buf.value or ""
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    proc = ""
    h = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if h:
        try:
            size = wintypes.DWORD(1024)
            pbuf = ctypes.create_unicode_buffer(1024)
            if kernel32.QueryFullProcessImageNameW(h, 0, pbuf, ctypes.byref(size)):
                proc = os.path.basename(pbuf.value)
        finally:
            kernel32.CloseHandle(h)
    return proc.lower(), title


def classify(proc: str, title: str) -> str:
    p = (proc or "").lower()
    if any(k in p for k in ("code", "devenv", "pycharm", "idea64", "sublime",
                            "cursor", "vim", "windowsterminal", "powershell", "wt.exe")):
        return "coding"
    if any(k in p for k in ("chrome", "msedge", "firefox", "brave")):
        return "browsing"
    if any(k in p for k in ("potplayer", "vlc", "mpv", "bilibili", "iqiyi")):
        return "video"
    if any(k in p for k in ("zoom", "teams", "wemeet", "dingtalk", "meeting")):
        return "meeting"
    if any(k in p for k in ("steam", "game", "riot", "genshin")):
        return "gaming"
    if any(k in p for k in ("winword", "excel", "powerpnt", "notion", "obsidian",
                            "typora", "onenote")):
        return "writing"
    return "other"


def allowed(cfg: dict, proc: str) -> bool:
    """白名单优先为空则放行；黑名单永远优先拦截。"""
    if not proc:
        return False
    bl = [x.lower() for x in cfg.get("blacklist", [])]
    if any(x in proc for x in bl):
        return False
    wl = [x.lower() for x in cfg.get("whitelist", [])]
    if wl and not any(x in proc for x in wl):
        return False
    return True


# ---------- 截图（纯 ctypes，不出内存） ----------

class _BMPHDR(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


def capture_bmp(max_width: int = 1280) -> tuple[bytes, int, int]:
    """抓主屏并等比缩到 max_width，返回 BMP 字节（只在内存里）。"""
    sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    dw = min(max_width, sw)
    dh = max(1, int(sh * dw / max(1, sw)))
    hdc = user32.GetDC(0)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, dw, dh)
    old = gdi32.SelectObject(mem, bmp)
    gdi32.SetStretchBltMode(mem, 4)  # HALFTONE
    gdi32.StretchBlt(mem, 0, 0, dw, dh, hdc, 0, 0, sw, sh, 0x00CC0020)
    info = _BMPHDR(ctypes.sizeof(_BMPHDR), dw, -dh, 1, 32, 0, dw * dh * 4, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(dw * dh * 4)
    gdi32.GetDIBits(mem, bmp, 0, dh, buf, ctypes.byref(info), 0)
    gdi32.SelectObject(mem, old)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(0, hdc)
    import struct
    off = 14 + ctypes.sizeof(_BMPHDR)
    head = struct.pack("<2sIHHI", b"BM", off + len(buf), 0, 0, off)
    ih = struct.pack("<IiiHHIIiiII", 40, dw, -dh, 1, 32, 0, len(buf), 0, 0, 0, 0)
    return head + ih + buf.raw, dw, dh


# ---------- 本地 OCR（Windows.Media.Ocr） ----------

_ENGINE = None
_OCR_LOCK = threading.Lock()


def ocr_available() -> bool:
    try:
        import winrt.windows.media.ocr  # noqa: F401
        return True
    except Exception:
        return False


def _engine():
    global _ENGINE
    if _ENGINE is not None:
        return _ENGINE
    from winrt.windows.globalization import Language
    from winrt.windows.media.ocr import OcrEngine
    for lang in ("zh-Hans", "zh-CN", "en-US"):
        try:
            e = OcrEngine.try_create_from_language(Language(lang))
            if e:
                _ENGINE = e
                return e
        except Exception:
            continue
    _ENGINE = OcrEngine.try_create_from_user_profile_languages()
    return _ENGINE


def ocr_bmp(bmp_bytes: bytes) -> str:
    """BMP → 文字。全部在内存流里，临时文件都不落。"""
    import asyncio
    from winrt.windows.graphics.imaging import BitmapDecoder
    from winrt.windows.storage.streams import DataWriter, InMemoryRandomAccessStream

    async def _run():
        stream = InMemoryRandomAccessStream()
        writer = DataWriter(stream.get_output_stream_at(0))
        writer.write_bytes(bmp_bytes)
        await writer.store_async()
        stream.seek(0)
        dec = await BitmapDecoder.create_async(stream)
        sb = await dec.get_software_bitmap_async()
        res = await _engine().recognize_async(sb)
        return (res.text or "")

    with _OCR_LOCK:
        return asyncio.run(_run())


# ---------- 采样与判定 ----------

class Sampler:
    """一次采样：窗口 → 是否允许 → 截图 → 帧差 → OCR → 事件。"""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.last_hash = 0
        self.last_activity = ""
        self.focus_since = time.time()
        self.last_say = 0.0
        self.say_times: list[float] = []
        self.paused = False

    def snapshot(self) -> dict:
        proc, title = foreground()
        ev = {"ts": round(time.time(), 1), "proc": proc, "title": title[:80]}
        if not allowed(self.cfg, proc):
            ev["skipped"] = "黑名单/白名单"
            return ev
        act = classify(proc, title)
        ev["activity"] = act
        text = ""
        if self.cfg.get("ocr") and ocr_available():
            try:
                bmp, _w, _h = capture_bmp()
                h = hash(bmp)
                if h == self.last_hash:
                    ev["skipped"] = "画面未变化"
                    return ev
                self.last_hash = h
                text = ocr_bmp(bmp)
            except Exception as e:  # noqa: BLE001
                ev["ocr_error"] = type(e).__name__
        low = (text or "").lower()
        if any(w in low for w in ERROR_WORDS):
            ev["activity"] = "coding_error" if act == "coding" else act + "_error"
        if act != self.last_activity:
            ev["changed"] = True
            self.focus_since = time.time()
            self.last_activity = act
            try:                        # 活动切换进事件流（梦境蒸馏/潜意识的食材）
                import timeline
                timeline.emit("activity", "screen_buddy",
                              activity=ev.get("activity", act), proc=proc)
            except Exception:
                pass
        ev["focus_min"] = round((time.time() - self.focus_since) / 60.0, 1)
        ev["chars"] = len(text)
        return ev

    def can_say(self) -> bool:
        now = time.time()
        self.say_times = [t for t in self.say_times if now - t < 600]
        cap = int(self.cfg.get("max_say_per_10min", 1))
        if len(self.say_times) >= cap:
            return False
        try:
            import state_engine
            if not state_engine.allow_voice():
                _audit("skip", reason="state")
                return False
        except Exception:
            pass
        return True

    def say(self, ev: dict) -> str:
        """规则挑一句；narrator 模式想更活可另接 LLM（当前保持零成本）。"""
        import random
        act = ev.get("activity") or "other"
        if act.endswith("_error"):
            key = "coding_error" if act.startswith("coding") else "other"
        elif ev.get("focus_min", 0) >= 45 and act in ("coding", "writing", "browsing"):
            key = "long_focus"
        else:
            key = act if act in LINES else "other"
        if not self.can_say():
            return ""
        line = random.choice(LINES[key])
        self.say_times.append(time.time())
        rec = {"ts": round(time.time(), 1), "activity": act, "line": line,
               "mode": self.cfg.get("mode"), "proc": ev.get("proc", "")}
        try:
            SAY_LOG.parent.mkdir(exist_ok=True)
            with open(SAY_LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            pass
        _audit("say", activity=act, chars=len(line))
        return line


# ---------- 指示窗 + 全局热键 ----------

def run_indicator(cfg: dict) -> int:
    import tkinter as tk

    sampler = Sampler(cfg)
    root = tk.Tk()
    root.title("小鲸鱼 · 读屏陪伴")
    root.attributes("-topmost", True)
    root.overrideredirect(True)
    root.geometry("+{}+{}".format(
        max(0, root.winfo_screenwidth() - 280), 12))

    def restyle(paused: bool) -> None:
        lab.config(text="⏸ 读屏已暂停（Ctrl+Alt+P 恢复）" if paused else
                   "👁 读屏陪伴中（Ctrl+Alt+P 暂停）", bg="#4a4a4a" if paused else "#1f6feb")

    lab = tk.Label(root, text="", fg="white", bg="#1f6feb", padx=10, pady=6,
                   font=("Microsoft YaHei", 9))
    lab.pack()
    line = tk.Label(root, text="", fg="#333", bg="#f5f5f5", padx=8, pady=4,
                    wraplength=240, justify="left", font=("Microsoft YaHei", 9))
    line.pack()
    restyle(False)

    # 全局热键：RegisterHotKey 的 WM_HOTKEY 投递到本线程消息队列
    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT = 0x1, 0x2, 0x4000
    user32.RegisterHotKey(None, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, ord("P"))

    def poll_hotkey():
        msg = wintypes.MSG()
        while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
            if msg.message == 0x0312:
                toggle_pause()
        root.after(200, poll_hotkey)

    def toggle_pause():
        sampler.paused = not sampler.paused
        restyle(sampler.paused)
        _audit("pause" if sampler.paused else "resume")
        if sampler.paused:
            line.config(text="")

    lab.bind("<Button-1>", lambda _e: toggle_pause())
    _audit("start", mode=cfg.get("mode"), ocr=ocr_available())
    _prune_audit(int(cfg.get("retention_days", 7)))

    def tick():
        if not sampler.paused:
            def work():
                ev = sampler.snapshot()
                if ev.get("skipped"):
                    _audit("skip", reason=ev["skipped"], proc=ev.get("proc", ""))
                    return
                _audit("sample", activity=ev.get("activity"), chars=ev.get("chars"),
                       focus_min=ev.get("focus_min"))
                # P2 关怀联动：有活动就记一次心跳（60s 节流；关怀模块挂了不影响读屏主线）
                now = time.time()
                if now - getattr(sampler, "_care_ts", 0.0) >= 60:
                    sampler._care_ts = now
                    try:
                        import care
                        care.note_activity(ev.get("activity") or "other")
                    except Exception:  # noqa: BLE001
                        pass
                if ev.get("changed") or ev.get("focus_min", 0) >= 45:
                    txt = sampler.say(ev)
                    if txt:
                        root.after(0, lambda: line.config(text=txt))
            threading.Thread(target=work, daemon=True).start()
        root.after(max(1500, int(cfg.get("interval_sec", 4) * 1000)), tick)

    root.after(1200, tick)
    root.after(200, poll_hotkey)

    def on_close():
        user32.UnregisterHotKey(None, 1)
        _audit("stop")
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    try:
        root.mainloop()
    finally:
        try:
            user32.UnregisterHotKey(None, 1)
        except Exception:
            pass
    return 0


# ---------- 状态 ----------

def status() -> dict:
    cfg = load_config()
    says = 0
    if SAY_LOG.is_file():
        cut = time.time() - 600
        try:
            for ln in SAY_LOG.read_text("utf-8").splitlines():
                try:
                    if json.loads(ln).get("ts", 0) >= cut:
                        says += 1
                except Exception:
                    continue
        except OSError:
            pass
    return {"enabled": cfg["enabled"], "mode": cfg["mode"],
            "interval_sec": cfg["interval_sec"],
            "max_say_per_10min": cfg["max_say_per_10min"],
            "says_last_10min": says, "ocr_available": ocr_available(),
            "allow_image_upload": False,
            "hotkey": "Ctrl+Alt+P", "whitelist": cfg["whitelist"],
            "blacklist": cfg["blacklist"]}


def _main(argv: list[str]) -> int:
    cfg = load_config()
    if not argv or argv[0] == "status":
        print(json.dumps(status(), ensure_ascii=False, indent=2))
    elif argv[0] == "enable":
        if "--yes" not in argv:
            print("她将能看到你的屏幕内容（默认只在内存处理、可随时 Ctrl+Alt+P 暂停）。"
                  "确认请加 --yes")
            return 1
        cfg["enabled"] = True
        save_config(cfg)
        _audit("enable")
        print(json.dumps(status(), ensure_ascii=False))
    elif argv[0] == "disable":
        cfg["enabled"] = False
        save_config(cfg)
        _audit("disable")
        print("已关闭读屏陪伴")
    elif argv[0] == "run":
        if not cfg["enabled"]:
            print("读屏陪伴当前是关闭的（默认关闭）。先 enable --yes")
            return 1
        return run_indicator(cfg)
    elif argv[0] == "once":
        s = Sampler(cfg)
        print(json.dumps(s.snapshot(), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
