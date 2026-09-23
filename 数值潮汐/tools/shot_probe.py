# -*- coding: utf-8 -*-
"""
shot_probe.py —— 对游戏截图做「不依赖肉眼」的结构分析

用不了视觉模型的时候，判断一张截图是否正常只能靠量化：
  · 画面被切成几块？游戏画布在哪、侧栏在哪？
  · 画布里的内容有没有按 TILE 网格对齐（错位会表现为周期性丢失）
  · 有没有大片纯黑 / 单色区域（渲染漏掉了一块的特征）
  · 行/列亮度剖面里有没有突变的"接缝"

用法：py -3 tools/shot_probe.py <图片路径> [--tile 32]
"""
import sys
import os
import argparse

from PIL import Image


def profile(px, w, h, axis, step=1):
    """返回沿某个轴的亮度均值序列"""
    out = []
    if axis == 'x':
        for x in range(0, w, step):
            s = 0
            n = 0
            for y in range(0, h, 4):
                r, g, b = px[x, y][:3]
                s += r * 0.299 + g * 0.587 + b * 0.114
                n += 1
            out.append(s / max(1, n))
    else:
        for y in range(0, h, step):
            s = 0
            n = 0
            for x in range(0, w, 4):
                r, g, b = px[x, y][:3]
                s += r * 0.299 + g * 0.587 + b * 0.114
                n += 1
            out.append(s / max(1, n))
    return out


def bands(seq, lo=6.0, minLen=8):
    """找出连续暗段（可能的空白区）"""
    out = []
    start = None
    for i, v in enumerate(seq):
        if v < lo:
            if start is None:
                start = i
        else:
            if start is not None and i - start >= minLen:
                out.append((start, i - 1))
            start = None
    if start is not None and len(seq) - start >= minLen:
        out.append((start, len(seq) - 1))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('img')
    ap.add_argument('--tile', type=int, default=32)
    a = ap.parse_args()

    im = Image.open(a.img).convert('RGB')
    W, H = im.size
    px = im.load()
    print('图片尺寸: %dx%d' % (W, H))

    # 1) 找出侧栏边界：从右边往左扫，找一条"整列都是暗色"的分界
    cx = profile(px, W, H, 'x')
    print('\n--- 横向亮度剖面（每 %d 列一个采样点）---' % max(1, W // 40))
    step = max(1, W // 40)
    line = []
    for i in range(0, W, step):
        line.append('%d:%.0f' % (i, cx[i]))
    print('  ' + '  '.join(line))

    # 2) 纵向剖面
    cy = profile(px, W, H, 'y')
    stepy = max(1, H // 30)
    print('\n--- 纵向亮度剖面 ---')
    line = []
    for i in range(0, H, stepy):
        line.append('%d:%.0f' % (i, cy[i]))
    print('  ' + '  '.join(line))

    # 3) 暗段（可能是没被渲染到的地方）
    bx = bands(cx, 6.0, max(6, W // 40))
    by = bands(cy, 6.0, max(6, H // 30))
    print('\n几乎全黑的列区间: %s' % (bx if bx else '无'))
    print('几乎全黑的行区间: %s' % (by if by else '无'))

    # 4) 瓦片网格对齐检测：如果内容按 TILE 网格绘制，
    #    那么在 TILE 的整数倍位置，相邻列的差异应该整体偏小（砖缝处在固定位置）
    print('\n--- 网格对齐检测（tile=%d）---' % a.tile)
    diffs = []
    for x in range(1, W):
        s = 0
        n = 0
        for y in range(0, H, 5):
            p0 = px[x - 1, y]
            p1 = px[x, y]
            s += abs(p0[0] - p1[0]) + abs(p0[1] - p1[1]) + abs(p0[2] - p1[2])
            n += 1
        diffs.append(s / max(1, n))
    # 按 x % tile 分组，看有没有某个相位显著更"锐利"
    buckets = {}
    for x in range(1, W):
        buckets.setdefault(x % a.tile, []).append(diffs[x - 1])
    rows = sorted(buckets.items(), key=lambda kv: -sum(kv[1]) / len(kv[1]))
    print('  列差分最大的相位（可能是不对齐的接缝）: ' +
          ', '.join('%d:%.1f' % (k, sum(v) / len(v)) for k, v in rows[:5]))
    print('  列差分最小的相位（应该是砖缝/对齐处）: ' +
          ', '.join('%d:%.1f' % (k, sum(v) / len(v)) for k, v in rows[-5:]))

    # 5) 整图颜色统计
    cols = im.getcolors(maxcolors=1 << 22) or []
    cols.sort(reverse=True)
    print('\n--- 颜色统计 ---')
    print('  不同颜色数: %d' % len(cols))
    print('  占比最高的 8 种:')
    total = W * H
    for cnt, c in cols[:8]:
        print('    #%02x%02x%02x  %5.2f%%' % (c[0], c[1], c[2], 100.0 * cnt / total))

    # 6) 分区亮度：把画布区域切成 4x4 宫格，看有没有哪块异常
    print('\n--- 分区平均亮度（4x4 宫格，判断有没有整块异常）---')
    for gy in range(4):
        row = []
        for gx in range(4):
            x0, x1 = W * gx // 4, W * (gx + 1) // 4
            y0, y1 = H * gy // 4, H * (gy + 1) // 4
            s = 0
            n = 0
            for y in range(y0, y1, 5):
                for x in range(x0, x1, 5):
                    r, g, b = px[x, y]
                    s += r * 0.299 + g * 0.587 + b * 0.114
                    n += 1
            row.append('%6.1f' % (s / max(1, n)))
        print('  ' + ' '.join(row))


if __name__ == '__main__':
    main()
