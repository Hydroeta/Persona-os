# -*- coding: utf-8 -*-
"""小鲸鱼 · 自动版本化备份（P2-1）

替代手工 zip：定时跑（可挂 Windows 计划任务，建议每天一次），保留最近 5 份。
    python tools/auto_backup.py            # 立即备份
    python tools/auto_backup.py --verify   # 验证最新备份"还原后能跑"

备份内容（配置与源码，不含运行时/模型/数据/密钥密文）：
  console.py、config/、tools/（不含 db/密文）、ohwhale-deploy 的
  config/scripts/plugins（不含 runtime/data）、dsh/home（cron/工作区文本）、
  dsh-pet 的 persona_presets 与配置。
还原步骤（--verify 只校验不解压；真还原时手动解压并覆盖同名目录即可）：
  解压 backups/whale-YYYYMMDD-HHMM.zip → 覆盖到项目根 → 控制台填密钥 → 全部启动。
"""
# Copyright 2026 Xiaojingyu AI Companion contributors
# SPDX-License-Identifier: MIT
from __future__ import annotations

import json
import shutil
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "backups"
KEEP = 5


def _mirror_dir() -> Path | None:
    """config/master.json backup.mirror_dir：异地/第二块盘目录，单机磁盘挂了不至于全没。"""
    try:
        cfg = json.loads((ROOT / "config" / "master.json").read_text("utf-8"))
        d = str(cfg.get("backup", {}).get("mirror_dir", "")).strip()
        return Path(d) if d else None
    except Exception:
        return None

INCLUDE = [
    ("console.py",), ("控制台.cmd",), ("项目介绍.md",), ("使用说明.md",),
    ("config",), ("tests",),
    ("tools", ("*.py", "*.json"), ("keys.dpapi.json", "search_gate.db", "upgrade_baseline.json")),
    # 注意：pathlib 的 "dir/**" 只匹配子目录，必须写 "dir/**/*" 才会含文件
    ("ohwhale-deploy", ("*.json", "*.md", "scripts/**/*", "plugins/**/*",
                        "install/**/*", "config/**/*",
                        "assets/voice/**/*"), None),   # 参考音素材（声音状态化，约 1.5 MB）
    ("dsh/home", ("*.json", "*.md"), None),
    ("dsh-pet", ("*.json", "_internal/pet/persona_presets/**/*",
                 "_internal/pet/menu_templates/**/*"), None),
]

NEVER = ("node_modules", "runtime", "models", "data", "sessions", "logs",
         "__pycache__", ".git", "venv")


def _wanted(path: Path) -> bool:
    parts = set(path.parts)
    return not any(b in parts for b in NEVER)


def backup() -> Path:
    OUT.mkdir(exist_ok=True)
    name = "whale-%s.zip" % time.strftime("%Y%m%d-%H%M")
    dest = OUT / name
    n = 0
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for item in INCLUDE:
            base = ROOT / item[0]
            if not base.exists():
                continue
            if base.is_file():
                z.write(base, base.name)
                n += 1
                continue
            globs = item[1] if len(item) > 1 else ("**/*",)
            excludes = item[2] if len(item) > 2 and item[2] else ()
            for g in globs:
                for f in base.glob(g):
                    if f.is_file() and _wanted(f) and f.name not in excludes:
                        z.write(f, str(f.relative_to(ROOT)))
                        n += 1
    # 版本化：只留最近 KEEP 份
    olds = sorted(OUT.glob("whale-*.zip"), key=lambda p: -p.stat().st_mtime)
    for f in olds[KEEP:]:
        f.unlink()
    print("备份完成 %s（%d 个文件，%.1f MB；共保留 %d 份）" % (
        dest.name, n, dest.stat().st_size / 1048576, min(len(olds), KEEP)))
    # 异地镜像：第二块盘 / 网盘同步目录（config/master.json backup.mirror_dir）
    mirror = _mirror_dir()
    if mirror:
        try:
            mirror.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, mirror / dest.name)
            molds = sorted(mirror.glob("whale-*.zip"), key=lambda p: -p.stat().st_mtime)
            for f in molds[KEEP:]:
                f.unlink()
            print("已镜像到 %s" % mirror)
        except OSError as e:
            print("镜像失败（备份本体已完成）: %s" % e)
    return dest


def verify() -> bool:
    zips = sorted(OUT.glob("whale-*.zip"), key=lambda p: -p.stat().st_mtime)
    if not zips:
        print("没有备份可验证")
        return False
    latest = zips[0]
    try:
        with zipfile.ZipFile(latest) as z:
            bad = z.testzip()
            names = set(z.namelist())
    except zipfile.BadZipFile:
        print("✗ 最新备份 %s 不是有效 zip（损坏）" % latest.name)
        return False
    must = ["console.py", "config/master.json", "tools/search_gate.py",
            "tools/key_vault.py"]
    missing = [m for m in must if m not in names]
    if bad or missing:
        print("✗ 备份损坏或缺文件:", bad or "", missing)
        return False
    print("✓ 最新备份 %s 完整（含关键文件，zip 校验通过）" % latest.name)
    return True


if __name__ == "__main__":
    if "--verify" in sys.argv:
        sys.exit(0 if verify() else 1)
    backup()
    verify()
