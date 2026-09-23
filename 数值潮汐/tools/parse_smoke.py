#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把集成冒烟测试的 dump 结果解析成一份摘要。

用法：
    # 1) 让无头浏览器把页面 dump 到文件
    msedge.exe --headless=new --disable-gpu --allow-file-access-from-files ^
        --virtual-time-budget=300000 --dump-dom "file:///.../tools/smoke.html" > smoke.dump.html
    # 2) 再解析
    python tools/parse_smoke.py smoke.dump.html

为什么分成"跑"和"看"两步：
无头浏览器偶尔会交出 0 字节（渲染进程被回收，或者上一个实例还占着 profile）。
分开之后，一出问题就能分清到底是"页面没跑起来"还是"测试真的挂了" ——
混在一条命令里时，这两种情况的输出长得一模一样。

也可以直接给 URL 参数之外的任何 dump 文件（包括发行版副本那一份）。
"""
import html
import re
import sys


def parse(path):
    raw = open(path, 'rb').read().decode('utf-8-sig', 'replace')
    m = re.search(r'(?s)<pre[^>]*>(.*?)</pre>', raw)
    if not m:
        print('没有找到 <pre> 输出块 —— 页面可能没跑起来（看文件大小是不是 0）')
        print('文件前 300 字符：')
        print(raw[:300])
        return 1
    body = html.unescape(m.group(1))
    lines = body.split('\n')
    oks = [l.strip() for l in lines if l.strip().startswith('ok ')]
    fails = [l.strip() for l in lines if l.strip().startswith('FAIL')]
    tail = [l.strip() for l in lines if '结果:' in l]

    print('ok = %d   FAIL = %d' % (len(oks), len(fails)))
    if tail:
        print(tail[-1])
    if fails:
        print()
        print('--- 失败项 ---')
        for f in fails:
            print('  ' + f)
    return 1 if fails else 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(parse(sys.argv[1]))
