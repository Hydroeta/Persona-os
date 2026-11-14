# -*- coding: utf-8 -*-
r"""make_smile_pixel.py —— 在**像素网格上**把 content 的微笑嘴贴到 shy 上

为什么在像素网格上做：
    高清阶段贴嘴，肤色填充会留下肉眼可见的方块边界（嘴周肤色有渐变，单色填不上）。
    降到 128 网格后一格 = 4px，嘴只占十几格，直接替换格子**看不出接缝**。

打薄（2026-11-14 加）：
    content 的微笑弧在网格上是一行 6 个格子，在 512 画幅上 = 24px 宽 4px 厚，
    看起来偏粗。做法有两条：
      · thickness=1（默认）：只保留**最中间那 1 行**，横向保留原宽
      · 更薄：再把两端各去掉 1 格（--trim 参数）
    想让它更长更细就调这两项，别去动原图。

用法：
    python make_smile_pixel.py --eyes shy.png --mouth content.png --out smile.png
    python make_smile_pixel.py ... --trim 1        # 两端各去一格，更秀气
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
from PIL import Image

# 嘴部框（相对【正方形裁剪后】的画布，按 shy 标定）
MOUTH_BOX = (0.355, 0.495, 0.560, 0.545)


def pixel_small(im: Image.Image, grid: int) -> Image.Image:
    sq = im.convert('RGBA')
    w, h = sq.size
    side = min(w, h)
    sq = sq.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
    return sq.resize((grid, grid), Image.NEAREST)


def is_mouth_cell(px) -> bool:
    r, g, b, al = px
    if al <= 128:
        return False
    mx, mn = max(r, g, b), min(r, g, b)
    return mx < 235 or (mx - mn) > 45


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--eyes', required=True)
    ap.add_argument('--mouth', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--grid', type=int, default=128)
    ap.add_argument('--size', type=int, default=512)
    ap.add_argument('--box', default='')
    ap.add_argument('--trim', type=int, default=0, help='微笑弧两端各去掉几格，默认 0')
    ap.add_argument('--thickness', type=int, default=0, help='保留几行（0=全保留，>0 只留最长的几行）')
    ap.add_argument('--thin-middle', type=int, default=0,
                    help='中间打薄：把最厚那行的中段掏空几格（两端保留）')
    args = ap.parse_args(argv)

    box = tuple(float(v) for v in args.box.split(',')) if args.box else MOUTH_BOX
    g = args.grid
    base = pixel_small(Image.open(args.eyes), g)
    srcm = pixel_small(Image.open(args.mouth), g)

    x0, y0 = int(g * box[0]), int(g * box[1])
    x1, y1 = int(np.ceil(g * box[2])), int(np.ceil(g * box[3]))

    b = np.asarray(base).copy()
    s = np.asarray(srcm)

    # 收集每一行的嘴格子
    rows = []
    for y in range(y0, y1):
        xs = [x for x in range(x0, x1) if is_mouth_cell(s[y, x])]
        if xs:
            rows.append((y, sorted(xs)))
    if not rows:
        print('没找到嘴部格子')
        return 1
    print('嘴部行：', [(y, len(xs)) for y, xs in rows])

    # 可选：只保留最长的 N 行（整体变薄）
    if args.thickness > 0:
        rows = sorted(rows, key=lambda t: len(t[1]), reverse=True)[:args.thickness]
        rows.sort()

    # 可选：中间打薄 —— 对"格子最多的那一行"，掏空它中间几格，只留两端
    thin_row = None
    if args.thin_middle > 0:
        thin_row = max(rows, key=lambda t: len(t[1]))[0]

    applied = 0
    for y, xs in rows:
        xs = list(xs)
        if args.trim > 0 and len(xs) > 2 * args.trim:
            xs = xs[args.trim: len(xs) - args.trim]
        if y == thin_row and len(xs) > 2:
            k = args.thin_middle
            # 掏空中间 k 格，两端各保留 1 格（若 xs 足够长）
            if len(xs) - 2 * k >= 2:
                mid = len(xs) // 2
                start = mid - k // 2
                del xs[start: start + k]
        for x in xs:
            b[y, x] = s[y, x]
            applied += 1

    out_small = Image.fromarray(b, 'RGBA')
    out_big = out_small.resize((args.size, args.size), Image.NEAREST)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    out_big.save(args.out, optimize=True)
    out_small.save(str(args.out).replace('.png', '_128.png'), optimize=True)
    print(f'替换 {applied} 格  ->  {args.out} {out_big.size} {os.path.getsize(args.out)//1024} KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
