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
import tempfile
from pathlib import Path

# 让仓库根（含 whale/ 包）可导入：与 live_bot.py 的 _REPO_ROOT 惯例一致
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
from whale.tts_sanitize import speakify, split_chunks  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VOICE = ROOT / "assets" / "voice" / "mortis" / "default.wav"
# index-tts 独立环境默认在仓库根 index-tts/ 下；模型目录必须纯 ASCII（可用环境变量覆盖）
INDEXTTS_PY = Path(os.environ.get(
    "INDEXTTS_PY",
    str(ROOT.parent / "index-tts" / ".venv" / "Scripts" / "python.exe")))
MODEL_DIR = os.environ.get("INDEXTTS_MODEL_DIR", r"C:\idx_models")


_MAX_CHUNK = 20          # IndexTTS2 超过 ~20 汉字易崩（torch.cat 空列表）
_LOCK_FILE = os.path.join(tempfile.gettempdir(), "persona_os_tts.lock")


def _acquire_lock(timeout: float = 600.0):
    """跨进程互斥：IndexTTS2 不支持两个进程同时跑（OOM / GPU 冲突）。

    用 msvcrt.locking 对锁文件第 1 字节加非阻塞独占锁；拿不到就等，超时抛错。
    进程崩溃时 fd 关闭会自动释放，不会残留死锁。
    """
    import time as _time
    fd = os.open(_LOCK_FILE, os.O_RDWR | os.O_CREAT)
    deadline = _time.time() + timeout
    while True:
        try:
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return fd
        except OSError:
            if _time.time() >= deadline:
                os.close(fd)
                raise RuntimeError(
                    "另一个 TTS 合成进程正在运行，请等待结束后再试（IndexTTS2 不支持并发，且必须带 --device cpu --force）")
            _time.sleep(1.0)


def _release_lock(fd) -> None:
    try:
        import msvcrt
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    finally:
        os.close(fd)


def _concat_wavs(paths: list[str], out_path: str) -> None:
    """拼接多个同格式 wav → out_path（取第一个的参数，数据直接串接）。"""
    import wave
    with wave.open(paths[0], "rb") as w0:
        params = w0.getparams()
        frames = w0.readframes(w0.getnframes())
    for p in paths[1:]:
        with wave.open(p, "rb") as w:
            frames += w.readframes(w.getnframes())
    with wave.open(out_path, "wb") as w:
        w.setparams(params)
        w.writeframes(frames)


def _synth_one(text: str, out_path: str, voice: str, device: str) -> None:
    """单块合成：显式 --device cpu --force（硬性条件，缺了会崩）。"""
    cmd = [
        str(INDEXTTS_PY), "-m", "indextts.cli_v2", "synth",
        "--model-dir", MODEL_DIR,
        "--text", text,
        "--voice", str(voice),
        "--output", out_path,
        "--device", device,
        "--force",
    ]
    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not Path(out_path).exists() or Path(out_path).stat().st_size == 0:
        raise RuntimeError(f"合成失败: {proc.stderr[-800:]}")


def synth(text: str, out_path: str, voice: str = str(DEFAULT_VOICE), device: str = "cpu") -> str:
    # 喂给 TTS 前必须先净化：英文/符号会让 IndexTTS2 崩（0xC0000005）；长文切块防 torch.cat 空列表
    safe = speakify(text)
    chunks = split_chunks(safe, _MAX_CHUNK) or [safe or "。"]
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    fd = _acquire_lock()
    try:
        if len(chunks) == 1:
            _synth_one(chunks[0], str(out), voice, device)
        else:
            temps: list[str] = []
            try:
                for i, c in enumerate(chunks):
                    tp = os.path.join(tempfile.gettempdir(), "mortis_tts_%d_%d.wav" % (os.getpid(), i))
                    _synth_one(c, tp, voice, device)
                    temps.append(tp)
                _concat_wavs(temps, str(out))
            finally:
                for tp in temps:
                    try:
                        os.remove(tp)
                    except OSError:
                        pass
    finally:
        _release_lock(fd)
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError("合成失败：输出文件为空")
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
