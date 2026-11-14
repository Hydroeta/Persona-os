# -*- coding: utf-8 -*-
"""calibrate_face.py —— 在【正方形裁剪后】的图上标眼睛/嘴的位置

不靠目测：把脸区域按 10% 网格切开，输出带网格坐标的放大图，
照着读数直接写进 make_pixel_avatar.py 的 DEFAULT_FACE。
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else "calib.png"
im = Image.open(src).convert("RGBA")
w, h = im.size
side = min(w, h)
sq = im.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side)).convert("RGB")

# 脸大致在 0.15~0.75 x、0.30~0.62 y，切出来放大 2 倍再叠网格
crop = sq.crop((int(side * 0.10), int(side * 0.28), int(side * 0.78), int(side * 0.64)))
scale = 2
crop = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
d = ImageDraw.Draw(crop)
# 网格步长 = 原图 0.02（即正方形边长的 2%）
step_px = side * 0.02 * scale
x0, y0 = int(side * 0.10), int(side * 0.28)
gx = 0
while gx * step_px < crop.width:
    val = round((x0 + gx * side * 0.02) / side, 2)
    d.line([(gx * step_px, 0), (gx * step_px, crop.height)], fill=(0, 255, 255) if gx % 5 else (255, 80, 80), width=1)
    if gx % 5 == 0:
        d.text((gx * step_px + 2, 2), f"{val:.2f}", fill=(255, 255, 0))
    gx += 1
gy = 0
while gy * step_px < crop.height:
    val = round((y0 + gy * side * 0.02) / side, 2)
    d.line([(0, gy * step_px), (crop.width, gy * step_px)], fill=(0, 255, 255) if gy % 5 else (255, 80, 80), width=1)
    if gy % 5 == 0:
        d.text((2, gy * step_px + 1), f"{val:.2f}", fill=(255, 255, 0))
    gy += 1
crop.save(out)
print("写出", out, crop.size)
