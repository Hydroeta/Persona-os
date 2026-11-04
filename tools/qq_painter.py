# -*- coding: utf-8 -*-
"""小鲸鱼 QQ 群「生图 + 发图」桥接（独立于 Tulpa，可单独测试）。

把 painter 生成的本地图，通过 OneBot v11 的 send_group_msg 发成 image 消息段。
OneBot 地址/令牌从 .env 读（REPLY_ONEBOT_URL / REPLY_ONEBOT_TOKEN），与 Tulpa
message_sender 同一套配置；优先项目根 .env，其次 Tulpa/Tulpa/.env。

Tulpa 群聊工具 draw_picture 复用这里的生图逻辑，但发送走 Tulpa 自己的 sender
（带授权/幂等校验），不经过本模块的 HTTP 发送。

CLI：
    python tools/qq_painter.py send <group_id> "一只猫"          # 真发图到群
    python tools/qq_painter.py send <group_id> "一只猫" --dry    # 只生图+算 base64，不发（验证链路）
"""
from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import painter  # noqa: E402

# OneBot 可能的 .env 位置（按优先级）
_ENV_CANDIDATES = [ROOT / ".env", ROOT / "Tulpa" / "Tulpa" / ".env"]


def _read_dotenv(path: Path) -> dict:
    out = {}
    if not path.is_file():
        return out
    for line in path.read_text("utf-8", "replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def onebot_config() -> tuple[str, str]:
    """返回 (url, token)，与 Tulpa message_sender.sender_config 同源。"""
    merged: dict = {}
    for p in _ENV_CANDIDATES:
        merged.update(_read_dotenv(p))
    url = os.environ.get("REPLY_ONEBOT_URL") or merged.get("REPLY_ONEBOT_URL", "")
    token = os.environ.get("REPLY_ONEBOT_TOKEN") or merged.get("REPLY_ONEBOT_TOKEN", "")
    return url.strip(), token.strip()


def image_to_base64(local_path: str) -> str:
    """本地图片 → OneBot image 段的 file 字段（base64:// 前缀）。"""
    raw = Path(local_path).read_bytes()
    return "base64://" + base64.b64encode(raw).decode("ascii")


def draw_and_send(group_id, prompt, scene: str = "group",
                  style: str = "anime, high quality", dry_run: bool = False):
    """生图并通过 OneBot 发到指定 QQ 群。返回 (ok, message)。

    dry_run=True 时只生图+算 base64，不真正发送（用于离线验证链路）。
    """
    path, msg = painter.generate_image_sync(prompt, style=style, scene=scene)
    if not path:
        return False, msg
    try:
        b64 = image_to_base64(path)
    except Exception as e:
        return False, "读取图片失败: %s（图在 %s）" % (e, path)
    if dry_run:
        return True, "dry-run 就绪: 生成 %s (%d bytes), base64 长度 %d（未发送）" % (
            path, Path(path).stat().st_size, len(b64))

    url, token = onebot_config()
    if not url:
        return False, "未配置 REPLY_ONEBOT_URL，图已生成在 %s（手动发或配好再发）" % path
    payload = {"group_id": int(group_id),
               "message": [{"type": "image", "data": {"file": b64}}]}
    try:
        req = urllib.request.Request(
            url.rstrip("/") + "/send_group_msg",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     **({"Authorization": "Bearer " + token} if token else {})})
        with urllib.request.urlopen(req, timeout=20) as r:
            resp = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        return False, "OneBot HTTP %s: %s（图在 %s）" % (e.code, body[:200], path)
    except Exception as e:
        return False, "发送失败: %s（图已生成在 %s，可手动补发）" % (e, path)

    if resp.get("status") == "ok" and resp.get("retcode") == 0:
        return True, "已发到群 %s" % group_id
    return False, "OneBot 返回失败: %s（图在 %s）" % (str(resp)[:200], path)


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[1] != "send":
        print(__doc__)
        return 1
    group_id = argv[2]
    dry = "--dry" in argv
    rest = [a for a in argv[3:] if a != "--dry"]
    prompt = " ".join(rest)
    ok, msg = draw_and_send(group_id, prompt,
                            scene="dream" if dry else "group", dry_run=dry)
    print(("✅ " if ok else "❌ ") + msg)
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
