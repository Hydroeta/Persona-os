# -*- coding: utf-8 -*-
"""measure_align.py —— 逐张量表情图的内容外框，检查是否统一对齐"""
import numpy as np
import os
from PIL import Image

D = r"C:\Users\79365\Desktop\新建文件夹 (2)\github-release\persona-os\plugins\dsh-control-center\web\assets\expr"
NAMES = ['smile','shy','content','joy','giggle','smug','starry','nervous','blush',
         'surprise','sleepy','wink','scared','sad','pout','puzzled','aggrieved']

rows = []
for n in NAMES:
    p = os.path.join(D, f'pixel_{n}.png')
    if not os.path.exists(p):
        continue
    a = np.asarray(Image.open(p).convert('RGBA'))
    m = a[..., 3] > 20
    ys, xs = np.where(m)
    cx = (xs.min() + xs.max()) / 2.0
    cy = (ys.min() + ys.max()) / 2.0
    rows.append(dict(name=n, x0=int(xs.min()), x1=int(xs.max()),
                     y0=int(ys.min()), y1=int(ys.max()),
                     cx=cx, cy=cy,
                     w=int(xs.max() - xs.min() + 1), h=int(ys.max() - ys.min() + 1)))

hdr = "{:<12}{:>6}{:>6}{:>6}{:>6}{:>9}{:>9}{:>6}{:>6}"
print(hdr.format('name', 'x0', 'x1', 'y0', 'y1', 'cx', 'cy', 'w', 'h'))
for r in rows:
    print(hdr.format(r['name'], r['x0'], r['x1'], r['y0'], r['y1'],
                     f"{r['cx']:.0f}", f"{r['cy']:.0f}", r['w'], r['h']))

print()
print('水平中心 min/max:', min(r['cx'] for r in rows), max(r['cx'] for r in rows))
print('垂直中心 min/max:', min(r['cy'] for r in rows), max(r['cy'] for r in rows))
print('宽度   min/max:', min(r['w'] for r in rows), max(r['w'] for r in rows))
print('高度   min/max:', min(r['h'] for r in rows), max(r['h'] for r in rows))
print('底边   min/max:', min(r['y1'] for r in rows), max(r['y1'] for r in rows))
print('顶边   min/max:', min(r['y0'] for r in rows), max(r['y0'] for r in rows))
