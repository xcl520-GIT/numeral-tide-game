# assets-raw

这个目录**不参与构建**，发行版 `dist\数值潮汐\` 里一个文件都不会用到它。
留着只是为了能在需要时重新生成图标模块。

## 现在里面有什么

`game-icons/` —— [game-icons.net](https://game-icons.net) 的完整 SVG 图标库
（4176 个，CC BY 3.0），`tools/pick_icons.py` 的输入源。

重新获得它的命令（如果删掉了）：

```bash
git clone --depth 1 https://github.com/game-icons/icons.git assets-raw/game-icons
```

然后重新生成内联图标模块：

```bash
py -3 tools/pick_icons.py           # 输出 src/js/icons.js
```

如果你不想留着这 6.7 MB，整目录删掉即可 —— 游戏本身照常运行，
因为真正被用到的 68 个图标已经内联进 `src/js/icons.js` 了。

## 曾经放在这里、但已被删除的东西

| 包 | 内容 | 为什么没采用 |
|---|---|---|
| Kenney `roguelike-characters` | 648 个角色精灵（v3 在用） | 见下 |
| Kenney `tiny-dungeon` | 132 块地牢瓦片 + 道具 + 角色 | 见下 |
| Kenney `roguelike-rpg-pack` | 1767 块（含地形/怪物/道具） | 见下 |
| Kenney `ui-pack` | 具名 UI 元件 | 风格与像素画面不搭 |

前三个质量都很好，但有一个绕不开的问题：**图集是「16×16 密排 + 纯数字编号」，
没有任何语义标注。** `tile_0048.png` 到底是地板还是宝箱，只能靠看图判断。

试过一条不依赖肉眼的自动推断路线：用 Kenney 自带的 `sampleMap.tmx`
（明确记录了每格用了哪个 tile 和翻转标志）配合 `Sample.png` 反推图块语义，
再用「重渲染结果与 Sample.png 逐像素求差」来**自证映射正确**。
思路是成立的，但实测 `Sample.png` 是无周期性的营销图（256 色、平滑缩放），
和地图网格对不上，逐像素比对不成立，这条路作废。

猜错的后果是「法师举着一个木桶」这种一眼假的事故，**比画得朴素更伤**。
所以最终改成两条都不需要猜编号的路：地形/角色/怪物由
`src/js/art.js` 代码生成，界面图标用 `game-icons.net`（文件名即语义）。

想把 Kenney 的包再下回来的话，直链可以直接从素材页抓：

```powershell
# 示例：先取素材页，再从页面里抓 .zip 直链
Invoke-WebRequest 'https://kenney.nl/assets/tiny-dungeon' -UseBasicParsing |
  Select-String -Pattern 'https://kenney\.nl/media/pages/assets/[^"'']*\.zip' -AllMatches
```

（`tools/tmx_recon.py` 就是上面那条推断路线的实现，保留备查。）
