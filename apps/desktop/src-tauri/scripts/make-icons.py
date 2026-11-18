#!/usr/bin/env python3
"""Generates the application icons (cherry wood + brass rocket) with Pillow.

Usage: python3 scripts/make-icons.py   (from apps/desktop/src-tauri)
Produces icons/icon.png (512), 32x32.png, 128x128.png, 128x128@2x.png, icon.ico (multi-size) and
icons/tray.png (monochrome-friendly 64px). Colours are the tokens of the interface theme.
"""
import os
import struct
from PIL import Image, ImageDraw

CHERRY = (110, 39, 23, 255)      # --cherry-700
CHERRY_D = (61, 21, 13, 255)     # --cherry-900
BRASS = (216, 170, 72, 255)      # --brass-400
BRASS_D = (154, 111, 23, 255)    # --brass-600
INK = (248, 236, 217, 255)       # --wood-ink


def draw_icon(size: int) -> Image.Image:
    k = 4  # supersampling
    n = 512 * k
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = n // 5
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=r, fill=CHERRY)
    # darker lower half to suggest wood grain depth
    d.rounded_rectangle([n // 16, n // 16, n - n // 16, n - n // 16], radius=r - n // 16, outline=CHERRY_D, width=n // 64)
    cx = n // 2
    # rocket body
    body = [(cx, n * 0.14), (cx + n * 0.13, n * 0.40), (cx + n * 0.13, n * 0.66), (cx - n * 0.13, n * 0.66), (cx - n * 0.13, n * 0.40)]
    d.polygon(body, fill=BRASS)
    # fins
    d.polygon([(cx - n * 0.13, n * 0.50), (cx - n * 0.26, n * 0.72), (cx - n * 0.13, n * 0.66)], fill=BRASS_D)
    d.polygon([(cx + n * 0.13, n * 0.50), (cx + n * 0.26, n * 0.72), (cx + n * 0.13, n * 0.66)], fill=BRASS_D)
    # porthole
    rr = n * 0.055
    d.ellipse([cx - rr, n * 0.34 - rr, cx + rr, n * 0.34 + rr], fill=CHERRY_D)
    d.ellipse([cx - rr * 0.6, n * 0.34 - rr * 0.6, cx + rr * 0.6, n * 0.34 + rr * 0.6], fill=INK)
    # exhaust: two sync arrows suggested by a ring segment
    d.arc([cx - n * 0.2, n * 0.62, cx + n * 0.2, n * 0.92], start=20, end=160, fill=INK, width=n // 40)
    return im.resize((size, size), Image.LANCZOS)


def write_ico(path: str, sizes):
    images = [draw_icon(s) for s in sizes]
    pngs = []
    for im in images:
        import io
        b = io.BytesIO()
        im.save(b, format="PNG")
        pngs.append(b.getvalue())
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for im, data in zip(images, pngs):
        w = im.width if im.width < 256 else 0
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    with open(path, "wb") as f:
        f.write(header + entries + b"".join(pngs))


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out, exist_ok=True)
    draw_icon(512).save(os.path.join(out, "icon.png"))
    draw_icon(32).save(os.path.join(out, "32x32.png"))
    draw_icon(128).save(os.path.join(out, "128x128.png"))
    draw_icon(256).save(os.path.join(out, "128x128@2x.png"))
    draw_icon(64).save(os.path.join(out, "tray.png"))
    write_ico(os.path.join(out, "icon.ico"), [16, 24, 32, 48, 64, 128, 256])


if __name__ == "__main__":
    main()
