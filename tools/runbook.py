# -*- coding: utf-8 -*-
"""小鲸鱼 · 故障 runbook（P2）

「通话没声音」「反向 WS 断连」「显存 OOM」各给一棵排障树，控制台内嵌展示。
比翻 FAQ 好用：按步骤点，走一步看一步。纯静态数据 + 进度记忆（本机）。

CLI：
    python tools/runbook.py list
    python tools/runbook.py show call_no_sound
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

TREES = {
    "call_no_sound": {
        "title": "通话没声音",
        "steps": [
            "控制台「一键自检」：VB-CABLE 是否已安装",
            "ohwhale-deploy/config.json 的 master.qq 是否已填",
            "QQ 语音设置里麦克风选的是 CABLE Output（不是真麦克风）",
            "深度自检跑「TTS 闭环试合成」，确认合成端正常",
            "看 logs/call_metrics.jsonl 有无 degrade / asr_timeout",
            "都没问题 → 看 AstrBot 面板 :6185 的平台适配器是否在线",
        ],
    },
    "reverse_ws_down": {
        "title": "反向 WS 断连",
        "steps": [
            "深度自检「OneBot 反向 WS（6199）」是否可连",
            "LuckyLillia 面板反向地址应为 ws://127.0.0.1:6199/ws",
            "AstrBot :6185 子项是否为 ✓",
            "两侧 ONEBOT_ACCESS_TOKEN 是否一致（控制台密钥页重填一次）",
            "重启顺序：先 LuckyLillia，再 AstrBot",
        ],
    },
    "vram_oom": {
        "title": "显存 OOM（4GB 卡）",
        "steps": [
            "指标页看当前显存与 7 日峰值",
            "通话/直播进行中不要跑 bili-vision 等重任务（resource_gate 会让路）",
            "关掉不用的 GPU 程序（浏览器硬件加速也算）",
            "GPT-SoVITS 重启可释放泄漏的显存",
            "常态爆显存 → 考虑把 TTS 切到 CPU 慢速模式",
        ],
    },
    "qq_offline": {
        "title": "QQ 不在线 / 掉登录",
        "steps": [
            "控制台「QQ 登录」重新扫码",
            "LuckyLillia 窗口不要关（最小化即可）",
            "掉登录频繁 → 换登录方式（手表/平板协议更稳）",
        ],
    },
    "llm_fail": {
        "title": "LLM 调用失败 / 一直兜底",
        "steps": [
            "密钥页确认 DeepSeek 密钥「已配置 N 位」",
            "指标页看 LLM 今日 token 是否触顶（触顶会固定应答）",
            "浏览器直接访问 api.deepseek.com 看网络通不通",
            "账户余额：DeepSeek 控制台查一下是否欠费",
        ],
    },
}


def list_all() -> list:
    return [{"id": k, "title": v["title"], "steps": len(v["steps"])}
            for k, v in TREES.items()]


def show(rid: str) -> dict:
    t = TREES.get(rid)
    if not t:
        return {"found": False}
    return {"found": True, "id": rid, "title": t["title"], "steps": t["steps"]}


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "list":
        print(json.dumps(list_all(), ensure_ascii=False, indent=2))
    elif len(sys.argv) >= 3 and sys.argv[1] == "show":
        print(json.dumps(show(sys.argv[2]), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
