# -*- coding: utf-8 -*-
"""
pick_icons.py —— 从 game-icons.net 图标库抽取所需 SVG，打成内联 JS 模块

为什么要内联而不是 <img src>：
  game-icons 的 SVG 是单条 <path>，默认填充黑色。
  想让它跟随 CSS 颜色（品阶色、悬停高亮、禁用置灰）就必须让它进 DOM，
  这样 fill="currentColor" 才生效。<img> 引用的 SVG 无法被外部 CSS 染色。
  内联还有一个好处：零请求、完全离线，符合"一个文件夹带走"的发行要求。

许可：game-icons.net 为 CC BY 3.0，需署名。署名写在生成文件的头部注释里，
     并会出现在游戏内的「关于」面板中。
"""
import argparse
import os
import re
import sys

# 需要的图标：文件名 -> 在游戏里代表的含义（注释用）
WANTED = {
    # —— 八维 + 副属性 ——
    'hearts': '生命上限', 'broadsword': '物理攻击/武器槽',
    'magic-swirl': '法术攻击', 'armor-punch': '物理穿透',
    'magic-shield': '法术穿透', 'checked-shield': '物理防御',
    'shield-reflect': '法术防御', 'wingfoot': '速度',
    'crossed-swords': '暴击率/连击', 'droplets': '吸血',
    'dodging': '闪避', 'clover': '幸运',
    # —— 装备槽 ——
    'visored-helm': '头盔槽', 'breastplate': '胸甲槽',
    'leather-boot': '靴子槽', 'ring': '饰品槽',
    # —— 装备基底 ——
    'pointy-sword': '短剑', 'warhammer': '战锤', 'plain-dagger': '匕首',
    'pocket-bow': '长弓', 'wizard-staff': '学徒法杖', 'fairy-wand': '符文法杖',
    'crystal-ball': '潮汐宝珠', 'helmet': '皮盔', 'hood': '秘法兜帽',
    'crown': '潮冠', 'robe': '布袍', 'chain-mail': '锁甲', 'scale-mail': '鳞背心',
    'sandal': '布鞋', 'metal-boot': '铁靴', 'gem-pendant': '紫晶坠',
    'skull-ring': '骸骨符', 'heart-bottle': '潮汐心', 'rolling-dices': '赌徒骰',
    # —— 词条 / 遗物 ——
    'cactus': '荆棘', 'sound-waves': '回响', 'swordman': '处决',
    'running-shoe': '疾行', 'regeneration': '再生', 'tooth': '吞噬',
    'vampire-dracula': '血契', 'stone-wall': '壁垒/铁律',
    'cut-palm': '连环斩', 'barbed-sun': '过量打击', 'shining-heart': '全能之印',
    'treasure-map': '拾荒者', 'magic-potion': '秘藏',
    # —— 界面 / 地图 / 氛围 ——
    'backpack': '背包', 'chest': '宝箱', 'coins': '金币', 'skull': '敌人',
    'flame': '火把', 'torch': '照明', 'key': '钥匙', 'waves': '潮水',
    'high-tide': '涨潮', 'low-tide': '退潮', 'health-potion': '药剂',
    'gems': '宝石', 'scroll-unfurled': '卷轴', 'shield': '护甲',
    'crossed-bones': '骸骨装饰', 'broken-bone': '断骨', 'water': '水',
    'death-skull': '首领', 'barbed-arrow': '箭矢', 'boots': '行进',
}

SVG_RE = re.compile(r'<svg[^>]*>(.*)</svg>', re.S)
VIEWBOX_RE = re.compile(r'viewBox="([^"]+)"')
PLACEHOLDER_RE = re.compile(r'<(defs|metadata|title|desc)[^>]*>.*?</\1>', re.S)


def build_index(root):
    idx = {}
    for dp, dn, fn in os.walk(root):
        if '.git' in dp.split(os.sep):
            continue
        for f in fn:
            if f.endswith('.svg'):
                name = f[:-4]
                # 同名图标优先取 lorc（作者库最全、风格统一）
                if name not in idx or 'lorc' in dp:
                    idx[name] = os.path.join(dp, f)
    return idx


def clean(path):
    with open(path, 'r', encoding='utf-8') as fh:
        raw = fh.read()
    vb = VIEWBOX_RE.search(raw)
    body = SVG_RE.search(raw)
    if not body:
        return None, None
    inner = PLACEHOLDER_RE.sub('', body.group(1)).strip()
    inner = inner.replace('\n', '').replace('  ', ' ')
    return (vb.group(1) if vb else '0 0 512 512'), inner


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=r'assets-raw\game-icons')
    ap.add_argument('--out', default=r'src\js\icons.js')
    args = ap.parse_args()

    if not os.path.isdir(args.src):
        sys.exit('icon source not found: %s' % args.src)

    idx = build_index(args.src)
    print('indexed %d icons' % len(idx))

    entries = []
    missing = []
    for name in sorted(WANTED):
        if name not in idx:
            missing.append(name)
            continue
        vb, inner = clean(idx[name])
        if not inner:
            missing.append(name)
            continue
        entries.append((name, vb, inner))

    if missing:
        print('!! missing (%d): %s' % (len(missing), ', '.join(missing)))

    lines = []
    lines.append('/* ============================================================')
    lines.append('   数值潮汐 · 图标模块（自动生成，请勿手改）')
    lines.append('   生成脚本：tools/pick_icons.py')
    lines.append('')
    lines.append('   图标来源：game-icons.net  —  CC BY 3.0')
    lines.append('   作者：Lorc, Delapouite, Skoll, Sbed, Willdabeast,')
    lines.append('         Cathelineau, Caro Asercion, Carl Olsen, Zeromancer, Badges')
    lines.append('   协议要求署名，游戏内「关于」面板与 说明.txt 均已标注。')
    lines.append('')
    lines.append('   为什么内联而不是引用文件：这些 SVG 只有一条 <path>，')
    lines.append('   内联进 DOM 后 fill="currentColor" 才能被 CSS 染色，')
    lines.append('   从而让同一个图标在不同品质/状态下呈现不同颜色。')
    lines.append('   ============================================================ */')
    lines.append('(function (global) {')
    lines.append("  'use strict';")
    lines.append('  var PATHS = {')
    for name, vb, inner in entries:
        safe = inner.replace('\\', '\\\\').replace("'", "\\'")
        lines.append("    '%s': { v: '%s', p: '%s' }," % (name, vb, safe))
    lines.append('  };')
    lines.append('''
  /** 返回一段可直接塞进 innerHTML 的 SVG 字符串。
   *  size 为像素边长；用 currentColor 以便继承 CSS 颜色。 */
  function svg(name, size, cls) {
    var e = PATHS[name];
    if (!e) e = PATHS.skull;                    // 缺图不留白，兜底成骷髅
    if (!e) return '';
    var s = size || 20;
    return '<svg class="' + (cls || 'ico') + '" width="' + s + '" height="' + s +
           '" viewBox="' + e.v + '" fill="currentColor" aria-hidden="true">' +
           '<path d="' + e.p + '"/></svg>';
  }

  global.TideIcons = { PATHS: PATHS, svg: svg, has: function (n) { return !!PATHS[n]; } };
})(window);
''')
    with open(args.out, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))
    print('wrote %s  (%d icons, %.1f KB)'
          % (args.out, len(entries), os.path.getsize(args.out) / 1024.0))


if __name__ == '__main__':
    main()
