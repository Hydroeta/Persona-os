# -*- coding: utf-8 -*-
"""measure_expr.py —— 量出 16 张表情差分的外框与中心，判断能否像素化后对齐"""
import os
import numpy as np
from PIL import Image

ROOT = r"C:\Users\79365\Documents\douyin-whale\assets\expr"
NAMES = ['aggrieved','blush','content','giggle','joy','nervous','pout','puzzled',
         'sad','scared','shy','sleepy','smug','starry','surprise','wink']

print(f"{'name':<12}{'canvas':>12}{'bbox(w x h)':>16}{'center':>14}{'ratio w/h':>11}")
rows = []
for n in NAMES:
    p = os.path.join(ROOT, n + '.png')
    if not os.path.exists(p):
        print(f"{n:<12} 缺失")
        continue
    im = Image.open(p).convert('RGBA')
    a = np.asarray(im)
    alpha = a[..., 3] > 20
    ys, xs = np.where(alpha)
    if len(xs) == 0:
        print(f"{n:<12} 全透明")
        continue
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    rows.append((n, im.size, bw, bh, cx, cy))
    print(f"{n:<12}{str(im.size):>12}{f'{bw} x {bh}':>16}{f'{cx},{cy}':>14}{bw / bh:>11.3f}")

if rows:
    ws = [r[2] for r in rows]
    hs = [r[3] for r in rows]
    print("-" * 66)
    print(f"宽度范围 {min(ws)}~{max(ws)}  差 {max(ws) - min(ws)}")
    print(f"高度范围 {min(hs)}~{max(hs)}  差 {max(hs) - min(hs)}")
    print(f"宽高比范围 {min(r[2]/r[3] for r in rows):.3f}~{max(r[2]/r[3] for r in rows):.3f}")
