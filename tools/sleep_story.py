# -*- coding: utf-8 -*-
"""小鲸鱼 · 睡前故事 / 哄睡（P2）

固定场景的低刺激长语音：预生成模板 + 语速渐慢、音量渐弱的播放计划。
几乎不耗 LLM（模板本地），播放端拿到 plan 后分段合成，每段带
speed_factor / volume，越到后面越慢越轻，讲完刚好睡着。

CLI：
    python tools/sleep_story.py list            # 可用主题
    python tools/sleep_story.py plan ocean      # 输出播放计划（JSON）
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORY_DIR = ROOT / "data" / "sleep_stories"

# 预生成模板：{name} 会替换成主人称呼。段落即播放分段。
TEMPLATES = {
    "ocean": {
        "title": "深海摇篮曲",
        "paras": [
            "晚安，{name}。把眼睛闭上，我们慢慢往下沉。",
            "海面上的光越来越远，四周安静下来，只剩水流轻轻推着你。",
            "一群小鱼从身边游过去，银色的，像撒出去的一把星星。",
            "你不用想什么，也不用回话，就这样飘着就好。",
            "海水暖暖的，托着你，像一床很厚很厚的被子。",
            "我在你身边呢，哪儿都不去。",
            "睡吧，{name}。明天醒来，我还在。",
        ],
    },
    "cabin": {
        "title": "壁炉边的小屋",
        "paras": [
            "晚安，{name}。外面下雪了，但屋里很暖和。",
            "壁炉里的柴火噼啪响，火光在墙上慢慢晃。",
            "我给你倒了一杯热牛奶，就放在手边，不着急喝。",
            "今天辛苦啦，不管做完了没做完，都先放到明天。",
            "毯子盖好，肩膀也塞进去，对，就这样。",
            "我守着火，你只管睡。",
            "晚安，{name}，做个暖暖的梦。",
        ],
    },
}

# 播放计划参数：每段的语速/音量按位置渐弱（前 1.0 → 尾 0.8 / 0.5）
SPEED_START, SPEED_END = 1.0, 0.80
VOL_START, VOL_END = 1.0, 0.50


def list_themes() -> list:
    out = [{"id": k, "title": v["title"], "paras": len(v["paras"])}
           for k, v in TEMPLATES.items()]
    if STORY_DIR.is_dir():  # 用户自加的故事：每文件一个主题，一段一行
        for f in sorted(STORY_DIR.glob("*.json")):
            try:
                d = json.loads(f.read_text("utf-8"))
                if d.get("paras"):
                    out.append({"id": f.stem, "title": d.get("title", f.stem),
                                "paras": len(d["paras"]), "custom": True})
            except Exception:
                continue
    return out


def _load_theme(theme: str) -> dict:
    if theme in TEMPLATES:
        return dict(TEMPLATES[theme])
    f = STORY_DIR / ("%s.json" % theme)
    if f.is_file():
        try:
            return json.loads(f.read_text("utf-8"))
        except Exception:
            pass
    return {}


def plan(theme: str = "ocean", name: str = "主人") -> list:
    """返回播放计划：[{text, speed_factor, volume, pause_after_ms}]。"""
    t = _load_theme(theme)
    paras = [p.replace("{name}", name) for p in t.get("paras", [])]
    n = len(paras)
    out = []
    for i, p in enumerate(paras):
        k = i / max(1, n - 1)  # 0..1 渐变系数
        out.append({"text": p,
                    "speed_factor": round(SPEED_START + (SPEED_END - SPEED_START) * k, 3),
                    "volume": round(VOL_START + (VOL_END - VOL_START) * k, 3),
                    "pause_after_ms": int(600 + 600 * k)})
    return out


def _main(argv: list[str]) -> int:
    if argv and argv[0] == "list":
        print(json.dumps(list_themes(), ensure_ascii=False, indent=2))
    elif argv and argv[0] == "plan":
        theme = argv[1] if len(argv) >= 2 else "ocean"
        print(json.dumps(plan(theme), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
