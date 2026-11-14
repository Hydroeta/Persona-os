# -*- coding: utf-8 -*-
r"""sync_colors.py —— 把 16 张表情图的**头发**和**眼睛**颜色统一同步到参考图

为什么不能只做一次：每一张脸的构图不同，头发在画面里占的像素集合也不同，
如果按整图乘系数，每张都会被不同程度地拉偏。所以这里：
    1. 逐张单独测「头发 mask 内」和「眼睛 mask 内」的颜色中位数
    2. 逐张单独算各自的系数（乘到参考图的中位数）
    3. 只在这两块 mask 内做修正，边缘羽化，别处一律不动

用法：
    python sync_colors.py --src <expr目录> --ref <参考图> --out <输出目录>
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

NAMES = ['aggrieved', 'blush', 'content', 'giggle', 'joy', 'nervous', 'pout', 'puzzled',
         'sad', 'scared', 'shy', 'sleepy', 'smug', 'starry', 'surprise', 'wink']

EYE_BOX = (0.22, 0.36, 0.70, 0.52)


def load_rgba(p: str) -> np.ndarray:
    return np.asarray(Image.open(p).convert('RGBA')).astype(np.float32)


def hair_mask(a: np.ndarray) -> np.ndarray:
    h, w = a.shape[:2]
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a[..., :3].max(2), a[..., :3].min(2)
    m = (B > R + 18) & (B > 60) & (B < 220) & (G < B - 5) & ((mx - mn) > 20)
    top = np.zeros((h, w), bool)
    top[: int(h * 0.62), :] = True
    return m & top & (a[..., 3] > 200)


def eye_mask(a: np.ndarray) -> np.ndarray:
    h, w = a.shape[:2]
    x0, y0, x1, y1 = int(w * EYE_BOX[0]), int(h * EYE_BOX[1]), int(w * EYE_BOX[2]), int(h * EYE_BOX[3])
    sub = a[y0:y1, x0:x1]
    R, G, B = sub[..., 0], sub[..., 1], sub[..., 2]
    mx, mn = sub[..., :3].max(2), sub[..., :3].min(2)
    m = (B > 90) & (B > R + 25) & (G > R - 10) & ((mx - mn) > 45) & (sub[..., 3] > 200)
    full = np.zeros((h, w), bool)
    full[y0:y1, x0:x1] = m
    return full


def median_of(a: np.ndarray, m: np.ndarray):
    if not m.any():
        return None
    return np.median(a[..., :3][m], axis=0)


def apply_mask(a: np.ndarray, m: np.ndarray, target: np.ndarray, feather: int = 2) -> np.ndarray:
    cur = median_of(a, m)
    if cur is None:
        return a
    ratio = np.maximum(target, 1e-3) / np.maximum(cur, 1e-3)
    soft = np.asarray(
        Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(feather))
    ).astype(np.float32) / 255.0
    k = soft[..., None]
    out = a.copy()
    out[..., :3] = a[..., :3] * (1.0 - k + k * ratio)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--ref', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--only', default='', help='只处理这几张（逗号分隔），默认全部')
    args = ap.parse_args(argv)

    ref = load_rgba(args.ref)
    t_hair = median_of(ref, hair_mask(ref))
    t_eye = median_of(ref, eye_mask(ref))
    print(f'参考图 头发={None if t_hair is None else t_hair.round(0)}  眼睛={None if t_eye is None else t_eye.round(0)}')

    names = [n.strip() for n in args.only.split(',') if n.strip()] or NAMES
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    for n in names:
        p = Path(args.src) / f'{n}.png'
        if not p.exists():
            print(f'  跳过 {n}')
            continue
        a = load_rgba(str(p))
        h0 = median_of(a, hair_mask(a))
        e0 = median_of(a, eye_mask(a))
        if t_hair is not None:
            a = apply_mask(a, hair_mask(a), t_hair)
        if t_eye is not None:
            a = apply_mask(a, eye_mask(a), t_eye)
        h1 = median_of(a, hair_mask(a))
        e1 = median_of(a, eye_mask(a))
        dst = out / f'{n}.png'
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA').save(dst, optimize=True)
        fmt = lambda v: 'None' if v is None else '(%d,%d,%d)' % tuple(v.round(0))
        print(f'  {n:<12} 头发 {fmt(h0)} -> {fmt(h1)}   眼睛 {fmt(e0)} -> {fmt(e1)}')
    print('done ->', out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
