# -*- coding: utf-8 -*-
r"""make_pixel_avatar.py —— 从一张立绘生成像素风主图 + 眨眼/说话微变体

设计要点（都是踩过坑总结的）：
1. **先定型、后标定坐标**：所有变体都走同一个 `pixelize()`，坐标一律写在
   `pixelize()` 内部那套「正方形裁剪后」的坐标系上，避免裁完偏移。
2. **不量化颜色**（--colors 0 默认）：蓝灰色调在 16/32 色下会发脏，
   像素画靠的是 NEAREST 的硬边，不是靠压色数。
3. 眼睛/嘴巴位置用**比例 + 可覆盖**：换图只要改 `--face` 或传新的 mark 参数。

用法：
    python make_pixel_avatar.py --src puzzled.png --out ../web/assets --grid 128 --size 512
    python make_pixel_avatar.py --src x.png --out d --grid 128 --colors 32   # 要限色时显式给
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw

# 脸部件相对【正方形裁剪后】画布的位置与大小
DEFAULT_FACE = {
    "left_eye":  (0.300, 0.472),
    "right_eye": (0.512, 0.452),
    "mouth":     (0.404, 0.514),
    "eye_w":     0.088,
    "eye_h":     0.052,
    "mouth_w":   0.050,
    "mouth_h":   0.026,
    "skin":      [252, 235, 224, 255],
    "line":      [44, 36, 52, 255],
    "mouth_in":  [118, 62, 70, 255],
}

SIZE = 512  # 与 bottom() 呼应，main 里会覆盖


def square_crop(im: Image.Image) -> Image.Image:
    """居中裁成正方形（这一步是后面所有坐标的基准）。"""
    im = im.convert("RGBA")
    w, h = im.size
    side = min(w, h)
    return im.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))


def pixelize(sq: Image.Image, grid: int, colors: int, size: int) -> Image.Image:
    """【已经是正方形】的图 -> grid×grid -> (可选量化) -> size。"""
    if size % grid != 0:
        size = (size // grid) * grid or grid
    small = sq.resize((grid, grid), Image.NEAREST)
    if colors and colors > 0:
        rgb = Image.new("RGB", small.size, (255, 255, 255))
        rgb.paste(small, mask=small.split()[3])
        q = rgb.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
        q.putalpha(small.split()[3].point(lambda v: 255 if v >= 128 else 0))
        small = q
    return small.resize((size, size), Image.NEAREST)


def _ellipse(d, cx, cy, w, h, color):
    d.ellipse([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], fill=color)


def draw_face(sq: Image.Image, face: dict, mode: str) -> Image.Image:
    """在【正方形原图】上画眼睛/嘴。mode: 'blink' | 'talk' | 'both'"""
    im = sq.copy()
    d = ImageDraw.Draw(im, "RGBA")
    W, H = im.size
    f = face

    if mode in ("blink", "both"):
        ew, eh = W * f["eye_w"], H * f["eye_h"]
        for key in ("left_eye", "right_eye"):
            rx, ry = W * f[key][0], H * f[key][1]
            _ellipse(d, rx, ry, ew * 1.18, eh * 1.18, tuple(f["skin"]))
            lw = max(2, int(H * 0.007))
            d.line(
                [(rx - ew / 2, ry - eh * 0.10), (rx - ew / 6, ry + eh * 0.12), (rx + ew / 2, ry - eh * 0.10)],
                fill=tuple(f["line"]),
                width=lw,
                joint="curve",
            )

    if mode in ("talk", "both"):
        mx, my = W * f["mouth"][0], H * f["mouth"][1]
        mw, mh = W * f["mouth_w"], H * f["mouth_h"]
        _ellipse(d, mx, my + mh * 0.2, mw, mh * 1.6, tuple(f["mouth_in"]))
    return im


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--grid", type=int, default=128)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--colors", type=int, default=0, help="0=不限色数（默认）")
    ap.add_argument("--face", default="", help="JSON 文件覆盖默认脸部坐标")
    args = ap.parse_args(argv)

    face = dict(DEFAULT_FACE)
    if args.face:
        face.update(json.loads(Path(args.face).read_text(encoding="utf-8")))

    sq = square_crop(Image.open(args.src))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    variants = {
        "pixel_main": sq,
        "pixel_blink": draw_face(sq, face, "blink"),
        "pixel_talk": draw_face(sq, face, "talk"),
    }
    for name, im in variants.items():
        px = pixelize(im, args.grid, args.colors, args.size)
        p = out / f"{name}.png"
        px.save(p, optimize=True)
        print(f"{name:<12} {px.size} {round(os.path.getsize(p)/1024,1)} KB -> {p}")
    (out / "pixel_face.json").write_text(json.dumps(face, ensure_ascii=False, indent=2), encoding="utf-8")
    print("face ->", out / "pixel_face.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
