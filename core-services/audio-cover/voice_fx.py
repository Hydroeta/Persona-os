# -*- coding: utf-8 -*-
r"""voice_fx.py —— 拟声词引擎（叹气 / 轻笑 / 哈欠）

思路：真人说话前后常带气口（叹气、轻哼、哈欠），TTS 合成的是"标准音"，缺这一层就没人味。
本模块只做两件事：
    1. plan(text, energy)   —— 判断这一句该不该加、加哪种气口（纯规则，零依赖）
    2. prepend(voice, fx)   —— 把气口与语音做 30ms 交叉淡化后拼成一条音频

为什么必须交叉淡化：直接首尾相接会有爆音、听感像两个人；短交叉（20~40ms）能糊掉接缝。

占位音效：generate_placeholder() 会合成三段极短的合成音（不是真人录音），
只用于打通链路；真实素材放 assets/fx/{sigh,giggle,yawn}.wav 即自动使用。
"""
from __future__ import annotations

import math
import os
import wave
from pathlib import Path
from typing import Optional

import numpy as np

FX_DIR = Path(__file__).resolve().parent / "assets" / "fx"
FX_KINDS = ("sigh", "giggle", "yawn")

# 触发词（宁缺毋滥：只在明确出现时才加，避免每句都叹气）
TRIGGERS = {
    "sigh": ("唉", "哎", "叹气", "累", "困死了", "无语", "算了"),
    "giggle": ("哈哈", "嘿嘿", "嘻嘻", "笑死", "好笑", "噗"),
    "yawn": ("哈欠", "好困", "困了", "睡了", "晚安", "熬夜"),
}


def _read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"不支持的位深：{sw * 8}bit（{path}）")
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data, sr


def _write_wav(path: Path, data: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(data, -1.0, 1.0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((pcm * 32767).astype(np.int16).tobytes())


def _resample(x: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or x.size == 0:
        return x
    n = max(1, int(round(x.size * dst / src)))
    idx = np.linspace(0, x.size - 1, n)
    return np.interp(idx, np.arange(x.size), x).astype(np.float32)


def generate_placeholder(kind: str, sr: int = 24000) -> Path:
    """合成极短的占位气口（真实素材存在时不调用）。"""
    path = FX_DIR / f"{kind}.wav"
    if path.exists():
        return path
    rng = np.random.default_rng(hash(kind) & 0xFFFF)
    dur = {"sigh": 0.55, "giggle": 0.45, "yawn": 0.85}.get(kind, 0.4)
    t = np.linspace(0, dur, int(sr * dur), endpoint=False)
    if kind == "sigh":
        # 低频气声 + 缓慢衰减，模拟出气
        noise = rng.normal(0, 1, t.size).astype(np.float32)
        k = np.ones(400) / 400
        noise = np.convolve(noise, k, mode="same")
        env = np.exp(-3.2 * t) * (1 - np.exp(-30 * t))
        x = noise * env * 0.35
    elif kind == "giggle":
        # 三次短促的高频脉冲
        x = np.zeros_like(t)
        for center in (0.06, 0.19, 0.32):
            env = np.exp(-((t - center) ** 2) / (2 * 0.02 ** 2))
            x += np.sin(2 * np.pi * (520 + 120 * center) * t) * env
        x = x.astype(np.float32) * 0.28
    else:  # yawn
        # 上滑再下滑的长音，配合气声
        f0 = 220 + 90 * np.sin(np.pi * t / dur)
        x = (np.sin(2 * np.pi * np.cumsum(f0) / sr) * np.exp(-1.6 * t)).astype(np.float32) * 0.3
        x += rng.normal(0, 0.01, t.size).astype(np.float32)
    # 首尾各 15ms 淡入淡出，避免自带的爆音
    edge = max(1, int(sr * 0.015))
    x[:edge] *= np.linspace(0, 1, edge)
    x[-edge:] *= np.linspace(1, 0, edge)
    _write_wav(path, x, sr)
    return path


def ensure_placeholders() -> None:
    for k in FX_KINDS:
        generate_placeholder(k)


def plan(text: str, energy: Optional[float] = None) -> dict:
    """判断这句话该配哪种气口。energy<0.35 视为"精力低"，允许用哈欠。"""
    t = (text or "").strip()
    if not t:
        return {"effect": None, "reason": "空文本"}
    lowered = t[:24]
    for kind, words in TRIGGERS.items():
        hit = next((w for w in words if w in lowered), None)
        if hit:
            if kind == "yawn" and energy is not None and energy > 0.6:
                continue
            return {"effect": kind, "reason": f"命中「{hit}」"}
    if energy is not None and energy < 0.2 and "困" in lowered:
        return {"effect": "yawn", "reason": "精力过低"}
    return {"effect": None, "reason": "无匹配"}


def crossfade(a: np.ndarray, b: np.ndarray, sr: int, ms: int = 30) -> np.ndarray:
    """a 的尾部与 b 的头部做线性交叉淡化，返回拼接结果。"""
    n = max(1, int(sr * ms / 1000))
    n = min(n, a.size, b.size)
    if n <= 1:
        return np.concatenate([a, b])
    fade_out = np.linspace(1, 0, n, dtype=np.float32)
    fade_in = np.linspace(0, 1, n, dtype=np.float32)
    head = a[:-n]
    mid = a[-n:] * fade_out + b[:n] * fade_in
    return np.concatenate([head, mid, b[n:]])


def prepend(voice_path: str, effect: str, out_path: Optional[str] = None,
            ms: int = 30, gain: float = 0.9) -> dict:
    """在语音前插入气口，交叉淡化后输出。"""
    if effect not in FX_KINDS:
        raise ValueError(f"未知气口：{effect}")
    fx_path = FX_DIR / f"{effect}.wav"
    if not fx_path.exists():
        generate_placeholder(effect)
    voice, vsr = _read_wav(Path(voice_path))
    fx, fsr = _read_wav(fx_path)
    if fsr != vsr:
        fx = _resample(fx, fsr, vsr)
    fx = fx * gain
    merged = crossfade(fx, voice, vsr, ms=ms)
    # 简单限幅，避免叠加后削波
    peak = float(np.max(np.abs(merged))) or 1.0
    if peak > 0.99:
        merged = merged * (0.99 / peak)
    dst = Path(out_path) if out_path else Path(voice_path).with_name(Path(voice_path).stem + f"_{effect}.wav")
    _write_wav(dst, merged, vsr)
    return {"ok": True, "effect": effect, "out": str(dst), "sr": vsr,
            "voice_s": round(voice.size / vsr, 2), "fx_s": round(fx.size / vsr, 2),
            "crossfade_ms": ms}


if __name__ == "__main__":
    ensure_placeholders()
    print("placeholders:", [str(FX_DIR / f"{k}.wav") for k in FX_KINDS])
    for s in ("唉，今天好累", "哈哈哈哈笑死我了", "今天天气不错", "好困，我先睡了"):
        print(s, "->", plan(s, energy=0.3))
