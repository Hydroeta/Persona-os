# Copyright 2026 persona-os contributors
# SPDX-License-Identifier: MIT
# -*- coding: utf-8 -*-
"""Mortis 中文语音合成（IndexTTS2 零样本，只要参考音频，不需要参考文本）。

用法：
    python scripts/mortis_tts.py "你们都给我跪下" out.wav
    python scripts/mortis_tts.py --voice assets/voice/mortis/ref_happy.wav "我还要再玩一会" out.wav
    python scripts/mortis_tts.py --text-file lines.txt --out-dir out/mortis_voice

说明：
- 走独立的 index-tts 环境（Python 3.11 + CPU torch），不碰鲸鲸那套 .venv-tts。
- 模型目录必须是纯 ASCII：C:\\idx_models（中文路径会报 Illegal byte sequence）。
- CPU 推理约 1~2 分钟/句，批量请自己排好时间。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VOICE = ROOT / "assets" / "voice" / "mortis" / "default.wav"
# index-tts 独立环境默认在仓库根 index-tts/ 下；模型目录必须纯 ASCII（可用环境变量覆盖）
INDEXTTS_PY = Path(os.environ.get(
    "INDEXTTS_PY",
    str(ROOT.parent / "index-tts" / ".venv" / "Scripts" / "python.exe")))
MODEL_DIR = os.environ.get("INDEXTTS_MODEL_DIR", r"C:\idx_models")


def synth(text: str, out_path: str, voice: str = str(DEFAULT_VOICE), device: str = "cpu") -> str:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(INDEXTTS_PY), "-m", "indextts.cli_v2", "synth",
        "--model-dir", MODEL_DIR,
        "--text", text,
        "--voice", str(voice),
        "--output", str(out),
        "--device", device,
        "--force",
    ]
    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(f"合成失败: {proc.stderr[-800:]}")
    return str(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="Mortis TTS (IndexTTS2 zero-shot)")
    ap.add_argument("text", nargs="?", help="要说的中文")
    ap.add_argument("out", nargs="?", help="输出 wav 路径")
    ap.add_argument("--voice", default=str(DEFAULT_VOICE), help="参考音频")
    ap.add_argument("--text-file", help="逐行读取文本，每行一句")
    ap.add_argument("--out-dir", default="out/mortis_voice", help="配合 --text-file 的输出目录")
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

    if args.text_file:
        lines = [l.strip() for l in Path(args.text_file).read_text(encoding="utf-8").splitlines() if l.strip()]
        for i, line in enumerate(lines, 1):
            dst = Path(args.out_dir) / f"{i:02d}.wav"
            print(f"[{i}/{len(lines)}] {line}", flush=True)
            print("  ->", synth(line, str(dst), args.voice, args.device), flush=True)
        return 0

    if not args.text or not args.out:
        ap.print_help()
        return 2
    print(synth(args.text, args.out, args.voice, args.device))
    return 0


if __name__ == "__main__":
    sys.exit(main())
