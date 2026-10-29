# -*- coding: utf-8 -*-
"""小鲸鱼 · 告警外发（无人值守不静默失败）

崩溃、重启触顶、P95 超阈、显存告急、预算 80% —— 除了控制台红条，还推到这里。

配置（config/master.json）：
    "alerts": { "webhook": "" }
webhook 支持三种（留空 = 不外发，只写本地日志）：
    · Bark       https://api.day.app/你的Key
    · Server 酱  https://sctapi.ftqq.com/你的SENDKEY.send
    · 通用 POST  任意接收 {"title","text"} JSON 的 URL（如企业微信/飞书机器人中转）

防刷屏：同一 key 30 分钟内只发一次。
CLI：python tools/alert.py test            # 发一条测试
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
STATE = TOOLS / "alert_state.json"
MASTER = ROOT / "config" / "master.json"
MIN_INTERVAL = 1800  # 同一告警 30 分钟只发一次


def _webhook() -> str:
    try:
        cfg = json.loads(MASTER.read_text("utf-8"))
        return str(cfg.get("alerts", {}).get("webhook", "")).strip()
    except Exception:
        return ""


def _throttled(key: str) -> bool:
    try:
        st = json.loads(STATE.read_text("utf-8")) if STATE.is_file() else {}
    except Exception:
        st = {}
    now = time.time()
    if now - st.get(key, 0) < _throttled.interval:
        return True
    st[key] = now
    try:
        STATE.write_text(json.dumps(st), "utf-8")
    except Exception:
        pass
    return False


_throttled.interval = MIN_INTERVAL


def send(title: str, text: str, key: str = "") -> bool:
    """发告警。返回是否真正外发（未配置/被限流都返回 False）。失败绝不抛异常。"""
    url = _webhook()
    if not url:
        return False
    if key and _throttled(key):
        return False
    try:
        if "api.day.app" in url:  # Bark
            full = "%s/%s/%s" % (url.rstrip("/"),
                                 urllib.parse.quote(title), urllib.parse.quote(text))
            urllib.request.urlopen(full, timeout=10)
        elif "sctapi.ftqq.com" in url:  # Server 酱 Turbo
            body = urllib.parse.urlencode({"title": title, "desp": text}).encode()
            urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=10)
        else:  # 通用 JSON webhook
            body = json.dumps({"title": title, "text": text}, ensure_ascii=False).encode()
            req = urllib.request.Request(url, data=body,
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10)
        return True
    except Exception:
        return False


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        ok = send("小鲸鱼告警测试", "如果你看到这条，说明 webhook 配置生效了。", key="test")
        print("已外发" if ok else "未外发（检查 config/master.json alerts.webhook）")
    else:
        print(__doc__)
