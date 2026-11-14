# -*- coding: utf-8 -*-
r"""make_pixel_expr.py —— 16 张表情差分 -> 像素版 + 上半身裁切（默认裁到围裙一半）

对齐策略（关键）：
    1. 先在**原图**上按 alpha 外框裁紧
    2. 缩放到统一高度（人物高 = 画幅的 92%）
    3. **按头部对齐**：以"发顶"为基准，而不是脚底 —— 上半身构图要看头
    4. 裁到 **腰部**（围裙一半左右），比例可调
    5. 最后统一像素化（NEAREST），保证所有帧格子严格对齐

用法：
    python make_pixel_expr.py --src <expr目录> --out web/assets/expr --grid 128 --size 512 \
        --crop-bottom 0.74          # 74% 处裁断 ≈ 围裙一半
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

NAMES = ['aggrieved', 'blush', 'content', 'giggle', 'joy', 'nervous', 'pout', 'puzzled',
         'sad', 'scared', 'shy', 'sleepy', 'smug', 'starry', 'surprise', 'wink']

BANDS = [(0, 40), (40, 80), (80, 120), (120, 160), (160, 200), (200, 256)]


def luma(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def hair_mask(a):
    h, w = a.shape[:2]
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a[..., :3].max(2), a[..., :3].min(2)
    m = (B > R + 18) & (B > 60) & (B < 220) & (G < B - 5) & ((mx - mn) > 20)
    top = np.zeros((h, w), bool)
    top[: int(h * 0.62), :] = True
    m &= top
    if a.shape[2] == 4:
        m &= a[..., 3] > 200
    return m


def band_targets(ref_path: str) -> dict:
    """从参考图取每个亮度档的头发颜色"""
    ref = np.asarray(Image.open(ref_path).convert('RGBA')).astype(np.float32)
    m = hair_mask(ref)
    L = luma(ref)
    out = {}
    for lo, hi in BANDS:
        k = m & (L >= lo) & (L < hi)
        if k.sum() >= 50:
            out[(lo, hi)] = np.median(ref[..., :3][k], axis=0)
    return out


def recolor_hair(a: np.ndarray, targets: dict) -> np.ndarray:
    if not targets:
        return a
    m = hair_mask(a)
    L = luma(a)
    out = a.copy()
    for (lo, hi), t in targets.items():
        k = m & (L >= lo) & (L < hi)
        if not k.any():
            continue
        Lt = float(t[0]) * 0.299 + float(t[1]) * 0.587 + float(t[2]) * 0.114
        if Lt < 1e-3:
            continue
        out[..., :3][k] = np.clip(t[None, :] * (L[k] / Lt)[..., None], 0, 255)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='原表情目录')
    ap.add_argument('--out', required=True)
    ap.add_argument('--ref', default='', help='头发配色参考图（可选）')
    ap.add_argument('--grid', type=int, default=128)
    ap.add_argument('--size', type=int, default=512)
    ap.add_argument('--person-h', type=float, default=0.92, help='人物高度占画幅比例')
    ap.add_argument('--crop-bottom', type=float, default=0.74, help='在画幅的这个比例处裁断（围裙一半≈0.74）')
    args = ap.parse_args(argv)

    targets = band_targets(args.ref) if args.ref else {}
    if targets:
        print(f'头发配色档位：{len(targets)} 个')

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # 第一遍：统一缩放到"人物高度 = person_h * size"，按**发顶**对齐到画幅顶部留白
    sized = []
    for n in NAMES:
        p = Path(args.src) / f'{n}.png'
        if not p.exists():
            print(f'  跳过（缺失）{n}')
            continue
        im = Image.open(p).convert('RGBA')
        a = np.asarray(im).astype(np.float32)
        a = recolor_hair(a, targets)
        im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')
        bb = im.split()[3].getbbox()
        if bb:
            im = im.crop(bb)
        w, h = im.size
        nh = int(args.size * args.person_h)
        nw = max(1, round(w * nh / h))
        im = im.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new('RGBA', (args.size, args.size), (0, 0, 0, 0))
        # 水平居中；顶部留 2% 空白（发顶对齐）
        canvas.alpha_composite(im, ((args.size - nw) // 2, int(args.size * 0.02)))
        sized.append((n, canvas))

    # 第二遍：统一裁到 crop_bottom，再像素化
    # 关键：裁完后**把内容贴到底边**，否则下半是透明区，前端 object-fit 会把人顶到上面、
    # 下面是空的，看起来和画框对不齐。
    cut = int(args.size * args.crop_bottom)
    for n, canvas in sized:
        crop = canvas.crop((0, 0, args.size, cut))
        final = Image.new('RGBA', (args.size, args.size), (0, 0, 0, 0))
        final.alpha_composite(crop, (0, args.size - cut))   # 底边对齐
        px = final.resize((args.grid, args.grid), Image.NEAREST).resize((args.size, args.size), Image.NEAREST)
        dst = out / f'pixel_{n}.png'
        px.save(dst, optimize=True)
        print(f'  {dst.name:<26} 裁到 {args.crop_bottom:.0%}  底边对齐  {os.path.getsize(dst)//1024} KB')

    (out / 'meta.json').write_text(json.dumps({
        'grid': args.grid, 'size': args.size,
        'person_h': args.person_h, 'crop_bottom': args.crop_bottom,
        'names': [n for n, _ in sized],
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print('done')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
