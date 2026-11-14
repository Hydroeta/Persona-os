# -*- coding: utf-8 -*-
r"""make_pixel_avatar.py —— 立绘像素化 + 按亮度分段做**色差修正**

为什么按亮度分段而不是套一个乘法系数：
    乘法会把整段色调一起拖走（高光也变暗、阴影也发灰）。
    实测 USER 与 expr/shy 的头发在**每一档亮度上的色相都不一致**：
        L 40-80    USER (47,61,109)  vs  SRC (40,58,101)
        L 80-120   USER (65,84,140)  vs  SRC (70,98,156)   <- 差最多，G 高了 14
        L 120-160  USER (102,128,179) vs SRC (101,135,190)
    所以做法是：**保留源图的亮度 L，把色相/饱和度换成目标图对应亮度档的**，
    相当于"形状和明暗不变，只把颜色对齐"。

用法：
    python make_pixel_avatar.py --src shy.png --out web/assets --ref user.png \
        --fix hair --grid 128 --size 512
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
from PIL import Image

# 亮度分档（用 L 区间划分，各档单独对齐）
BANDS = [(0, 40), (40, 80), (80, 120), (120, 160), (160, 200), (200, 256)]


def load(p: str) -> np.ndarray:
    return np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)


def luma(a: np.ndarray) -> np.ndarray:
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def hair_mask(a: np.ndarray, top_ratio: float = 0.62) -> np.ndarray:
    h, w = a.shape[:2]
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a[..., :3].max(2), a[..., :3].min(2)
    m = (B > R + 18) & (B > 60) & (B < 220) & (G < B - 5) & ((mx - mn) > 20)
    top = np.zeros((h, w), bool)
    top[: int(h * top_ratio), :] = True
    m &= top
    if a.shape[2] == 4:
        m &= a[..., 3] > 200
    return m


def band_targets(ref: np.ndarray, mask: np.ndarray) -> dict:
    """从参考图统计每一档亮度下的颜色中位数"""
    L = luma(ref)
    out = {}
    for lo, hi in BANDS:
        k = mask & (L >= lo) & (L < hi)
        if k.sum() >= 50:
            out[(lo, hi)] = np.median(ref[..., :3][k], axis=0)
    return out


def apply_bands(src: np.ndarray, mask: np.ndarray, targets: dict) -> np.ndarray:
    """保留源图亮度 L，把颜色替换成该亮度档的目标颜色（保持 L 不变）。

    做法：目标颜色按亮度归一化后乘以源图 L，得到"同样的明暗、不同的色调"。
    """
    out = src.copy()
    L = luma(src)
    for (lo, hi), tgt in targets.items():
        k = mask & (L >= lo) & (L < hi)
        if not k.any():
            continue
        Lt = tgt[0] * 0.299 + tgt[1] * 0.587 + tgt[2] * 0.114
        if Lt < 1e-3:
            continue
        scale = (L[k] / Lt)[..., None]
        out[..., :3][k] = np.clip(tgt[None, :] * scale, 0, 255)
    return out


def pixelize(im: Image.Image, grid: int, size: int) -> Image.Image:
    sq = im.convert('RGBA')
    w, h = sq.size
    side = min(w, h)
    sq = sq.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
    if size % grid != 0:
        size = (size // grid) * grid or grid
    return sq.resize((grid, grid), Image.NEAREST).resize((size, size), Image.NEAREST)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--ref', required=True, help='参考图（目标颜色）')
    ap.add_argument('--out', required=True)
    ap.add_argument('--fix', default='hair', choices=['hair', 'none'])
    ap.add_argument('--grid', type=int, default=128)
    ap.add_argument('--size', type=int, default=512)
    ap.add_argument('--name', default='avatar_pixel')
    args = ap.parse_args(argv)

    ref = load(args.ref)
    src = load(args.src)
    work = src

    if args.fix == 'hair':
        rm = hair_mask(ref)
        sm = hair_mask(src)
        tg = band_targets(ref, rm)
        print('参考图各亮度档颜色：')
        for (lo, hi), c in tg.items():
            print(f'  L {lo:>3}-{hi:<3} -> {c.round(0)}')
        work = apply_bands(src, sm, tg)

    img = Image.fromarray(np.clip(work, 0, 255).astype(np.uint8), 'RGBA')
    px = pixelize(img, args.grid, args.size)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    p = out / f'{args.name}.png'
    px.save(p, optimize=True)
    print(f'{p.name}: {px.size} grid={args.grid} {os.path.getsize(p)//1024} KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
