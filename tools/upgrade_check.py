# -*- coding: utf-8 -*-
"""小鲸鱼 · 升级兼容验证（P2-1）

GPT-SoVITS / AstrBot / LuckyLillia 升级前后的核对流程：
    升级前：python tools/upgrade_check.py baseline     # 记录当前指纹为基线
    升级后：python tools/upgrade_check.py check        # 与基线比对 + 就绪探测

核对内容：
  1. 关键文件 SHA256（GPT-SoVITS 权重、LuckyLillia.exe、start 脚本）
  2. 端口就绪（9880 TTS /docs、6185 AstrBot、3080 DSH）
  3. Python / Node 版本未漂移
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / "tools" / "upgrade_baseline.json"

# 关键文件：相对项目根的路径 glob（取第一个命中）
WATCH_FILES = [
    ("GPT-SoVITS 权重", "ohwhale-deploy/**/GPT_SoVITS/*.pth"),
    ("GPT-SoVITS 配置", "ohwhale-deploy/**/GPT_SoVITS/*.json"),
    ("LuckyLillia", "ohwhale-deploy/runtime/LL/LuckyLillia.exe"),
    ("DSH 启动脚本", "dsh/start-dsh.ps1"),
    ("Tulpa 主程序", "Tulpa/Tulpa/Tulpa.exe"),
]

PORTS = [("GPT-SoVITS", 9880, "http://127.0.0.1:9880/docs"),
         ("AstrBot", 6185, "http://127.0.0.1:6185/"),
         ("DSH", 3080, "http://127.0.0.1:3080/")]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _versions() -> dict:
    def ver(args):
        try:
            out = subprocess.run(args, capture_output=True, timeout=15,
                                 text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return (out.stdout or out.stderr).strip().splitlines()[0]
        except Exception:
            return None
    return {"python": ver(["python", "--version"]), "node": ver(["node", "--version"])}


def collect() -> dict:
    files = {}
    for label, pattern in WATCH_FILES:
        hits = sorted(ROOT.glob(pattern))
        if hits:
            files[label] = {"path": str(hits[0].relative_to(ROOT)),
                            "sha256": _sha256(hits[0])}
    return {"files": files, "versions": _versions()}


def _http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.status < 500
    except Exception:
        return False


def main(argv) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    if argv[1] == "baseline":
        data = collect()
        BASELINE.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
        print("基线已记录：")
        for label, f in data["files"].items():
            print("  %-14s %s  %s" % (label, f["sha256"][:16], f["path"]))
        print("  版本:", data["versions"])
        return 0
    if argv[1] == "check":
        if not BASELINE.is_file():
            print("没有基线，先跑 baseline")
            return 1
        base = json.loads(BASELINE.read_text("utf-8"))
        now = collect()
        ok = True
        for label, f in base["files"].items():
            cur = now["files"].get(label)
            if not cur:
                print("✗ %-14s 文件缺失（基线 %s）" % (label, f["path"]))
                ok = False
            elif cur["sha256"] != f["sha256"]:
                print("⚠ %-14s 哈希变化（升级导致？确认后重跑 baseline）" % label)
            else:
                print("✓ %-14s 一致" % label)
        for label, port, url in PORTS:
            print(("✓" if _http_ok(url) else "✗"), "%-12s :%d %s" % (label, port,
                  "就绪" if _http_ok(url) else "未就绪（未启动则忽略）"))
        if base["versions"] != now["versions"]:
            print("⚠ 运行时版本漂移: 基线 %s → 现在 %s" % (base["versions"], now["versions"]))
        print("结论:", "通过" if ok else "有缺失，需排查")
        return 0 if ok else 2
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
