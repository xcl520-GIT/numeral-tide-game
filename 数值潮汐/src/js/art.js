/* ============================================================
   数值潮汐 · 美术层 v4.1

   【这一版最重要的两条改动，都是被"看起来帧率很低"逼出来的】

   1. 精灵不再逐像素绘制。
      v4.0 的 blitPX 每帧对每个实体做一次 fillRect/像素 ——
      一个 24×28 的精灵最多 672 次调用，场上十五个实体就是上万次/帧。
      帧率当然崩。现在所有精灵都预先烤成离屏 canvas，运行时只 drawImage。

   2. 精灵画布统一 32×32，和瓦片 1:1。
      只要像素网格对齐，就近采样就不会产生"有的像素 1px 有的 2px"的脏边。
      按设备像素比（dpr）预烤，HiDPI 屏上也是整数倍。

   另外补上了"动作"：
     · 三个朝向（正面 / 背面 / 侧面），侧面靠镜像复用
     · 每个朝向两帧行走（双腿交替）+ 一帧攻击前倾
   移动的顺滑感由 render.js 的插值负责，这里只负责"每一帧长什么样"。
   ============================================================ */
(function (global) {
  'use strict';

  const TILE = 32;                    // 世界坐标里一格的像素边长
  const SPR = 32;                     // 所有精灵的画布边长（= TILE，1:1）

  /* ---------------- 颜色工具 ---------------- */
  function hex2rgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb2hex(r, g, b) {
    return '#' + ((1 << 24) + ((Math.max(0, Math.min(255, r | 0))) << 16) +
      ((Math.max(0, Math.min(255, g | 0))) << 8) + Math.max(0, Math.min(255, b | 0)))
      .toString(16).slice(1);
  }
  function shade(hex, amt) {
    const c = hex2rgb(hex);
    return rgb2hex(
      amt > 0 ? c[0] + (255 - c[0]) * amt : c[0] * (1 + amt),
      amt > 0 ? c[1] + (255 - c[1]) * amt : c[1] * (1 + amt),
      amt > 0 ? c[2] + (255 - c[2]) * amt : c[2] * (1 + amt));
  }
  function mix(a, b, t) {
    const x = hex2rgb(a), y = hex2rgb(b);
    return rgb2hex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
  }
  /** 确定性噪声：不能用 Math.random，否则同一块地砖每帧都在闪 */
  function hash2(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + (seed || 0) * 2246822519) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* ============================================================
     PX —— 极简像素画布
     只负责"写像素"，不负责性能。渲染前一律 toCanvas() 预烤。
     ============================================================ */
  function PX(w, h) {
    this.w = w; this.h = h;
    this.d = new Array(w * h).fill(null);
  }
  PX.prototype.inb = function (x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; };
  PX.prototype.set = function (x, y, c) {
    x |= 0; y |= 0;
    if (c && this.inb(x, y)) this.d[y * this.w + x] = c;
    return this;
  };
  PX.prototype.get = function (x, y) { return this.inb(x, y) ? this.d[y * this.w + x] : null; };
  PX.prototype.rect = function (x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
    return this;
  };
  PX.prototype.ell = function (cx, cy, rx, ry, c, mask) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1.0 && (!mask || mask(x, y))) this.set(x, y, c);
      }
    }
    return this;
  };
  PX.prototype.line = function (x0, y0, x1, y1, c) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      const t = n ? i / n : 0;
      this.set(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), c);
    }
    return this;
  };
  PX.prototype.outline = function (c, diagonal) {
    const add = [];
    const dirs = diagonal ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
      : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.get(x, y)) continue;
      for (const d of dirs) if (this.get(x + d[0], y + d[1])) { add.push([x, y]); break; }
    }
    for (const p of add) this.set(p[0], p[1], c);
    return this;
  };
  /** 顶面受光：上方为空的地方提亮 */
  PX.prototype.topLight = function (amt, only) {
    const edits = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const c = this.get(x, y);
      if (c && !this.get(x, y - 1)) edits.push([x, y, shade(c, amt)]);
    }
    for (const e of edits) this.set(e[0], e[1], e[2]);
    return this;
  };
  PX.prototype.bottomDark = function (amt) {
    const edits = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const c = this.get(x, y);
      if (c && !this.get(x, y + 1)) edits.push([x, y, shade(c, -amt)]);
    }
    for (const e of edits) this.set(e[0], e[1], e[2]);
    return this;
  };
  /** 左亮右暗的简易体积感 */
  PX.prototype.sideLight = function (up, down) {
    const edits = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const c = this.get(x, y);
      if (!c) continue;
      if (!this.get(x - 1, y)) edits.push([x, y, shade(c, up)]);
      else if (!this.get(x + 1, y)) edits.push([x, y, shade(c, -down)]);
    }
    for (const e of edits) this.set(e[0], e[1], e[2]);
    return this;
  };
  /** 逐像素微噪，避免大色块看起来很"平" */
  PX.prototype.grain = function (n, seed, amt) {
    for (let i = 0; i < (n || 24); i++) {
      const x = Math.floor(hash2(i, seed, 71) * this.w);
      const y = Math.floor(hash2(i, seed, 73) * this.h);
      const c = this.get(x, y);
      if (c) this.set(x, y, shade(c, hash2(i, seed, 77) > 0.5 ? amt : -amt));
    }
    return this;
  };
  PX.prototype.toCanvas = function (scale) {
    const s = Math.max(1, Math.floor(scale || 1));
    const cv = global.document.createElement('canvas');
    cv.width = this.w * s;
    cv.height = this.h * s;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    // 按行合并连续同色像素，减少 fillRect 次数（烤一次，代价可忽略）
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const c = this.d[y * this.w + x];
        if (!c) { x++; continue; }
        let w = 1;
        while (x + w < this.w && this.d[y * this.w + x + w] === c) w++;
        ctx.fillStyle = c;
        ctx.fillRect(x * s, y * s, w * s, s);
        x += w;
      }
    }
    return cv;
  };

  /* ============================================================
     调色板
     ============================================================ */
  const PAL = {
    floorA: '#3b4356', floorB: '#454f64', floorC: '#313847', grout: '#282e3b',
    wallTop: '#5b6579', wallTopLit: '#7a869d', wallFace: '#353c4d', wallFaceDark: '#242a36',
    wallEdge: '#8b96b0',
    waterDeep: '#16374f', waterMid: '#205674', waterLight: '#338fae', foam: '#9fe6f2',
    moss: '#43734b', mossLit: '#639e6a', mossDark: '#2e5034',
    lava: '#d4522a', lavaLit: '#f4a842', lavaHot: '#ffe48e',
    wood: '#75522e', woodLit: '#96683b', woodDark: '#523818',
    stone: '#626a7c', stoneLit: '#808a9e',
    bone: '#e0dbc7', boneDark: '#a29c86',
    clothRed: '#a8383f', gold: '#e8c060'
  };

  /* ============================================================
     地形瓦片（全部 32×32）
     ============================================================ */
  function floorTile(variant, tone) {
    const p = new PX(TILE, TILE);
    const base = tone || PAL.floorA;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const n = hash2(x, y, variant * 97);
      let c = base;
      if (n > 0.87) c = shade(base, 0.11);
      else if (n < 0.13) c = shade(base, -0.11);
      else if (n > 0.48 && n < 0.52) c = shade(base, 0.05);
      p.set(x, y, c);
    }
    // 错缝砖缝：这是"铺过"的秩序感来源
    const off = (variant % 2) * 8;
    for (let x = 0; x < TILE; x++) p.set(x, 15 + 8 - off * 0, PAL.grout);
    for (let x = 0; x < TILE; x++) p.set(x, (15 + 8 - off + 16) % TILE, shade(PAL.grout, 0.08));
    for (let y = 0; y < TILE; y++) {
      p.set(off, y, PAL.grout);
      p.set((off + 16) % TILE, y, shade(PAL.grout, 0.08));
    }
    if (variant % 4 === 0) {
      let cx = 6 + (variant * 5) % 20, cy = 8;
      for (let i = 0; i < 12; i++) {
        p.set(cx, cy, shade(base, -0.17));
        cx += hash2(i, variant, 3) > 0.5 ? 1 : -1;
        cy += 1;
        if (cx < 1 || cx > 30 || cy > 30) break;
      }
    }
    // 一点苔痕，避免大面积地板过于单调
    if (variant % 3 === 1) {
      for (let i = 0; i < 7; i++) {
        const x = Math.floor(hash2(i, variant, 131) * TILE);
        const y = Math.floor(hash2(i, variant, 137) * TILE);
        p.set(x, y, mix(base, PAL.mossDark, 0.5));
        p.set(x + 1, y, mix(base, PAL.mossDark, 0.3));
      }
    }
    return p;
  }

  /**
   * 墙：画面"立起来"的关键。
   * capH 那段顶面 + 交界的一整条高光线 + 正面交错的石缝。
   * 再加底部压暗，墙和地板的落差就出来了。
   */
  function wallTile(exposedTop, exposedLeft, exposedRight, variant) {
    const p = new PX(TILE, TILE);
    const capH = exposedTop ? 12 : 0;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const n = hash2(x, y, variant * 31 + 7);
      if (y < capH) {
        let c = PAL.wallTop;
        if (n > 0.78) c = PAL.wallTopLit;
        else if (n < 0.22) c = shade(PAL.wallTop, -0.13);
        p.set(x, y, c);
      } else {
        let c = PAL.wallFace;
        if (n > 0.86) c = shade(PAL.wallFace, 0.13);
        else if (n < 0.14) c = PAL.wallFaceDark;
        p.set(x, y, c);
      }
    }
    if (capH) {
      for (let x = 0; x < TILE; x++) p.set(x, capH, PAL.wallEdge);          // 高光线
      for (let x = 0; x < TILE; x++) p.set(x, capH + 1, shade(PAL.wallFace, 0.20));
      for (let x = 0; x < TILE; x++) p.set(x, capH - 1, shade(PAL.wallTop, -0.16));
    }
    // 正面石缝：横向三道 + 竖向交错
    const rows = [capH + 7, capH + 14, capH + 21];
    for (const ry of rows) for (let x = 0; x < TILE; x++) p.set(x, ry, shade(PAL.wallFace, -0.24));
    for (let i = 0; i < rows.length; i++) {
      const ry = rows[i];
      const sx = ((variant * 7 + i * 11) % 20) + 4;
      for (let y = ry - 7; y < ry; y++) if (y > capH) p.set(sx, y, shade(PAL.wallFace, -0.20));
      const sx2 = (sx + 14) % TILE;
      for (let y = ry; y < ry + 7 && y < TILE; y++) p.set(sx2, y, shade(PAL.wallFace, -0.20));
    }
    if (exposedLeft) for (let y = capH; y < TILE; y++) p.set(0, y, PAL.wallEdge);
    if (exposedRight) for (let y = capH; y < TILE; y++) p.set(TILE - 1, y, shade(PAL.wallFace, -0.34));
    // 贴地处压暗：给地板一点接触阴影
    for (let x = 0; x < TILE; x++) p.set(x, TILE - 1, shade(PAL.wallFace, -0.4));
    return p;
  }

  function waterTile(frame, deep) {
    const p = new PX(TILE, TILE);
    const t = frame * (Math.PI * 2 / 3);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const w = Math.sin((x * 0.34) + t) * 0.5 + Math.sin((x * 0.17 + y * 0.4) + t * 1.4) * 0.5;
      let c = deep ? PAL.waterDeep : PAL.waterMid;
      if (w > 0.62) c = PAL.waterLight;
      else if (w > 0.34) c = mix(c, PAL.waterLight, 0.45);
      else if (w < -0.7) c = shade(c, -0.16);
      const s = hash2(x, y, 11 + frame);
      if (s > 0.972 && w > 0.2) c = PAL.foam;
      p.set(x, y, c);
    }
    return p;
  }

  function mossTile(variant) {
    const p = floorTile(variant, mix(PAL.floorA, PAL.mossDark, 0.34));
    for (let i = 0; i < 52; i++) {
      const x = Math.floor(hash2(i, variant, 17) * TILE);
      const y = Math.floor(hash2(i, variant, 29) * TILE);
      const h = 2 + Math.floor(hash2(i, variant, 41) * 3);
      const c = hash2(i, variant, 53) > 0.5 ? PAL.mossLit : PAL.moss;
      for (let k = 0; k < h; k++) p.set(x, y - k, k === h - 1 ? shade(c, 0.24) : c);
      p.set(x - 1, y, PAL.mossDark);
    }
    return p;
  }

  function lavaTile(frame) {
    const p = new PX(TILE, TILE);
    const t = frame * 0.7;
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const w = Math.sin(x * 0.22 + t) * Math.cos(y * 0.28 - t) +
        0.6 * Math.sin((x + y) * 0.13 + t * 2);
      let c = PAL.lava;
      if (w > 0.7) c = PAL.lavaHot;
      else if (w > 0.15) c = PAL.lavaLit;
      else if (w < -0.6) c = shade(PAL.lava, -0.3);
      p.set(x, y, c);
    }
    return p;
  }

  function stairsTile(frame) {
    const p = floorTile(2, PAL.floorA);
    const glow = ['#2f6f8f', '#3f8faf', '#57b4d4'][frame % 3];
    p.ell(16, 17, 12, 10, shade(PAL.waterDeep, -0.1));
    p.ell(16, 17, 9, 7, PAL.waterMid);
    p.ell(16, 17, 5.5, 4.5, glow);
    p.ell(16, 16, 2.5, 2, PAL.foam);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + frame * 0.4;
      p.set(16 + Math.cos(a) * 13, 17 + Math.sin(a) * 10, glow);
    }
    return p;
  }

  function chestTile(opened) {
    const p = floorTile(1, PAL.floorA);
    p.rect(6, 13, 20, 13, PAL.wood);
    p.rect(6, 13, 20, 4, PAL.woodLit);
    p.rect(6, 24, 20, 2, PAL.woodDark);
    p.rect(5, 9, 22, 6, opened ? shade(PAL.woodDark, -0.2) : PAL.woodLit);
    if (!opened) {
      p.rect(5, 9, 22, 2, shade(PAL.woodLit, 0.2));
      p.rect(15, 9, 2, 17, PAL.gold);
      p.rect(14, 17, 4, 3, '#f6e08a');
    } else {
      p.rect(7, 15, 18, 6, '#1a1f28');
      p.rect(9, 16, 6, 2, PAL.gold);
      p.rect(17, 17, 5, 2, PAL.foam);
    }
    p.outline('#151920');
    return p;
  }

  /** 潮汐商栈：带遮阳篷的木摊 + 钱袋，一眼能认出是"可以交易的地方" */
  function shopTile(frame) {
    const p = floorTile(3, PAL.floorA);
    p.rect(5, 26, 22, 4, PAL.stone);                 // 台基
    p.rect(5, 26, 22, 1, PAL.stoneLit);
    p.rect(6, 20, 20, 7, PAL.wood);                  // 柜台
    p.rect(6, 20, 20, 2, PAL.woodLit);
    p.rect(6, 26, 20, 1, PAL.woodDark);
    // 遮阳篷（交替竖条）
    for (let i = 0; i < 20; i++) {
      const c = (i % 4 < 2) ? PAL.clothRed : '#e8e0cc';
      for (let y = 8; y < 14; y++) p.set(6 + i, y - Math.round((i - 10) * 0.18), c);
    }
    p.rect(5, 13, 22, 2, shade(PAL.clothRed, -0.35));
    p.rect(8, 14, 2, 7, PAL.woodDark);               // 支杆
    p.rect(22, 14, 2, 7, PAL.woodDark);
    // 钱袋 + 货品
    p.ell(13, 24, 3.4, 3.4, PAL.gold);
    p.ell(13, 22, 2, 1.4, '#a8801a');
    p.rect(19, 22, 4, 4, '#4a8fd8');
    p.set(20, 22, '#9fd0ff');
    p.set(13, 18 + (frame % 2), '#fff6c0');          // 闪烁的招财光点
    p.outline('#151920');
    return p;
  }

  function fountainTile(frame) {
    const p = floorTile(0, PAL.floorA);
    p.ell(16, 19, 12, 10, PAL.stone);
    p.ell(16, 19, 9, 7, PAL.waterMid);
    p.ell(16, 19, 5.5, 4.5, PAL.waterLight);
    p.ell(16, 17, 2.6, 2.2, PAL.foam);
    p.rect(14, 5, 4, 10, PAL.stoneLit);
    p.ell(16, 4, 3, 2, PAL.foam);
    p.outline('#151920');
    return p;
  }

  function propTile(kind, frame) {
    const p = floorTile(0, PAL.floorA);
    if (kind === 'bones') {
      for (let i = 0; i < 6; i++) {
        const x = 5 + Math.floor(hash2(i, 3, 5) * 20);
        const y = 10 + Math.floor(hash2(i, 3, 9) * 14);
        p.rect(x, y, 5, 1, PAL.bone);
        p.set(x + 5, y, PAL.boneDark);
      }
      p.ell(19, 20, 4, 4, PAL.bone);
      p.rect(17, 21, 2, 2, '#2a2f3a'); p.rect(21, 21, 2, 2, '#2a2f3a');
      p.ell(19, 23, 2.2, 1.4, PAL.boneDark);
    } else if (kind === 'rubble') {
      for (let i = 0; i < 11; i++) {
        const x = 3 + Math.floor(hash2(i, 7, 11) * 26);
        const y = 4 + Math.floor(hash2(i, 7, 13) * 24);
        const s = 2 + Math.floor(hash2(i, 7, 17) * 3);
        p.rect(x, y, s, s, hash2(i, 7, 19) > 0.5 ? PAL.stone : PAL.stoneLit);
      }
    } else if (kind === 'barrel') {
      p.ell(16, 21, 9, 8, PAL.wood);
      p.rect(7, 13, 18, 10, PAL.wood);
      p.ell(16, 13, 9, 4, PAL.woodLit);
      p.rect(7, 16, 18, 2, '#4a3218');
      p.rect(7, 21, 18, 2, '#4a3218');
      p.outline('#151920');
    } else if (kind === 'crate') {
      p.rect(7, 12, 18, 16, PAL.wood);
      p.rect(7, 12, 18, 2, PAL.woodLit);
      p.rect(7, 26, 18, 2, PAL.woodDark);
      p.line(7, 12, 25, 28, shade(PAL.wood, -0.22));
      p.line(25, 12, 7, 28, shade(PAL.wood, -0.22));
      p.outline('#151920');
    } else if (kind === 'brazier') {
      p.ell(16, 24, 7, 5, PAL.stone);
      p.rect(9, 19, 14, 6, PAL.stone);
      p.rect(9, 19, 14, 2, PAL.stoneLit);
      const f = ['#e04a1e', '#f09a2c', '#f0d060'][frame % 3];
      p.ell(16, 15, 6, 7, f);
      p.ell(16, 13, 3.6, 4.6, '#ffe08a');
      p.set(16, 5 + (frame % 2), '#ffd060');
      p.outline('#151920');
    }
    return p;
  }

  /* ============================================================
     角色：参数化纸娃娃
     身体按职业配色，武器按 cls.weapon 分支绘制 ——
     两者在数据结构上就绑定了，所以不可能出现"法师举着木桶"。

     dir : 'down' | 'up' | 'side'
     frame: 0 / 1 = 行走的两帧，2 = 攻击前倾
     ============================================================ */
  function paintHero(cls, dir, frame) {
    dir = dir || 'down';
    frame = frame || 0;
    const s = cls.style;
    const p = new PX(SPR, SPR);
    const dark = '#12151d';
    const skinD = shade(s.skin, -0.24);
    const step = frame === 1 ? 1 : 0;           // 行走相位
    const atk = frame === 2;
    const lean = atk ? 1 : 0;                   // 攻击时整体前倾

    if (dir === 'side') {
      /* ---------- 侧面（默认朝右，朝左由渲染层镜像） ---------- */
      const bx = 9 + lean;
      // 腿：一前一后，靠 step 交替
      p.rect(bx + 1 + step, 20, 3, 7, shade(s.cloth, -0.12));
      p.rect(bx + 4 - step, 20, 3, 7, s.cloth);
      p.rect(bx + step, 26, 4, 2, '#2a2f3a');
      p.rect(bx + 4 - step, 26, 4, 2, '#222732');
      // 躯干
      p.rect(bx, 11, 8, 10, s.body);
      p.rect(bx, 11, 8, 3, shade(s.body, 0.18));
      p.rect(bx + 1, 14, 6, 2, shade(s.body, -0.14));
      p.rect(bx, 18, 8, 2, s.trim);
      p.rect(bx, 11, 1, 9, shade(s.body, -0.3));
      // 肩甲
      p.rect(bx + 5, 10, 4, 3, s.metal);
      p.rect(bx + 5, 10, 4, 1, shade(s.metal, 0.3));
      // 手臂：攻击时前伸
      if (atk) p.rect(bx + 8, 13, 5, 2, s.body);
      else p.rect(bx + 6, 14, 2, 6, shade(s.body, -0.1));
      // 头
      p.ell(bx + 5.5, 7.5, 3.8, 4.2, s.skin);
      p.ell(bx + 4.5, 4.6, 4.2, 2.6, s.hair);
      p.rect(bx + 2, 3, 8, 2, s.hair);
      p.rect(bx + 8, 8, 1, 1, dark);            // 一只眼
      p.set(bx + 9, 10, skinD);
      // 披风在后
      p.rect(bx - 2, 12, 2, 9, shade(s.cloth, -0.38));
    } else {
      /* ---------- 正面 / 背面 ---------- */
      const cx = 12 + lean;
      const back = (dir === 'up');
      p.rect(cx - 4 + step, 20, 3, 7, s.cloth);
      p.rect(cx + 2 - step, 20, 3, 7, shade(s.cloth, -0.12));
      p.rect(cx - 5 + step, 26, 4, 2, '#2a2f3a');
      p.rect(cx + 2 - step, 26, 4, 2, '#222732');
      // 躯干
      p.rect(cx - 5, 11, 10, 10, s.body);
      p.rect(cx - 5, 11, 10, 3, shade(s.body, back ? 0.10 : 0.18));
      p.rect(cx - 4, 14, 8, 2, shade(s.body, -0.13));
      p.rect(cx - 5, 18, 10, 2, s.trim);
      p.rect(cx - 5, 11, 1, 9, shade(s.body, -0.3));
      p.rect(cx + 4, 11, 1, 9, shade(s.body, -0.36));
      if (back) p.rect(cx - 3, 12, 6, 7, shade(s.cloth, -0.22));   // 背面看到披风
      // 肩甲
      p.rect(cx - 8, 10, 4, 3, back ? shade(s.metal, -0.2) : s.metal);
      p.rect(cx + 4, 10, 4, 3, shade(s.metal, -0.2));
      if (!back) p.rect(cx - 8, 10, 4, 1, shade(s.metal, 0.3));
      // 手臂
      if (atk) { p.rect(cx + 7, 13, 3, 3, s.body); p.rect(cx - 10, 13, 3, 3, s.body); }
      else { p.rect(cx - 7, 13, 2, 6, s.body); p.rect(cx + 5, 13, 2, 6, shade(s.body, -0.2)); }
      // 头
      p.ell(cx, 7.5, 4, 4.2, s.skin);
      p.ell(cx, 4.4, 4.4, 2.6, s.hair);
      p.rect(cx - 5, 3, 10, 2, s.hair);
      if (!back) {
        p.rect(cx - 3, 8, 2, 1, dark);
        p.rect(cx + 1, 8, 2, 1, dark);
        p.set(cx - 3, 7, '#ffffff'); p.set(cx + 1, 7, '#ffffff');
        p.set(cx, 10, skinD);
        p.rect(cx - 2, 11, 4, 1, shade(s.skin, -0.35));
      } else {
        p.ell(cx, 8, 4.2, 3.6, s.hair);     // 背面只有头发
        p.rect(cx - 2, 12, 4, 1, shade(s.hair, -0.2));
      }
      // 披风轮廓
      p.rect(cx - 6, 12, 1, 9, shade(s.cloth, -0.34));
      p.rect(cx + 5, 12, 1, 9, shade(s.cloth, -0.46));
    }

    /* ---------- 武器：按职业类型画，武器与职业在数据上就绑定了 ---------- */
    const W = cls.weapon;
    const wx = (dir === 'side') ? 16 + lean : 18 + lean;
    if (W === 'greatsword') {
      if (atk) {
        p.rect(wx, 8, 3, 12, s.metal);
        p.rect(wx, 8, 1, 12, shade(s.metal, 0.34));
        p.rect(wx + 3, 9, 1, 11, shade(s.metal, -0.32));
        p.rect(wx - 2, 19, 8, 2, s.trim);
      } else {
        p.rect(wx, 3, 3, 15, s.metal);
        p.rect(wx, 3, 1, 15, shade(s.metal, 0.34));
        p.rect(wx + 3, 4, 1, 14, shade(s.metal, -0.32));
        p.rect(wx - 2, 17, 8, 2, s.trim);
        p.rect(wx + 1, 19, 1, 4, '#5b3a1e');
        p.set(wx + 1, 3, '#ffffff');
      }
    } else if (W === 'staff') {
      p.rect(wx, 5, 2, 19, '#6b4a2a');
      p.rect(wx, 5, 1, 19, '#8a5f36');
      const oy = atk ? 7 : 3;
      p.ell(wx + 1, oy, 3.4, 3.4, '#3a7fa8');
      p.ell(wx + 1, oy, 2, 2, '#9fe8f0');
      p.set(wx + 1, oy - 1, '#ffffff');
      if (atk) p.ell(wx + 1, 12, 4, 4, 'rgba(255,255,255,0.16)');
    } else if (W === 'bow') {
      p.rect(wx, 6, 2, 15, '#6b4a2a');
      p.rect(wx - 1, 5, 1, 2, '#8a5f36'); p.rect(wx - 1, 20, 1, 2, '#8a5f36');
      p.rect(wx + 2, 5, 1, 17, '#cfd8e0');
      p.rect(wx + 1, 13, atk ? 5 : 3, 1, '#cfd8e0');
      p.rect(2, 5, 2, 17, '#6b4a2a');                 // 背上的箭袋
      p.rect(2, 3, 1, 4, '#d8d2bd'); p.rect(4, 4, 1, 3, '#d8d2bd');
    } else if (W === 'hammer') {
      p.rect(wx, 7, 2, 16, '#5b3a1e');
      const hy = atk ? 8 : 3;
      p.rect(wx - 3, hy, 9, 6, s.metal);
      p.rect(wx - 3, hy, 9, 2, shade(s.metal, 0.3));
      p.rect(wx - 3, hy + 4, 9, 2, shade(s.metal, -0.3));
      p.rect(wx - 4, hy - 1, 11, 2, shade(s.trim, -0.1));
    }

    p.outline('#0b0e14', true);
    p.topLight(0.14);
    p.grain(20, cls.key.length + dir.length + frame, 0.06);
    return p;
  }

  /* ============================================================
     怪物：按 shape 参数生成，统一塞进 32×32
     6 种体型模板 + 参数（眼数/尖刺/手臂/颜色），
     所以加一种新怪只要加一条数据，不用画图。
     ============================================================ */
  function paintMonster(shape) {
    const p = new PX(SPR, SPR);
    const cx = 16 - 1;
    const base = shape.color, acc = shape.accent;
    const bw = Math.min(26, shape.w), bh = Math.min(24, shape.h);
    const groundY = 28;

    if (shape.body === 'blob') {
      p.ell(cx, groundY - bh / 2, bw / 2, bh / 2, base);
      p.ell(cx, groundY - bh / 2 + 1, bw / 2 - 1.5, bh / 2 - 2, shade(base, 0.13));
    } else if (shape.body === 'brute') {
      p.rect(cx - bw / 2 + 2, groundY - bh, bw - 4, bh - 3, base);
      p.rect(cx - bw / 2, groundY - bh + 4, bw, bh - 7, base);
      p.rect(cx - bw / 2 + 2, groundY - bh, bw - 4, 3, shade(base, 0.2));
      p.ell(cx, groundY - bh + 2, bw / 2 - 1.5, bh / 3.2, shade(base, 0.1));
      p.rect(cx - bw / 2 + 3, groundY - 4, 5, 4, shade(acc, -0.1));
      p.rect(cx + bw / 2 - 8, groundY - 4, 5, 4, shade(acc, -0.1));
    } else if (shape.body === 'beast') {
      p.ell(cx - 2, groundY - bh / 2, bw / 2, bh / 2.6, base);
      p.ell(cx + bw / 2 - 5, groundY - bh / 2 - 3, bw / 4.4, bh / 3.4, base);
      p.ell(cx + bw / 2 - 5, groundY - bh / 2 - 3, bw / 6, bh / 5, shade(base, 0.18));
      for (let i = 0; i < 4; i++) {
        const lx = cx - bw / 2 + 3 + i * (bw / 4.6);
        p.rect(lx, groundY - 5, 2, 5, shade(acc, -0.15));
      }
      p.rect(cx - bw / 2 - 3, groundY - bh / 2 - 2, 5, 2, acc);
    } else if (shape.body === 'ghost') {
      p.ell(cx, groundY - bh / 2 - 2, bw / 2, bh / 2.2, base);
      p.rect(cx - bw / 2, groundY - bh / 2, bw, bh / 2 - 1, base);
      for (let x = cx - bw / 2; x < cx + bw / 2; x++) {
        const wave = Math.sin((x - cx) * 0.7) * 2.5;
        for (let y = groundY - 4 + wave; y < groundY; y++) p.set(x, y, null);
        for (let y = groundY - 6 + wave; y < groundY - 2 + wave; y++) p.set(x, y, shade(base, -0.18));
      }
      p.ell(cx, groundY - bh / 2 - 6, bw / 3, bh / 4, shade(base, 0.16));
    } else if (shape.body === 'robed') {
      for (let y = 0; y < bh; y++) {
        const halfW = (bw / 2) * (0.42 + 0.58 * (y / bh));
        for (let x = cx - halfW; x <= cx + halfW; x++) p.set(x, groundY - bh + y, base);
      }
      p.ell(cx, groundY - bh + 3, bw / 3.4, bh / 4.4, shade(base, 0.18));
      p.rect(cx - bw / 4, groundY - bh + 8, bw / 2, 2, acc);
      p.ell(cx, groundY - bh + 4, bw / 5, bh / 6, shade(base, -0.4));
      for (let y = groundY - 4; y < groundY; y++) for (let x = 0; x < SPR; x++)
        if (p.get(x, y)) p.set(x, y, shade(base, -0.26));
    } else if (shape.body === 'mimic') {
      p.rect(cx - bw / 2, groundY - bh / 2, bw, bh / 2 + 1, PAL.wood);
      p.rect(cx - bw / 2 + 1, groundY - bh / 2 + 1, bw - 2, 3, PAL.gold);
      p.rect(cx - bw / 2 - 1, groundY - bh, bw + 2, bh / 2, shade(PAL.wood, 0.1));
      p.rect(cx - bw / 2 - 1, groundY - bh, bw + 2, 3, PAL.woodLit);
      for (let i = 0; i < 7; i++) {
        p.rect(cx - bw / 2 + 1 + i * (bw / 7), groundY - bh + 4, 2, 4, '#f4f8fc');
      }
      p.rect(cx - bw / 2 + 1, groundY - bh / 2 - 1, bw - 2, 2, '#241a10');
    }

    if (shape.arms > 0) {
      p.ell(cx - bw / 2 - 1, groundY - bh / 2, 3, 2.6, shade(base, -0.14));
      p.ell(cx + bw / 2 + 1, groundY - bh / 2, 3, 2.6, shade(base, -0.22));
    }
    for (let i = 0; i < (shape.spikes || 0); i++) {
      const t = (i + 0.5) / shape.spikes;
      const sx = Math.round(cx - bw / 2 + t * bw);
      const sh = 3 + Math.round(hash2(i, shape.spikes, 91) * 4);
      for (let k = 0; k < sh; k++) p.set(sx, groundY - bh - k + 3, shade(acc, k === sh - 1 ? 0.28 : 0));
    }
    const eyes = shape.eye || 2;
    for (let i = 0; i < eyes; i++) {
      const ex = cx - (eyes - 1) * 3 + i * 6;
      const ey = groundY - bh / 2 - (shape.body === 'robed' ? 12 : 5);
      p.rect(ex - 1, ey - 1, 3, 3, '#f8f8f8');
      p.rect(ex, ey, 1, 1, i % 2 ? '#e04040' : '#1a1d26');
    }
    if (shape.crown) {
      const cy = groundY - bh - 3;
      for (let i = 0; i < 5; i++) p.rect(cx - 8 + i * 4, cy, 2, 4, PAL.gold);
      p.rect(cx - 9, cy + 3, 19, 2, '#a8801a');
    }

    p.outline('#0b0e14', true);
    p.topLight(0.20);
    p.bottomDark(0.24);
    return p;
  }

  /* ============================================================
     预烤缓存
     一切都烤成 canvas，渲染时只 drawImage。
     按 dpr 缓存：HiDPI 屏上精灵是整数倍放大，不会出现脏边。
     ============================================================ */
  let dpr = 1;
  const tileCache = {};
  const spriteCache = {};

  function setDpr(d) {
    const v = Math.max(1, Math.min(3, Math.round((d || 1) * 100) / 100));
    if (v !== dpr) { dpr = v; buildTiles(); spriteCacheClear(); }
    return dpr;
  }
  function spriteCacheClear() {
    for (const k in spriteCache) delete spriteCache[k];
  }

  function buildTiles() {
    for (const k in tileCache) delete tileCache[k];
    tileCache['floor0'] = floorTile(0).toCanvas(dpr);
    tileCache['floor1'] = floorTile(1).toCanvas(dpr);
    tileCache['floor2'] = floorTile(2).toCanvas(dpr);
    tileCache['floor3'] = floorTile(3).toCanvas(dpr);
    for (let i = 0; i < 3; i++) {
      tileCache['water' + i] = waterTile(i).toCanvas(dpr);
      tileCache['waterD' + i] = waterTile(i, true).toCanvas(dpr);
      tileCache['lava' + i] = lavaTile(i).toCanvas(dpr);
      tileCache['stairs' + i] = stairsTile(i).toCanvas(dpr);
      tileCache['moss' + i] = mossTile(i).toCanvas(dpr);
      tileCache['prop_brazier' + i] = propTile('brazier', i).toCanvas(dpr);
      tileCache['shop' + i] = shopTile(i).toCanvas(dpr);
    }
    tileCache['chest'] = chestTile(false).toCanvas(dpr);
    tileCache['chestOpen'] = chestTile(true).toCanvas(dpr);
    tileCache['fountain'] = fountainTile(0).toCanvas(dpr);
    for (const k of ['bones', 'rubble', 'barrel', 'crate']) {
      tileCache['prop_' + k] = propTile(k, 0).toCanvas(dpr);
    }
    for (let m = 0; m < 8; m++) {
      tileCache['wall' + m] = wallTile(!!(m & 1), !!(m & 2), !!(m & 4), m).toCanvas(dpr);
    }
  }

  /** 英雄：3 朝向 × 3 帧（走 2 帧 + 攻击 1 帧），共 9 张 */
  function heroSprite(cls, dir, frame) {
    const k = 'h|' + cls.key + '|' + (dir || 'down') + '|' + (frame || 0);
    if (!spriteCache[k]) spriteCache[k] = paintHero(cls, dir, frame).toCanvas(dpr);
    return spriteCache[k];
  }
  /** 怪物：3 帧（呼吸相位），用于挤压拉伸以外的形变 */
  function monsterSprite(shape, id, frame) {
    const k = 'm|' + id + '|' + (frame || 0);
    if (!spriteCache[k]) spriteCache[k] = paintMonster(shape).toCanvas(dpr);
    return spriteCache[k];
  }

  /** 生成小尺寸立绘（开始界面的职业卡） */
  function heroDataURL(cls, size, dir) {
    const px = paintHero(cls, dir || 'down', 0);
    const cv = px.toCanvas(2);
    const out = global.document.createElement('canvas');
    out.width = size; out.height = size;
    const c = out.getContext('2d');
    c.imageSmoothingEnabled = false;
    const s = Math.min(size / cv.width, size / cv.height);
    c.drawImage(cv, (size - cv.width * s) / 2, (size - cv.height * s) / 2, cv.width * s, cv.height * s);
    return out.toDataURL();
  }

  global.TideArt = {
    TILE: TILE, SPR: SPR, PAL: PAL, PX: PX,
    shade: shade, mix: mix, hash2: hash2,
    setDpr: setDpr, buildTiles: buildTiles,
    get tiles() { return tileCache; },
    get dpr() { return dpr; },
    heroSprite: heroSprite,
    monsterSprite: monsterSprite,
    heroDataURL: heroDataURL,
    paintHero: paintHero,
    paintMonster: paintMonster
  };
})(window);
