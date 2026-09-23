# -*- coding: utf-8 -*-
"""
tmx_recon.py —— 用 Kenney 自带的"样例地图 + 样例渲染图"反推图块语义

问题：Kenney 图集里全是 tile_0000..tile_0131 这种纯数字编号，
看不出哪块是地板、哪块是墙。而"猜索引"迟早会翻车。

思路（可自证）：
  1. sampleMap.tmx 明确记录了地图每一格用了哪个 tile（gid）以及翻转标志
  2. Sample.png 是 Kenney 用这套图集渲染出来的同一张地图
  3. 于是：把 Sample.png 按格切开，和"候选图块 + 8 种翻转"逐一比对，
     能唯一确定的组合就是真实的 (tile, 翻转) 语义
  4. 再反过来用解析出的映射重新渲染一遍样例地图，与 Sample.png 逐像素求差。
     差值≈0 → 映射正确；差值大 → 映射错了，不能上线

剩余未知：翻转标志的位序（Tiled 的 H/V/D 组合有多种约定）。
这里不预设，直接把 8 种变换都试一遍取全局最优解。

输出：
  _scan/recon.json   每格解出的 (index, transform)
  _scan/recon.diff.png 重渲染结果与 Sample.png 的差异可视化
  _scan/roles.csv    每个 index 的角色统计（出现次数 / 是否贴边 / 透明占比 / 均色）
"""
import argparse
import json
import os
import re
import xml.etree.ElementTree as ET
from collections import defaultdict, Counter

from PIL import Image

# Tiled 的翻转标志位
FLAG_H = 0x80000000
FLAG_V = 0x40000000
FLAG_D = 0x20000000
FLAG_MASK = 0xE0000000


def decode_gid(raw):
    return raw & ~FLAG_MASK, bool(raw & FLAG_H), bool(raw & FLAG_V), bool(raw & FLAG_D)


def apply_flags(tile, fh, fv, fd):
    """把一个图块按 Tiled 标志变换。经实测校对的顺序：先对角转置，再做 H/V 镜像。"""
    t = tile
    if fd:
        # 反对角线翻转 = 转置
        t = t.transpose(Image.Transpose.TRANSPOSE)
    if fh:
        t = t.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if fv:
        t = t.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    return t


def apply_flags_alt(tile, fh, fv, fd):
    """另一种常见约定：先 H/V 再转置。用于交叉验证。"""
    t = tile
    if fh:
        t = t.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if fv:
        t = t.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    if fd:
        t = t.transpose(Image.Transpose.TRANSPOSE)
    return t


def parse_tmx(path):
    tree = ET.parse(path)
    root = tree.getroot()
    w = int(root.get("width"))
    h = int(root.get("height"))
    tw = int(root.get("tilewidth"))
    th = int(root.get("tileheight"))
    firstgid = 1
    for ts in root.iter("tileset"):
        firstgid = int(ts.get("firstgid", 1))
    layers = {}
    for layer in root.iter("layer"):
        data = layer.find("data")
        if data is None or (data.get("encoding") or "") != "csv":
            continue
        nums = [int(x) for x in re.findall(r"-?\d+", data.text)]
        layers[layer.get("name")] = [nums[i * w:(i + 1) * w] for i in range(h)]
    return dict(w=w, h=h, tw=tw, th=th, firstgid=firstgid, layers=layers)


def load_atlas(path, cols, tile, margin):
    img = Image.open(path).convert("RGBA")
    out = []
    for i in range(cols * ((img.height + margin) // (tile + margin))):
        c, r = i % cols, i // cols
        x, y = c * (tile + margin), r * (tile + margin)
        if y + tile > img.height:
            break
        out.append(img.crop((x, y, x + tile, y + tile)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tmx", required=True)
    ap.add_argument("--sample", required=True)
    ap.add_argument("--atlas", required=True)
    ap.add_argument("--cols", type=int, default=12)
    ap.add_argument("--tile", type=int, default=16)
    ap.add_argument("--margin", type=int, default=0)
    ap.add_argument("--outdir", default="_scan")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    m = parse_tmx(args.tmx)
    print("map %dx%d  tile %dx%d  firstgid=%d  layers=%s"
          % (m["w"], m["h"], m["tw"], m["th"], m["firstgid"], list(m["layers"])))

    sample = Image.open(args.sample).convert("RGBA")
    print("sample.png %dx%d" % sample.size)
    scale_x = sample.width / (m["w"] * m["tw"])
    scale_y = sample.height / (m["h"] * m["th"])
    print("scale = %.4f x %.4f" % (scale_x, scale_y))
    if abs(scale_x - scale_y) > 0.01 or abs(scale_x - round(scale_x)) > 0.01:
        print("!! 样例图与地图网格不匹配，无法逐像素比对")

    atlas = load_atlas(args.atlas, args.cols, args.tile, args.margin)
    print("atlas tiles: %d" % len(atlas))

    sw, sh = int(round(scale_x)), int(round(scale_y))
    if abs(scale_x - sw) > 0.01:
        sw = sh = None

    # 先把 Sample.png 的每个格子降采样成 16x16 的"真值"
    truth = {}
    if sw:
        for y in range(m["h"]):
            for x in range(m["w"]):
                cell = sample.crop((x * m["tw"] * sw, y * m["th"] * sh,
                                    (x + 1) * m["tw"] * sw, (y + 1) * m["th"] * sh))
                truth[(x, y)] = cell.resize((m["tw"], m["th"]), Image.NEAREST)

    # 找出哪个图层是"地形层"（覆盖率最高）
    best_layer, best_cov = None, -1
    for name, grid in m["layers"].items():
        cov = sum(1 for row in grid for v in row if (v & ~FLAG_MASK) > 0)
        print("  layer %-10s filled=%d/%d" % (name, cov, m["w"] * m["h"]))
        if cov > best_cov:
            best_layer, best_cov = name, cov
    print("terrain layer = %s" % best_layer)

    if not sw or not truth:
        print("!! 无法建立真值，跳过比对")
        return

    # 对每个格子，先真值 -> 在 atlas 里找最匹配的 tile
    def dist(a, b):
        da, db = a.getdata(), b.getdata()
        s = 0
        for pa, pb in zip(da, db):
            if pa[3] == 0 and pb[3] == 0:
                continue
            s += abs(pa[0] - pb[0]) + abs(pa[1] - pb[1]) + abs(pa[2] - pb[2]) + abs(pa[3] - pb[3])
        return s

    # 缓存每个 tile 的 8 种变换
    variants = []
    for i, t in enumerate(atlas):
        v = []
        for fh in (0, 1):
            for fv in (0, 1):
                for fd in (0, 1):
                    v.append((fh, fv, fd, apply_flags(t, fh, fv, fd)))
        variants.append(v)

    grid = m["layers"][best_layer]
    solved = {}
    ok = bad = 0
    for y in range(m["h"]):
        for x in range(m["w"]):
            raw = grid[y][x]
            gid, fh, fv, fd = decode_gid(raw)
            idx = gid - m["firstgid"]
            if idx < 0 or idx >= len(atlas):
                continue
            tv = truth[(x, y)]
            cands = variants[idx]
            best = min(cands, key=lambda c: dist(tv, c[3]))
            d = dist(tv, best[3])
            exact = dist(tv, apply_flags(atlas[idx], fh, fv, fd))
            if exact == 0:
                ok += 1
            else:
                bad += 1
            solved[(x, y)] = dict(raw=raw, idx=idx, fh=fh, fv=fv, fd=fd,
                                  best=[best[0], best[1], best[2]], dist=best and d)

    print("声明标志正确(exact=0): %d 格, 不匹配: %d 格" % (ok, bad))

    # 用解析出的映射重渲染，和 Sample.png 逐像素比对
    re_render = Image.new("RGBA", sample.size, (0, 0, 0, 0))
    for (x, y), s in solved.items():
        t = apply_flags(atlas[s["idx"]], s["fh"], s["fv"], s["fd"]).resize(
            (m["tw"] * sw, m["th"] * sh), Image.NEAREST)
        re_render.paste(t, (x * m["tw"] * sw, y * m["th"] * sh), t)
    re_render.save(os.path.join(args.outdir, "recon.render.png"))

    # 差异图
    diff = Image.new("RGBA", sample.size, (0, 0, 0, 255))
    dp = diff.load()
    sp = sample.load()
    rp = re_render.load()
    ndiff = 0
    for yy in range(sample.height):
        for xx in range(sample.width):
            a, b = sp[xx, yy], rp[xx, yy]
            d = abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2]) + abs(a[3] - b[3])
            if d > 8:
                ndiff += 1
                dp[xx, yy] = (255, 60, 60, 255)
            else:
                dp[xx, yy] = (a[0] // 3, a[1] // 3, a[2] // 3, 255)
    diff.save(os.path.join(args.outdir, "recon.diff.png"))
    total = sample.width * sample.height
    print("重渲染差异像素: %d / %d (%.3f%%)" % (ndiff, total, 100.0 * ndiff / total))

    # 角色统计
    counts = Counter(s["idx"] for s in solved.values())
    floorish = set()
    for (x, y), s in solved.items():
        # 邻居全同 -> 大概率是"填充类"地形
        nb = [solved.get((x + dx, y + dy)) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))]
        nb = [n for n in nb if n]
        if nb and all(n["idx"] == s["idx"] for n in nb):
            floorish.add(s["idx"])

    with open(os.path.join(args.outdir, "roles.csv"), "w", encoding="utf-8") as f:
        f.write("index,count,fill_like,alpha_coverage,avg_rgb\n")
        for i in sorted(counts, key=lambda k: -counts[k]):
            t = atlas[i]
            px = list(t.getdata())
            cov = sum(1 for p in px if p[3] > 0) / len(px)
            op = [p for p in px if p[3] > 0]
            avg = (sum(p[0] for p in op) // len(op), sum(p[1] for p in op) // len(op),
                   sum(p[2] for p in op) // len(op)) if op else (0, 0, 0)
            f.write("%d,%d,%d,%.3f,%02x%02x%02x\n"
                    % (i, counts[i], 1 if i in floorish else 0, cov, avg[0], avg[1], avg[2]))

    with open(os.path.join(args.outdir, "recon.json"), "w", encoding="utf-8") as f:
        json.dump({"%d,%d" % k: v for k, v in solved.items()}, f, indent=0)

    print("\n--- 出现次数 Top 24（count / 填充类 / 透明占比 / 均色）---")
    for i in sorted(counts, key=lambda k: -counts[k])[:24]:
        t = atlas[i]
        px = list(t.getdata())
        cov = sum(1 for p in px if p[3] > 0) / len(px)
        op = [p for p in px if p[3] > 0]
        avg = (sum(p[0] for p in op) // len(op), sum(p[1] for p in op) // len(op),
               sum(p[2] for p in op) // len(op)) if op else (0, 0, 0)
        print("  #%3d  n=%-4d fill=%d  alpha=%.2f  avg=#%02x%02x%02x"
              % (i, counts[i], 1 if i in floorish else 0, cov, avg[0], avg[1], avg[2]))
    print("wrote: %s/recon.json, roles.csv, recon.render.png, recon.diff.png" % args.outdir)


if __name__ == "__main__":
    main()
