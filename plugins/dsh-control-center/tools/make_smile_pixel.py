# -*- coding: utf-8 -*-
r"""make_smile_pixel.py —— 在像素网格上把 content 的微笑嘴贴到 shy 上（v3，修误伤）

前两版的教训：
    v1 用"非肤色即嘴"当判据 -> 把围裙白蕾丝、蝴蝶结全当成嘴拷了进去，
      在 y76~89（肩膀/围裙位置）留下一片浅灰白格子，看起来像一条竖直脏缝。
    v2 在高清图贴嘴 -> 肤色填充留方块边界。

v3 的判据（三条同时满足才算"嘴"）：
    ① **位置**：只在脸中央的小框里找（相对正方形画布 x 0.36~0.54, y 0.47~0.55）
    ② **颜色偏暗**：max(r,g,b) < 200 —— 排除围裙/蕾丝/眼白这类亮色
    ③ **偏红**：r >= b 或在暗色区间（嘴唇/口腔都是暗红或深色）

用法：
    python make_smile_pixel.py --eyes shy.png --mouth content.png --out web/assets/expr/pixel_smile.png \
        --grid 128 --size 512 --crop-bottom 0.74 --person-h 0.92 --thin-middle 2
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
from PIL import Image

# 嘴的搜索框（相对【正方形裁方后】的画布）
# 实测 content 的微笑弧在 128 网格的 y65~66（约 0.508~0.516），框收紧到这个范围
MOUTH_BOX = (0.40, 0.495, 0.52, 0.535)

# 相对肤色的"暗度阈值"：比周围肤色暗这么多才算嘴
# 实测：弧端点 (139,114,107) 暗 130+，弧边缘 (208,184,174) 只暗 40 左右，
# 而围裙白蕾丝比肤色更亮 —— 用"比肤色暗"当判据，天然不会误伤围裙。
DARKNESS = 15


def pixel_small(path: str, grid: int) -> Image.Image:
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    side = min(w, h)
    im = im.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
    return im.resize((grid, grid), Image.NEAREST)


def skin_reference(a: np.ndarray, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    """取嘴框**外面**一圈的亮像素当肤色基准（比框内最亮的还准）"""
    h, w = a.shape[:2]
    ring = []
    for y in range(max(0, y0 - 6), min(h, y1 + 6)):
        for x in range(max(0, x0 - 6), min(w, x1 + 6)):
            if x0 <= x < x1 and y0 <= y < y1:
                continue
            p = a[y, x]
            if int(p[3]) <= 128:
                continue
            r, g, b = int(p[0]), int(p[1]), int(p[2])
            if min(r, g, b) > 200 and abs(r - b) < 45:   # 亮且不偏蓝 = 肤色
                ring.append((r, g, b))
    if not ring:
        return np.array([247, 225, 210], dtype=np.float32)
    return np.median(np.array(ring, dtype=np.float32), axis=0)


def is_mouth(px, skin: np.ndarray) -> bool:
    """判据：不透明 + 不偏蓝 + **明显比肤色暗**（围裙更亮，头发更蓝，都不会命中）"""
    r, g, b, al = int(px[0]), int(px[1]), int(px[2]), int(px[3])
    if al <= 128:
        return False
    if b > r + 30:                       # 偏蓝 -> 头发
        return False
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    skin_lum = 0.299 * skin[0] + 0.587 * skin[1] + 0.114 * skin[2]
    return (skin_lum - lum) > DARKNESS


def find_mouth_rows(s: np.ndarray, x0: int, y0: int, x1: int, y1: int, skin: np.ndarray):
    rows = []
    for y in range(y0, y1):
        xs = [x for x in range(x0, x1) if is_mouth(s[y, x], skin)]
        if xs:
            rows.append((y, sorted(xs)))
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--eyes', required=True)
    ap.add_argument('--mouth', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--grid', type=int, default=128)
    ap.add_argument('--size', type=int, default=512)
    ap.add_argument('--box', default='', help='x0,y0,x1,y1 相对比例，覆盖默认嘴框')
    ap.add_argument('--thin-middle', type=int, default=2, help='最厚那行中间掏空几格')
    ap.add_argument('--person-h', type=float, default=0.92)
    ap.add_argument('--crop-bottom', type=float, default=0.74)
    args = ap.parse_args(argv)

    box = tuple(float(v) for v in args.box.split(',')) if args.box else MOUTH_BOX
    g = args.grid

    b_img = pixel_small(args.eyes, g)
    s_img = pixel_small(args.mouth, g)
    b = np.asarray(b_img).copy()
    s = np.asarray(s_img)

    x0, y0 = int(g * box[0]), int(g * box[1])
    x1, y1 = int(np.ceil(g * box[2])), int(np.ceil(g * box[3]))
    skin = skin_reference(s, x0, y0, x1, y1)
    print('肤色基准 =', skin.round(0))
    rows = find_mouth_rows(s, x0, y0, x1, y1, skin)
    if not rows:
        print('搜索框内没找到嘴的格子，打印该区域以便调框：')
        for y in range(y0, y1):
            line = ''
            for x in range(x0, x1):
                line += '#' if is_mouth(s[y, x], skin) else '.'
            print(f'{y:3d} {line}')
        return 1

    print('嘴部行：', [(y, len(xs)) for y, xs in rows])
    thin_row = max(rows, key=lambda t: len(t[1]))[0]

    applied = 0
    for y, xs in rows:
        xx = list(xs)
        if y == thin_row and args.thin_middle > 0 and len(xx) > args.thin_middle + 1:
            mid = len(xx) // 2
            k = args.thin_middle
            start = mid - k // 2
            del xx[start:start + k]
        for x in xx:
            b[y, x] = s[y, x]
            applied += 1
    print(f'替换 {applied} 格（打薄行 y={thin_row}）')

    # 与 16 张相同的收尾：74% 裁断 + 贴底边 + 放大
    cut = round(g * args.crop_bottom)
    cropped = np.zeros_like(b)
    cropped[g - cut:, :] = b[:cut, :]
    out = Image.fromarray(cropped, 'RGBA').resize((args.size, args.size), Image.NEAREST)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    out.save(args.out, optimize=True)
    a = np.asarray(out)
    ys = np.where((a[..., 3] > 20).any(1))[0]
    print(f'内容行 {ys.min()}~{ys.max()}（16 张是 144~511）  {os.path.getsize(args.out)//1024} KB -> {args.out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
