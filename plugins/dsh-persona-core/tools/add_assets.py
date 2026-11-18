# -*- coding: utf-8 -*-
"""add_assets.py —— 给 persona.json 补 assets 节点（幂等，可重复跑）

为什么单独写脚本而不是手改：
    persona.json 是 UTF-8 + 中文，用 PowerShell 改会乱码；
    用脚本还能顺手校验 JSON 合法性、保留原有字段顺序（dict 有序）。

用法：
    python add_assets.py            # 只打印将要写入的内容（dry run）
    python add_assets.py --write    # 真写盘
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(r"C:\Users\79365\Desktop\新建文件夹 (2)\github-release\persona-os")
PERSONAS = ROOT / "config" / "personas"

# 每个角色要注入的 assets。expr_dir 相对仓库根；theme_color 是面板边框主色。
ASSETS = {
    "ohwhale": {
        "$comment": "面板/前端用的视觉资产。相对路径一律相对仓库根（PERSONA_OS_ROOT）。",
        "display_name": "鲸鲸",
        "expr_dir": "plugins/dsh-control-center/web/assets/expr",
        "expr_prefix": "pixel_",
        "theme_color": "#00F0FF",
        "theme_sea": "#5BC0BE",
    },
    "mortis": {
        "$comment": "面板/前端用的视觉资产。相对路径一律相对仓库根（PERSONA_OS_ROOT）。",
        "display_name": "Mortis",
        # mortis 还没有自己的表情差分，先共用同一目录；等她有了改这里即可
        "expr_dir": "plugins/dsh-control-center/web/assets/expr",
        "expr_prefix": "pixel_",
        "theme_color": "#C77DFF",
        "theme_sea": "#9D4EDD",
    },
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="真写盘（默认 dry run）")
    args = ap.parse_args()

    for pid, assets in ASSETS.items():
        p = PERSONAS / pid / "persona.json"
        if not p.exists():
            print(f"跳过（不存在）{p}")
            continue

        raw = p.read_text(encoding="utf-8")
        d = json.loads(raw)

        before = json.dumps(d.get("assets"), ensure_ascii=False) if "assets" in d else "(无)"
        d["assets"] = assets
        after = json.dumps(d["assets"], ensure_ascii=False)

        print(f"=== {pid} ===")
        print(f"  原 assets: {before[:100]}")
        print(f"  新 assets: {after[:160]}")

        if args.write:
            # 保留中文不转义、2 空格缩进（和仓库里其它 json 一致）
            p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            # 立刻回读校验
            back = json.loads(p.read_text(encoding="utf-8"))
            ok = back.get("assets", {}).get("theme_color") == assets["theme_color"]
            print(f"  已写入并回读校验: {'OK' if ok else 'FAIL'}")
        else:
            print("  (dry run，未写盘)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
