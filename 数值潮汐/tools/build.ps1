# ============================================================
# 数值潮汐 · 构建脚本（v10.2 目录重构版）
#
# 产出两样东西：
#   1) 项目根目录下的可运行文件 —— 启动器就摆在最表层，双击即玩：
#      数值潮汐.exe + 3 个 DLL + www\ + 说明.txt
#   2) release\数值潮汐\ 干净分发包（只含可运行文件，传网盘用）
#      以及 release\数值潮汐-<版本>.zip
#
# 安全约定（改这个脚本前请先读）：
#   项目根目录里同时住着源码（src\ tools\ docs\ …）和游戏本体，
#   所以清理动作只允许作用于下面写死的**白名单**，
#   并且每次删除前都断言"目标在项目根之内、且不等于项目根本身"。
#   绝不允许出现 Remove-Item $root -Recurse 这类写法 ——
#   只要输出目录和项目根重合，那就是一次不可逆的灾难。
#
# 用法：powershell -ExecutionPolicy Bypass -File tools\build.ps1
# ============================================================
$ErrorActionPreference = "Stop"

$root    = Split-Path -Parent $PSScriptRoot          # numeral-tide\
$name    = "数值潮汐"
# 版本号：唯一源头（zip 名 + 生成的 说明.txt 都用它）。
# v11.6 起补齐：此前一直写死 11.1，于是 v11.2~v11.5 的包都印着 v11.1 ——
# 这个文件自己的注释就写着"发错版本比没发更糟"，这次把这条账结了。
$version = "11.10"
$lib     = Join-Path $root "builder\lib"
$release = Join-Path $root "release\$name"
$csc     = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$dlls    = @("Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll")

function Say($m) { Write-Host "  $m" }
function Head($m) { Write-Host ""; Write-Host "== $m ==" -ForegroundColor Cyan }

# ------------------------------------------------------------
# 安全闸门：任何删除动作都必须先过这一关
# ------------------------------------------------------------
$rootFull = (Resolve-Path $root).Path.TrimEnd('\')
function Assert-InRoot([string]$candidate) {
    $full = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
    if ($full -eq $rootFull) {
        throw "安全闸门拦下：拒绝操作项目根目录本身（$full）"
    }
    if (-not $full.ToLower().StartsWith(($rootFull + '\').ToLower())) {
        throw "安全闸门拦下：路径不在项目根之内（$full）"
    }
}

Head "检查环境"
if (-not (Test-Path $csc)) { throw "找不到 csc.exe：$csc（Windows 自带的 .NET Framework 编译器）" }
# 确认这确实是本项目的根目录，避免脚本被拷到别处后误删别人的文件
if (-not (Test-Path (Join-Path $root "src\index.html"))) {
    throw "这里不像是数值潮汐的项目根（缺少 src\index.html）：$root"
}
Say "项目根  $root"
Say "编译器  $csc"
foreach ($d in $dlls) {
    if (-not (Test-Path (Join-Path $lib $d))) {
        throw "缺少构建依赖：$lib\$d。这三个 DLL 来自 Microsoft.Web.WebView2 的 NuGet 包，已随仓库放在 builder\lib\。"
    }
}
Say "WebView2 SDK  已就绪（builder\lib）"

Head "清理上一次的产物（只删白名单，且必须在本项目之内）"
$cleanup = @(
    (Join-Path $root "www"),
    (Join-Path $root "$name.exe"),
    (Join-Path $root "说明.txt"),
    $release
)
foreach ($d in $dlls) { $cleanup += (Join-Path $root $d) }

foreach ($p in $cleanup) {
    if (-not (Test-Path -LiteralPath $p)) { continue }
    Assert-InRoot $p
    try {
        Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
        Say "已删除  $p"
    } catch {
        throw "删除失败：$p`n（如果游戏窗口还开着，请先关掉再构建）`n$($_.Exception.Message)"
    }
}

# ------------------------------------------------------------
Head "组装游戏本体 → www\"
New-Item -ItemType Directory -Path (Join-Path $root "www") -Force | Out-Null
Copy-Item (Join-Path $root "src\*") (Join-Path $root "www") -Recurse -Force
# 说明：玩法资源全部是代码生成的 ——
#   地形 / 角色 / 怪物由 src\js\art.js 现场画，图标内联在 src\js\icons.js，
#   音效由 Web Audio 合成。所以 www\ 下没有任何二进制素材，
#   也就没有"图集索引猜错"和"素材授权说不清"这两类问题。
$gameFiles = (Get-ChildItem (Join-Path $root "www") -Recurse -File).Count
$gameKB = [math]::Round((Get-ChildItem (Join-Path $root "www") -Recurse -File |
    Measure-Object -Property Length -Sum).Sum / 1KB, 1)
Say "www\  ($gameFiles 个文件, $gameKB KB, 零外部素材)"

Head "复制运行时依赖"
foreach ($d in $dlls) { Copy-Item (Join-Path $lib $d) $root -Force }
Say "3 个 DLL 已放到项目根"

Head "编译启动器"
$coreDll = Join-Path $lib "Microsoft.Web.WebView2.Core.dll"
$wfDll   = Join-Path $lib "Microsoft.Web.WebView2.WinForms.dll"
$cscArgs = @(
    "/nologo", "/target:winexe", "/optimize+", "/platform:x64",
    "/out:$root\$name.exe",
    "/r:System.dll", "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll",
    "/r:$coreDll",
    "/r:$wfDll"
)
$icon = Join-Path $root "launcher\icon.ico"
if (Test-Path $icon) { $cscArgs += "/win32icon:$icon"; Say "已附加图标 icon.ico" }
$cscArgs += (Join-Path $root "launcher\launcher.cs")

& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "编译失败（csc 退出码 $LASTEXITCODE）" }
$exeKB = [math]::Round((Get-Item (Join-Path $root "$name.exe")).Length / 1KB, 1)
Say "$name.exe  $exeKB KB"

Head "写发行说明"
$readme = @"
数值潮汐 · Numeral Tide   v$version
========================================

怎么玩
  双击「$name.exe」，游戏窗口会自己打开。
  先在标题页选一个职业和难度，然后点「开始下潜」。

操作
  方向键 / WASD      走一格（按住连续走）
  点击相邻格          走一格
  点击远处            自动寻路走过去（青色小点是路线）
  按住鼠标            持续朝目标走，松手即停
  空格                原地等一回合
  Q                   释放魂技（冷却写在技能键上）
  E / I / B / Tab     开关背包（含商店页）
  双击左键            自动装备（比身上强才换，更弱会说理由）
  滚轮                在右侧栏上 = 上下滚动；在地图上 = 缩放视角
                      （右侧的属性和秘藏比一屏长，滚一下就都能看到）
  H                   玩法说明
  G                   折叠 / 展开左侧操作指南
  Esc                 逐层往回退（先关弹窗，全关完才到暂停菜单）
  M                   静音开关
  F11                 全屏切换

  局内左侧常驻一块「操作指南」，内容会跟着当前界面变
  （走路时 / 开背包时 / 选秘藏时，各是一套）。

这一版怎么玩
  · 战斗一次算完整场。伤害 = 攻击 × 50 / (有效防御 + 50)，
    物理和法术各算一遍，系统自动挑更高的那一路。
  · 敌人是偏科的：石甲兽物防 26 法防 0，幽魂反过来。
    鼠标移到敌人身上会直接告诉你该用哪一路、几轮能杀掉、要掉多少血。
  · 潮汐按 0→1→2→3→3→2→1→0 循环。涨潮时水面扩散、踩水掉血，
    退潮时是绕路和开宝箱的窗口。
  · 装备五槽、五档品质、可叠加词条；鼠标停在任何装备上都会显示
    基础属性 / 词条 / 机制效果 / 与身上那件的逐项差值 / 身价与售价。
  · 每层有 2 处潮汐商栈，站上去就能买卖（售价是身价的 35%，买价 175%）。
  · 每击杀 6 个敌人给一次「潮汐秘藏」三选一。
    秘藏共 19 件、不会重复获得；拿满之后这个位置会换成「潮汐馈赠」
    （金币 / 回血 / 装备）—— 候选永远给满三张，永远有得选。
  · 潮汐结晶（局外成长）：每局结束按深度与击杀结算，回标题页可以兑换永久增益
    （起始金币 / 背包格 / 开局装备 / 复活次数 / 生命上限）。
    元进度只动你自己的存档，不写进平衡数据。
  · 地图分区域：每层切成 4~6 块，有普通 / 精英 / 危险 / 奖励 / 守门五种。
    精英区和危险区的怪更强；奖励区几乎没有怪，还保底一个宝箱。
    区域全部看得见（小地图按区域上色），出口固定在守门区 ——
    小地图上方会一直告诉你「出口在哪个方向、还隔着几个区」。
  · 通关一次会解锁「无尽模式」：没有终点，只有你能撑到第几层。
  · 每一局结束都会算一个分数（深度 + 击杀 + 精英 + 守卫 + 通关，再乘难度系数），
    记进本机排行榜（前 10 名，含逐项明细）。
    这是单机包、没有服务器，分数只存在你自己的存档里。
  · 背景音乐：同样是 Web Audio 实时合成，三个段落会随潮汐水位与血量切换（M 静音）。

说明
  这是一个绿色免安装版本，整个文件夹拷走就能玩。
  不需要安装任何东西 —— 渲染内核用的是 Windows 自带的
  Microsoft Edge WebView2 运行时（Win10/11 默认已包含）。

  如果提示缺少 WebView2 运行时，可从微软官网免费下载安装：
  https://developer.microsoft.com/microsoft-edge/webview2/

  画面设置与存档保存在 %LOCALAPPDATA%\NumeralTide，删除该目录即可重置。

美术与音效来源
  · 地形瓦片、角色、怪物：全部由游戏代码实时绘制（无外部素材文件）。
  · 界面图标：game-icons.net，CC BY 3.0，作者 Lorc / Delapouite / Skoll /
    Sbed / Willdabeast / Cathelineau / Caro Asercion / Carl Olsen /
    Zeromancer / Badges。协议要求署名，此处即为署名。
  · 音效：全部由 Web Audio 实时合成，无音频文件。
"@
$readme | Out-File -FilePath (Join-Path $root "说明.txt") -Encoding utf8 -Force
Say "说明.txt"

# ------------------------------------------------------------
Head "打包干净分发包 → release\$name\"
New-Item -ItemType Directory -Path $release -Force | Out-Null
Copy-Item (Join-Path $root "www") $release -Recurse -Force
foreach ($d in $dlls) { Copy-Item (Join-Path $root $d) $release -Force }
Copy-Item (Join-Path $root "$name.exe") $release -Force
Copy-Item (Join-Path $root "说明.txt") $release -Force
$relKB = [math]::Round((Get-ChildItem $release -Recurse -File |
    Measure-Object -Property Length -Sum).Sum / 1KB, 1)
Say "release\$name\  ($relKB KB)"

# 旧版本的 zip 必须一并清掉：release\ 里留着一个上一版的 zip，
# 是最容易被当成最新版发出去的东西 —— 发错版本比没发更糟。
Get-ChildItem (Join-Path $root "release") -Filter "*.zip" -File -ErrorAction SilentlyContinue | ForEach-Object {
    Assert-InRoot $_.FullName
    Remove-Item -LiteralPath $_.FullName -Force
    Say "已删除旧分发包  $($_.Name)"
}

$zip = Join-Path $root "release\$name-v$version.zip"
if (Test-Path $zip) { Assert-InRoot $zip; Remove-Item $zip -Force }
Compress-Archive -Path $release -DestinationPath $zip -CompressionLevel Optimal -Force
$zipKB = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Say "$name-v$version.zip  ($zipKB KB)"

# ------------------------------------------------------------
Head "完成"
Get-ChildItem $root | Where-Object {
    $_.Name -in @("$name.exe", "说明.txt", "www", "release") -or $_.Name -in $dlls
} | ForEach-Object {
    if ($_.PSIsContainer) { Say ("[目录] " + $_.Name) }
    else { Say ("{0,8:N1} KB  {1}" -f ($_.Length / 1KB), $_.Name) }
}
Write-Host ""
Write-Host "  双击即玩：$root\$name.exe" -ForegroundColor Green
Write-Host "  干净分发包：$zip" -ForegroundColor Green
Write-Host ""
