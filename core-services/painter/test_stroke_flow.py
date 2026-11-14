#!/usr/bin/env python3
"""test_stroke_flow.py —— 笔触堆叠法（流场平滑版）

在 test_stroke.py（网格排线）的骨架上，把「单点 Sobel 方向」升级成**结构张量流场**：

  1. 灰度 -> Sobel(gx, gy)
  2. 结构张量  J = [[gx², gx·gy], [gx·gy, gy²]]，三个分量各自做高斯平滑
  3. 主方向 theta = ½·atan2(2·Jxy, Jxx−Jyy)，笔触取**垂直方向**（沿纹理走 = 切线）
  4. 平滑后的方向不会在噪声处乱跳，发丝/轮廓的走向是连续的

其余**全部沿用旧版**（这三点是它铺色好看的原因，不能丢）：
  · 网格采样（笔数由 step 决定，可控）
  · 粗线（笔宽 = step×超采样倍率）铺满，太细像划痕
  · 按 y 条带排序（一块块从上往下铺，不是满天飞点）

本机没有 cv2（会和 numpy 2 的 ABI 冲突，装坏了 .venv-tts 里 TTS/RVC 全挂），
Sobel 与高斯全部用 numpy + PIL 实现。

用法：
  <venv-tts 的 python> test_stroke_flow.py --src <图> --out <目录> \
      [--size 720] [--step 6] [--fps 20] [--seconds 20] [--flow-blur 6]
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
from PIL import Image, ImageDraw, ImageFilter

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


def flow_field(gx: np.ndarray, gy: np.ndarray, blur: int = 6):
    """结构张量流场：返回 (平滑后的梯度主方向 theta, 归一化强度 mag)。

    做法：
      Jxx = gx², Jyy = gy², Jxy = gx·gy  —— 三个分量各做一次高斯平滑
      theta = ½·atan2(2·Jxy, Jxx − Jyy)
    平滑后方向在噪声处不会乱跳，容易形成连续的「丝」。
    """
    jxx, jyy, jxy = gx * gx, gy * gy, gx * gy

    def smooth(a: np.ndarray) -> np.ndarray:
        lo, hi = float(a.min()), float(a.max())
        span = max(hi - lo, 1e-6)
        # 归一化到 0~255 再过 PIL 高斯，避免浮点精度损失
        n = ((a - lo) / span * 255).astype(np.uint8)
        s = np.asarray(Image.fromarray(n).filter(ImageFilter.GaussianBlur(blur))).astype(np.float32)
        return s / 255.0 * span + lo

    sxx, syy, sxy = smooth(jxx), smooth(jyy), smooth(jxy)
    theta = 0.5 * np.arctan2(2 * sxy, sxx - syy)
    mag = np.sqrt(sxx + syy)
    mag = mag / (mag.max() + 1e-6)          # 归一化到 0~1
    return theta.astype(np.float32), mag.astype(np.float32)


def build_strokes(im: Image.Image, step: int, mode: str, seed: int = 7, flow_blur: int = 6):
    rnd = random.Random(seed)
    rgb = np.asarray(im, dtype=np.float32)
    gray = rgb.mean(axis=2)
    gx, gy = sobel(gray)
    h, w = gray.shape

    # ---- 结构张量流场：把单点方向平滑成连续方向 ----
    theta, mag_s = flow_field(gx, gy, blur=flow_blur)

    strokes = []
    for y in range(step // 2, h, step):
        for x in range(step // 2, w, step):
            block = rgb[max(0, y - 3): y + 4, max(0, x - 3): x + 4].reshape(-1, 3)
            lum = block.mean(axis=1)
            ink = block[lum < 245]
            if len(ink) < 4 and lum.mean() > 246:  # 纯白背景不落笔
                continue
            src_block = ink if len(ink) >= 3 else block
            color = tuple(int(v) for v in np.median(src_block, axis=0))

            # 用**平滑后的流场方向**替代单点 Sobel
            ang = float(theta[y, x]) + (math.pi / 2 if mode == "tangent" else 0)
            mag = float(mag_s[y, x])
            base = step * (2.0 if mag < 0.2 else 2.6)
            length = base * rnd.uniform(0.7, 1.3)
            cx = x + rnd.uniform(-1.5, 1.5)
            cy = y + rnd.uniform(-1.5, 1.5)
            dx = math.cos(ang) * length / 2
            dy = math.sin(ang) * length / 2
            k = rnd.uniform(0.94, 1.06)
            col = tuple(max(0, min(255, int(c * k))) for c in color)
            strokes.append((cx - dx, cy - dy, cx + dx, cy + dy, col))

    band = step * 6
    strokes.sort(key=lambda s: (int(s[1] // band), rnd.random()))
    return strokes, (w, h)


def render(strokes, size, out_dir: str, fps: int, seconds: float, step: int):
    w, h = size
    canvas = Image.new("RGB", (w * SS, h * SS), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    frames_dir = os.path.join(out_dir, "frames")
    shutil.rmtree(frames_dir, ignore_errors=True)
    os.makedirs(frames_dir, exist_ok=True)

    total = len(strokes)
    target_frames = max(1, int(fps * seconds))
    every = max(1, total // target_frames)   # 不设上限：笔多就多存帧，靠 seconds 定节奏
    width = max(3, int(round(SS * step)))
    n = 0
    fi = 0
    for i, (x0, y0, x1, y1, col) in enumerate(strokes, 1):
        draw.line((x0 * SS, y0 * SS, x1 * SS, y1 * SS), fill=col, width=width, joint="curve")
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
    ap.add_argument("--flow-blur", type=int, default=6, help="结构张量平滑半径，越大方向越连续")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    im = load_source(args.src, args.size)
    im.save(os.path.join(args.out, "source.png"))
    strokes, size = build_strokes(im, args.step, args.mode, flow_blur=args.flow_blur)
    frames_dir = render(strokes, size, args.out, args.fps, args.seconds, args.step)
    encode(frames_dir, args.out, args.fps)
    return 0


if __name__ == "__main__":
    sys.exit(main())
