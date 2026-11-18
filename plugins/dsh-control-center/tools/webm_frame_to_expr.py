# -*- coding: utf-8 -*-
r"""webm_frame_to_expr.py —— 把 mortis 的 WebM 抽帧做成高清立绘

为什么要处理：
    dsh-pet 里的 mortis 素材是 **640x360 全身 + 纯黑背景**的 WebM 帧。
    直接放进 300x300 立绘窗有两个问题：① 黑底会变成一个黑方块；② 全身像在这个框里太小。

做法：
    1. 从**四角泛洪填充**把背景变透明（不用阈值全局删黑——她衣服本身有黑色，全局删会吃掉礼服）
    2. 按 alpha 外框裁紧，再裁到**头部+上半身**（和像素版构图一致）
    3. 居中贴到正方形画布，底部对齐
    4. 输出 assets/expr_mortis/<name>.png（高清，不做像素化）

用法：
    python webm_frame_to_expr.py --src frame.png --out assets/expr_mortis/content.png [--crop-bottom 0.62] [--size 768]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def remove_black_bg(im: Image.Image, thresh: int = 16) -> Image.Image:
    """从四角泛洪填充背景为透明。

    用泛洪而不是全局阈值：mortis 的礼服/披风本身有大片黑色，
    全局删黑会把衣服挖空；从四角向外扩散只吃掉"连通到边界的黑"。
    """
    rgba = im.convert('RGBA').copy()
    w, h = rgba.size
    for xy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        # PIL 的 floodfill 支持 RGBA；用带 alpha=0 的目标值把背景抹掉
        ImageDraw.floodfill(rgba, xy, (0, 0, 0, 0), thresh=thresh)
    return rgba


def crop_upper_body(im: Image.Image, bottom_ratio: float) -> Image.Image:
    """按 alpha 外框裁紧后，只保留上部 bottom_ratio（0.62 ≈ 头部到腰）"""
    bb = im.split()[3].getbbox()
    if bb:
        im = im.crop(bb)
    w, h = im.size
    return im.crop((0, 0, w, max(1, int(h * bottom_ratio))))


def place_square(im: Image.Image, size: int, pad: float = 0.96) -> Image.Image:
    """等比缩放到画布高度的 pad，水平居中、底部对齐"""
    w, h = im.size
    nh = int(size * pad)
    nw = max(1, round(w * nh / h))
    if nw > size:
        nw = size
        nh = max(1, round(h * nw / w))
    im = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(im, ((size - nw) // 2, size - nh))
    return canvas


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--size', type=int, default=768)
    ap.add_argument('--crop-bottom', type=float, default=0.62)
    ap.add_argument('--thresh', type=int, default=16)
    args = ap.parse_args()

    src = Image.open(args.src)
    print(f'源图: {src.size} {src.mode}')

    no_bg = remove_black_bg(src, args.thresh)
    bb = no_bg.split()[3].getbbox()
    print(f'抠背景后 alpha 外框: {bb}')

    upper = crop_upper_body(no_bg, args.crop_bottom)
    print(f'裁上半身后: {upper.size}')

    final = place_square(upper, args.size)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    final.save(out, optimize=True)

    # 统计透明占比，确认背景真的被去掉了
    a = np.asarray(final)
    transparent = float((a[..., 3] < 16).mean())
    print(f'输出: {out} {final.size} 透明像素占比 {transparent:.1%}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
