# -*- coding: utf-8 -*-
r"""align_face.py —— 把两张表情图的脸部按像素网格对齐，求出列/行偏移

为什么要做：
    合成"睁眼微笑"时，我把 content 的嘴格子直接拷到 shy 上，
    但两张图的脸在网格上差了几列（content 的头微微偏），
    拷贝后出现一条**竖直的接缝**（同一列格子颜色对不上）。

做法：
    用"眼睛中心"作为对齐锚点——两张图的眼睛都很好找（蓝色高饱和区）。
    返回 (dx, dy)：要把 content 的脸平移多少，才能和 shy 的脸重合。

用法：
    python align_face.py --a shy.png --b content.png
"""
from __future__ import annotations

import argparse
import numpy as np
from PIL import Image


def pixel_small(path: str, grid: int) -> np.ndarray:
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    side = min(w, h)
    im = im.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
    return np.asarray(im.resize((grid, grid), Image.NEAREST))


def eye_centroid(a: np.ndarray) -> tuple[float, float] | None:
    """蓝绿高饱和 -> 眼睛。返回重心（网格坐标）"""
    rgb = a[..., :3].astype(np.float32)
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(2), rgb.min(2)
    m = (B > 90) & (B > R + 25) & (G > R - 10) & ((mx - mn) > 45) & (a[..., 3] > 128)
    # 只留上半部分（防止裙子/蝴蝶结干扰）
    h = m.shape[0]
    m[int(h * 0.62):, :] = False
    if m.sum() < 10:
        return None
    ys, xs = np.where(m)
    return float(xs.mean()), float(ys.mean())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--a', required=True, help='基准图')
    ap.add_argument('--b', required=True, help='要对齐的图')
    ap.add_argument('--grid', type=int, default=128)
    args = ap.parse_args(argv)

    A = pixel_small(args.a, args.grid)
    B = pixel_small(args.b, args.grid)
    ca, cb = eye_centroid(A), eye_centroid(B)
    print(f'A 眼睛重心 = {ca}')
    print(f'B 眼睛重心 = {cb}')
    if ca and cb:
        dx = round(ca[0] - cb[0])
        dy = round(ca[1] - cb[1])
        print(f'把 B 平移 (dx={dx}, dy={dy}) 即可与 A 对齐')
        print(f'JSON: {{"dx": {dx}, "dy": {dy}}}')
    else:
        print('找不到眼睛，无法对齐')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
