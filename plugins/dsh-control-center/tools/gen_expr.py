# -*- coding: utf-8 -*-
r"""gen_expr.py —— 17 张表情逐张走【同一条】管道：定型 -> 校色 -> 74% 裁切 -> 像素化

为什么要合并成一个脚本：
    之前 smile 是自己拼的（坐标从原图换算），其它 16 张是 make_pixel_expr 单独跑的，
    两条链的校色处理不同（smile 用了 DARKNESS 判据的嘴像素、其余只做整图 sync），
    导致 **smile 的头发/眼睛比其余 16 张暗一档**（63,81,137 vs 66,86,144），
    连"区块颜色和周围不一样"的观感也来自这里。

现在：
    1. 所有图（含 smile 的源图 shy+content 合成结果）先按同一定型：裁紧 -> 高92% -> 发顶对齐 -> 74%裁断 -> 贴底边
    2. **统一校色基准**：以 shy 的头发/眼睛中位数为目标，逐张把头发与眼睛拉到同一档
    3. 统一 128 网格像素化
    这样 17 张的头发/眼睛色值应当完全一致。

用法：
    python gen_expr.py --src <表达式目录> --out web/assets/expr --smile-base shy --smile-mouth content
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

NAMES = ['aggrieved', 'blush', 'content', 'giggle', 'joy', 'nervous', 'pout', 'puzzled',
         'sad', 'scared', 'shy', 'sleepy', 'smug', 'starry', 'surprise', 'wink']

SIZE, GRID = 512, 128
PERSON_H, CROP = 0.92, 0.74


# ---------------- 定型 ----------------
def prepare(path: str, size: int = SIZE, person_h: float = PERSON_H, crop: float = CROP):
    """裁紧 -> 高 person_h -> 发顶对齐 -> 裁上部 crop -> 贴底边。返回 (图, 变换参数)"""
    im = Image.open(path).convert('RGBA')
    bb = im.split()[3].getbbox()
    x0, y0 = bb[0], bb[1]
    im = im.crop(bb)
    w, h = im.size
    nh = int(size * person_h)
    nw = max(1, round(w * nh / h))
    im = im.resize((nw, nh), Image.LANCZOS)
    px = (size - nw) // 2
    py = int(size * 0.02)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(im, (px, py))
    cut = int(size * crop)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.alpha_composite(canvas.crop((0, 0, size, cut)), (0, size - cut))
    return out, dict(w=w, h=h, nw=nw, nh=nh, x0=x0, y0=y0, px=px, py=py, cut=cut, size=size)


# ---------------- 校色 ----------------
def hair_mask(a: np.ndarray) -> np.ndarray:
    h, w = a.shape[:2]
    rgb = a[..., :3].astype(np.float32)
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(2), rgb.min(2)
    m = (B > R + 18) & (B > 60) & (B < 220) & (G < B - 5) & ((mx - mn) > 20)
    top = np.zeros((h, w), bool)
    top[: int(h * 0.62), :] = True
    return m & top & (a[..., 3] > 200)


def eye_mask(a: np.ndarray) -> np.ndarray:
    h, w = a.shape[:2]
    x0, y0, x1, y1 = int(w * 0.20), int(h * 0.34), int(w * 0.72), int(h * 0.55)
    sub = a[y0:y1, x0:x1]
    rgb = sub[..., :3].astype(np.float32)
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(2), rgb.min(2)
    m = (B > 90) & (B > R + 25) & (G > R - 10) & ((mx - mn) > 45) & (sub[..., 3] > 200)
    full = np.zeros((h, w), bool)
    full[y0:y1, x0:x1] = m
    return full


def med(a: np.ndarray, m: np.ndarray):
    return np.median(a[..., :3].astype(np.float32)[m], axis=0) if m.any() else None


def recolor(a: np.ndarray, m: np.ndarray, target: np.ndarray, feather: int = 2) -> np.ndarray:
    cur = med(a, m)
    if cur is None or not m.any():
        return a
    ratio = np.maximum(target, 1e-3) / np.maximum(cur, 1e-3)
    soft = np.asarray(
        Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(feather))
    ).astype(np.float32) / 255.0
    k = soft[..., None]
    out = a.astype(np.float32).copy()
    out[..., :3] = out[..., :3] * (1.0 - k + k * ratio)
    return out


# ---------------- 主流程 ----------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args(argv)

    src = Path(args.src)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # 1) 全部定型
    prepped = {}
    for n in NAMES + ['smile']:
        p = src / f'{n}.png'
        if p.exists():
            prepped[n], _ = prepare(str(p))
        else:
            print(f'  跳过（缺失）{n}')

    # 2) 校色目标：取 shy + content 的头发/眼睛中位数（这两张最"标准"）
    refs = [k for k in ('shy', 'content') if k in prepped]
    t_hair = np.median(np.stack([med(np.asarray(prepped[k]), hair_mask(np.asarray(prepped[k]))) for k in refs]), axis=0)
    t_eye = np.median(np.stack([med(np.asarray(prepped[k]), eye_mask(np.asarray(prepped[k]))) for k in refs]), axis=0)
    print(f'统一目标  头发={t_hair.round(0)}  眼睛={t_eye.round(0)}')

    # 3) 逐张校色 + 像素化
    report = {}
    for n, img in prepped.items():
        a = np.asarray(img)
        a = recolor(a, hair_mask(a), t_hair)
        a = recolor(a, eye_mask(a), t_eye)
        fixed = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')
        px = fixed.resize((GRID, GRID), Image.NEAREST).resize((SIZE, SIZE), Image.NEAREST)
        dst = out / f'pixel_{n}.png'
        px.save(dst, optimize=True)
        b = np.asarray(px)
        report[n] = dict(hair=med(b, hair_mask(b)).round(0).tolist(),
                         eye=med(b, eye_mask(b)).round(0).tolist(),
                         kb=round(os.path.getsize(dst) / 1024, 1))
        print(f'  {n:<12} 头发={report[n]["hair"]}  眼睛={report[n]["eye"]}  {report[n]["kb"]}KB')

    (out / 'meta.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('done ->', out)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
