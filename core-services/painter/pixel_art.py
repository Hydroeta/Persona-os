# -*- coding: utf-8 -*-
r"""persona-os · 像素画模式（静态处理端，第一步）

职责：把一张生图压成 N×N 的像素画大图。**纯 PIL，不碰 cv2**（本机 cv2 与 numpy 2 不兼容，一 import 就崩）。

流程：
    原图 -> 裁成正方形 -> 缩到 N×N（NEAREST）-> 量化到 K 色 -> 放大回 target（NEAREST）
放大后每个色块都是**完美的正方形**，色数被锁死在 K —— 这就是像素画该有的样子。

用法：
    python pixel_art.py --src 原图.png --out out_dir --sizes 32,128
    python pixel_art.py --src 原图.png --out out_dir --sizes 32 --colors 16 --target 512

只做静态图；铺砖动画在 TS 插件侧（Python 不逐帧渲染）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image


def prepare_square(im: Image.Image) -> Image.Image:
    """居中裁成正方形，保留 alpha。"""
    im = im.convert("RGBA")
    w, h = im.size
    if w == h:
        return im
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return im.crop((left, top, left + side, top + side))


def process_pixel_art(src: Image.Image, n: int, colors: int = 16, target: int = 512) -> Image.Image:
    """生成像素画大图：N×N 个色块，每个色块是 target/N 的正方形。

    - 缩小时用 NEAREST：不做插值平均，块里的颜色来自原图的一个真实像素，不会糊。
    - quantize 在**量化前先转 RGB**，否则 RGBA 会带一堆半透明杂色。
    - 放大也用 NEAREST：保证边缘是硬边、块是正方形，不会出现抗锯齿的毛边。
    """
    if n < 2:
        raise ValueError("N 太小：至少要 2×2")
    if colors < 2 or colors > 256:
        raise ValueError("colors 需在 2~256 之间")
    if target % n != 0:
        # 不能让块边长出现小数 —— 那会让某些块宽 1px、某些宽 2px
        target = (target // n) * n
        if target < n:
            target = n

    sq = prepare_square(src)
    small = sq.resize((n, n), Image.NEAREST)

    # 量化：RGB 空间，保留 colors 个主色
    rgb = Image.new("RGB", small.size, (255, 255, 255))
    rgb.paste(small, mask=small.split()[3] if small.mode == "RGBA" else None)
    quant = rgb.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
    quant = quant.convert("RGB")
    # MEDIANCUT 不给 alpha，重新贴回原始透明度（放大后仍按块）
    alpha_small = small.split()[3].point(lambda v: 255 if v >= 128 else 0)
    quant.putalpha(alpha_small)

    big = quant.resize((target, target), Image.NEAREST)
    return big


def grid_colors(big: Image.Image, n: int, target: int) -> list[list[tuple[int, int, int, int]]]:
    """把大图读回 N×N 颜色矩阵（供 TS 侧对照核验 / 后续动画用）。"""
    step = target // n
    px = big.load()
    out: list[list[tuple[int, int, int, int]]] = []
    for r in range(n):
        row: list[tuple[int, int, int, int]] = []
        for c in range(n):
            row.append(px[c * step + step // 2, r * step + step // 2])
        out.append(row)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="像素画模式：N×N 静态处理")
    ap.add_argument("--src", required=True, help="原图路径")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--sizes", default="32,128", help="逗号分隔的 N 列表，如 32,64,128")
    ap.add_argument("--colors", type=int, default=16, help="量化色数，默认 16")
    ap.add_argument("--target", type=int, default=512, help="输出画幅边长，默认 512（需能被 N 整除）")
    args = ap.parse_args(argv)

    src_path = Path(args.src)
    if not src_path.is_file():
        print(f"找不到原图：{src_path}", file=sys.stderr)
        return 2
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    src = Image.open(src_path)
    print(f"原图：{src_path.name} {src.size[0]}×{src.size[1]}")
    for token in args.sizes.split(","):
        token = token.strip()
        if not token:
            continue
        n = int(token)
        img = process_pixel_art(src, n, colors=args.colors, target=args.target)
        dst = out_dir / f"pixel_{n}.png"
        img.save(dst)
        step = args.target // n
        print(f"  N={n:<4} 块边长 {step}px  色数 {args.colors}  -> {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
