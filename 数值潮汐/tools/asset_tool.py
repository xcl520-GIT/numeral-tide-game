# -*- coding: utf-8 -*-
"""
asset_tool.py —— 素材图集分析与导出工具（纯 Pillow，无第三方依赖）

为什么需要它：
  Kenney 的图集是"16x16 + 1px margin"的密排网格，索引是纯数字，看不出内容。
  直接靠猜索引映射，上线后必然出现"法师拿着木桶"这类事故。
  所以先把图集渲染成**带编号的对照表**，人工/AI 确认编号含义，
  再用 pick 把选中的图块导出成**有语义名的独立 PNG**。
  游戏代码从此只引用 'items/sword.png'，不再需要任何图集算术。

用法：
  py -3 tools/asset_tool.py info  <png...>
  py -3 tools/asset_tool.py sheet <png> --cols 54 --rows 12 --scale 4 --start 0 --count 96 --out x.png
  py -3 tools/asset_tool.py grid  <png> --cols 54 --rows 12 --scale 2 --out x.png
  py -3 tools/asset_tool.py pick  <png> --cols 54 --rows 12 --map "1=hero_warrior,25=slime" --outdir out
  py -3 tools/asset_tool.py pickdir <dir> --map "1=hero" --outdir out
"""
import argparse
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
]


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    try:
        return ImageFont.load_default(size=size)
    except Exception:
        return ImageFont.load_default()


def open_sheet(path):
    img = Image.open(path).convert("RGBA")
    return img


def infer_grid(img, tile, margin):
    step = tile + margin
    cols = (img.width + margin) // step
    rows = (img.height + margin) // step
    return cols, rows


def cmd_info(args):
    for path in args.src:
        img = open_sheet(path)
        cols, rows = infer_grid(img, args.tile, args.margin)
        print("%s" % path)
        print("   size   : %dx%d" % (img.width, img.height))
        print("   grid   : %d cols x %d rows = %d tiles (tile=%d margin=%d)"
              % (cols, rows, cols * rows, args.tile, args.margin))
        print("   colors : %d non-transparent unique" % len(
            {c for c in img.getcolors(maxcolors=1 << 24) or []}))
        print()


def checkerboard(size, a=(38, 40, 48), b=(28, 30, 36), cell=8):
    w, h = size
    bg = Image.new("RGBA", size, a + (255,))
    d = ImageDraw.Draw(bg)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if ((x // cell) + (y // cell)) % 2:
                d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=b + (255,))
    return bg


def draw_tile_sheet(img, cols, rows, tile, margin, scale, start, count, per_row, out):
    total = cols * rows
    start = max(0, start)
    end = min(total, start + count) if count > 0 else total
    idxs = list(range(start, end))
    per_row = min(per_row, len(idxs)) or 1

    f = load_font(max(14, int(11 * scale / 2)))
    pad = 4
    cellw = tile * scale + pad * 2
    labh = f.size + 6
    cellh = tile * scale + labh + pad

    nrows = (len(idxs) + per_row - 1) // per_row
    W = per_row * cellw
    H = nrows * cellh
    canvas = checkerboard((W, H))
    d = ImageDraw.Draw(canvas)

    for n, idx in enumerate(idxs):
        cx = (n % per_row) * cellw
        cy = (n // per_row) * cellh
        col = idx % cols
        row = idx // cols
        sx = col * (tile + margin)
        sy = row * (tile + margin)
        t = img.crop((sx, sy, sx + tile, sy + tile))
        t = t.resize((tile * scale, tile * scale), Image.NEAREST)
        canvas.paste(t, (cx + pad, cy + pad), t)
        # 编号：全局索引，尽量大、白底黑字，便于视觉确认
        label = str(idx)
        tw = d.textlength(label, font=f)
        bx = cx + pad + (tile * scale - tw) / 2
        by = cy + pad + tile * scale + 1
        d.rectangle([bx - 3, by - 1, bx + tw + 3, by + f.size + 2], fill=(255, 240, 200, 255))
        d.text((bx, by), label, font=f, fill=(20, 20, 20, 255))
        # 网格线
        d.rectangle([cx, cy, cx + cellw - 1, cy + cellh - 1], outline=(70, 75, 90, 255))

    canvas.save(out)
    print("wrote %s  (%dx%d, %d tiles %d..%d)" % (out, W, H, len(idxs), start, end - 1))


def cmd_sheet(args):
    img = open_sheet(args.src)
    cols, rows = (args.cols, args.rows)
    if not cols or not rows:
        cols, rows = infer_grid(img, args.tile, args.margin)
        print("inferred grid %dx%d" % (cols, rows))
    draw_tile_sheet(img, cols, rows, args.tile, args.margin, args.scale,
                    args.start, args.count, args.per_row, args.out)


def cmd_grid(args):
    """整张图集的总览图：带列号/行号标尺，用于快速定位大区块。"""
    img = open_sheet(args.src)
    cols, rows = args.cols, args.rows
    if not cols or not rows:
        cols, rows = infer_grid(img, args.tile, args.margin)
    scale = args.scale
    tile, margin = args.tile, args.margin
    f = load_font(16)
    fret = load_font(14)
    ruler = int(tile * scale) + 6

    zoom = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    W = zoom.width + ruler
    H = zoom.height + ruler
    canvas = checkerboard((W, H))
    canvas.paste(zoom, (ruler, ruler), zoom)
    d = ImageDraw.Draw(canvas)

    for c in range(cols):
        x = ruler + c * (tile + margin) * scale
        d.line([x, ruler, x, H], fill=(255, 90, 90, 90))
        if c % 5 == 0:
            d.text((x + 1, 2), str(c), font=fret, fill=(255, 220, 120, 255))
    for r in range(rows):
        y = ruler + r * (tile + margin) * scale
        d.line([ruler, y, W, y], fill=(255, 90, 90, 90))
        d.text((2, y + 2), str(r), font=f, fill=(120, 230, 255, 255))

    canvas.save(args.out)
    print("wrote %s (%dx%d)" % (args.out, W, H))


def parse_map(spec):
    """'1=hero,25=slime' -> {1:'hero', 25:'slime'}"""
    m = {}
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise SystemExit("bad --map entry: %r" % part)
        k, v = part.split("=", 1)
        m[int(k.strip())] = v.strip()
    return m


def cmd_pick(args):
    img = open_sheet(args.src)
    cols, rows = args.cols, args.rows
    if not cols or not rows:
        cols, rows = infer_grid(img, args.tile, args.margin)
    mapping = parse_map(args.map)
    os.makedirs(args.outdir, exist_ok=True)
    made = []
    for idx, name in sorted(mapping.items()):
        col, row = idx % cols, idx // cols
        sx, sy = col * (args.tile + args.margin), row * (args.tile + args.margin)
        t = img.crop((sx, sy, sx + args.tile, sy + args.tile))
        dst = os.path.join(args.outdir, name + ".png")
        if args.scale != 1 and args.up:
            t = t.resize((args.tile * args.up, args.tile * args.up), Image.NEAREST)
        t.save(dst)
        made.append(name)
    print("exported %d sprites -> %s" % (len(made), args.outdir))
    print("   " + ", ".join(made))


def cmd_pickdir(args):
    """从 Kenney 的 Tiles/tile_0000.png 风格目录里按序号复制并改名。"""
    mapping = parse_map(args.map)
    files = {}
    for fn in os.listdir(args.src):
        m = re.match(r".*?(\d+)\.png$", fn)
        if m:
            files[int(m.group(1))] = os.path.join(args.src, fn)
    os.makedirs(args.outdir, exist_ok=True)
    n = 0
    for idx, name in sorted(mapping.items()):
        if idx not in files:
            print("!! missing tile %d" % idx)
            continue
        Image.open(files[idx]).convert("RGBA").save(
            os.path.join(args.outdir, name + ".png"))
        n += 1
    print("exported %d sprites -> %s" % (n, args.outdir))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("src")
        p.add_argument("--tile", type=int, default=16)
        p.add_argument("--margin", type=int, default=1)

    a = sub.add_parser("info"); a.add_argument("src", nargs="+")
    a.add_argument("--tile", type=int, default=16); a.add_argument("--margin", type=int, default=1)
    a.set_defaults(func=cmd_info)

    a = sub.add_parser("sheet"); common(a)
    a.add_argument("--cols", type=int, default=0); a.add_argument("--rows", type=int, default=0)
    a.add_argument("--scale", type=int, default=4)
    a.add_argument("--start", type=int, default=0); a.add_argument("--count", type=int, default=96)
    a.add_argument("--per-row", type=int, default=12)
    a.add_argument("--out", required=True)
    a.set_defaults(func=cmd_sheet)

    a = sub.add_parser("grid"); common(a)
    a.add_argument("--cols", type=int, default=0); a.add_argument("--rows", type=int, default=0)
    a.add_argument("--scale", type=int, default=3)
    a.add_argument("--out", required=True)
    a.set_defaults(func=cmd_grid)

    a = sub.add_parser("pick"); common(a)
    a.add_argument("--cols", type=int, default=0); a.add_argument("--rows", type=int, default=0)
    a.add_argument("--map", required=True)
    a.add_argument("--outdir", required=True)
    a.add_argument("--up", type=int, default=1)
    a.add_argument("--scale", type=int, default=1)
    a.set_defaults(func=cmd_pick)

    a = sub.add_parser("pickdir"); a.add_argument("src")
    a.add_argument("--map", required=True); a.add_argument("--outdir", required=True)
    a.set_defaults(func=cmd_pickdir)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
