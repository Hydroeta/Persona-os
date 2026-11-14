# -*- coding: utf-8 -*-
r"""make_smile.py —— 用 shy（睁眼）+ content（微笑嘴）合成 "睁眼微笑"

做法：
    1. 以 shy 为底图
    2. 在嘴的位置用**周围肤色中位数**把原来的闭嘴线填掉
    3. 从 content 抠出微笑的嘴（只取嘴部框内、非肤色像素），贴到 shy 的嘴位置
    4. 边缘羽化，避免硬接缝
    5. 输出（后续交给 make_pixel_expr.py 做像素化）

对齐依据：两张图都是同一套立绘，先按**脸部关键点**归一化到同一坐标，再贴。
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# 嘴部框（相对人脸归一化坐标，基于 shy 正脸标定）
MOUTH_BOX = (0.36, 0.50, 0.55, 0.58)     # x0,y0,x1,y1
# 取肤色的环形区域（嘴周围一圈）
SKIN_RING = (0.30, 0.44, 0.62, 0.62)


def load(p: str) -> Image.Image:
    return Image.open(p).convert('RGBA')


def skin_fill(im: Image.Image, box, ring) -> Image.Image:
    """用嘴周围一圈的肤色中位数填掉嘴部区域"""
    a = np.asarray(im).astype(np.float32)
    h, w = a.shape[:2]
    rx0, ry0, rx1, ry1 = int(w * ring[0]), int(h * ring[1]), int(w * ring[2]), int(h * ring[3])
    ring_px = a[ry0:ry1, rx0:rx1, :3]
    alpha = a[ry0:ry1, rx0:rx1, 3] > 200
    # 只取"像皮肤"的像素：亮且低饱和
    mx = ring_px.max(2)
    mn = ring_px.min(2)
    skin = (mx > 200) & ((mx - mn) < 40) & alpha
    if skin.sum() < 50:
        print('  肤色采样不足，跳过填色')
        return im
    color = np.median(ring_px[skin], axis=0)
    x0, y0, x1, y1 = int(w * box[0]), int(h * box[1]), int(w * box[2]), int(h * box[3])
    a[y0:y1, x0:x1, :3] = color
    print(f'  肤色 = {color.round(0)}，填掉嘴部框 {box}')
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA')


def mouth_patch(src: Image.Image, box) -> tuple[Image.Image, np.ndarray]:
    """从 src 抠出嘴部（非肤色像素），返回 RGBA patch 与它的 alpha"""
    a = np.asarray(src).astype(np.float32)
    h, w = a.shape[:2]
    x0, y0, x1, y1 = int(w * box[0]), int(h * box[1]), int(w * box[2]), int(h * box[3])
    sub = a[y0:y1, x0:x1]
    rgb = sub[..., :3]
    mx = rgb.max(2)
    mn = rgb.min(2)
    # 嘴：明显不是肤色（偏暗/偏红/饱和高）
    is_mouth = ((mx < 235) | ((mx - mn) > 45)) & (sub[..., 3] > 200)
    patch = np.zeros_like(sub)
    patch[..., :3] = sub[..., :3]
    patch[..., 3] = np.where(is_mouth, 255, 0)
    return Image.fromarray(patch.astype(np.uint8), 'RGBA'), is_mouth


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--eyes', required=True, help='提供眼睛的图（shy）')
    ap.add_argument('--mouth', required=True, help='提供嘴的图（content）')
    ap.add_argument('--out', required=True)
    ap.add_argument('--feather', type=int, default=2)
    args = ap.parse_args(argv)

    base = load(args.eyes)
    mouth_src = load(args.mouth)

    # 两张图先统一到同一尺寸（按宽度归一）
    W = 800
    def fit(im):
        w, h = im.size
        return im.resize((W, round(h * W / w)), Image.LANCZOS)
    base = fit(base)
    mouth_src = fit(mouth_src)
    if base.size != mouth_src.size:
        hh = min(base.height, mouth_src.height)
        base = base.crop((0, 0, W, hh))
        mouth_src = mouth_src.crop((0, 0, W, hh))

    # 1) 先清掉 base 原来的嘴
    cleaned = skin_fill(base, MOUTH_BOX, SKIN_RING)

    # 2) 抠 mouth_src 的嘴
    patch, mask = mouth_patch(mouth_src, MOUTH_BOX)
    if not mask.any():
        print('  没抠到嘴部像素，放弃')
        return 1
    ys, xs = np.where(mask)
    print(f'  抠到嘴 {mask.sum()} 像素，框 {xs.min()}~{xs.max()} x {ys.min()}~{ys.max()}')

    # 3) 用 patch 的嘴部质心对齐 cleaned 的嘴部中心
    a2 = np.asarray(cleaned).astype(np.float32)
    h, w = a2.shape[:2]
    pb = MOUTH_BOX
    tx = int(w * (pb[0] + pb[2]) / 2)
    ty = int(h * (pb[1] + pb[3]) / 2)
    px = int((xs.min() + xs.max()) / 2)
    py = int((ys.min() + ys.max()) / 2)
    dx, dy = tx - px, ty - py
    print(f'  贴图位移 dx={dx} dy={dy}')

    # 4) 羽化后合成
    soft = patch.filter(ImageFilter.GaussianBlur(args.feather))
    layer = Image.new('RGBA', cleaned.size, (0, 0, 0, 0))
    layer.alpha_composite(soft, (dx, dy))
    out_img = Image.alpha_composite(cleaned, layer)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    out_img.save(args.out, optimize=True)
    print(f'输出 {args.out} {out_img.size} {os.path.getsize(args.out)//1024} KB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
