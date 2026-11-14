#!/usr/bin/env python3
"""test_stroke.py —— 笔触堆叠法（网格排线版，回退版）

按网格采样：每格取「颜色 + Sobel 边缘方向」，沿方向画一根短排线（±1.5px 抖动），
几千根排线一笔笔铺满白纸。本机没有可用 cv2，Sobel 用 numpy、画线用 PIL。

要点（都是踩出来的）：
  · 方向上取「垂直于梯度」（切线），头发才有发丝感（--mode grad 可换回沿梯度）
  · 笔宽 ≈ step、笔长 ≈ step×2 才能铺满，太细会像划痕
  · 颜色取块内**非白像素的中位数**，直接平均会被白底冲淡
  · 纯白格不落笔，否则满屏白点
  · 笔数与帧数都不设上限：step 越小越密、越慢

用法：
  <venv-tts 的 python> test_stroke.py --src <图> --out <目录> [--size 720] [--step 6] [--fps 20] [--seconds 20]
"""
from __future__ import annotations

import argparse
import math
import os
import random
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

SS = 2  # 超采样


def load_source(path: str, size: int) -> Image.Image:
    im = Image.open(path)
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    im = im.convert("RGB")
    w, h = im.size
    scale = size / max(w, h)
    if scale < 1:
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    return im


def sobel(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    g = gray.astype(np.float32)
    p = np.pad(g, 1, mode="edge")
    gx = (
        (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:])
        - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    )
    gy = (
        (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:])
        - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    )
    return gx, gy


def build_strokes(im: Image.Image, step: int, mode: str, seed: int = 7,
                  layers: int = 1, length_k: float = 1.0, pen: float = 1.0):
    rnd = random.Random(seed)
    rgb = np.asarray(im, dtype=np.float32)
    gray = rgb.mean(axis=2)
    gx, gy = sobel(gray)
    h, w = gray.shape

    strokes = []
    for y in range(step // 2, h, step):
        for x in range(step // 2, w, step):
            # 油画感：同一格**多叠几笔**（超过 1 笔时位置/角度/长度各异，互相压盖）
            for _layer in range(max(1, layers)):
                sx = x + rnd.uniform(-step * 0.7, step * 0.7)
                sy = y + rnd.uniform(-step * 0.7, step * 0.7)
                block = rgb[max(0, int(sy) - 3): int(sy) + 4,
                            max(0, int(sx) - 3): int(sx) + 4].reshape(-1, 3)
                lum = block.mean(axis=1)
                ink = block[lum < 245]
                if len(ink) < 4 and lum.mean() > 246:  # 纯白背景不落笔
                    continue
                src_block = ink if len(ink) >= 3 else block
                color = tuple(int(v) for v in np.median(src_block, axis=0))
                yy, xx = int(min(max(sy, 0), h - 1)), int(min(max(sx, 0), w - 1))

                ang_grad = math.atan2(gy[yy, xx], gx[yy, xx])
                ang_base = ang_grad + (math.pi / 2 if mode == "tangent" else 0)
                # 方向随机：在纹理方向基础上抖动，三成笔完全随机（交错感）
                r = rnd.random()
                if r < 0.12:
                    ang = ang_base + rnd.uniform(-math.pi, math.pi)     # 全随机
                elif r < 0.42:
                    ang = ang_base + rnd.uniform(-0.9, 0.9)             # 大抖动 ±52°
                else:
                    ang = ang_base + rnd.uniform(-0.18, 0.18)           # 小幅抖动 ±10°
                mag = math.hypot(gx[yy, xx], gy[yy, xx])
                # 长度随机：基础长度 ± 大量随机，短线出细节、长线出铺色
                base = step * (2.0 if mag < 8 else 2.6)
                length = base * rnd.uniform(0.35, 2.4) * length_k
                cx = sx + rnd.uniform(-1.5, 1.5)
                cy = sy + rnd.uniform(-1.5, 1.5)
                dx = math.cos(ang) * length / 2
                dy = math.sin(ang) * length / 2
                # 油画的"颜料浓淡"：每笔明暗略变，叠起来有层次
                k = rnd.uniform(0.86, 1.14)
                col = tuple(max(0, min(255, int(c * k))) for c in color)
                # 统一笔宽（用户反馈"有粗有细"反而更乱，回到等宽）
                lw = int(round(SS * step * pen))
                strokes.append((cx - dx, cy - dy, cx + dx, cy + dy, col, max(2, lw)))

    band = step * 6
    strokes.sort(key=lambda s: (int(s[1] // band), rnd.random()))
    return strokes, (w, h)


def render(strokes, size, out_dir: str, fps: int, seconds: float, step: int, pen: float = 1.0):
    w, h = size
    canvas = Image.new("RGB", (w * SS, h * SS), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    frames_dir = os.path.join(out_dir, "frames")
    shutil.rmtree(frames_dir, ignore_errors=True)
    os.makedirs(frames_dir, exist_ok=True)

    total = len(strokes)
    target_frames = max(1, int(fps * seconds))
    every = max(1, total // target_frames)   # 不设上限：笔多就多存帧，靠 seconds 定节奏
    width = max(2, int(round(SS * step * pen)))
    w_max = max(width + 1, int(round(SS * step * pen * 3.5)))   # 粗笔上限
    n = 0
    fi = 0
    for i, s in enumerate(strokes, 1):
        x0, y0, x1, y1, col = s[:5]
        # 每笔自己的宽度（由 build_strokes 决定：有粗有细）
        lw = int(s[5]) if len(s) > 5 else width
        lw = max(2, min(w_max, lw))
        draw.line((x0 * SS, y0 * SS, x1 * SS, y1 * SS), fill=col, width=lw, joint="curve")
        n += 1
        if n >= every or i == total:
            n = 0
            fi += 1
            canvas.resize((w, h), Image.LANCZOS).save(
                os.path.join(frames_dir, f"f_{fi:04d}.jpg"), quality=89
            )
    print(f"strokes={total} frames={fi} size={w}x{h} every={every} width={width}@2x")
    return frames_dir


def encode(frames_dir: str, out_dir: str, fps: int) -> str | None:
    mp4 = os.path.join(out_dir, "hatch.mp4")
    ff = shutil.which("ffmpeg") or os.path.expanduser("~/.local/bin/ffmpeg.exe")
    cmd = [ff, "-y", "-framerate", str(fps), "-i", os.path.join(frames_dir, "f_%04d.jpg"),
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", mp4]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print("ffmpeg 失败：", r.stderr[-800:])
        return None
    print("mp4:", mp4, round(os.path.getsize(mp4) / 1024 / 1024, 2), "MB")
    return mp4


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=720)
    ap.add_argument("--step", type=int, default=6)
    ap.add_argument("--mode", choices=["tangent", "grad"], default="tangent")
    ap.add_argument("--fps", type=int, default=20)
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--pen", type=float, default=1.0, help="笔宽系数，0.5=细笔，1.0=原样")
    ap.add_argument("--layers", type=int, default=1, help="每格叠几笔，>1 出油画厚涂感")
    ap.add_argument("--length-k", type=float, default=1.0, help="笔长整体系数")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    im = load_source(args.src, args.size)
    im.save(os.path.join(args.out, "source.png"))
    strokes, size = build_strokes(im, args.step, args.mode,
                                  layers=args.layers, length_k=args.length_k, pen=args.pen)
    frames_dir = render(strokes, size, args.out, args.fps, args.seconds, args.step, args.pen)
    encode(frames_dir, args.out, args.fps)
    return 0


if __name__ == "__main__":
    sys.exit(main())
