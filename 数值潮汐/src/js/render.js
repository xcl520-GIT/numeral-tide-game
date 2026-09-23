/* ============================================================
   数值潮汐 · 渲染层 v4.1

   【两个核心改动】

   1. 插值。v4.0 是"逻辑上的格子坐标直接当屏幕坐标用"，所以每走一步
      角色都是瞬移 —— 逻辑没错，但观感上就是"卡、帧率低"。
      现在逻辑位置（整数格）和视觉位置（浮点）分开，
      视觉位置每帧朝逻辑位置收敛（指数平滑，与帧率无关）。
      这一步对"手感"的提升，比任何美术素材都大。

   2. 世界层烘焙。地形、AO、以及"去过但当前看不见"的压暗，
      全部烤进一张与世界等大的离屏 canvas，只在状态变化时重建。
      每帧只做一次 drawImage 把可视区域贴出来。

   分层顺序：
     世界层（烘焙） → 动画地形 → 实体 → 光照 → 粒子 → 小地图
   ============================================================ */
(function (global) {
  'use strict';

  const D = global.TideData;
  const C = global.TideCore;
  const A = global.TideArt;
  const FX = global.TideFX;

  const TILE = A.TILE;
  const T = C.T;

  function $(id) { return document.getElementById(id); }

  let cv, ctx, W = 0, H = 0, dpr = 1;
  let camX = 0, camY = 0;              // 整数像素（像素画游戏必须整格移动，否则砖缝会闪）
  let camFX = 0, camFY = 0;            // 未取整的相机目标，用于平滑
  const light = document.createElement('canvas');
  const lctx = light.getContext('2d');
  const worldCv = document.createElement('canvas');
  const miniCv = document.createElement('canvas');
  let worldDirty = true, miniDirty = true;
  const time = { t: 0 };

  /* ============================================================
     视觉位置：逻辑格（整数）→ 屏幕格（浮点）
     ============================================================ */
  const vis = { px: 0, py: 0, face: 'down', walk: 0, moving: false };
  const entVis = {};                   // 敌人 id → {x,y}
  let atkT = 0, atkDir = { x: 1, y: 0 };
  let lastDepth = -1, lastW = 0;

  const TAU_MOVE = 46;                 // 越小越"跟手"，越大越"沉"
  const TAU_CAM = 95;

  function kOf(tau, dt) { return 1 - Math.exp(-dt / tau); }

  function approach(cur, target, k) {
    const d = target - cur;
    if (Math.abs(d) < 0.015) return target;
    return cur + d * k;
  }

  /* ============================================================
     初始化（幂等：showGame 每次回到游戏界面都会调）
     ============================================================ */
  let inited = false;
  let ro = null;
  function init() {
    if (inited) { resize(); return; }
    cv = $('view');
    if (!cv) return;
    ctx = cv.getContext('2d');
    if (!ctx) {
      // WebView2 在显卡驱动异常 / 硬件加速被关掉时可能拿不到 2D 上下文。
      // 这时如果继续每帧调 ctx.xxx()，就会变成"黑屏 + 控制台无限刷错误"，
      // 而这游戏是发给别人的，玩家只会觉得"游戏坏了"。
      if (global.TideMain && global.TideMain.fatal) {
        global.TideMain.fatal('canvas.getContext("2d") 返回了 null',
          '这台机器的渲染内核拿不到 2D 画布。可以先重启试试；' +
          '如果一直这样，在 Edge 设置里关闭「硬件加速」后重开游戏通常能解决。');
      }
      return;
    }
    inited = true;
    resize();
    global.addEventListener('resize', resize);
    // ResizeObserver 才是正解：容器因为"从 display:none 变成可见"而获得尺寸时
    // 不会触发 window.resize，只靠 setTimeout 猜时机迟早会错。
    if (global.ResizeObserver) {
      ro = new global.ResizeObserver(function () { resize(); });
      ro.observe(cv.parentElement);
    }
  }

  /**
   * 画布尺寸必须**严格等于容器尺寸**。
   *
   * 这一版砍掉了原来的 `Math.max(320, ...)`：
   * 容器比 320 窄时（侧栏占 268px 的窄窗口、或者被压扁的面板），
   * 那个下限会把画布撑到 320px，溢出到侧栏上；
   * 由于 #stage 是 position:relative 而侧栏不是，画布会**盖住整个侧栏**，
   * 而溢出区域又恰好是未探索的纯黑地图 —— 看上去就是"地图错乱、面板消失"。
   *
   * 另外：容器还没布局好（宽度≈0）时直接返回，不要把画布改成错误尺寸。
   * 早先的做法是退化成 320×240，于是开局前两帧画面尺寸是错的。
   */
  /* ============================================================
     视角缩放

     实现路线：**拉伸屏幕，而不是改绘制变换。**

     全项目有二十多处手工算「屏幕 = 世界 × TILE − cam」（瓦片剔除、地形烘焙、
     光照层、粒子、指针映射…）。要是改用 ctx.scale 缩放，这些地方全都要跟着改，
     漏一处就是「地图错位」那类 bug 的翻版 —— 而且那种错位不报错、不崩，
     只有像素统计才看得出来。

     所以这里反过来做：绘制代码**一行不动**（仍然在 1× 空间里算），
     只让「可见世界」缩小，再由浏览器把画布放大贴回屏幕。

     代价：非整数缩放对像素画不友好（有的像素占 2 格、有的占 1 格），
     所以档位取得稀疏一些。收益：所有既有坐标逻辑的正确性原样保留。
     ============================================================ */
  const ZOOM_STEPS = [0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2];
  let zoom = 1;
  let cssW = 0, cssH = 0;        // canvas 元素的显示尺寸（容器给的）

  function setZoom(z) {
    const nz = Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Number(z) || 1));
    if (nz === zoom) return zoom;
    zoom = nz;
    resize();                    // 可见世界尺寸变了，画布要重算
    return zoom;
  }

  /** 沿档位走一格：dir > 0 放大，dir < 0 缩小。返回新的倍率。 */
  function zoomBy(dir) {
    let i;
    if (dir > 0) { for (i = 0; i < ZOOM_STEPS.length; i++) if (ZOOM_STEPS[i] > zoom + 1e-6) break; }
    else { for (i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < zoom - 1e-6) break; }
    return setZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i))]);
  }

  function resize() {
    if (!cv || !ctx) return;     // 拿不到 2D 上下文时别再往下走，否则每帧抛错
    const box = cv.parentElement.getBoundingClientRect();
    const cw = Math.floor(box.width), ch = Math.floor(box.height);
    if (cw < 8 || ch < 8) return;               // 容器尚未布局，保持现状
    dpr = Math.min(2, global.devicePixelRatio || 1);
    // W/H 从此的含义是「可见世界的像素尺寸」，不再是画布元素的显示尺寸：
    // zoom=2 时可见世界缩到一半，画布元素仍占满容器，由浏览器放大 2 倍贴回。
    const nw = Math.max(64, Math.round(cw / zoom));
    const nh = Math.max(64, Math.round(ch / zoom));
    if (nw === W && nh === H && cssW === cw && cssH === ch) return;
    cssW = cw; cssH = ch;
    W = nw; H = nh;
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    cv.style.width = cssW + 'px';
    cv.style.height = cssH + 'px';
    light.width = cv.width;
    light.height = cv.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    A.setDpr(dpr);
    worldDirty = true;
    miniDirty = true;      // 小地图按 dpr 烘焙，dpr 变了必须重建
  }

  /** 状态变了就调一次：地形 / 视野 / 潮汐 / 宝箱 都会影响世界层 */
  function markDirty() { worldDirty = true; miniDirty = true; }
  function onDepthChange() { vis.px = -999; worldDirty = true; miniDirty = true; atkT = 0; }

  /** 玩家做了一次动作（攻击时朝目标方向前倾） */
  function action(dirx, diry) {
    if (dirx || diry) atkDir = { x: dirx, y: diry };
    atkT = 1;
  }

  /* ============================================================
     魂技的表演层

     光有数值不算"加了技能"。玩家反馈过「技能没有任何感觉，虽然有效」——
     实测那一次它只产生了震屏，**零粒子零飘字**。
     所以这一层要补齐三件事，缺一件都会"没感觉"：

       1. 施法**姿态**  —— 身体上浮 + 缩放脉冲 + 身上一层光 + 地面法阵
       2. 技能**名号**  —— 飘字喊出来，否则玩家不知道刚才放的是什么
       3. 招牌**特效**  —— 每个技能各有一套（地裂 / 水束 / 残影 / 护盾罩）

     全部由 skill 事件驱动，逻辑层依旧完全不认识 canvas。
     ============================================================ */
  let castT = 0, castKey = null, castTint = '#9fe6f2';

  function castSkill(ev) {
    castT = 1;
    castKey = ev ? ev.key : null;
    castTint = (ev && ev.tint) || '#9fe6f2';
  }

  /** 角色身上有没有"不退之壁"这类持续增益 —— 护盾罩要一直亮着，不能闪一下就没 */
  function shieldOn(game) {
    if (!game.buffs) return false;
    for (const b of game.buffs) if (b.key === 'bulwark') return true;
    return false;
  }

  /** #rgb / #rrggbb → rgba(...)，用来给技能色做半透明光晕 */
  function hexA(hex, a) {
    const h = String(hex || '#ffffff').replace('#', '');
    const full = h.length === 3 ? h.replace(/./g, function (c) { return c + c; }) : h;
    const n = parseInt(full, 16) || 0;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ============================================================
     世界层烘焙
     ============================================================ */
  function buildWorld(game) {
    const w = game.W * TILE, h = game.H * TILE;
    if (worldCv.width !== Math.floor(w * dpr) || worldCv.height !== Math.floor(h * dpr)) {
      worldCv.width = Math.floor(w * dpr);
      worldCv.height = Math.floor(h * dpr);
    }
    const c = worldCv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, w, h);
    const tiles = A.tiles;

    for (let y = 0; y < game.H; y++) {
      for (let x = 0; x < game.W; x++) {
        const i = y * game.W + x;
        if (!game.explored[i]) continue;
        const t = game.tiles[i];
        const dx = x * TILE, dy = y * TILE;
        // 这一格属于哪个区域（地图太小时 core 会干脆不分区，所以可能没有）
        const rid = game.regionOf ? game.regionOf[i] : -1;
        const rReg = (rid >= 0 && game.regionOfId) ? game.regionOfId(rid) : null;
        const rInfo = rReg ? (D.REGIONS[rReg.type] || D.REGIONS.normal) : null;
        if (t === T.WALL) {
          let m = 0;
          if (game.tileAt(x, y - 1) !== T.WALL) m |= 1;
          if (game.tileAt(x - 1, y) !== T.WALL) m |= 2;
          if (game.tileAt(x + 1, y) !== T.WALL) m |= 4;
          if (game.tileAt(x, y + 1) !== T.WALL) m |= 8;
          c.drawImage(tiles['wall' + (m & 7)], dx, dy, TILE, TILE);
        } else if (t === T.WATER) {
          c.drawImage(tiles['water0'], dx, dy, TILE, TILE);
        } else if (t === T.MOSS) {
          c.drawImage(tiles['moss' + ((x ^ y) % 3)], dx, dy, TILE, TILE);
        } else if (t === T.LAVA) {
          c.drawImage(tiles['lava0'], dx, dy, TILE, TILE);
        } else if (t === T.STAIRS) {
          c.drawImage(tiles['stairs0'], dx, dy, TILE, TILE);
        } else if (t === T.CHEST) {
          c.drawImage(tiles['chest'], dx, dy, TILE, TILE);
        } else if (t === T.FOUNTAIN) {
          c.drawImage(tiles['fountain'], dx, dy, TILE, TILE);
        } else if (t === T.SHOP) {
          c.drawImage(tiles['shop0'], dx, dy, TILE, TILE);
        } else {
          c.drawImage(tiles['floor' + ((((x * 73856093) ^ (y * 19349663)) >>> 0) % 4)], dx, dy, TILE, TILE);
        }
        // —— 区域染色（v11-5）——
        // 只染**可走格**，墙不染：这样"区域"读出来就是"地面上的地盘"，
        // 而不是"连墙带地一起刷了色的一个方块"。
        // 相邻两区的接缝另画四根 1.5px 的边 —— 两块深浅相近的色块挨在一起时，
        // 只靠染色是看不出分界的。
        if (rInfo && t !== T.WALL) {
          c.fillStyle = rInfo.tint;
          c.fillRect(dx, dy, TILE, TILE);
          c.globalAlpha = 0.30;
          c.fillStyle = rInfo.color;
          if (game.regionAt(x, y - 1) !== rid) c.fillRect(dx, dy, TILE, 1.5);
          if (game.regionAt(x, y + 1) !== rid) c.fillRect(dx, dy + TILE - 1.5, TILE, 1.5);
          if (game.regionAt(x - 1, y) !== rid) c.fillRect(dx, dy, 1.5, TILE);
          if (game.regionAt(x + 1, y) !== rid) c.fillRect(dx + TILE - 1.5, dy, 1.5, TILE);
          c.globalAlpha = 1;
        }
        // AO：墙脚的一圈暗，是"墙立起来了"的关键
        let am = 0;
        if (game.tileAt(x, y - 1) === T.WALL) am |= 1;
        if (game.tileAt(x - 1, y) === T.WALL) am |= 2;
        if (game.tileAt(x + 1, y) === T.WALL) am |= 4;
        if (game.tileAt(x, y + 1) === T.WALL) am |= 8;
        if (am) c.drawImage(aoTile(am), dx, dy, TILE, TILE);
        const d = game.deco[i];
        if (d) {
          const key = d === C.DECO.RUBBLE ? 'prop_rubble'
            : d === C.DECO.BONES ? 'prop_bones'
              : d === C.DECO.BARREL ? 'prop_barrel'
                : d === C.DECO.CRATE ? 'prop_crate' : null;
          if (key) c.drawImage(tiles[key], dx, dy, TILE, TILE);
        }
        // 「去过但当前看不见」的压暗直接烘进来 ——
        // 它只在玩家移动时变化，正好和世界层重建的时机一致
        if (!game.visible[i]) {
          c.fillStyle = 'rgba(6,9,18,0.42)';
          c.fillRect(dx, dy, TILE, TILE);
        }
      }
    }
    worldDirty = false;
  }

  /* AO 预烤：16 种邻接组合 */
  const aoCache = {};
  function aoTile(mask) {
    const key = mask + '@' + dpr;
    if (aoCache[key]) return aoCache[key];
    const s = Math.floor(TILE * dpr);
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const g = c.getContext('2d');
    const D2 = 9 * dpr;
    const put = (x0, y0, x1, y1) => {
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, 'rgba(0,0,0,0.42)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, s, s);
    };
    if (mask & 1) put(0, 0, 0, D2);
    if (mask & 2) put(0, 0, D2, 0);
    if (mask & 4) put(s, 0, s - D2, 0);
    if (mask & 8) put(0, s, 0, s - D2);
    aoCache[key] = c;
    return c;
  }

  /* ============================================================
     动画地形（水 / 岩浆 / 潮汐之门 / 商栈 / 火盆）
     只画**当前可见**的格子。
     之前把"去过但看不见"的格子也用全亮动画重绘了一遍，
     而世界层已经把那些格子压暗了 42% —— 结果是黑暗的地图上
     浮着一块块全亮的水和岩浆，看起来就是"地图错乱"。
     不可见的格子保留烘焙时的静态帧（已经被压暗），视觉才统一。
     ============================================================ */
  function drawAnimated(game, anim) {
    const x0 = Math.max(0, Math.floor(camX / TILE));
    const y0 = Math.max(0, Math.floor(camY / TILE));
    const x1 = Math.min(game.W - 1, Math.ceil((camX + W) / TILE));
    const y1 = Math.min(game.H - 1, Math.ceil((camY + H) / TILE));
    const tiles = A.tiles;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * game.W + x;
        if (!game.visible[i]) continue;
        const t = game.tiles[i];
        const dx = x * TILE - camX, dy = y * TILE - camY;
        if (t === T.WATER) {
          ctx.drawImage(tiles['water' + anim.waterFrame], dx, dy, TILE, TILE);
        } else if (t === T.LAVA) {
          ctx.drawImage(tiles['lava' + anim.lavaFrame], dx, dy, TILE, TILE);
        } else if (t === T.STAIRS) {
          ctx.drawImage(tiles['stairs' + anim.waterFrame], dx, dy, TILE, TILE);
        } else if (t === T.SHOP) {
          ctx.drawImage(tiles['shop' + (anim.waterFrame % 2)], dx, dy, TILE, TILE);
        } else if (game.deco[i] === C.DECO.BRAZIER) {
          ctx.drawImage(tiles['prop_brazier' + anim.lavaFrame], dx, dy, TILE, TILE);
        }
        // 玩家踩在水上时加一圈涟漪
        if (t === T.WATER && x === game.px && y === game.py) {
          const ph = (time.t % 40) / 40;
          ctx.strokeStyle = 'rgba(159,230,242,' + (0.5 * (1 - ph)).toFixed(2) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(dx + TILE / 2, dy + TILE / 2, 5 + ph * 13, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  /* ============================================================
     区域标签（v11-5）

     颜色能回答"这是不是同一块地"，但回答不了"这是什么地" ——
     危险区该不该进，靠的是名字和星数。
     所以每个区域在自己的重心上浮一个名字；没去过的淡一档
     （名字照给：v11 的口径是"进图就能规划路线"，那就不该藏信息）。

     为什么不烘进世界层：它要跟着相机走，而且"认不认得"会变。
     ============================================================ */
  let labelDepth = -1, labelSeen = {}, lastLabelCount = 0;

  /** 区域重心未必落在可走格上（区域是沿可走格长出来的），
      所以从重心往外一圈圈找最近的己方格子当代言位置。 */
  function labelAnchor(game, reg) {
    const key = reg.id + '@' + reg.cx + ',' + reg.cy;
    if (labelSeen[key]) return labelSeen[key];
    let best = { x: reg.cx, y: reg.cy }, bestD = 1e9;
    for (let y = -6; y <= 6; y++) {
      for (let x = -6; x <= 6; x++) {
        const qx = reg.cx + x, qy = reg.cy + y;
        if (game.regionAt(qx, qy) !== reg.id) continue;
        const d = x * x + y * y;
        if (d < bestD) { bestD = d; best = { x: qx, y: qy }; }
      }
    }
    labelSeen[key] = best;
    return best;
  }

  function drawRegionLabels(game) {
    lastLabelCount = 0;
    if (!game.regions || !game.regions.length || !ctx) return;
    if (labelDepth !== game.depth) { labelDepth = game.depth; labelSeen = {}; }
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 11px "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
    for (const reg of game.regions) {
      const info = D.REGIONS[reg.type] || D.REGIONS.normal;
      const at = labelAnchor(game, reg);
      const sx = Math.round(at.x * TILE - camX + TILE / 2);
      const sy = Math.round(at.y * TILE - camY + TILE / 2);
      if (sx < -60 || sy < -20 || sx > W + 60 || sy > H + 20) continue;
      const known = !!(game.regionVisited && game.regionVisited[reg.id]);
      const text = info.name + '　' + '\u2605'.repeat(info.danger);
      const tw = ctx.measureText(text).width;
      ctx.globalAlpha = known ? 0.95 : 0.55;
      // 底衬：没有它，名字压在花纹地砖上会糊成一团
      ctx.fillStyle = 'rgba(6,9,18,0.55)';
      ctx.fillRect(sx - tw / 2 - 6, sy - 9, tw + 12, 18);
      ctx.fillStyle = info.color;
      ctx.fillRect(sx - tw / 2 - 6, sy - 9, 2, 18);
      ctx.fillStyle = known ? '#e8eef8' : '#93a1b8';
      ctx.fillText(text, sx, sy + 0.5);
      lastLabelCount++;
    }
    ctx.restore();
  }

  /** 路径预览 */
  function drawPath(path) {
    if (!path || path.length < 2) return;
    ctx.save();
    for (let i = 1; i < path.length; i++) {
      const p = path[i];
      const a = 0.60 * (1 - i / path.length) + 0.14;
      ctx.fillStyle = 'rgba(126,224,214,' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x * TILE - camX + TILE / 2, p.y * TILE - camY + TILE / 2, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ============================================================
     实体
     ============================================================ */
  function shadow(dx, dy, scale) {
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath();
    ctx.ellipse(dx + TILE / 2, dy + TILE - 5, TILE * 0.30 * (scale || 1), TILE * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPlayer(game) {
    const dx = vis.px * TILE - camX;
    const dy = vis.py * TILE - camY;
    shadow(dx, dy, 1);
    const spr = A.heroSprite(game.cls, vis.face, vis.moving ? (1 + (Math.floor(vis.walk / 118) % 2)) % 2 : 0);
    let ox = 0, oy = 0;
    if (atkT > 0.01) {
      const amp = Math.sin((1 - atkT) * Math.PI) * 7;
      ox = atkDir.x * amp; oy = atkDir.y * amp * 0.6;
      atkT *= 0.86;
    } else if (vis.moving) {
      oy = -Math.abs(Math.sin(vis.walk / 118 * Math.PI)) * 1.6;
    } else {
      oy = Math.sin(time.t * 0.11) * 0.9;
    }
    // 施法时身体上浮：让"在放技能"和"在走路"一眼分得开
    if (castT > 0.01) oy -= Math.sin((1 - castT) * Math.PI) * 2.6;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(dx + ox, dy + oy);
    if (vis.face === 'side' && vis.faceLeft) {
      ctx.translate(TILE, 0); ctx.scale(-1, 1);
    }
    ctx.drawImage(spr, 0, 0, TILE, TILE);
    ctx.restore();
    // 脚下光环：一眼找到自己
    const g = ctx.createRadialGradient(dx + TILE / 2, dy + TILE - 6, 1, dx + TILE / 2, dy + TILE - 6, TILE * 0.62);
    g.addColorStop(0, 'rgba(126,224,214,0.20)');
    g.addColorStop(1, 'rgba(126,224,214,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(dx + TILE / 2, dy + TILE - 6, TILE * 0.62, TILE * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();

    // —— 施法姿态：地面法阵 + 身上一层光 ——
    // 只有粒子和震屏是不够的：玩家需要一个"我确实按下了技能"的确认，
    // 而这个确认最好长在角色自己身上。
    if (castT > 0.01) {
      const ccx = dx + TILE / 2, ccy = dy + TILE - 6;
      const pulse = Math.sin((1 - castT) * Math.PI);
      ctx.save();
      ctx.globalAlpha = castT * 0.95;
      ctx.strokeStyle = castTint;
      for (let i = 0; i < 2; i++) {
        const rr = TILE * (0.44 + i * 0.2) * (1 + pulse * 0.45);
        ctx.lineWidth = Math.max(1, 2 - i * 0.7);
        ctx.beginPath();
        ctx.ellipse(ccx, ccy, rr, rr * 0.42, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      const gg = ctx.createRadialGradient(ccx, dy + TILE / 2, 2, ccx, dy + TILE / 2, TILE * 0.95);
      gg.addColorStop(0, 'rgba(255,255,255,0)');
      gg.addColorStop(0.5, hexA(castTint, 0.34 * castT));
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = gg;
      ctx.beginPath();
      ctx.arc(ccx, dy + TILE / 2, TILE * 0.95, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // —— 不退之壁：护盾罩 ——
    // 持续型增益必须**一直看得见**。技能价值的一半是"我知道它还在生效"，
    // 只闪一下的护盾会让玩家怀疑自己是不是白点了。
    if (shieldOn(game)) {
      const ccx = dx + TILE / 2, ccy = dy + TILE / 2;
      ctx.save();
      ctx.globalAlpha = 0.46 + Math.sin(time.t * 0.13) * 0.14;
      ctx.strokeStyle = '#f0d060';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ccx, ccy + 1, TILE * 0.76, Math.PI * 0.12, Math.PI * 0.88, true);
      ctx.stroke();
      ctx.globalAlpha *= 0.55;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(ccx, dy + TILE - 5, TILE * 0.64, TILE * 0.25, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawEnemy(game, e) {
    const i = e.y * game.W + e.x;
    if (!game.visible[i]) return;
    const v = entVis[e.id] || (entVis[e.id] = { x: e.x, y: e.y });
    const dx = v.x * TILE - camX;
    const dy = v.y * TILE - camY;
    shadow(dx, dy, 1);
    const spr = A.monsterSprite(e.arc.shape, e.arc.id, 0);
    // 呼吸挤压：怪物体积大，一点点形变就很有"活物"的感觉
    const ph = time.t * 0.07 + e.id;
    const sy = 1 + Math.sin(ph) * 0.045;
    const sx = 1 - Math.sin(ph) * 0.035;
    let ox = 0, oy = 0;
    if (e.hitFlash > 0) {
      const amp = (e.hitFlash / 12) * Math.sin((1 - e.hitFlash / 12) * Math.PI) * 6;
      const ddx = game.px - e.x, ddy = game.py - e.y;
      const len = Math.max(1, Math.hypot(ddx, ddy));
      ox = ddx / len * amp; oy = ddy / len * amp * 0.6;
      e.hitFlash--;
    }
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(dx + TILE / 2 + ox, dy + TILE + oy);
    ctx.scale(sx, sy);
    ctx.drawImage(spr, -TILE / 2, -TILE, TILE, TILE);
    ctx.restore();

    const pct = Math.max(0, e.hp / e.maxHp);
    const bw = e.isBoss ? TILE * 1.7 : TILE * 0.8;
    const bx = dx + TILE / 2 - bw / 2, by = dy - (e.isBoss ? 10 : 5);
    ctx.fillStyle = 'rgba(8,10,16,0.86)';
    ctx.fillRect(bx - 1, by - 1, bw + 2, 5);
    ctx.fillStyle = e.isBoss ? '#f0a03c' : (e.kind === 'elite' ? '#b06cf0' : '#e0525a');
    ctx.fillRect(bx, by, bw * pct, 3);
    if (e.isBoss || e.kind === 'elite') {
      ctx.fillStyle = e.isBoss ? '#f0d060' : '#d8b0ff';
      ctx.font = 'bold 10px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(e.name, dx + TILE / 2, by - 3);
      ctx.textAlign = 'left';
    }

    // —— 状态：眩晕 / 潮湿 ——
    // 状态不画出来，玩家就只能靠"这怪怎么不动"去猜。
    // 这两个都是**能改变打法**的信息（一个告诉你它这轮白给，
    // 一个告诉你现在用法术更赚），值得占精灵上的位置。
    if (e.stun > 0) {
      const ph = time.t * 0.09 + e.id;
      ctx.save();
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      for (let i = 0; i < 3; i++) {
        const a = ph + i * (Math.PI * 2 / 3);
        ctx.globalAlpha = 0.55 + Math.sin(a) * 0.35;
        ctx.fillStyle = '#ffe08a';
        ctx.fillText('✦', dx + TILE / 2 + Math.cos(a) * 9, dy - 1 + Math.sin(a) * 3.2);
      }
      ctx.restore();
      ctx.textAlign = 'left';
    }
    if (e.wet > 0) {
      const drip = (time.t * 0.5 + e.id * 7) % 12;
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#5fc8e8';
      ctx.beginPath();
      ctx.ellipse(dx + TILE / 2, dy + TILE * 0.6, TILE * 0.36, TILE * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(dx + TILE / 2 - 5, dy + 6 + drip, 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(dx + TILE / 2 + 6, dy + 9 + ((drip + 6) % 12), 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /* ============================================================
     光照
     ============================================================ */
  function drawLighting(game, anim) {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, light.width, light.height);
    lctx.fillStyle = 'rgba(3,6,14,0.62)';
    lctx.fillRect(0, 0, light.width, light.height);
    lctx.globalCompositeOperation = 'destination-out';
    const cut = (cx, cy, r, strength) => {
      const g = lctx.createRadialGradient(cx, cy, r * 0.12, cx, cy, r);
      g.addColorStop(0, 'rgba(0,0,0,' + strength + ')');
      g.addColorStop(0.50, 'rgba(0,0,0,' + (strength * 0.88).toFixed(3) + ')');
      g.addColorStop(0.78, 'rgba(0,0,0,' + (strength * 0.48).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.beginPath();
      lctx.arc(cx, cy, r, 0, Math.PI * 2);
      lctx.fill();
    };
    const pr = 10.6 * TILE * dpr;
    const flick = 1 + Math.sin(time.t * 0.13) * 0.012 + Math.sin(time.t * 0.41) * 0.008;
    cut((vis.px * TILE + TILE / 2 - camX) * dpr, (vis.py * TILE + TILE / 2 - camY) * dpr, pr * flick, 0.99);

    const x0 = Math.max(0, Math.floor(camX / TILE) - 2);
    const y0 = Math.max(0, Math.floor(camY / TILE) - 2);
    const x1 = Math.min(game.W - 1, Math.ceil((camX + W) / TILE) + 2);
    const y1 = Math.min(game.H - 1, Math.ceil((camY + H) / TILE) + 2);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * game.W + x;
        if (!game.visible[i]) continue;
        const t = game.tiles[i], d = game.deco[i];
        let r = 0, s = 0;
        if (t === T.STAIRS) { r = 3.4 * TILE; s = 0.92; }
        else if (t === T.SHOP) { r = 3.2 * TILE; s = 0.88; }
        else if (t === T.LAVA) { r = 2.6 * TILE; s = 0.72; }
        else if (t === T.FOUNTAIN) { r = 2.6 * TILE; s = 0.70; }
        else if (t === T.CHEST) { r = 1.7 * TILE; s = 0.52; }
        else if (d === C.DECO.BRAZIER) { r = 3.0 * TILE; s = 0.85; }
        if (!r) continue;
        const f = (d === C.DECO.BRAZIER)
          ? (1 + Math.sin(time.t * 0.31 + x * 1.7) * 0.06) : 1;
        cut((x * TILE + TILE / 2 - camX) * dpr, (y * TILE + TILE / 2 - camY) * dpr, r * dpr * f, s);
      }
    }
    lctx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(light, 0, 0);
    ctx.restore();
  }

  function drawColorGrade() {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = 'rgba(120,90,40,0.055)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /* ============================================================
     小地图（只在状态变化时重画；按 dpr 烘焙，避免被放大糊掉）
     ============================================================ */
  const MINI_W = 190;
  let miniW = 0, miniH = 0, miniScale = 1;
  function buildMinimap(game) {
    miniScale = Math.min(MINI_W / game.W, MINI_W / game.H);
    miniW = Math.ceil(game.W * miniScale);
    miniH = Math.ceil(game.H * miniScale);
    miniCv.width = Math.floor(miniW * dpr);
    miniCv.height = Math.floor(miniH * dpr);
    const c = miniCv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, miniW, miniH);
    c.fillStyle = 'rgba(6,9,17,0.86)';
    c.fillRect(0, 0, miniW, miniH);
    for (let y = 0; y < game.H; y++) {
      for (let x = 0; x < game.W; x++) {
        const i = y * game.W + x;
        if (!game.explored[i]) continue;
        const t = game.tiles[i];
        let col;
        if (t === T.WALL) col = 'rgba(92,100,124,0.85)';
        else if (t === T.WATER) col = 'rgba(43,126,160,0.85)';
        else if (t === T.LAVA) col = 'rgba(216,84,42,0.9)';
        else if (t === T.STAIRS) col = 'rgba(126,224,214,1)';
        else if (t === T.SHOP) col = 'rgba(240,200,96,1)';
        else if (t === T.CHEST) col = 'rgba(240,208,96,0.95)';
        else if (t === T.FOUNTAIN) col = 'rgba(120,200,255,0.95)';
        else if (t === T.MOSS) col = 'rgba(70,110,80,0.8)';
        else {
          // 地板按所属区域上色 —— 小地图要能一眼扫出"哪块地是什么"，
          // 否则那张图只能告诉你"哪里是墙"
          const mrid = game.regionOf ? game.regionOf[i] : -1;
          const mreg = (mrid >= 0 && game.regionOfId) ? game.regionOfId(mrid) : null;
          col = mreg ? hexA((D.REGIONS[mreg.type] || D.REGIONS.normal).color, 0.62)
            : 'rgba(58,66,84,0.75)';
        }
        c.fillStyle = col;
        c.fillRect(x * miniScale, y * miniScale, Math.ceil(miniScale), Math.ceil(miniScale));
      }
    }
    miniDirty = false;
  }

  let lastExitNav = '';

  function drawMinimap(game) {
    if (!miniW) return;
    const ox = W - miniW - 14, oy = H - miniH - 14;
    ctx.save();
    ctx.fillStyle = 'rgba(6,9,17,0.6)';
    ctx.fillRect(ox - 4, oy - 4, miniW + 8, miniH + 8);
    ctx.strokeStyle = 'rgba(216,185,106,0.32)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox - 3.5, oy - 3.5, miniW + 7, miniH + 7);
    ctx.drawImage(miniCv, ox, oy, miniW, miniH);
    // 出口单独标：它是这一层**唯一必须去的地方**。混在地板色里等于没标，
    // 所以给它一个跟着时间脉动的空心方框。
    if (game.exit) {
      const ph = (time.t % 60) / 60;
      const ex = ox + game.exit.x * miniScale, ey = oy + game.exit.y * miniScale;
      ctx.strokeStyle = 'rgba(126,224,214,' + (0.95 - ph * 0.75).toFixed(2) + ')';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ex - 2 - ph * 3, ey - 2 - ph * 3, miniScale + 4 + ph * 6, miniScale + 4 + ph * 6);
    }
    for (const e of game.enemies) {
      if (!game.visible[e.y * game.W + e.x]) continue;
      ctx.fillStyle = e.isBoss ? '#f0a03c' : '#e0525a';
      ctx.fillRect(ox + e.x * miniScale - 1, oy + e.y * miniScale - 1, miniScale + 2, miniScale + 2);
    }
    ctx.fillStyle = '#7ee0d6';
    ctx.fillRect(ox + vis.px * miniScale - 1, oy + vis.py * miniScale - 1, miniScale + 2, miniScale + 2);
    // 出口导航挂在**小地图正上方**，而不是挤进顶部 HUD。
    // 理由是这两句是同一件事的两半：「我在哪 → 我要去哪」。
    // 挤 HUD 还有个实际后果：1120px 的最小窗口下，顶部那排会增加一条换行。
    const ginfo = game.exitRegionInfo ? game.exitRegionInfo() : null;
    lastExitNav = !ginfo ? ''
      : ginfo.same ? ('出口就在本区 · ' + ginfo.name)
        : ('出口 ' + ginfo.dir + ' · ' + ginfo.name + (ginfo.hops > 0 ? ' · ' + ginfo.hops + ' 区外' : ''));
    if (lastExitNav) {
      ctx.font = '600 11px "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const nw = Math.max(miniW, ctx.measureText(lastExitNav).width + 16);
      const nx = ox + miniW / 2;
      const ny = oy - 13;
      ctx.fillStyle = 'rgba(6,9,17,0.74)';
      ctx.fillRect(nx - nw / 2, ny - 9, nw, 18);
      ctx.strokeStyle = 'rgba(126,224,214,0.30)';
      ctx.lineWidth = 1;
      ctx.strokeRect(nx - nw / 2 + 0.5, ny - 8.5, nw - 1, 17);
      ctx.fillStyle = ginfo.same ? '#7ee0d6' : '#c9d6e6';
      ctx.fillText(lastExitNav, nx, ny + 0.5);
    }
    ctx.restore();
  }

  /* ============================================================
     主入口
     ============================================================ */
  let lastT = 0;
  function render(game, anim, shake, dtMs) {
    if (!ctx) return;
    const dt = Math.max(4, Math.min(64, dtMs || 16));
    time.t++;
    anim = anim || {};
    anim.waterFrame = Math.floor(time.t / 18) % 3;
    anim.lavaFrame = Math.floor(time.t / 12) % 3;
    // 施法姿态只是一段演出时间，和游戏逻辑无关，所以在渲染层自己衰减
    if (castT > 0) castT = Math.max(0, castT - dt / 420);

    /* —— 视觉位置收敛 —— */
    if (game.depth !== lastDepth) { lastDepth = game.depth; vis.px = game.px; vis.py = game.py; entVisClear(); }
    if (Math.abs(game.px - vis.px) > 6 || Math.abs(game.py - vis.py) > 6) { vis.px = game.px; vis.py = game.py; }
    const km = kOf(TAU_MOVE, dt);
    const dxPrev = game.px - vis.px;
    const dyPrev = game.py - vis.py;
    vis.moving = Math.abs(dxPrev) > 0.02 || Math.abs(dyPrev) > 0.02;
    vis.px = approach(vis.px, game.px, km);
    vis.py = approach(vis.py, game.py, km);
    if (Math.abs(dxPrev) > 0.06) { vis.face = 'side'; vis.faceLeft = dxPrev < 0; }
    else if (dyPrev < -0.06) vis.face = 'up';
    else if (dyPrev > 0.06) vis.face = 'down';
    if (vis.moving) vis.walk += dt;

    for (const e of game.enemies) {
      let v = entVis[e.id];
      if (!v) { v = entVis[e.id] = { x: e.x, y: e.y }; }
      if (Math.abs(e.x - v.x) > 6 || Math.abs(e.y - v.y) > 6) { v.x = e.x; v.y = e.y; }
      else { v.x = approach(v.x, e.x, km); v.y = approach(v.y, e.y, km); }
    }

    /* —— 相机：平滑 + 取整 —— */
    const mw = game.W * TILE, mh = game.H * TILE;
    let tcx = vis.px * TILE + TILE / 2 - W / 2;
    let tcy = vis.py * TILE + TILE / 2 - H / 2;
    if (mw <= W) tcx = (mw - W) / 2; else tcx = Math.max(0, Math.min(mw - W, tcx));
    if (mh <= H) tcy = (mh - H) / 2; else tcy = Math.max(0, Math.min(mh - H, tcy));
    if (Math.abs(tcx - camFX) > 400) camFX = tcx;
    if (Math.abs(tcy - camFY) > 400) camFY = tcy;
    const kc = kOf(TAU_CAM, dt);
    camFX = approach(camFX, tcx, kc);
    camFY = approach(camFY, tcy, kc);
    camX = Math.round(camFX);
    camY = Math.round(camFY);

    /* —— 世界层 —— */
    if (worldDirty) buildWorld(game);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, W, H);
    const sh = shake || { x: 0, y: 0 };
    ctx.save();
    // 震屏位移必须取整：亚像素平移会让整屏瓦片出现 1px 的接缝，
    // 看起来像地图撕裂
    ctx.translate(Math.round(sh.x), Math.round(sh.y));
    // 只贴可视区域。
    // 直接 drawImage(整张世界) 在 45×35 的地图上是每帧 600 万像素的填充，
    // 是那种"看不出哪儿慢但就是慢"的典型 —— 必须裁剪。
    const ww = game.W * TILE, wh = game.H * TILE;
    const sx0 = Math.max(0, camX), sy0 = Math.max(0, camY);
    const sw2 = Math.min(ww - sx0, W + 2), sh2 = Math.min(wh - sy0, H + 2);
    if (sw2 > 0 && sh2 > 0) {
      // 目标坐标必须是 (sx0 - camX, sy0 - camY)，也就是和所有实体一样的
      // "世界坐标 − 相机"。这里曾经直接写成 (sx0, sy0)，等于把源偏移当成了目标偏移：
      // 相机滚到 (camX, camY) 时，地形仍然被画在「世界坐标 = 屏幕坐标」的位置上，
      // 于是地形和玩家/敌人错开整整一个相机位移，视口左上还留出等宽的黑带；
      // 而相机停在原点时这个错误恰好抵消 —— 表现为"地图是黑的、人物错位、
      // 偶尔走到某处又正常了"。地形层被烘焙成离屏画布，这种错位不报错也不崩，
      // 连像素统计都很难发现，只有"相机滚起来之后视口边缘是否被铺满"能抓住它。
      ctx.drawImage(worldCv,
        sx0 * dpr, sy0 * dpr, sw2 * dpr, sh2 * dpr,
        sx0 - camX, sy0 - camY, sw2, sh2);
    }

    drawAnimated(game, anim);
    // 标签画在实体之前：角色和敌人要压在标签上面，否则名字会挡住战斗
    drawRegionLabels(game);
    if (anim.path) drawPath(anim.path);

    // 实体按 y 排序，靠下的后画 —— 形成前后遮挡关系
    const ents = game.enemies.slice().sort(function (a, b) { return a.y - b.y; });
    let drewPlayer = false;
    for (const e of ents) {
      if (!drewPlayer && e.y > vis.py) { drawPlayer(game); drewPlayer = true; }
      drawEnemy(game, e);
    }
    if (!drewPlayer) drawPlayer(game);
    ctx.restore();

    drawLighting(game, anim);
    drawColorGrade();
    FX.draw(ctx);
    if (miniDirty) buildMinimap(game);
    drawMinimap(game);
  }

  function entVisClear() { for (const k in entVis) delete entVis[k]; }

  global.TideRender = {
    init: init, resize: resize, render: render,
    markDirty: markDirty, action: action, onDepthChange: onDepthChange,
    castSkill: castSkill,
    /* 观测量：施法姿态有没有被触发。"技能有没有感觉"不该只靠肉眼说，
       这条链（模型事件 → 主循环 → 渲染层）要能被断言。 */
    get cast() { return { t: castT, key: castKey, tint: castTint }; },
    get view() { return { w: W, h: H }; },
    get cam() { return { x: camX, y: camY }; },
    /* 缩放的观测量：viewport 是"可见世界"，viewPx 是"画布元素" ——
       zoom = viewPx.w / viewport.w 必须始终成立，这是缩放的核心不变量。 */
    get zoom() { return zoom; },
    get viewPx() { return { w: cssW, h: cssH }; },
    setZoom: setZoom,
    zoomBy: zoomBy,
    ZOOM_STEPS: ZOOM_STEPS,
    /* 区域层的观测量：这一帧真画了几个区域标签、标签落在哪一格。
       "区域有没有画出来"不该只靠肉眼说 —— 冒烟要能断言它。 */
    get regionLabels() { return lastLabelCount; },
    /* 出口导航这一行到底写了什么 —— 它是一条会随走位变化的文本，
       断言"往哪走"这件事必须能读到它的内容，而不是靠看图。 */
    get exitNav() { return lastExitNav; },
    regionLabelAnchor: function (game, reg) { return labelAnchor(game, reg); },
    /* 小地图某个世界格子的**真实像素**。
       断言"小地图按区域上色"只有读像素才是真的：
       重算一遍颜色再和配置比，等于把配置抄了两遍。 */
    miniPixelAt: function (x, y) {
      if (!miniW || !miniScale) return null;
      const c = miniCv.getContext('2d');
      const px = Math.max(0, Math.min(miniCv.width - 1,
        Math.floor((x * miniScale + miniScale / 2) * dpr)));
      const py = Math.max(0, Math.min(miniCv.height - 1,
        Math.floor((y * miniScale + miniScale / 2) * dpr)));
      const d4 = c.getImageData(px, py, 1, 1).data;
      return [d4[0], d4[1], d4[2], d4[3]];
    },
    toCell: function (clientX, clientY) {
      const r = cv.getBoundingClientRect();
      // 画布被拉伸过：先把客户端像素换算回「1× 世界像素」，再减相机。
      // 用 W / r.width 而不是硬编码 zoom —— 万一 CSS 改过元素尺寸也不会算错
      // （参考系取自实际布局，而不是取自我们的意图）。
      const sx = r.width > 0 ? W / r.width : 1;
      const sy = r.height > 0 ? H / r.height : 1;
      return {
        x: Math.floor(((clientX - r.left) * sx + camX) / TILE),
        y: Math.floor(((clientY - r.top) * sy + camY) / TILE)
      };
    },
    TILE: TILE
  };
})(window);
