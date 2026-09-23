# -*- coding: utf-8 -*-
"""数值潮汐 · 图标生成器

纯标准库手写 PNG + ICO，不依赖 Pillow。
图形语言呼应游戏本身：深海底色 + 一颗发光的主球 + 底部上涨的潮线。

用法：py -3 tools/make-icon.py
输出：launcher/icon.ico
"""

import math
import os
import struct
import sys
import zlib

SIZES = (256, 64, 48, 32, 16)


def png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def encode_png(size, rows):
    raw = bytearray()
    for row in rows:
        raw.append(0)                       # filter type 0
        for (r, g, b) in row:
            raw += bytes((r, g, b, 255))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" +
            png_chunk(b"IHDR", ihdr) +
            png_chunk(b"IDAT", zlib.compress(bytes(raw), 9)) +
            png_chunk(b"IEND", b""))


def clamp(v):
    return 0 if v < 0 else (255 if v > 255 else int(v))


def render(size):
    c = (size - 1) / 2.0
    ball_r = size * 0.295
    glow_r = ball_r * 1.42
    glow_w = size * 0.055

    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            dx, dy = x - c, y - c
            d = math.hypot(dx, dy)

            # 底色：径向渐变的深海
            t = min(1.0, d / (size * 0.66))
            r = 8 + 16 * (1 - t)
            g = 14 + 26 * (1 - t)
            b = 20 + 34 * (1 - t)

            # 外发光环
            glow = math.exp(-((d - glow_r) ** 2) / (2 * glow_w * glow_w))
            r += 26 * glow
            g += 118 * glow
            b += 150 * glow

            # 底部上涨的潮线
            if d > ball_r * 0.9:
                base_y = size * 0.80
                amp = size * 0.030
                for i, phase in enumerate((0.0, 1.3, 2.6)):
                    wy = base_y + i * size * 0.072 + amp * math.sin(x / (size * 0.20) + phase)
                    if abs(y - wy) < max(0.8, size * 0.016):
                        fade = 1.0 - i * 0.30
                        r += 18 * fade
                        g += 130 * fade
                        b += 165 * fade

            # 主球
            if d <= ball_r:
                k = d / ball_r
                hl = math.hypot(x - (c - ball_r * 0.34), y - (c - ball_r * 0.36))
                spec = max(0.0, 1.0 - hl / (ball_r * 0.95))
                r = 26 + 150 * spec + 30 * (1 - k)
                g = 132 + 108 * spec
                b = 176 + 62 * spec

            row.append((clamp(r), clamp(g), clamp(b)))
        rows.append(row)
    return rows


def build_ico(entries):
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dir_entries = b""
    blobs = b""
    for size, data in entries:
        dim = 0 if size >= 256 else size
        dir_entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    return header + dir_entries + blobs


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "launcher", "icon.ico")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    entries = []
    for s in SIZES:
        entries.append((s, encode_png(s, render(s))))

    with open(out, "wb") as f:
        f.write(build_ico(entries))

    print("icon written : %s" % out)
    print("sizes        : %s" % ", ".join("%dx%d" % (s, s) for s in SIZES))
    print("bytes        : %d" % os.path.getsize(out))


if __name__ == "__main__":
    main()
