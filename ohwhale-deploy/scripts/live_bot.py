"""直播 AI 副驾 — 抖音 + B 站通用

链路（两个平台一模一样，只换弹幕抓取层）：
    弹幕 WS → PlatformAdapter(统一输出 dict)
            → CommentFilter(去重/节流/挑选)
            → AstrBotBridge.chat()    # 走 DeepSeek + 小满人设
            → 本地 GPT-SoVITS /tts    # 流式合成
            → sounddevice 播到默认扬声器

用法：
    # 1) 先启动 AstrBot + GPT-SoVITS（双击 install\40_start_all.bat）
    # 2) config.json 里填好对应平台的 live_id/short_id
    # 3) 运行：
    python scripts/live_bot.py --platform douyin        # 抖音
    python scripts/live_bot.py --platform bilibili      # B 站
    python scripts/live_bot.py --platform bilibili --cid 12345  # 可选：直接给短号

config.json 配置（两套独立，互不干扰）：
    "douyin":  { "live_id": "261378947940", ... }
    "bilibili":{ "short_id": 123456, ... }
    共用字段：keywords_at_host / only_reply_questions / min_chars
              max_replies_per_10s / per_user_cooldown_s
              auto_fill / auto_fill_interval_s
"""

from __future__ import annotations

import argparse
import os
import queue
import re
import sys
import threading
import time
from abc import ABC, abstractmethod
from collections import deque
from pathlib import Path

# ---------- sys.path 修正 ----------
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
for _p in (_PROJECT_ROOT, _PROJECT_ROOT / "scripts"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

os.environ.setdefault("OHWHALE_HOME", str(_PROJECT_ROOT))
os.environ.pop("HTTP_PROXY", None)
os.environ.pop("HTTPS_PROXY", None)
os.environ.pop("http_proxy", None)
os.environ.pop("https_proxy", None)
os.environ["NO_PROXY"] = "127.0.0.1,localhost"

import httpx
import numpy as np
import sounddevice as sd

from ohwhale.config import get as cfg
from astrbot_bridge import AstrBotBridge

# ============================================================
# 工具：平台统一的弹幕 dict
# ============================================================
def _danmu_dict(platform: str, *, user_id: str, nick_name: str,
                content: str, pay_grade: int = 0,
                is_super: bool = False, is_gift: bool = False,
                gift_name: str = "", gift_num: int = 0) -> dict:
    """所有平台的弹幕事件进主循环前都归一化成这个格式。"""
    return {
        "platform": platform,
        "user_id": str(user_id),
        "nick_name": str(nick_name),
        "content": str(content).strip(),
        "pay_grade": {"level": int(pay_grade)},
        "is_super": bool(is_super),
        "is_gift": bool(is_gift),
        "gift_name": str(gift_name),
        "gift_num": int(gift_num),
    }


# ============================================================
# PlatformAdapter — 抽象基类
# ============================================================
class PlatformAdapter(ABC):
    name: str = "base"
    _queue: queue.Queue[dict]

    def set_queue(self, q: queue.Queue[dict]):
        self._queue = q

    def _put(self, msg: dict):
        try:
            self._queue.put_nowait(msg)
        except queue.Full:
            pass

    @abstractmethod
    def start(self) -> None: ...

    @abstractmethod
    def stop(self) -> None: ...

    @abstractmethod
    def describe(self) -> str: ...


# ------------------------------------------------------------
# 抖音适配
# ------------------------------------------------------------
class DouyinAdapter(PlatformAdapter):
    name = "抖音"

    def __init__(self, live_id: str):
        self.live_id = str(live_id).strip()
        self._fetcher = None

    def _on_chat(self, raw: dict):
        # DouyinLiveWebFetcher 的 chat_callback 已经给了标准化的 dict
        msg = _danmu_dict(
            "douyin",
            user_id=raw.get("user_id", ""),
            nick_name=raw.get("nick_name", ""),
            content=raw.get("content", ""),
            pay_grade=(raw.get("pay_grade") or {}).get("level", 0),
        )
        self._put(msg)

    def start(self):
        from douyin_live_chat import DouyinLiveWebFetcher
        self._fetcher = DouyinLiveWebFetcher(self.live_id, chat_callback=self._on_chat)
        self._thread = threading.Thread(target=self._fetcher.start,
                                        name="douyin-fetcher", daemon=True)
        self._thread.start()

    def stop(self):
        if self._fetcher:
            self._fetcher.stop()

    def describe(self) -> str:
        return f"抖音 https://live.douyin.com/{self.live_id}"


# ------------------------------------------------------------
# B 站适配
# ------------------------------------------------------------
class BilibiliAdapter(PlatformAdapter):
    name = "B 站"

    def __init__(self, short_id: int):
        self.short_id = int(short_id)
        self._live = None

    def start(self):
        from bilibili_live import BilibiliLive
        from bilibili_live.events.handler import BilibiliLiveEventHandler

        adapter = self  # 闭包捕获

        class _Handler(BilibiliLiveEventHandler):
            """把 B 站事件转成统一 dict 塞队列。"""

            def onDanmu(self, event):
                d = event.data
                adapter._put(_danmu_dict(
                    "bilibili",
                    user_id=str(d.user.uid),
                    nick_name=d.user.uname,
                    content=d.msg,
                    pay_grade=0,
                ))

            def onSuperChat(self, event):
                d = event.data
                adapter._put(_danmu_dict(
                    "bilibili",
                    user_id=str(d.user.uid),
                    nick_name=f"{d.user.uname}[SC¥{d.price}]",
                    content=d.msg,
                    pay_grade=int(d.price),     # SuperChat 价格当"优先级权重"
                    is_super=True,
                ))

            def onGift(self, event):
                d = event.data
                adapter._put(_danmu_dict(
                    "bilibili",
                    user_id=str(d.user.uid),
                    nick_name=d.user.uname,
                    content=f"【礼物】{d.gift_name} × {d.gift_num}",
                    pay_grade=int(d.price * d.gift_num // 1000) if d.price else 0,
                    is_gift=True,
                    gift_name=d.gift_name,
                    gift_num=d.gift_num,
                ))

            def onLiveEnd(self, event):
                print("📺 B 站直播已结束")

            def onException(self, exc_info):
                import traceback
                traceback.print_exception(*exc_info)

        self._live = BilibiliLive()
        self._live.schedule(_Handler, self.short_id)
        self._live.start()

    def stop(self):
        if self._live:
            self._live.stop()

    def describe(self) -> str:
        return f"B 站直播间 short_id={self.short_id}"


# ============================================================
# 配置加载（按平台）
# ============================================================
def load_platform_config(platform: str) -> dict:
    """读 config.json 里 douyin 或 bilibili 段，拿到全部通用参数。"""
    raw = cfg(platform) or {}
    # 通用参数（所有平台都支持这些，字段名统一）
    common_keys = ["keywords_at_host", "only_reply_questions", "min_chars",
                   "max_replies_per_10s", "per_user_cooldown_s",
                   "min_pay_grade", "blacklist_users",
                   "auto_fill", "auto_fill_interval_s"]
    out = {k: raw.get(k) for k in common_keys if raw.get(k) is not None}
    return out


def build_adapter(platform: str, platform_id_override: str | None = None) -> PlatformAdapter:
    if platform == "douyin":
        live_id = platform_id_override or (cfg("douyin") or {}).get("live_id", "")
        if not live_id or "改这里" in str(live_id):
            raise ValueError("config.json 的 douyin.live_id 没填（https://live.douyin.com/ 后面那串）")
        return DouyinAdapter(live_id)
    elif platform == "bilibili":
        raw = cfg("bilibili") or {}
        if platform_id_override:
            sid = int(platform_id_override)
        else:
            sid = raw.get("short_id") or raw.get("room_id")
        if not sid:
            raise ValueError("config.json 的 bilibili.short_id 没填（直播间页面 URL 里的短号）")
        return BilibiliAdapter(int(sid))
    else:
        raise ValueError(f"未知平台: {platform}（支持 douyin / bilibili）")


# ============================================================
# 通用逻辑：CommentFilter + score + TTS + 主循环
# ============================================================
class CommentFilter:
    """挑值得回复的弹幕。"""

    def __init__(self, *, keywords, only_questions, min_chars,
                 max_replies_10s, user_cooldown, min_pay_grade,
                 blacklist):
        self.keywords = [k.strip() for k in (keywords or []) if k.strip()]
        self.only_questions = bool(only_questions)
        self.min_chars = int(min_chars)
        self.max_replies_10s = int(max_replies_10s)
        self.user_cooldown = float(user_cooldown)
        self.min_pay_grade = int(min_pay_grade)
        self.blacklist = set(blacklist or [])
        self._user_last_reply: dict[str, float] = {}
        self._content_seen: dict[str, float] = {}
        self._recent_replies: deque[float] = deque()
        self._content_ttl = 30.0

    def should_reply(self, msg: dict) -> bool:
        uid = msg.get("user_id", "")
        content = msg.get("content", "").strip()
        pay_grade = (msg.get("pay_grade") or {}).get("level", 0)

        # SuperChat / Gift 走不同通道，不用过滤
        if msg.get("is_super") or msg.get("is_gift"):
            return True

        if not content or len(content) < self.min_chars:
            return False
        if uid in self.blacklist:
            return False
        if pay_grade < self.min_pay_grade:
            return False
        if self.only_questions and "?" not in content and "？" not in content:
            return False

        now = time.monotonic()

        if uid in self._user_last_reply:
            if now - self._user_last_reply[uid] < self.user_cooldown:
                return False

        norm = re.sub(r"\s+", "", content)
        if norm in self._content_seen:
            if now - self._content_seen[norm] < self._content_ttl:
                return False

        while self._recent_replies and now - self._recent_replies[0] > 10.0:
            self._recent_replies.popleft()
        if len(self._recent_replies) >= self.max_replies_10s:
            return False

        self._user_last_reply[uid] = now
        self._content_seen[norm] = now
        self._recent_replies.append(now)
        return True

    def score(self, msg: dict) -> int:
        """分值越高越优先。SuperChat/Gift 自带高优先级。"""
        if msg.get("is_super"):
            return 50 + (msg.get("pay_grade") or {}).get("level", 0)
        if msg.get("is_gift"):
            return 30 + (msg.get("pay_grade") or {}).get("level", 0)
        content = msg.get("content", "")
        score = min((msg.get("pay_grade") or {}).get("level", 0) * 2, 10)
        for kw in self.keywords:
            if kw and kw in content:
                score += 15
        if "?" in content or "？" in content:
            score += 5
        score += min(len(content) // 5, 5)
        return score


class DanmuBatcher:
    """弹幕攒批：普通弹幕先攒 15~30 秒，到点挑高分 2~3 条合并成一次回应。

    降 LLM 成本，也更像真人主播（真人就是攒几条一起念的）。
    礼物 / SuperChat 不走这里，保持即时插播。
    """

    def __init__(self, *, window_s=20.0, batch_max=3, enabled=True):
        self.window_s = float(window_s)
        self.batch_max = int(batch_max)
        self.enabled = bool(enabled)
        self._buf: list = []      # [(score, msg)]
        self._opened: float = 0.0  # 本批开始时间

    def add(self, msg: dict, score: int) -> None:
        if not self._buf:
            self._opened = time.monotonic()
        self._buf.append((score, msg))

    def due(self) -> bool:
        return bool(self._buf) and (time.monotonic() - self._opened >= self.window_s)

    def flush(self) -> list:
        """取出本批分值最高的 batch_max 条，清空缓冲。"""
        if not self._buf:
            return []
        top = sorted(self._buf, key=lambda x: -x[0])[: self.batch_max]
        self._buf = []
        return [m for _s, m in top]


def merge_prompt(platform_label: str, msgs: list) -> str:
    """把一批弹幕拼成一个合并回应 prompt。"""
    lines = "\n".join("%d. [%s] %s" % (i + 1, m.get("nick_name", ""),
                                       m.get("content", ""))
                      for i, m in enumerate(msgs))
    return ("【%s直播间弹幕】这几条弹幕一起回应：\n%s\n"
            "用 2~3 句口语把它们串起来回应，别逐条念编号。"
            % (platform_label, lines))


# ---------- TTS ----------
# 引擎：indextts2 走 scripts/indextts_server.py（零样本克隆，只需参考音频）；
# 其他值维持 GPT-SoVITS api_v2。两边都返回 s16le 单声道 PCM，播放逻辑一致。
_TTS_ENGINE = cfg("services.tts_engine", "gpt_sovits")
if _TTS_ENGINE == "indextts2":
    _TTS_URL = cfg("services.indextts_url", "http://127.0.0.1:9881/tts")
else:
    _TTS_URL = cfg("services.tts_url", "http://127.0.0.1:9880/tts")
_ref_rel = cfg("paths.voice_ref", "assets/voice/default.wav")
_REF_AUDIO = str(_PROJECT_ROOT / _ref_rel) if _ref_rel else ""
_PROMPT_TEXT = cfg("voice.prompt_text", "")
_TTS_RAW_RATE = int(cfg("audio.tts_raw_rate", 32000))
_TTS_CHUNK = 1024
if _TTS_ENGINE == "indextts2":
    _TTS_BASE = {"ref_audio_path": _REF_AUDIO}
else:
    _TTS_BASE = {
        "text_lang": "zh", "ref_audio_path": _REF_AUDIO,
        "prompt_text": _PROMPT_TEXT, "prompt_lang": "zh",
        "text_split_method": "cut0", "media_type": "raw",
        "streaming_mode": 3, "batch_size": 1,
    }


def stream_tts(text: str) -> None:
    if not text:
        return
    params = dict(_TTS_BASE, text=text)
    print(f"  🎙️ TTS: {text[:60]}{'...' if len(text) > 60 else ''}")
    try:
        with httpx.stream("GET", _TTS_URL, params=params,
                          timeout=120, trust_env=False) as resp:
            resp.raise_for_status()
            with sd.OutputStream(samplerate=_TTS_RAW_RATE, channels=1,
                                 dtype="int16", blocksize=_TTS_CHUNK) as out:
                buf = b""
                frame_bytes = _TTS_CHUNK * 2
                for chunk in resp.iter_raw():
                    if not chunk:
                        continue
                    buf += chunk
                    while len(buf) >= frame_bytes:
                        out.write(np.frombuffer(buf[:frame_bytes], dtype=np.int16))
                        buf = buf[frame_bytes:]
                if buf:
                    pad = frame_bytes - len(buf)
                    if pad > 0:
                        buf += b"\x00" * pad
                    out.write(np.frombuffer(buf[:frame_bytes], dtype=np.int16))
    except httpx.HTTPError as e:
        print(f"  ✗ TTS 调用失败: {e}")
    except Exception as e:  # noqa: BLE001
        print(f"  ✗ TTS 播放异常: {e}")


# ---------- 主循环 ----------
def run(platform: str, platform_id_override: str | None = None) -> int:
    # --- 建适配器 ---
    try:
        adapter = build_adapter(platform, platform_id_override)
    except ValueError as e:
        print(f"✗ {e}")
        return 1

    pc = load_platform_config(platform)

    # --- 等 AstrBot ---
    bridge = AstrBotBridge()
    print(f"⏳ 等 AstrBot 在线（http://127.0.0.1:6185）...")
    for _ in range(60):
        if bridge.alive():
            break
        time.sleep(1)
    else:
        print("✗ AstrBot 没起来，先启动它（双击 install\\40_start_all.bat）")
        return 2
    if not bridge.login():
        print("✗ AstrBot 登录失败，检查 .env 里的 ASTRBOT_DASHBOARD_PASSWORD")
        return 3
    if not bridge.new_session("webchat"):
        print("✗ 建会话失败")
        return 4
    print("✓ AstrBot 就绪")

    # --- 等 TTS ---
    print(f"⏳ 等本地 TTS 在线（{_TTS_URL}，引擎 {_TTS_ENGINE}）...")
    tts_probe = httpx.Client(timeout=3, trust_env=False)
    for _ in range(60):
        try:
            if tts_probe.get(_TTS_URL.rsplit("/tts", 1)[0] + "/docs").status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(1)
    else:
        print(f"✗ 本地 TTS 没起来（{_TTS_URL}），先启动对应引擎服务")
        return 5
    print("✓ TTS 就绪")

    # --- 队列 + 过滤器 ---
    danmu_q: queue.Queue[dict] = queue.Queue(maxsize=512)
    adapter.set_queue(danmu_q)
    fltr = CommentFilter(
        keywords=pc.get("keywords_at_host", []),
        only_questions=pc.get("only_reply_questions", False),
        min_chars=pc.get("min_chars", 2),
        max_replies_10s=pc.get("max_replies_per_10s", 3),
        user_cooldown=pc.get("per_user_cooldown_s", 15),
        min_pay_grade=pc.get("min_pay_grade", 0),
        blacklist=pc.get("blacklist_users", []),
    )
    auto_fill = bool(pc.get("auto_fill", True))
    auto_fill_interval = float(pc.get("auto_fill_interval_s", 45))
    # 弹幕攒批：平台配置可覆盖，全局默认 live.batch_*
    batcher = DanmuBatcher(
        window_s=pc.get("batch_window_s", cfg("live.batch_window_s", 20)),
        batch_max=pc.get("batch_max", cfg("live.batch_max", 3)),
        enabled=pc.get("batch_enabled", cfg("live.batch_enabled", True)),
    )

    # --- 开弹幕抓取 ---
    print(f"📺 连接 {adapter.describe()} ...")
    adapter.start()
    time.sleep(3)
    print(f"\n🎤 {adapter.name}直播 AI 副驾启动，Ctrl+C 退出\n")

    platform_label = adapter.name  # "抖音" / "B 站"

    last_auto_fill = time.monotonic() - auto_fill_interval
    last_human_reply = time.monotonic()

    try:
        while True:
            try:
                msg = danmu_q.get(timeout=2.0)
            except queue.Empty:
                msg = None

            now = time.monotonic()

            if msg is not None:
                content = msg.get("content", "").strip()
                nick = msg.get("nick_name", "")

                # --- Gift 特殊处理：直接"谢谢" ---
                if msg.get("is_gift"):
                    gift = msg.get("gift_name", "")
                    num = msg.get("gift_num", 0)
                    print(f"🎁 [{nick}] 送出 {gift} × {num}")
                    prompt = (
                        f"【{platform_label}直播间礼物】用户[{nick}]送出了 {gift} × {num}。\n"
                        "请像直播主播一样口语化地道谢，1 句话，要真诚。"
                    )
                # --- SuperChat 直接优先回复 ---
                elif msg.get("is_super"):
                    print(f"⭐ SuperChat [{nick}] {content}")
                    prompt = (
                        f"【{platform_label}直播间 SuperChat/醒目留言】用户[{nick}]说："
                        f"{content}\n"
                        "这是付费留言，请优先、认真、用 1~2 句口语化地回复。"
                    )
                # --- 普通弹幕（走过滤 → 攒批，不立即回复）---
                else:
                    print(f"📥 [{nick}] {content}")
                    if not fltr.should_reply(msg):
                        print("  · 跳过（冷却/去重/节流）")
                        continue
                    priority = fltr.score(msg)
                    if batcher.enabled:
                        batcher.add(msg, priority)
                        print(f"  ✓ 攒入批次（优先级 {priority}，本批 {len(batcher._buf)} 条）")
                        continue
                    print(f"  ✓ 选中（优先级 {priority}）")
                    prompt = (
                        f"【{platform_label}直播间弹幕】用户[{nick}]说："
                        f"{content}\n"
                        "请像直播 AI 主播一样回复，1~2 句话，口语化，接得上弹幕。"
                    )

                last_human_reply = now
                t0 = time.monotonic()
                try:
                    reply = bridge.chat(prompt)
                except Exception as e:  # noqa: BLE001
                    print(f"  ✗ LLM 异常: {e}")
                    continue
                print(f"  🤖 ({time.monotonic()-t0:.1f}s) → {reply[:80]}")
                stream_tts(reply)

            # --- 攒批到点：合并回应本批高分弹幕 ---
            if batcher.enabled and batcher.due():
                msgs = batcher.flush()
                if msgs:
                    print(f"📦 攒批回应 {len(msgs)} 条："
                          + " / ".join(m.get("content", "")[:12] for m in msgs))
                    last_human_reply = now
                    try:
                        reply = bridge.chat(merge_prompt(platform_label, msgs))
                    except Exception as e:  # noqa: BLE001
                        print(f"  ✗ LLM 异常: {e}")
                        continue
                    print(f"  🤖 攒批 → {reply[:80]}")
                    stream_tts(reply)

            # --- 自动闲聊 ---
            if auto_fill and (now - last_human_reply > auto_fill_interval) \
                    and (now - last_auto_fill > auto_fill_interval):
                last_auto_fill = now
                try:
                    reply = bridge.chat(
                        f"【{platform_label}直播间】这会儿没人说话，你随便说一句活跃气氛，1 句话就行。"
                    )
                    print(f"🤖 自动闲聊 → {reply[:80]}")
                    stream_tts(reply)
                except Exception as e:  # noqa: BLE001
                    print(f"  ✗ 自动闲聊失败: {e}")

    except KeyboardInterrupt:
        print("\n🛑 退出")
    finally:
        adapter.stop()
    return 0


def main():
    ap = argparse.ArgumentParser(description="直播 AI 副驾 — 抖音/B 站通用")
    ap.add_argument("--platform", required=True, choices=["douyin", "bilibili"],
                    help="直播平台")
    ap.add_argument("--live-id", dest="live_id", default=None,
                    help="覆盖 config.json 的 live_id（抖音）或 short_id（B 站）")
    args = ap.parse_args()
    return run(args.platform, args.live_id)


if __name__ == "__main__":
    sys.exit(main())
