/* ============================================================
   数值潮汐 · 核心逻辑 v4
   纯状态推演，不碰 DOM、不碰 canvas。同一份代码既跑游戏也跑平衡模拟。

   核心循环：
     在洞窟里移动 → 撞上敌人触发「属性对决」→ 掉血 / 击杀 / 掉落装备
     → 潮水每 N 回合上涨，把地图淹掉，逼你往前走
     → 抵达潮汐之门下一层，打穿 N 层通关

   为什么战斗要一次算完一整场（而不是你一刀我一刀）：
     这样「速度」才有意义 —— 速度领先 18 点可以在这场对决里多打一次。
     也正因为整场一起结算，玩家真正的决策才落在
     「先打谁、绕开谁、把属性堆到哪条线上」，而不是点鼠标的手速。
   ============================================================ */
(function (global) {
  'use strict';

  const D = global.TideData;

  /* ============================================================
     地形编码。用数字而不是字符串：45×35 的地图每帧都要遍历，
     字符串比较会明显拖慢渲染。
     ============================================================ */
  const T = {
    VOID: 0, FLOOR: 1, WALL: 2, WATER: 3, MOSS: 4, LAVA: 5,
    CHEST: 6, STAIRS: 7, FOUNTAIN: 8, SHOP: 9
  };
  // 可站立的地形
  const WALKABLE = { 1: 1, 3: 1, 4: 1, 6: 1, 7: 1, 8: 1, 9: 1 };
  // 阻挡视线的地形
  const OPAQUE = { 0: 1, 2: 1, 5: 1 };
  // 装饰层
  const DECO = { NONE: 0, RUBBLE: 1, BONES: 2, BARREL: 3, CRATE: 4, BRAZIER: 5 };
  const DECO_NAMES = ['', '碎石', '骸骨', '木桶', '木箱', '火盆'];

  /* ============================================================
     随机数：mulberry32。
     必须和 Python / 浏览器两侧逐位一致，所以不能用 Math.random，
     也不要把 |0 换成 Math.floor —— 负数取整方向不同会分叉。
     ============================================================ */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  class RNG {
    constructor(seed) { this.seed = seed >>> 0; this._n = mulberry32(this.seed); }
    float() { return this._n(); }
    int(lo, hi) { return lo + Math.floor(this._n() * (hi - lo + 1)); }
    pick(a) { return a[Math.floor(this._n() * a.length)]; }
    chance(p) { return this._n() < p; }
    /** 从 [{weight}] 里加权抽一个 */
    weighted(list, wf) {
      let total = 0;
      for (const it of list) total += (wf ? wf(it) : it.weight) || 0;
      if (total <= 0) return list[0];
      let r = this._n() * total;
      for (const it of list) {
        r -= (wf ? wf(it) : it.weight) || 0;
        if (r <= 0) return it;
      }
      return list[list.length - 1];
    }
  }

  /* ============================================================
     战斗数学
     伤害 = 攻击 × K / (有效防御 + K)
     有效防御 = max(0, 防御 − 对方穿透)
     缺字段一律按 0 —— v3 在这里吃过亏：模板漏写 penP 导致
     def - undefined = NaN，AI 判定「所有敌人都打不赢」，全场绕圈不出手。
     ============================================================ */
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  function rawDamage(atk, pen, def, K) {
    const a = num(atk);
    if (a <= 0) return 0;
    const eff = Math.max(0, num(def) - num(pen));
    return a * K / (eff + K);
  }
  /** 物理和法术各算一遍，取更高的那一路 */
  function bestAttack(a, d, K) {
    const p = rawDamage(a.atkP, a.penP, d.defP, K);
    const m = rawDamage(a.atkM, a.penM, d.defM, K);
    return (p >= m) ? { base: p, type: 'p' } : { base: m, type: 'm' };
  }

  /* ============================================================
     Game
     ============================================================ */
  let SEQ = 0;

  class Game {
    /**
     * @param {object} opts { classKey, difficulty, seed, depth（覆盖层数）, relicPoolSkip,
     *                        meta（局外已购集合，**不传就没有局外加成**） }
     */
    constructor(opts) {
      opts = opts || {};
      const dk = (opts.difficulty && D.DIFFICULTIES[opts.difficulty]) ? opts.difficulty : 'standard';
      this.difficultyId = dk;
      this.diff = D.DIFFICULTIES[dk];
      this.cls = D.classByKey(opts.classKey);
      this.K = D.COMBAT.K;

      this.seed = (opts.seed === undefined || opts.seed === null)
        ? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0)
        : (opts.seed >>> 0);
      this.rng = new RNG(this.seed);
      // 元进度**只在显式传入时才存在**。模拟器从来不传，于是它跑出来的
      // 通关率永远是"这个版本的难度"，而不是"我解锁了多少"。
      // 不写成"默认读存档"是刻意的：那种写法会让平衡基准在不知不觉中失真。
      this.meta = opts.meta || null;
      // 无尽模式（v11-6）：没有"走出潮汐"这一步，只有"还能撑几层"。
      // 它**不新增任何难度旋钮** —— 用的还是这一局本来就选的 difficulty，
      // 只是把层数上限拿掉，再给越出正篇之后的每一层加一档强度（endlessBoost）。
      this.endless = !!opts.endless;
      this.reset();
    }

    /* ---------------- 初始化 ---------------- */
    reset() {
      this.turn = 0;
      this.status = 'playing';          // playing | dead | win
      this.reason = '';
      this.kills = 0;
      // 分数要按"杀掉的是什么"分别计价，所以不能只有一个总数
      this.eliteKills = 0;
      this.bossKills = 0;
      this.deaths = 0;
      this.lives = 1 + (this.diff.extraLife || 0);
      this.depth = 1;
      this.relics = [];
      this.pendingRelic = null;
      this.nextRelicAt = D.PROGRESSION.relicEvery;
      this.logs = [];
      this.events = [];
      this.devourStacks = 0;
      this.skillCd = 0;          // 魂技冷却剩余回合
      this.skillUses = 0;        // 一局里放过几次魂技（平衡分析用）
      this.freeMoves = 0;        // 免费行动次数（疾影）—— 不推进潮汐，敌人也不动
      this.buffs = [];           // 临时增益（魂技），随回合递减

      this.equip = { weapon: null, helm: null, chest: null, boots: null, trinket: null };
      this.bag = [];
      this.gold = 0;
      this.shopStock = [];

      /* ---- 元进度（局外）----
         先折算成一份**平铺的加成**再应用：模型层不需要认识任何解锁 id。
         位置很讲究，必须放在 this.hp = this.stats().hp 之前 ——
         生命上限的百分比加成得在第一次取面板时就生效，
         否则开局那条血是按旧上限算的，而且第一场战斗后才会"补"回来。 */
      this.metaBonus = D.META.effects(this.meta);
      this.gold += this.metaBonus.gold;
      this.lives += this.metaBonus.lives;
      if (this.metaBonus.startRarity) {
        const it = this.makeItem({ depth: 1, rarity: this.metaBonus.startRarity });
        if (it) this.bag.push(it);
      }

      this.hp = this.stats().hp;
      this._buildLevel(1);
      this._log('潮水正在上涨。往下走，或者被淹死。', 'info');
    }

    /* ============================================================
       面板
       ============================================================ */
    /** 无装备的基础面板（职业 + 等级） */
    basePanel() {
      const c = this.cls.stats, g = D.PROGRESSION.levelGain;
      const lv = this.level() - 1;
      const s = {};
      for (const k in c) s[k] = c[k];
      for (const k in g) s[k] = num(s[k]) + g[k] * lv;
      return s;
    }
    level() { return 1 + Math.floor(this.kills / D.PROGRESSION.levelEvery); }

    /**
     * 背包容量。**只有这一处能回答"能装几件"。**
     * 原先六处各自去读 D.LOOT.backpackSize；加了"补给袋"这类局外加成之后，
     * 那种写法必然漏改一处，而漏改的症状是"我买了补给袋，背包却还是满的"，
     * 从表面完全看不出是配置没读到。所以收敛成一个访问器。
     */
    bagCap() {
      const bonus = this.metaBonus ? num(this.metaBonus.bagCap) : 0;
      return D.LOOT.backpackSize + bonus;
    }

    /**
     * 完整面板 = 职业基础 + 等级成长 + 装备（固有 + 词条） + 遗物 + 吞噬层数。
     * 条件性加成（残血加防之类）不在这里算 —— 它们放 combatMods()，
     * 因为那些依赖当前生命值，塞进面板会导致面板随血量跳数字。
     */
    stats() {
      const s = this.basePanel();
      const add = function (o) {
        if (!o) return;
        for (const k in o) s[k] = num(s[k]) + num(o[k]);
      };
      for (const slot in this.equip) add(this.equip[slot] && this.equip[slot].total);
      for (const id of this.relics) {
        const r = this._relicById(id);
        if (r) add(r.mods);
      }
      if (this.devourStacks) s.atkP = num(s.atkP) + this.devourStacks * 2;
      // 临时增益（魂技的不退之壁）：用**乘法**乘在最后。
      // 写成加法会和装备/遗物的加防叠在一起，越到后期越接近无敌 ——
      // 而乘法让它在任何装备水平下的相对收益都是恒定的。
      for (let bi = 0; bi < this.buffs.length; bi++) {
        const b = this.buffs[bi];
        if (!b.mul) continue;
        for (const k in b.mul) s[k] = num(s[k]) * b.mul[k];
      }
      // 元进度：生命上限的百分比加成。用**乘法**乘在最后，和「不退之壁」同一套语义 ——
      // 写成加法会和装备/遗物叠在一起，越到后期越接近无敌。
      if (this.metaBonus && this.metaBonus.hpMul && this.metaBonus.hpMul !== 1) {
        s.hp = num(s.hp) * this.metaBonus.hpMul;
      }
      // 生命上限至少为 1，否则负值装备会把玩家直接判死
      s.hp = Math.max(1, Math.round(num(s.hp)));
      for (const k of D.CORE_STATS) if (k !== 'hp') s[k] = Math.round(num(s[k]));
      return s;
    }

    /** 汇总所有 flags（机制型效果） */
    flags() {
      const f = {
        doubleAtSpd: 0, echo: 0, thorns: 0, lastStand: 0, firstStrike: 0,
        dodge: 0, regenAfterWin: 0, devour: 0, dropBonus: 0, execute: 0,
        leechBonusIfBleed: 0, goldBonus: 0,
        dmgOut: 0        // 输出增伤（疾影的爆发窗口走这里）
      };
      const take = function (fl) {
        if (!fl) return;
        for (const k in fl) {
          if (!(k in f)) continue;
          if (k === 'doubleAtSpd') f[k] = (f[k] && f[k] < fl[k]) ? f[k] : fl[k];
          else f[k] = num(f[k]) + num(fl[k]);
        }
      };
      for (const id of this.relics) {
        const r = this._relicById(id);
        if (r) take(r.flags);
      }
      for (const slot in this.equip) {
        const it = this.equip[slot];
        if (it) take(it.flags);
      }
      const s = this.stats();
      f.dodge = Math.min(0.65, num(f.dodge) + num(s.dodge));   // 闪避封顶，否则会无敌
      // 临时增益（魂技）也能带 flags —— 比如不退之壁的反伤。
      // 走同一个汇总口，战斗结算就完全不用知道"这反伤是遗物给的还是技能给的"。
      for (const b of (this.buffs || [])) take(b.flags);
      return f;
    }

    _relicById(id) {
      for (const r of D.RELICS) if (r.id === id) return r;
      return null;
    }
    hasRelic(id) { return this.relics.indexOf(id) >= 0; }

    /* ============================================================
       地图生成
       房间 + 走廊是最经得起看的形状：有大小对比、有拐角、
       不会像纯细胞自动机那样到处都是看不出边界的糊状洞。
       ============================================================ */
    _buildLevel(depth) {
      const M = D.MAP, rng = this.rng;
      this.W = M.W; this.H = M.H;
      this.tiles = new Uint8Array(this.W * this.H).fill(T.WALL);
      this.deco = new Uint8Array(this.W * this.H).fill(0);
      this.explored = new Uint8Array(this.W * this.H);
      this.visible = new Uint8Array(this.W * this.H);
      this.enemies = [];
      this.items = [];
      this.tideLevel = 0;
      this.tideSeeds = [];
      this.tideTurn = 0;
      this.aiGoal = null;          // 换层必须清空目标，否则会朝上一层的坐标走
      this.aiBad = {};             // 本层的"走不到"黑名单

      const idx = (x, y) => y * this.W + x;
      const setT = (x, y, v) => { if (x > 0 && y > 0 && x < this.W - 1 && y < this.H - 1) this.tiles[idx(x, y)] = v; };
      const getT = (x, y) => (x < 0 || y < 0 || x >= this.W || y >= this.H) ? T.WALL : this.tiles[idx(x, y)];

      /* —— 1. 撒房间 —— */
      const rooms = [];
      const tries = M.rooms * 12;
      for (let t = 0; t < tries && rooms.length < M.rooms; t++) {
        const w = rng.int(M.roomMin, M.roomMax);
        const h = rng.int(M.roomMin, M.roomMax);
        const x = rng.int(1, this.W - w - 2);
        const y = rng.int(1, this.H - h - 2);
        const r = { x: x, y: y, w: w, h: h };
        let ok = true;
        for (const o of rooms) {
          if (x <= o.x + o.w + 1 && x + w + 1 >= o.x && y <= o.y + o.h + 1 && y + h + 1 >= o.y) { ok = false; break; }
        }
        if (ok) rooms.push(r);
      }
      for (const r of rooms) {
        for (let y = r.y; y < r.y + r.h; y++)
          for (let x = r.x; x < r.x + r.w; x++) setT(x, y, T.FLOOR);
      }
      /* —— 2. 连走廊（按房间顺序串起来，再补几条捷径形成环路）—— */
      const cen = (r) => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) });
      const carveH = (x0, x1, y) => { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) if (getT(x, y) === T.WALL) setT(x, y, T.FLOOR); };
      const carveV = (y0, y1, x) => { for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) if (getT(x, y) === T.WALL) setT(x, y, T.FLOOR); };
      for (let i = 1; i < rooms.length; i++) {
        const a = cen(rooms[i - 1]), b = cen(rooms[i]);
        if (rng.chance(0.5)) { carveH(a.x, b.x, a.y); carveV(a.y, b.y, b.x); }
        else { carveV(a.y, b.y, a.x); carveH(a.x, b.x, b.y); }
      }
      for (let i = 0; i < 4 && rooms.length > 3; i++) {
        const a = cen(rng.pick(rooms)), b = cen(rng.pick(rooms));
        carveH(a.x, b.x, a.y); carveV(a.y, b.y, b.x);
      }
      this.rooms = rooms;

      /* —— 3. 水洼：潮汐的源头。所有水位都从这里按步数扩散 —— */
      const waterCells = [];
      for (let i = 0; i < M.waterPatches; i++) {
        const r = rng.pick(rooms);
        const cx = rng.int(r.x + 1, r.x + r.w - 2);
        const cy = rng.int(r.y + 1, r.y + r.h - 2);
        const rad = rng.int(1, 3);
        for (let y = cy - rad; y <= cy + rad; y++) {
          for (let x = cx - rad; x <= cx + rad; x++) {
            if (getT(x, y) !== T.FLOOR) continue;
            if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rad * rad) continue;
            setT(x, y, T.WATER);
            waterCells.push({ x: x, y: y });
          }
        }
      }
      this.tideSeeds = waterCells.slice();

      /* —— 4. 苔草 / 岩浆 —— */
      for (let i = 0; i < M.grassPatches; i++) {
        const r = rng.pick(rooms);
        const cx = rng.int(r.x, r.x + r.w - 1), cy = rng.int(r.y, r.y + r.h - 1);
        const rad = rng.int(1, 3);
        for (let y = cy - rad; y <= cy + rad; y++)
          for (let x = cx - rad; x <= cx + rad; x++)
            if (getT(x, y) === T.FLOOR && rng.chance(0.62)) setT(x, y, T.MOSS);
      }
      if (depth >= 2) {
        const n = 1 + depth;
        for (let i = 0; i < n; i++) {
          const r = rng.pick(rooms);
          const cx = rng.int(r.x + 1, r.x + r.w - 2), cy = rng.int(r.y + 1, r.y + r.h - 2);
          const rad = rng.int(1, 2);
          for (let y = cy - rad; y <= cy + rad; y++)
            for (let x = cx - rad; x <= cx + rad; x++) {
              if (getT(x, y) !== T.FLOOR) continue;
              // 房间中心是走廊的接口，岩浆糊在那里会把整条路掐断
              let nearCenter = false;
              for (const rr of rooms) {
                const c2 = { x: Math.floor(rr.x + rr.w / 2), y: Math.floor(rr.y + rr.h / 2) };
                if (Math.abs(x - c2.x) + Math.abs(y - c2.y) <= 2) { nearCenter = true; break; }
              }
              if (nearCenter) continue;
              setT(x, y, T.LAVA);
            }
        }
      }

      /* —— 5. 装饰：贴着房间边缘放，中间留空，不然走位会被视觉噪音淹没 —— */
      const decoKinds = [DECO.RUBBLE, DECO.BONES, DECO.BARREL, DECO.CRATE];
      for (const r of rooms) {
        const n = rng.int(0, 4);
        for (let i = 0; i < n; i++) {
          const edge = rng.chance(0.7);
          const x = edge ? (rng.chance(0.5) ? r.x : r.x + r.w - 1) : rng.int(r.x, r.x + r.w - 1);
          const y = edge ? (rng.chance(0.5) ? r.y : r.y + r.h - 1) : rng.int(r.y, r.y + r.h - 1);
          if (getT(x, y) === T.FLOOR) this.deco[idx(x, y)] = rng.pick(decoKinds);
        }
        if (rng.chance(0.55)) {
          const bx = rng.int(r.x, r.x + r.w - 1), by = rng.int(r.y, r.y + r.h - 1);
          if (getT(bx, by) === T.FLOOR && getT(bx, by - 1) === T.WALL) this.deco[idx(bx, by)] = DECO.BRAZIER;
        }
      }

      /* —— 6. 潮汐之门（下一层入口）放在离起点最远的房间 —— */
      const start = cen(rooms[0]);
      let far = rooms[rooms.length - 1], farD = -1;
      for (const r of rooms) {
        const c = cen(r);
        const d = Math.abs(c.x - start.x) + Math.abs(c.y - start.y);
        if (d > farD) { farD = d; far = r; }
      }
      const exit = cen(far);
      // 门口清场，避免"楼梯被怪堵住"的死局
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = exit.x + dx, y = exit.y + dy;
        if (getT(x, y) === T.WATER || getT(x, y) === T.LAVA) setT(x, y, T.FLOOR);
        this.deco[idx(x, y)] = 0;
      }
      setT(exit.x, exit.y, T.STAIRS);
      this.exit = exit;

      /* —— 7. 宝箱 —— */
      for (let i = 0; i < M.chests; i++) {
        const r = rng.pick(rooms);
        const x = rng.int(r.x, r.x + r.w - 1), y = rng.int(r.y, r.y + r.h - 1);
        if (getT(x, y) === T.FLOOR && !(x === start.x && y === start.y)) {
          this.deco[idx(x, y)] = 0;
          setT(x, y, T.CHEST);
        }
      }
      /* —— 8. 治愈之泉 —— */
      for (let i = 0; i < (this.diff.healFountain || 0); i++) {
        const r = rng.pick(rooms);
        const x = rng.int(r.x, r.x + r.w - 1), y = rng.int(r.y, r.y + r.h - 1);
        if (getT(x, y) === T.FLOOR) setT(x, y, T.FOUNTAIN);
      }

      /* —— 8b. 潮汐商栈 —— */
      for (let i = 0; i < M.shops; i++) {
        const r = rng.pick(rooms);
        const x = rng.int(r.x, r.x + r.w - 1), y = rng.int(r.y, r.y + r.h - 1);
        if (getT(x, y) === T.FLOOR && !(x === start.x && y === start.y)) {
          this.deco[idx(x, y)] = 0;
          setT(x, y, T.SHOP);
        }
      }
      // 每下一层换一批货：逼你把金币花掉，而不是一路攒到通关
      this.shopStock = this._buildShop(depth);

      /* —— 9. 玩家 —— */
      this.px = start.x; this.py = start.y;
      setT(this.px, this.py, T.FLOOR);
      this.deco[idx(this.px, this.py)] = 0;
      // 起点周围一圈不能有水，否则开局就被烫
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (getT(this.px + dx, this.py + dy) === T.WATER) setT(this.px + dx, this.py + dy, T.FLOOR);
      }

      /* —— 10. 敌人：只在离起点足够远的位置放 —— */
      const count = Math.round(M.enemiesBase * (1 + (depth - 1) * 0.16) * num(this.diff.enemyMul));
      const occ = new Set([this.px + ',' + this.py]);
      for (let i = 0; i < count; i++) {
        const p = this._randomFloor(occ, start, 5);
        if (!p) break;
        occ.add(p.x + ',' + p.y);
        const e = this._makeEnemy(p.x, p.y, depth);
        this.enemies.push(e);
      }
      /* —— 10b. 连通性兜底 —— */
      this._ensureConnectivity();
      // 分区必须放在连通性兜底**之后**：兜底会凿开墙、增加可走格，
      // 在那之前算出来的区域会因为新增的通道而失准。
      this._buildRegions(depth);

      /* —— 11. Boss：守在下一层入口边上 —— */
      this.boss = null;
      if (depth >= this.diff.depth) {
        const bx = exit.x, by = exit.y - 1;
        if (getT(bx, by) !== T.WALL) {
          this.boss = this._makeBoss(bx, by, depth);
          this.enemies.push(this.boss);
          this.bossAlive = true;
        }
      } else this.bossAlive = false;

      /* —— 12. 记录「基准地形」。
         潮汐是"按水位重算水面"，不是"逐格往上涨"。
         没有基准地形，退潮时就不知道该把水还原成什么，
         水面会一路只增不减 —— 这是必须留的一份快照。 */
      this.base = this.tiles.slice();

      this._recomputeFOV();
      this._log('第 ' + depth + ' 层。' + (this.endless && depth > this.diff.depth
        ? '潮水已经漫过正篇的尽头 —— 再往下没有回头路。'
        : (depth >= this.diff.depth ? '潮汐之主就在下面。' : '找到潮汐之门继续下潜。')), 'info');
    }

    /**
     * 从起点做一次洪水填充，凡是走不到的地方都要处理掉。
     *
     * 为什么必须有这一步：房间+走廊的地图看起来天然连通，但只要后面
     * 任何一个生成步骤（这里就是岩浆）在走廊接口上留下一个不可通行的格子，
     * 出口就会整块被隔离。表现为：玩家清完怪却永远走不到潮汐之门，
     * 模拟里 21/60 局卡死。这种"地图本身生错了"的 bug 不能靠调数值掩盖，
     * 必须有一道确定性的兜底。
     */
    _reachable(sx, sy) {
      const W = this.W, H = this.H;
      const seen = new Uint8Array(W * H);
      const start = sy * W + sx;
      if (!this.walkable(sx, sy)) return seen;
      const q = [start]; seen[start] = 1;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let h = 0;
      while (h < q.length) {
        const i = q[h++], x = i % W, y = (i / W) | 0;
        for (const d of dirs) {
          const nx = x + d[0], ny = y + d[1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (seen[j] || !this.walkable(nx, ny)) continue;
          seen[j] = 1; q.push(j);
        }
      }
      return seen;
    }

    _ensureConnectivity() {
      const W = this.W;
      let seen = this._reachable(this.px, this.py);
      const exitIdx = this.exit.y * W + this.exit.x;

      if (!seen[exitIdx]) {
        // 强行开一条 L 形应急通道。宁可地图上多一条笔直的走廊，
        // 也不能让这一层无法通过。
        const carve = (x, y) => {
          if (x <= 0 || y <= 0 || x >= this.W - 1 || y >= this.H - 1) return;
          const v = this.tiles[y * W + x];
          if (v === T.WALL || v === T.LAVA || v === T.VOID) {
            this.tiles[y * W + x] = T.FLOOR;
            this.deco[y * W + x] = 0;
          }
        };
        let x = this.px, y = this.py;
        while (x !== this.exit.x) { x += (x < this.exit.x) ? 1 : -1; carve(x, y); }
        while (y !== this.exit.y) { y += (y < this.exit.y) ? 1 : -1; carve(x, y); }
        seen = this._reachable(this.px, this.py);
        this.connectedFix = (this.connectedFix || 0) + 1;
      }

      // 走不到的敌人留在场上只有坏处：玩家永远杀不掉，AI 会一直往上撞
      const keep = [];
      for (const e of this.enemies) {
        if (seen[e.y * W + e.x]) keep.push(e);
      }
      if (keep.length !== this.enemies.length) this.enemies = keep;

      // 出口本身若不可站立（例如被岩浆覆盖后没被清理干净），强制清了
      if (!this.walkable(this.exit.x, this.exit.y)) {
        this.tiles[exitIdx] = T.STAIRS;
        this.base && (this.base[exitIdx] = T.STAIRS);
      }
    }

    _randomFloor(occ, awayFrom, minDist) {
      for (let t = 0; t < 400; t++) {
        const x = this.rng.int(1, this.W - 2), y = this.rng.int(1, this.H - 2);
        const v = this.tiles[y * this.W + x];
        if (v !== T.FLOOR && v !== T.MOSS) continue;
        if (occ.has(x + ',' + y)) continue;
        if (awayFrom && (Math.abs(x - awayFrom.x) + Math.abs(y - awayFrom.y)) < minDist) continue;
        return { x: x, y: y };
      }
      return null;
    }

    /* ============================================================
       敌人
       ============================================================ */
    _enemyPool(depth) {
      const pool = [];
      const tb = num(this.diff.tierBoost);
      for (const e of D.ENEMIES) {
        let w = e.weight;
        // 精英权重随深度上升；深渊额外加成，让"石甲兽 + 幽魂"这种
        // 需要切换伤害类型的组合更早出现
        if (e.tier >= 2) w *= (1 + (depth - 1) * 0.34 + tb * 0.5 * (e.tier - 1));
        if (e.tier >= 3) w *= (1 + (depth - 1) * 0.30);
        if (e.tier === 1 && depth > 3) w *= 0.6;
        pool.push({ arc: e, weight: w });
      }
      return pool;
    }

    /**
     * 无尽模式的额外强度倍率（v11-6）。在正篇层数之内恒为 1 ——
     * 所以它**完全不影响任何一档难度的原有平衡**，这条边界是刻意留的。
     *
     * 为什么用递减增量、而不是随层数线性增长：
     * 线性到第 10 层就已经完全打不动，玩家会在一个固定层数上必死，
     * "无尽"于是退化成"再看一遍第 9 层的死法"。
     * 递减增量让曲线陡但不垂直，于是"能撑多久"取决于构筑质量，
     * 而不是取决于一个可以背下来的常数。
     *
     * 攻击力只吃 70% 的增幅：血量厚是"打久一点"，攻击高是"一下就死"，
     * 后者不给玩家反应空间，深层会从"难"变成"不讲理"。
     */
    endlessBoost(depth) {
      if (!this.endless) return 1;
      const over = Math.max(0, depth - this.diff.depth);
      if (over <= 0) return 1;
      let boost = 1, step = 0.14;
      for (let i = 0; i < over; i++) {
        boost += step;
        if ((i + 1) % 3 === 0) step *= 0.7;    // 每三层收敛一次
      }
      return Math.min(boost, 3);
    }

    _scaleEnemyStats(arc, depth) {
      const C = D.DEPTH_CFG, s = this.diff.enemyScale;
      const eb = this.endlessBoost(depth);
      const k = (1 + C.enemyHpPerDepth * (depth - 1)) * (1 + s * (depth - 1)) * eb;
      const a = (1 + C.enemyAtkPerDepth * (depth - 1)) * (1 + s * 0.8 * (depth - 1)) *
        (1 + (eb - 1) * 0.7);
      const d = (1 + C.enemyDefPerDepth * (depth - 1));
      const st = {};
      for (const key in arc.stats) {
        const v = arc.stats[key];
        if (key === 'hp') st[key] = Math.round(v * k);
        else if (key === 'atkP' || key === 'atkM') st[key] = Math.round(v * a);
        else if (key === 'defP' || key === 'defM') st[key] = Math.round(v * d);
        else st[key] = v;
      }
      // 补齐缺字段，杜绝 NaN 传染
      for (const key of ['atkP', 'atkM', 'penP', 'penM', 'defP', 'defM', 'spd', 'crit', 'leech', 'dodge']) {
        if (!(key in st)) st[key] = 0;
      }
      return st;
    }

    _makeEnemy(x, y, depth) {
      const pool = this._enemyPool(depth);
      const arc = this.rng.weighted(pool).arc;
      const st = this._scaleEnemyStats(arc, depth);
      return {
        id: ++SEQ, x: x, y: y, arc: arc, name: arc.name, kind: arc.kind || 'normal',
        stats: st, hp: st.hp, maxHp: st.hp, cd: 0, hitFlash: 0,
        region: this.regionAt(x, y)
      };
    }

    _makeBoss(x, y, depth) {
      const arc = this.rng.pick(D.BOSSES);
      const C = D.DEPTH_CFG, s = this.diff.enemyScale;
      const mult = (1 + C.enemyHpPerDepth * (depth - 1) * 0.5 + s * (depth - 1) * 0.5) *
        this.endlessBoost(depth);
      const st = {};
      for (const k in arc.stats) st[k] = k === 'leech' ? arc.stats[k] : Math.round(arc.stats[k] * mult);
      for (const key of ['penP', 'penM', 'crit', 'dodge']) if (!(key in st)) st[key] = 0;
      return {
        id: ++SEQ, x: x, y: y, arc: arc, name: arc.name, kind: 'boss',
        stats: st, hp: st.hp, maxHp: st.hp, cd: 0, hitFlash: 0, isBoss: true,
        region: this.regionAt(x, y)
      };
    }

    enemyAt(x, y) {
      for (const e of this.enemies) if (e.x === x && e.y === y) return e;
      return null;
    }
    tileAt(x, y) {
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return T.WALL;
      return this.tiles[y * this.W + x];
    }
    walkable(x, y) {
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return false;
      return !!WALKABLE[this.tiles[y * this.W + x]];
    }

    /* ============================================================
       视野：从玩家射一圈射线，撞墙即停。
       半径 8.5，只在玩家移动/地图变化时重算 —— 每帧重算会吃掉渲染预算。
       ============================================================ */
    _recomputeFOV() {
      const R = 8.5, R2 = R * R;
      this.visible.fill(0);
      const mark = (x, y) => {
        if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
        this.visible[y * this.W + x] = 1;
        this.explored[y * this.W + x] = 1;
      };
      mark(this.px, this.py);
      const steps = 240;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        let x = this.px + 0.5, y = this.py + 0.5;
        for (let t = 0; t < R * 1.6; t += 0.34) {
          x += dx * 0.34; y += dy * 0.34;
          const ix = Math.floor(x), iy = Math.floor(y);
          const ddx = ix - this.px, ddy = iy - this.py;
          if (ddx * ddx + ddy * ddy > R2) break;
          mark(ix, iy);
          if (OPAQUE[this.tileAt(ix, iy)]) break;
        }
      }
      // 墙背后贴着的一格也点亮：否则墙看起来像浮在黑里
      for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) {
        if (this.visible[y * this.W + x] || !OPAQUE[this.tileAt(x, y)]) continue;
        if (this.visible[(y) * this.W + (x - 1)] || this.visible[(y) * this.W + (x + 1)] ||
            this.visible[(y - 1) * this.W + x] || this.visible[(y + 1) * this.W + x]) {
          this.visible[y * this.W + x] = 1; this.explored[y * this.W + x] = 1;
        }
      }
    }
    isVisible(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H && !!this.visible[y * this.W + x]; }

    /* ============================================================
       区域（v11-5）

       实现上只有一条规则：**区域 = "到最近种子的距离"划分出来的连通块。**
       多源 BFS 一次给出两个保证：
         ① 每个区域都是连通的（从种子一步步长出来）
         ② 每个可走格恰好属于一个区域（是划分，不是重叠）

       为什么不用"按房间分"：房间之间常常只隔一条走廊，
       按房间划分会切出一堆只有一两格的小区域 —— 那种区域既没玩法也没法标颜色。
       ============================================================ */
    _buildRegions(depth) {
      const W = this.W, H = this.H, total = W * H;
      this.regionOf = new Int16Array(total); this.regionOf.fill(-1);
      this.regions = [];
      this.gateRegion = -1;

      const floors = [];
      for (let i = 0; i < total; i++) if (WALKABLE[this.tiles[i]]) floors.push(i);
      // 可走格太少就干脆不分区（宁可没有区域，也不要切出玩具一样的小块）
      if (floors.length < 40) return;

      const n = Math.max(3, Math.min(6, 4 + Math.floor((depth - 1) / 2)));
      const seeds = [];

      // 1) 第一个种子 = 离起点最远的可走格（保证"深处"也有独立区域）
      let best = floors[0], bestD = -1;
      for (const i of floors) {
        const x = i % W, y = (i / W) | 0;
        const d = Math.abs(x - this.px) + Math.abs(y - this.py);
        if (d > bestD) { bestD = d; best = i; }
      }
      seeds.push(best);

      // 2) 其余种子用"最远点采样"：每次挑离已有种子最远的格子。
      //    这一步让区域大小不会差得太离谱（纯随机会切出针尖状的小区域）。
      while (seeds.length < n) {
        let pick = -1, pickD = -1;
        for (const i of floors) {
          const x = i % W, y = (i / W) | 0;
          let md = 1e9;
          for (const s of seeds) {
            const qx = s % W, qy = (s / W) | 0;
            const d = Math.abs(x - qx) + Math.abs(y - qy);
            if (d < md) md = d;
          }
          if (md > pickD) { pickD = md; pick = i; }
        }
        if (pick < 0 || pickD <= 1) break;
        seeds.push(pick);
      }

      // 3) 多源 BFS：每个可走格归到最近的种子
      const q = [];
      for (let i = 0; i < seeds.length; i++) { this.regionOf[seeds[i]] = i; q.push(seeds[i]); }
      let head = 0;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      while (head < q.length) {
        const cur = q[head++], cx = cur % W, cy = (cur / W) | 0;
        for (const d of dirs) {
          const nx = cx + d[0], ny = cy + d[1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (!WALKABLE[this.tiles[ni]] || this.regionOf[ni] >= 0) continue;
          this.regionOf[ni] = this.regionOf[cur];
          q.push(ni);
        }
      }

      // 4) 建区域对象 + 统计面积与中心（中心给 UI 指方向用）
      const rng = this.rng;
      this.regions = seeds.map(function (s) {
        return { id: 0, seed: { x: s % W, y: (s / W) | 0 }, type: 'normal',
                 tiles: 0, sx: 0, sy: 0, cx: s % W, cy: (s / W) | 0 };
      });
      for (let i = 0; i < this.regions.length; i++) this.regions[i].id = i;
      for (let i = 0; i < total; i++) {
        const r = this.regionOf[i];
        if (r < 0) continue;
        const reg = this.regions[r];
        reg.tiles++;
        reg.sx += (i % W); reg.sy += ((i / W) | 0);
      }
      for (const reg of this.regions) {
        if (reg.tiles > 0) {
          reg.cx = Math.round(reg.sx / reg.tiles);
          reg.cy = Math.round(reg.sy / reg.tiles);
        }
      }

      // 5) 定类型：出口所在区域固定是守门区（"通关点在哪个区域"必须能标出来），
      //    其余从池子里抽，但**精英/危险/奖励每层各最多一个** ——
      //    否则会切出一层全是高难区，玩家的"规划路线"就没得规划了。
      const exitI = this.exit.y * W + this.exit.x;
      this.gateRegion = this.regionOf[exitI];
      const pool = ['normal', 'normal', 'normal', 'elite', 'reward', 'hazard'];
      const used = {};
      for (const reg of this.regions) {
        if (reg.id === this.gateRegion) { reg.type = 'gate'; continue; }
        let t = rng.pick(pool);
        used[t] = (used[t] || 0) + 1;
        if (t !== 'normal' && used[t] > 1) t = 'normal';
        reg.type = t;
      }

      // 5b) 开局层的缓冲：第 1 层不设高难区域。
      //     它不是"难度旋钮"，而是**教学层** —— 玩家在这里认识职业、试手感、
      //     搞明白水与门的关系。开局 20 步就撞进精英区，学到的不是
      //     "要不要绕开"，而是"这游戏只能硬碰硬"。
      //     奖励区保留：第一眼看到"地图上有块好地方"是正向引导。
      if (depth <= 1) {
        for (const reg of this.regions) {
          if (reg.type === 'elite' || reg.type === 'hazard') reg.type = 'normal';
        }
      }

      // 6) 敌人绑区域
      this._tagEnemyRegions();
      this.playerRegion = this.regionAt(this.px, this.py);
      // 出生点所在的区域开局就算"认得"，否则标签会以"未知"的样子
      // 出现在玩家脚底下，而玩家明明就站在里面
      if (!this.regionVisited) this.regionVisited = {};
      if (this.playerRegion >= 0) this.regionVisited[this.playerRegion] = 1;
      this._applyRegionFlavor();
    }

    _tagEnemyRegions() {
      for (const e of this.enemies) e.region = this.regionAt(e.x, e.y);
      if (this.boss) this.boss.region = this.regionAt(this.boss.x, this.boss.y);
    }

    regionAt(x, y) {
      if (!this.regionOf) return -1;
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
      return this.regionOf[y * this.W + x];
    }
    regionOfId(id) {
      if (!this.regions || id === undefined || id === null || id < 0) return null;
      return this.regions[id] || null;
    }
    regionTypeAt(x, y) {
      const r = this.regionOfId(this.regionAt(x, y));
      return r ? r.type : null;
    }
    regionInfoAt(x, y) {
      const r = this.regionOfId(this.regionAt(x, y));
      return r ? (D.REGIONS[r.type] || D.REGIONS.normal) : null;
    }

    /** 在指定区域里找一个干净的空地（放箱子 / 放奖励用） */
    _regionFreeTile(id) {
      if (!this.regionOf) return null;
      const W = this.W, H = this.H, cands = [];
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          if (this.regionOf[y * W + x] !== id) continue;
          if (this.tiles[y * W + x] !== T.FLOOR) continue;
          if (x === this.px && y === this.py) continue;
          if (this.exit && x === this.exit.x && y === this.exit.y) continue;
          cands.push({ x: x, y: y });
        }
      }
      return cands.length ? this.rng.pick(cands) : null;
    }

    /**
     * 让区域类型**真的有意义**（否则它只是一种颜色）。
     * 这里只做"和战斗直接相关"的三件事，不动掉落与经济 ——
     * 那两块已经在别处标定过，混进来会让平衡没法归因。
     */
    _applyRegionFlavor() {
      if (!this.regions || !this.regions.length) return;
      const byRegion = {};
      for (const e of this.enemies) {
        if (!byRegion[e.region]) byRegion[e.region] = [];
        byRegion[e.region].push(e);
      }
      const scale = function (e, mul) {
        for (const k in e.stats) {
          if (k === 'crit' || k === 'leech' || k === 'dodge') continue;
          e.stats[k] = Math.round(num(e.stats[k]) * mul);
        }
        e.hp = e.maxHp = e.stats.hp;
      };
      for (const reg of this.regions) {
        const list = byRegion[reg.id] || [];
        if (reg.type === 'reward') {
          // 奖励区：最多留一只怪 + 保底一个箱子。
          // "几乎没有怪"是它的全部意义 —— 让玩家有一个能喘气的地方。
          for (let i = 1; i < list.length; i++) {
            const at = this.enemies.indexOf(list[i]);
            if (at >= 0) this.enemies.splice(at, 1);
          }
          const free = this._regionFreeTile(reg.id);
          if (free) {
            const ci = free.y * this.W + free.x;
            this.tiles[ci] = T.CHEST;
            // base 是烘焙地形用的镜像层，必须一起改 ——
            // 只改 tiles 的话，"逻辑上有箱子、画面上没有"（很难查的那种）
            if (this.base) this.base[ci] = T.CHEST;
          }
        } else if (reg.type === 'elite' && list.length) {
          const e = list[0];
          e.kind = 'elite';
          scale(e, D.REGIONS.elite.enemMul);
          e.name = '精英·' + e.name;
        } else if (reg.type === 'hazard') {
          for (const e of list) scale(e, D.REGIONS.hazard.enemMul);
        } else if (reg.type === 'gate') {
          for (const e of list) scale(e, D.REGIONS.gate.enemMul);
        }
      }
      this._tagEnemyRegions();
    }

    /** 玩家换区了就报一次（横幅 / 音效 / 导航全靠这个事件） */
    _checkRegion() {
      const r = this.regionAt(this.px, this.py);
      if (r === this.playerRegion) return;
      const first = (this.playerRegion === undefined || this.playerRegion === null);
      this.playerRegion = r;
      const reg = this.regionOfId(r);
      if (!first && reg) {
        const info = D.REGIONS[reg.type] || D.REGIONS.normal;
        this.events.push({
          kind: 'region', id: r, rtype: reg.type, danger: info.danger,
          name: info.name, color: info.color
        });
        this._log('进入' + info.name + '（危险度 ' + '★'.repeat(info.danger) + '）',
          (reg.type === 'hazard' || reg.type === 'elite') ? 'warn' : 'info');
      }
      if (!this.regionVisited) this.regionVisited = {};
      if (r >= 0) this.regionVisited[r] = 1;
    }

    /** 出口在哪个区域、离玩家几个区域 —— 给 HUD 的"往哪走"用 */
    exitRegionInfo() {
      const g = this.regionOfId(this.gateRegion);
      if (!g) return null;
      const here = this.regionOfId(this.regionAt(this.px, this.py));
      const dx = g.cx - this.px, dy = g.cy - this.py;
      const dir = (Math.abs(dy) > Math.abs(dx))
        ? (dy < 0 ? '北' : '南')
        : (dx < 0 ? '西' : '东');
      const mix = (Math.abs(dy) > 4 && Math.abs(dx) > 4) ? (dx < 0 ? '西北' : '东北') : dir;
      // "几个区域外"：用区域中心之间的曼哈顿距离粗略折算，够用且稳定
      const hops = Math.max(0, Math.round((Math.abs(dx) + Math.abs(dy)) / 14));
      return {
        id: this.gateRegion, name: (D.REGIONS[g.type] || D.REGIONS.normal).name,
        dir: mix, hops: hops, same: (here && here.id === g.id)
      };
    }
    isExplored(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H && !!this.explored[y * this.W + x]; }

    /**
     * 寻路：A*。
     * 水的代价调高（5 而不是 1），但不是不可通行 ——
     * 玩家点远处理论上应该绕开水走；只有在绕不过去时才会涉水，
     * 这时候"代价"就变成了真实决策：省几步路，还是省几十点血。
     * @param {number} waterCost 水的额外代价，敌人传 0（它们本来就不怕水）
     */
    /**
     * @param onlyRegion 只允许走这个区域（敌人用；玩家不传 = 全图可走）。
     *   敌人必须传 —— "怪物不会离开对应区域"这条规则如果散在移动代码里写，
     *   迟早会有第二条移动路径漏掉它。让寻路本身拒绝越界，才是唯一执行点。
     */
    findPath(sx, sy, tx, ty, limit, waterCost, onlyRegion) {
      const lim = limit || 900;
      const wc = (waterCost === undefined) ? 5 : waterCost;
      if (!this.walkable(tx, ty)) return null;
      const W = this.W;
      const key = (x, y) => y * W + x;
      const cost = (x, y) => 1 + (this.tiles[y * W + x] === T.WATER ? wc : 0);
      const open = [{ x: sx, y: sy, g: 0, f: 0, p: null }];
      const seen = {};
      seen[key(sx, sy)] = 0;
      let steps = 0;
      while (open.length && steps++ < lim) {
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
        const cur = open.splice(bi, 1)[0];
        if (cur.x === tx && cur.y === ty) {
          const out = [];
          let n = cur;
          while (n) { out.push({ x: n.x, y: n.y }); n = n.p; }
          return out.reverse();
        }
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const d of dirs) {
          const nx = cur.x + d[0], ny = cur.y + d[1];
          if (!this.walkable(nx, ny)) continue;
          if (onlyRegion !== undefined && onlyRegion !== null && onlyRegion >= 0 &&
              this.regionAt(nx, ny) !== onlyRegion) continue;
          const g = cur.g + cost(nx, ny);
          const kk = key(nx, ny);
          if (kk in seen && seen[kk] <= g) continue;
          seen[kk] = g;
          const h = Math.abs(nx - tx) + Math.abs(ny - ty);
          open.push({ x: nx, y: ny, g: g, f: g + h * 1.15, p: cur });
        }
      }
      return null;
    }

    /* ============================================================
       装备与掉落
       ============================================================ */
    /** 词条数值随深度和品质膨胀。同一件装备的数值只在这里生成一次。 */
    _scaleStat(statKey, v, depth, power) {
      let mul = 1 + 0.22 * (depth - 1);
      mul *= power;
      // 生命在数据表里是按"条"写的，玩家血量是三位数，单独放大
      if (statKey === 'hp') mul *= 2.4;
      if (statKey === 'crit' || statKey === 'leech' || statKey === 'dodge') return Math.round(v * mul * 1000) / 1000;
      return Math.round(v * mul * 10) / 10;
    }

    /** 品质抽取：幸运把权重向高稀有度平移 */
    _rollRarity(luck, depth) {
      const l = num(luck);
      const bias = 1 + l * D.LOOT.luckPerPoint * 2.4 + (depth - 1) * 0.14;
      const list = D.RARITIES.map(function (r, i) {
        return { r: r, weight: r.weight * Math.pow(bias, i) };
      });
      return this.rng.weighted(list, function (x) { return x.weight; }).r;
    }

    makeItem(opts) {
      opts = opts || {};
      const depth = opts.depth || this.depth;
      const rng = this.rng;
      const stats = this.stats();
      const fl = this.flags();
      const luck = num(stats.luck) + num(fl.luck || 0);

      const slotDef = opts.slot ? { key: opts.slot } : rng.pick(D.EQUIP_SLOTS);
      const pool = D.basesForSlot(slotDef.key);
      // 深层才出高阶基底
      const filt = pool.filter(function (b) { return b.tier <= 1 + Math.ceil(depth / 2) + (opts.bonus || 0); });
      const base = rng.pick(filt.length ? filt : pool);
      const rarity = opts.rarity ? D.rarityByKey(opts.rarity) : this._rollRarity(luck + (opts.bonus || 0) * 2, depth);

      const item = {
        uid: ++SEQ, baseId: base.id, slot: base.slot, name: base.name, icon: base.icon,
        rarity: rarity.key, rarityName: rarity.name, color: rarity.color,
        implicit: {}, affixes: [], flags: {}, total: {}, text: [], depth: depth
      };
      // 固有属性
      for (const k in base.imp) {
        const v = this._scaleStat(k, base.imp[k], depth, rarity.power * 0.85);
        item.implicit[k] = v;
        item.total[k] = num(item.total[k]) + v;
      }
      // 词条
      const n = rarity.affixes;
      const used = {};
      const pool2 = D.AFFIXES.filter(function (a) {
        return !a.rare || rarity.key === 'epic' || rarity.key === 'legendary' || rng.chance(0.34);
      });
      for (let i = 0; i < n; i++) {
        const cand = pool2.filter(function (a) {
          return !used[a.id] && !(a.stat && a.stat in item.implicit && a.stat !== 'hp');
        });
        if (!cand.length) break;
        const a = this.rng.weighted(cand);
        used[a.id] = 1;
        if (a.flags) {
          item.affixes.push({ id: a.id, name: a.name, icon: a.icon, flag: true, text: a.text });
          for (const k in a.flags) item.flags[k] = num(item.flags[k]) + num(a.flags[k]);
        } else {
          const raw = a.min + this.rng.float() * (a.max - a.min);
          const v = this._scaleStat(a.stat, raw, depth, rarity.power);
          item.affixes.push({ id: a.id, name: a.name, icon: a.icon, stat: a.stat, value: v });
          item.total[a.stat] = num(item.total[a.stat]) + v;
        }
      }
      // 人类可读的词条文本：UI 直接用，不在渲染层拼字符串
      for (const k in item.implicit) item.text.push({ kind: 'imp', stat: k, value: item.implicit[k] });
      for (const a of item.affixes) {
        item.text.push(a.flag
          ? { kind: 'flag', text: a.text, icon: a.icon, name: a.name }
          : { kind: 'affix', stat: a.stat, value: a.value, icon: a.icon, name: a.name });
      }
      return item;
    }

    /**
     * 一件装备的「身价」。
     * 售价（× sellRate）和商店定价（× shopMarkup）都从这里派生 ——
     * 只在一处定义，否则迟早会出现"买回来再卖出去净赚"的套利漏洞。
     */
    itemValue(item) {
      if (!item) return 0;
      const r = D.rarityByKey(item.rarity);
      const base = 10 + num(item.depth) * 8;
      return Math.max(4, Math.round(base * r.power * (1 + item.affixes.length * 0.25)));
    }
    sellPrice(item) { return Math.max(1, Math.round(this.itemValue(item) * D.LOOT.sellRate)); }
    buyPrice(item) { return Math.max(2, Math.round(this.itemValue(item) * D.LOOT.shopMarkup)); }

    /* ============================================================
       装备融合（设计取自《元气骑士》的武器融合）

       两件同品质 → 一件高一档。规则放在模型层，界面只负责拖拽手势 ——
       否则模拟器的 AI 又学不会，融合的价值就进不了平衡数据。

       费用从**结果的身价**派生，而不是"两件材料的身价差"：
       品质是跳跃式而不是叠加式的，材料身价加起来通常已经超过结果，
       按差价算出来的费用会永远是 0（等于白送）。从结果身价派生还有个好处：
       它天然 ≥ 结果的售价，于是"融合完再卖掉"永远亏 ——
       和买卖定价一样，堵死回路只需要让价格来自同一个源。
       ============================================================ */
    /** 品质下标（-1 = 未知）。融合靠它判断"还能不能再升一档" */
    rarityIndex(key) {
      for (let i = 0; i < D.RARITIES.length; i++) if (D.RARITIES[i].key === key) return i;
      return -1;
    }

    /** 融合会长成什么样。null = 这两件不能融合（不同品质 / 已是最高档） */
    fuseResult(a, b) {
      if (!a || !b || a === b) return null;
      const i = this.rarityIndex(a.rarity);
      if (i < 0 || i + 1 >= D.RARITIES.length) return null;
      if (b.rarity !== a.rarity) return null;
      return { slot: a.slot, depth: Math.max(a.depth, b.depth), rarity: D.RARITIES[i + 1] };
    }

    /** 融合费用；-1 表示这两件不能融合 */
    fuseCost(a, b) {
      const r = this.fuseResult(a, b);
      if (!r) return -1;
      const v = this.itemValue({
        depth: r.depth, rarity: r.rarity.key, affixes: new Array(r.rarity.affixes)
      });
      return Math.max(D.LOOT.fuseMin, Math.round(v * D.LOOT.fuseRate));
    }

    /**
     * 融合背包里第 i、第 j 件。
     * @returns {{ok:boolean, reason?:string, cost?:number, item?:object}}
     */
    fuseItems(i, j) {
      if (i === j) return { ok: false, reason: 'invalid' };
      const a = this.bag[i], b = this.bag[j];
      const cost = this.fuseCost(a, b);
      if (cost < 0) return { ok: false, reason: 'invalid' };
      if (this.gold < cost) return { ok: false, reason: 'gold', cost: cost };
      const r = this.fuseResult(a, b);
      const made = this.makeItem({ depth: r.depth, slot: r.slot, rarity: r.rarity.key });
      // 先删大下标，否则删掉小的之后大的会前移一格
      this.bag.splice(Math.max(i, j), 1);
      this.bag.splice(Math.min(i, j), 1);
      if (this.bag.length < this.bagCap()) this.bag.push(made);
      this.gold -= cost;
      this.events.push({ kind: 'fuse', item: made, cost: cost });
      this._log('融合：' + a.name + ' × ' + b.name + ' → 「' + made.name + '」（' +
        r.rarity.name + '），花费 ' + cost + ' 金币', 'good');
      return { ok: true, cost: cost, item: made };
    }

    /** 生成一层的商店货架：5 件装备 + 一次治疗服务 */
    _buildShop(depth) {
      const stock = [];
      for (let i = 0; i < D.LOOT.shopSlots; i++) {
        // 商店的品质权重要比野怪掉落体面一点，否则没人愿意花钱
        const it = this.makeItem({ depth: depth + 1, bonus: 1 + (i === 0 ? 1 : 0) });
        stock.push({ type: 'item', item: it, price: this.buyPrice(it) });
      }
      stock.push({
        type: 'heal', name: '潮汐圣水', icon: 'health-potion',
        text: '回复 45% 最大生命', price: 30 + depth * 22, amount: 0.45
      });
      return stock;
    }

    refreshShop() {
      const cost = D.LOOT.refreshCost;
      if (this.gold < cost) { this._log('金币不足，刷新需要 ' + cost + '。', 'warn'); return false; }
      this.gold -= cost;
      this.shopStock = this._buildShop(this.depth);
      this.events.push({ kind: 'shop', refresh: true });
      return true;
    }

    /** 出售背包里第 index 件装备 */
    sellItem(index) {
      const it = this.bag[index];
      if (!it) return false;
      const price = this.sellPrice(it);
      this.bag.splice(index, 1);
      this.gold += price;
      this.events.push({ kind: 'sell', item: it, gold: price });
      this._log('出售 ' + it.name + '，获得 ' + price + ' 金币。', 'good');
      return true;
    }

    /** 一键出售所有「比身上那件差」的装备 */
    sellJunk() {
      const score = (it) => {
        if (!it) return -1;
        let sc = 0;
        for (const k in it.total) sc += num(it.total[k]) * (k === 'hp' ? 0.3 : 1);
        for (const k in it.flags) sc += 30;
        return sc;
      };
      let gold = 0, n = 0;
      for (let i = this.bag.length - 1; i >= 0; i--) {
        const it = this.bag[i];
        if (score(it) > score(this.equip[it.slot])) continue;
        gold += this.sellPrice(it);
        this.bag.splice(i, 1);
        n++;
      }
      if (!n) { this._log('没有可以出售的装备。', 'info'); return 0; }
      this.gold += gold;
      this._log('批量出售 ' + n + ' 件装备，获得 ' + gold + ' 金币。', 'good');
      this.events.push({ kind: 'sell', bulk: n, gold: gold });
      return gold;
    }

    /** 购买商店货架上的第 index 项。
     *  交易必须站在潮汐商栈上 —— 这条规则写在模型里，不写在界面里。
     *  第一版把它放在 UI 的点击处理里，结果模型层的 buyItem() 可以在任何地方买，
     *  模拟器里的 AI 直接把它当成了"无限自动补给站"。规则只有一个归属地。 */
    buyItem(index) {
      if (this.tileAt(this.px, this.py) !== T.SHOP) {
        this._log('要交易，得先站到潮汐商栈上。', 'warn');
        return false;
      }
      const s = this.shopStock[index];
      if (!s) return false;
      if (this.gold < s.price) { this._log('金币不足（需要 ' + s.price + '）。', 'warn'); return false; }
      if (s.type === 'item') {
        if (this.bag.length >= this.bagCap()) { this._log('背包已满，先腾出位置。', 'warn'); return false; }
        this.gold -= s.price;
        this.bag.push(s.item);
        this.shopStock.splice(index, 1);
        this.events.push({ kind: 'buy', item: s.item, gold: s.price });
        this._log('购入 ' + s.item.name + '（' + s.item.rarityName + '）。', 'loot');
      } else if (s.type === 'heal') {
        const st = this.stats();
        if (this.hp >= st.hp) { this._log('生命已满，不需要圣水。', 'info'); return false; }
        this.gold -= s.price;
        const heal = Math.round(st.hp * s.amount);
        this.hp = Math.min(st.hp, this.hp + heal);
        this.events.push({ kind: 'heal', amount: heal });
        this._log('饮下潮汐圣水，回复 ' + heal + ' 点生命。', 'good');
      }
      return true;
    }

    /** 掉落判定与生成 */
    _rollDrop(enemy) {
      const fl = this.flags();
      const L = D.LOOT;
      let chance = L.baseChance + num(fl.dropBonus);
      if (enemy.kind === 'elite') chance += L.eliteBonus;
      if (enemy.kind === 'treasure') chance = L.treasureChance;
      if (enemy.kind === 'boss') chance = 1.6;      // 必掉，且掉两件里的最好那件
      if (!this.rng.chance(Math.min(1.0, chance))) return null;
      const bonus = (enemy.kind === 'boss' ? 3 : enemy.kind === 'elite' ? 1 : enemy.kind === 'treasure' ? 2 : 0);
      if (enemy.kind === 'boss') {
        // Boss 掉两件，取稀有度更高的那件，避免"打死 Boss 掉白装"的挫败
        const a = this.makeItem({ depth: this.depth + 1, bonus: bonus });
        const b = this.makeItem({ depth: this.depth + 1, bonus: bonus });
        const rank = (it) => D.RARITIES.findIndex(function (r) { return r.key === it.rarity; });
        return rank(a) >= rank(b) ? a : b;
      }
      return this.makeItem({ depth: this.depth, bonus: bonus });
    }

    /* ============================================================
       战斗结算
       一次算完整场。返回每轮的明细，供飘字与日志使用。
       ============================================================ */
    /**
     * @param {object} A 攻方面板（含 hp/maxHp）
     * @param {object} B 守方面板
     * @param {object} af A 的 flags
     * @param {boolean} aFirst 平手时 A 是否先手
     * @param {object} aInfo {name, isPlayer}
     */
    _duel(A, B, af, bf, aFirst, aInfo, bInfo) {
      const K = this.K, C = D.COMBAT;
      const a = {
        name: aInfo.name, hp: A.hp, maxHp: A.maxHp || A.hp, st: A, flags: af || {},
        dodge: num(A.dodge), isPlayer: !!aInfo.isPlayer
      };
      const b = {
        name: bInfo.name, hp: B.hp, maxHp: B.maxHp || B.hp, st: B, flags: bf || {},
        dodge: num(B.dodge), isPlayer: !!bInfo.isPlayer,
        wet: num(B.wet)          // 潮湿是挂在敌人身上的状态，结算时读这里
      };
      const log = [];
      const roundLog = [];

      function atkOf(x) { return bestAttack(x.st, x === a ? b.st : a.st, K); }

      function strike(src, dst, round) {
        if (src.hp <= 0) return 0;
        const atk = bestAttack(src.st, dst.st, K);
        let dmg = atk.base;
        let crit = false, dodged = false, extra = [];
        // 闪避
        const dg = num(dst.dodge) + num(dst.flags.dodge);
        if (dg > 0 && this.rng.chance(Math.min(0.7, dg))) {
          dodged = true; dmg = 0;
          roundLog.push({ r: round, from: src.name, to: dst.name, dmg: 0, type: atk.type, dodge: true });
          return 0;
        }
        // 条件增伤
        if (num(src.flags.firstStrike) > 0 && num(src.st.spd) > num(dst.st.spd)) {
          dmg *= (1 + num(src.flags.firstStrike)); extra.push('先制');
        }
        if (num(src.flags.execute) > 0 && dst.hp / dst.maxHp < 0.32) {
          dmg *= (1 + num(src.flags.execute)); extra.push('处决');
        }
        if (num(src.flags.echo) > 0 && atk.type === 'm' && this.rng.chance(num(src.flags.echo))) {
          dmg *= 2; extra.push('回响');
        }
        // 潮湿：法术伤害加成 —— 潮语洪流留下的破绽，要在这里兑现
        if (atk.type === 'm' && num(dst.wet) > 0) {
          dmg *= (1 + num(C.wetAmp)); extra.push('潮湿');
        }
        // 疾影的爆发窗口。走和遗物同一套 flags，
        // 战斗结算就完全不必知道"这个增伤是遗物给的还是技能给的"。
        if (num(src.flags.dmgOut) > 0) {
          dmg *= (1 + num(src.flags.dmgOut)); extra.push('疾影');
        }
        // 暴击
        const critChance = num(src.st.crit);
        if (critChance > 0 && this.rng.chance(Math.min(0.85, critChance))) {
          dmg *= C.critMul; crit = true;
        }
        // 残血加防
        if (num(dst.flags.lastStand) > 0 && dst.hp / dst.maxHp < 0.4) {
          dmg *= 1 / (1 + num(dst.flags.lastStand)); extra.push('坚守');
        }
        dmg = Math.max(1, Math.round(dmg));
        dst.hp -= dmg;
        // 吸血
        let heal = 0;
        let leech = num(src.st.leech) + num(src.flags.leech || 0);
        if (leech > 0) {
          if (num(src.flags.leechBonusIfBleed) > 0 && src.hp / src.maxHp < 0.5) {
            leech *= (1 + num(src.flags.leechBonusIfBleed));
          }
          heal = Math.round(dmg * Math.min(0.75, leech));
          src.hp = Math.min(src.maxHp, src.hp + heal);
        }
        // 反伤
        if (num(dst.flags.thorns) > 0) {
          const back = Math.round(dmg * num(dst.flags.thorns));
          src.hp -= back;
          if (back > 0) extra.push('反伤' + back);
        }
        roundLog.push({
          r: round, from: src.name, to: dst.name, dmg: dmg, type: atk.type,
          crit: crit, heal: heal, extra: extra.join(' ')
        });
        return dmg;
      }

      // 先手权：速度高者先手；平手看参数
      let aFirstTurn = num(a.st.spd) === num(b.st.spd) ? !!aFirst : num(a.st.spd) > num(b.st.spd);
      let rounds = 0;
      while (a.hp > 0 && b.hp > 0 && rounds < C.maxRounds) {
        rounds++;
        const order = aFirstTurn ? [a, b] : [b, a];
        for (const src of order) {
          if (src.hp <= 0) continue;
          const dst = src === a ? b : a;
          strike.call(this, src, dst, rounds);
          if (dst.hp <= 0) break;
          // 速度碾压：快的一方多打一次
          const gap = num(src.st.spd) - num(dst.st.spd);
          if (gap >= C.speedGap && src.hp > 0 && dst.hp > 0) {
            strike.call(this, src, dst, rounds);
          }
          // 连击词条：达标就每轮两次
          if (num(src.flags.doubleAtSpd) > 0 && num(src.st.spd) >= num(src.flags.doubleAtSpd) &&
              src.hp > 0 && dst.hp > 0) {
            strike.call(this, src, dst, rounds);
          }
        }
      }
      /**
       * 回合上限必须给出一个确定结果。
       *
       * 之前这里只是"停下来，谁也没死"。后果是：吸血型敌人
       * （祷者 25% 吸血、首领 15~20%）每轮回的血可能刚好等于你打掉的伤害，
       * 形成真正的永久僵持 —— 双方都活着，回合数无限增长。
       * 模拟里表现为 8% 的对局跑满 2400 回合；对真人玩家则是一个死局：
       * 打不死它，也走不掉。
       *
       * 现在改成按剩余生命比例判定：谁掉得更多谁先撑不住。
       * 于是"能不能打赢"重新变成一个可以判断的问题 ——
       * 如果你在僵持中掉血更快，那这场本来就不该打。
       */
      let capped = false;
      if (a.hp > 0 && b.hp > 0) {
        capped = true;
        const af = a.hp / a.maxHp, bf = b.hp / b.maxHp;
        if (af <= bf) a.hp = 0; else b.hp = 0;
      }
      return {
        aHp: Math.max(0, Math.round(a.hp)), bHp: Math.max(0, Math.round(b.hp)),
        rounds: rounds, aWin: b.hp <= 0 && a.hp > 0, dead: a.hp <= 0,
        capped: capped, log: roundLog
      };
    }

    /** 玩家主动开战（走进敌人格）：整场对决，双方都会掉血 */
    fight(enemy) {
      const st = this.stats();
      const fl = this.flags();
      const A = Object.assign({}, st); A.hp = this.hp; A.maxHp = st.hp;
      const B = Object.assign({}, enemy.stats); B.hp = enemy.hp; B.maxHp = enemy.maxHp;
      B.wet = enemy.wet || 0;      // 潮湿状态要带进结算
      const res = this._duel(A, B, fl, null, true,
        { name: this.cls.name, isPlayer: true }, { name: enemy.name });
      this.hp = res.aHp;
      enemy.hp = res.bHp;
      enemy.hitFlash = 12;
      const ev = { kind: 'fight', enemy: enemy, rounds: res.log, target: enemy, capped: res.capped };
      this.events.push(ev);
      if (res.capped) this._log('与 ' + enemy.name + '僵持不下 —— 先撑不住的一方倒下了。', 'warn');
      if (res.bHp <= 0) {
        this._killEnemy(enemy, true);
        return { win: true, died: res.dead, rounds: res.log };
      }
      if (res.dead) { this._die(enemy.name); return { win: false, died: true, rounds: res.log }; }
      return { win: false, died: false, rounds: res.log };
    }

    /** 敌人主动打你：只打一下（不是整场对决）。否则一步一死，太难。 */
    enemyHit(enemy) {
      const st = this.stats();
      const fl = this.flags();
      const atk = bestAttack(enemy.stats, st, this.K);
      let dmg = atk.base;
      let crit = false;
      if (num(st.dodge) + num(fl.dodge) > 0 &&
          this.rng.chance(Math.min(0.7, num(st.dodge) + num(fl.dodge)))) {
        this.events.push({ kind: 'dodge', enemy: enemy });
        return 0;
      }
      if (num(fl.lastStand) > 0 && this.hp / st.hp < 0.4) dmg *= 1 / (1 + num(fl.lastStand));
      if (num(enemy.stats.crit) > 0 && this.rng.chance(enemy.stats.crit)) { dmg *= D.COMBAT.critMul; crit = true; }
      dmg = Math.max(1, Math.round(dmg));
      this.hp -= dmg;
      const round = [{ from: enemy.name, to: this.cls.name, dmg: dmg, type: atk.type, crit: crit }];
      this.events.push({ kind: 'hit', enemy: enemy, rounds: round, dmg: dmg, crit: crit });
      let heal = 0;
      if (num(enemy.stats.leech) > 0) {
        heal = Math.round(dmg * enemy.stats.leech);
        enemy.hp = Math.min(enemy.maxHp, enemy.hp + heal);
      }
      if (num(fl.thorns) > 0) {
        const back = Math.round(dmg * num(fl.thorns));
        enemy.hp -= back;
        if (enemy.hp <= 0) this._killEnemy(enemy, false);
      }
      if (this.hp <= 0) this._die(enemy.name);
      return dmg;
    }

    _killEnemy(enemy, byPlayer) {
      const i = this.enemies.indexOf(enemy);
      if (i >= 0) this.enemies.splice(i, 1);
      this.kills++;
      if (enemy.kind === 'elite') this.eliteKills++;
      if (enemy.kind === 'boss') this.bossKills++;
      this.events.push({ kind: 'kill', enemy: enemy });
      const fl = this.flags();
      if (num(fl.devour) > 0) this.devourStacks += num(fl.devour);

      // 掉落
      let gold = D.LOOT.goldPerKill + this.depth * D.LOOT.goldPerDepth;
      if (enemy.kind === 'elite') gold += D.LOOT.goldElite;
      if (enemy.kind === 'treasure') gold += D.LOOT.goldElite;
      if (enemy.kind === 'boss') gold += D.LOOT.goldBoss;
      this.gold += gold;
      this.events.push({ kind: 'gold', amount: gold });

      const drop = this._rollDrop(enemy);
      if (drop) {
        if (this.bag.length < this.bagCap()) {
          this.bag.push(drop);
          this.events.push({ kind: 'loot', item: drop, enemy: enemy });
          this._log('掉落：' + drop.name + '（' + drop.rarityName + '）', 'loot');
        } else {
          this._log('背包满了，遗落了 ' + drop.name + '。打开背包卖掉一些吧。', 'warn');
          this.events.push({ kind: 'bagfull', item: drop });
        }
      }
      if (enemy.isBoss) {
        this.bossAlive = false;
        this._log('潮汐之主倒下了。水位开始回落。', 'good');
        this.tideLevel = 0;
        this.events.push({ kind: 'bossdown' });
      }
      // 三选一
      if (this.kills >= this.nextRelicAt) {
        this.pendingRelic = this._offerRelics();
        this.nextRelicAt += D.PROGRESSION.relicEvery;
      }
      // 战后回复
      if (num(fl.regenAfterWin) > 0) {
        const st = this.stats();
        this.hp = Math.min(st.hp, this.hp + Math.round(st.hp * num(fl.regenAfterWin)));
      }
      if (num(this.diff.healAfterWin) > 0) {
        const st = this.stats();
        this.hp = Math.min(st.hp, this.hp + Math.round(st.hp * num(this.diff.healAfterWin)));
      }
    }

    _offerRelics() {
      const pool = D.RELICS.filter((r) => !this.hasRelic(r.id));
      const out = [];
      while (out.length < D.PROGRESSION.offerCount && pool.length) {
        const i = this.rng.int(0, pool.length - 1);
        out.push(pool.splice(i, 1)[0]);
      }
      return out;
    }

    chooseRelic(id) {
      this.relics.push(id);
      this.pendingRelic = null;
      const r = this._relicById(id);
      if (r) this._log('获得秘藏：' + r.name, 'good');
      this.events.push({ kind: 'relic', id: id });
    }

    /* ============================================================
       装备操作
       ============================================================ */
    equipFromBag(bagIndex) {
      const it = this.bag[bagIndex];
      if (!it) return false;
      const old = this.equip[it.slot];
      this.equip[it.slot] = it;
      this.bag.splice(bagIndex, 1);
      if (old) this.bag.push(old);
      // 换装可能降低生命上限，必须夹一下
      const st = this.stats();
      if (this.hp > st.hp) this.hp = st.hp;
      this.events.push({ kind: 'equip', item: it });
      return true;
    }
    unequip(slot) {
      const it = this.equip[slot];
      if (!it) return false;
      if (this.bag.length >= this.bagCap()) return false;
      this.equip[slot] = null;
      this.bag.push(it);
      const st = this.stats();
      if (this.hp > st.hp) this.hp = st.hp;
      return true;
    }
    dropFromBag(bagIndex) {
      const it = this.bag[bagIndex];
      if (!it) return false;
      this.bag.splice(bagIndex, 1);
      return true;
    }

    /* ============================================================
       移动
       ============================================================ */
    _die(cause) {
      this.deaths++;
      if (this.lives > 1) {
        this.lives--;
        const st = this.stats();
        this.hp = Math.round(st.hp * 0.5);
        this.enemies = this.enemies.filter((e) => Math.abs(e.x - this.px) + Math.abs(e.y - this.py) > 4);
        this.events.push({ kind: 'revive' });
        this._log('潮水把你推了回来。（剩余机会 ' + this.lives + '）', 'warn');
        return;
      }
      this.status = 'dead';
      this.reason = cause || 'unknown';
      this.events.push({ kind: 'death' });
      this._log('你在第 ' + this.depth + ' 层倒下了。', 'bad');
    }

    /**
     * 单格移动 —— 这是最基础的移动方式，所有其它方式（长按连走、点击寻路）
     * 最终都拆成一步步的 step()，这样规则只有一份。
     * @returns {boolean} 是否消耗了回合
     */
    stepTo(x, y) {
      if (this.status !== 'playing' || this.pendingRelic) return false;
      if (!this.walkable(x, y)) return false;
      const e = this.enemyAt(x, y);
      if (e) { this.fight(e); if (this.status === 'playing') this._afterAction(); return true; }

      this.px = x; this.py = y;
      this.events.push({ kind: 'step', x: x, y: y });
      this._enterTile();
      if (this.status === 'playing') this._afterAction();
      return true;
    }

    _enterTile() {
      const t = this.tileAt(this.px, this.py);
      if (t === T.SHOP) {
        this.events.push({ kind: 'shop', open: true });
        return;
      }
      if (t === T.CHEST) {
        this.tiles[this.py * this.W + this.px] = T.FLOOR;
        this.events.push({ kind: 'chest', x: this.px, y: this.py });
        const it = this.makeItem({ depth: this.depth + 1, bonus: 1 });
        const gold = D.LOOT.goldChest + this.depth * D.LOOT.goldChestPerDepth;
        this.gold += gold;
        if (this.bag.length < this.bagCap()) {
          this.bag.push(it);
          this._log('宝箱：' + it.name + '（' + it.rarityName + '）+ ' + gold + ' 金币', 'loot');
          this.events.push({ kind: 'loot', item: it });
        } else {
          this._log('背包满了，只拿到 ' + gold + ' 金币。', 'warn');
        }
      } else if (t === T.STAIRS) {
        // 无尽模式没有"走出去"这一步：门后面永远是下一层
        if (this.depth >= this.diff.depth && !this.endless) {
          this.status = 'win';
          this._log('你走出了潮汐。', 'good');
          this.events.push({ kind: 'win' });
          return;
        }
        // 未击败本层守卫时，潮汐之门关闭
        if (this.bossAlive) {
          this._log('潮汐之门被封锁着 —— 先解决这层的守卫。', 'warn');
          return;
        }
        this.depth++;
        this._log('下潜到第 ' + this.depth + ' 层。', 'info');
        this.events.push({ kind: 'descend', depth: this.depth });
        this._buildLevel(this.depth);
      } else if (t === T.FOUNTAIN) {
        const st = this.stats();
        if (this.hp < st.hp) {
          const heal = Math.round(st.hp * 0.34);
          this.hp = Math.min(st.hp, this.hp + heal);
          this.events.push({ kind: 'heal', amount: heal });
          this._log('泉水：回复 ' + heal + ' 点生命。泉水枯了。', 'good');
        }
        // 泉水一次喝完就枯。之前做成可重复使用，结果是
        // 玩家（和模拟 AI）可以原地无限回血，血量这个稀缺资源直接失效。
        this.tiles[this.py * this.W + this.px] = T.FLOOR;
      }
    }

    /* ============================================================
       魂技（设计取自《元气骑士》：每个角色一个技能 + 冷却）

       规则只在这一个地方实现：HUD 按钮、快捷键 Q、模拟器 AI 全都调 useSkill()。
       把"能不能放"写进界面是踩过的坑 —— 模拟器的 AI 会绕过规则，
       于是平衡数据是假的。规则只有一个归属地。
       ============================================================ */
    skill() { return D.skillByClass(this.cls.key); }
    skillReady() {
      return this.status === 'playing' && !this.pendingRelic && this.skillCd <= 0;
    }

    /**
     * 释放魂技。
     * @returns {{ok:boolean, reason?:string, hits?:number, cd?:number, moves?:number}}
     *   reason: 'over' 局面结束 / 'pending' 正在选秘藏 / 'cd' 还在冷却 /
     *           'empty' 范围内没有目标 —— 这类失败**不消耗冷却**，
     *           否则玩家点空一次就被白罚十几回合。
     */
    useSkill() {
      const s = this.skill();
      if (this.status !== 'playing') return { ok: false, reason: 'over' };
      if (this.pendingRelic) return { ok: false, reason: 'pending' };
      if (this.skillCd > 0) return { ok: false, reason: 'cd', cd: this.skillCd };

      let hits = 0, healed = 0, pushed = 0, stunned = 0, wet = 0;
      // 命中目标的位置要一起送进事件：表演层据此画水束与地裂的落点，
      // 而不是自己去猜"刚才打了谁" —— 那等于把规则抄了第二遍
      const targets = [];
      if (s.kind === 'burst') {
        // 裂地斩：伤害 + 掀开一格；掀不动的撞在墙上，被震晕
        for (const e of this.enemies.slice()) {
          if (Math.abs(e.x - this.px) + Math.abs(e.y - this.py) > s.radius) continue;
          this._skillHit(e, s);
          targets.push({ x: e.x, y: e.y });      // 落点取击退**之前**的位置，水花才在被打的地方
          hits++;
          if (this.enemies.indexOf(e) < 0) continue;   // 已经死了就不用管状态
          if (this._knockback(e, s.knockback, s.stun)) stunned++;
          else pushed++;
        }
        if (!hits) return { ok: false, reason: 'empty' };
      } else if (s.kind === 'ray') {
        const me = this;
        const near = this.enemies
          .filter(function (e) { return me.isVisible(e.x, e.y); })
          .filter(function (e) { return Math.abs(e.x - me.px) + Math.abs(e.y - me.py) <= s.range; })
          .sort(function (a, b) {
            return (Math.abs(a.x - me.px) + Math.abs(a.y - me.py)) -
              (Math.abs(b.x - me.px) + Math.abs(b.y - me.py));
          })
          .slice(0, s.count);
        for (const e of near) {
          this._skillHit(e, s);
          targets.push({ x: e.x, y: e.y });
          hits++;
          // 潮湿要**在伤害之后**上：否则同一发放出去的水会吃到自己的加成，
          // 那这个状态的定位就从"给下一手做铺垫"变成"单纯加伤"
          if (this.enemies.indexOf(e) >= 0 && s.wet) {
            e.wet = Math.max(e.wet || 0, s.wet);
            e.wetBirth = this.turn;      // 同上：出生那一回合不倒计时
            wet++;
          }
        }
        if (!hits) return { ok: false, reason: 'empty' };
      } else if (s.kind === 'free') {
        // 疾影：额外行动 + 一个只持续本轮的爆发窗口
        this.freeMoves += s.moves;
        this._pushBuff({
          key: s.key, name: s.name, icon: s.icon, turns: 1,
          flags: { dmgOut: s.dmgOut }, hint: '本轮攻击 +' + Math.round(s.dmgOut * 100) + '%'
        });
      } else if (s.kind === 'buff') {
        const max = this.stats().hp;
        healed = Math.min(max, this.hp + Math.round(max * s.healPct)) - this.hp;
        this.hp += healed;
        this._pushBuff({
          key: s.key, name: s.name, icon: s.icon, turns: s.turns,
          mul: s.mul, flags: s.flags, hint: '双防 ×' + s.mul.defP
        });
      }

      this.skillCd = s.cd;
      this.skillUses = (this.skillUses || 0) + 1;   // 统计用：一局里放了几次魂技
      this.events.push({
        kind: 'skill', key: s.key, name: s.name, hits: hits, heal: healed,
        moves: (s.kind === 'free') ? s.moves : 0,
        pushed: pushed, stunned: stunned, wet: wet,
        targets: targets, tint: s.tint
      });
      this._log('【' + s.name + '】' + (s.kind === 'free'
        ? '额外行动 ' + s.moves + ' 次，本轮攻击 +' + Math.round(s.dmgOut * 100) + '%。'
        : (hits ? '命中 ' + hits + ' 个敌人。' : '') +
          (pushed ? '掀开 ' + pushed + ' 个，' : '') +
          (stunned ? '震晕 ' + stunned + ' 个，' : '') +
          (wet ? '让 ' + wet + ' 个湿透，' : '') +
          (healed > 0 ? '回复 ' + Math.round(healed) + ' 生命。' : '')), 'good');
      if (s.cost > 0) this._afterAction();
      return { ok: true, hits: hits, moves: (s.kind === 'free') ? s.moves : 0 };
    }

    /**
     * 把敌人沿"远离玩家"的方向推开。
     * @returns {boolean} true = 一步都推不动（撞墙 / 被别的怪顶着 / 撞到玩家）→ 改判为眩晕
     *
     * 为什么"推不动就晕"：如果只是推不动就什么都没发生，玩家在窄走廊里放裂地斩
     * 会觉得自己放了个寂寞。掀开和震晕是同一次冲击的两种结局，读起来才完整。
     */
    _knockback(e, dist, stunTurns) {
      const step = Math.max(1, dist || 1);
      // 只沿**主轴**推（四方向）。这个游戏的移动是四方向的（玩家用方向键、
      // 敌人用四方向寻路），斜推会把怪放到它自己根本走不进来的格子上，
      // 而且"掀开一格"会变成斜着跨两格曼哈顿距离 —— 画面和规则对不上。
      const ddx = e.x - this.px, ddy = e.y - this.py;
      const sx = Math.abs(ddx) >= Math.abs(ddy) ? Math.sign(ddx) : 0;
      const sy = sx === 0 ? Math.sign(ddy) : 0;
      const ox = e.x, oy = e.y;      // 起点要留好：尘土该从原位飞出去
      let cx = e.x, cy = e.y, moved = 0;
      for (let i = 0; i < step; i++) {
        const nx = cx + sx, ny = cy + sy;
        const blocked = (sx === 0 && sy === 0) || !this.walkable(nx, ny) ||
          this.enemyAt(nx, ny) || (nx === this.px && ny === this.py);
        if (blocked) break;
        cx = nx; cy = ny; moved++;
      }
      if (!moved) {
        if (stunTurns) {
          e.stun = Math.max(e.stun || 0, stunTurns);
          this.events.push({ kind: 'stun', enemy: e, turns: stunTurns });
        }
        return true;
      }
      e.x = cx; e.y = cy;
      this.events.push({ kind: 'knock', enemy: e, from: { x: ox, y: oy } });
      return false;
    }

    /** 加一个临时增益；已存在同 key 的只刷新回合与内容（反复放不会叠加两层） */
    _pushBuff(b) {
      let cur = null;
      for (const x of this.buffs) if (x.key === b.key) cur = x;
      // birth：这一回合里刚挂上的增益，不在这一回合结束时倒计时（见 endTurn）。
      b.birth = this.turn;
      if (cur) {
        cur.turns = Math.max(cur.turns, b.turns);
        cur.birth = this.turn;
        if (b.mul) cur.mul = b.mul;
        if (b.flags) cur.flags = b.flags;
        if (b.hint) cur.hint = b.hint;
        return cur;
      }
      this.buffs.push(b);
      return b;
    }

    /** 魂技的一次命中：走和普攻同一套伤害公式，但敌人不会反击 */    _skillHit(e, s) {
      const hit = this._skillDamage(e, s);
      e.hp -= hit.dmg;
      e.hitFlash = 12;
      this.events.push({
        kind: 'hit', enemy: e, dmg: hit.dmg, crit: false, skill: true,
        rounds: [{ from: this.cls.name, to: e.name, dmg: hit.dmg, type: hit.type, crit: false }]
      });
      if (e.hp <= 0) this._killEnemy(e, true);
      return hit.dmg;
    }

    /**
     * 玩家完成一次行动之后该做什么。
     * 单独抽出这一层的唯一理由是「免费行动」（疾影）：有免费次数时只扣次数，
     * 既不推进潮汐、也不让敌人动。这个判断如果散在各个动作里迟早会漏一处，
     * 所以所有"动作结束"都必须经过这里。
     */
    _afterAction() {
      if (this.freeMoves > 0) { this.freeMoves--; this._checkRegion(); return; }
      this.endTurn();
      this._checkRegion();
    }

    /* ============================================================
       回合推进：潮汐 + 敌人行动
       ============================================================ */
    endTurn() {
      this.turn++;
      // 冷却与临时增益按"回合"结算，放在最前面：它们在这一回合里已经生效过了
      if (this.skillCd > 0) this.skillCd--;
      // 「出生那一回合不倒计时」：潮语洪流的潮湿、不退之壁的双防，都是玩家
      // 这一手刚打出来的状态，而这一手本身已经消耗掉一个回合了。少了这条，
      // 面板写 3 回合的不退之壁实际只护 2 回合、写 2 回合的潮湿实际只留 1 回合
      // —— 玩家照文案做的规划会被系统白吃一手。
      // 冷却**不**适用这条：冷却是在"下一次想放"的那一刻结算的，原口径本来就对。
      const born = this.turn - 1;
      if (this.buffs.length) {
        const keep = [];
        for (const b of this.buffs) {
          if (b.birth === born) { keep.push(b); continue; }
          b.turns--; if (b.turns > 0) keep.push(b);
        }
        this.buffs = keep;
      }
      // 敌人身上的「潮湿」也按回合递减（和玩家的增益同一套语义）。
      // 注意「眩晕」**不能**在这里递减：那样它会在敌人行动之前就归零，
      // 等于白放。眩晕必须在敌人该行动的那一刻消费掉（见下面的敌人循环）。
      for (const e of this.enemies) if (e.wet > 0 && e.wetBirth !== born) e.wet--;
      this._tideTick();
      if (this.status !== 'playing') return;

      // 站在水里每回合腐蚀。水位越高越疼，但速率压得很低 ——
      // 踩水应该是"这次绕路亏了"，而不是"这次踩水就该死"。
      if (this.tileAt(this.px, this.py) === T.WATER) {
        const st = this.stats();
        const dmg = Math.max(1, Math.round(st.hp * (0.006 + this.tideLevel * 0.005)));
        this.hp -= dmg;
        this.events.push({ kind: 'corrode', dmg: dmg });
        if (this.hp <= 0) { this._die('潮水'); return; }
      }

      // 敌人行动
      const list = this.enemies.slice();
      for (const e of list) {
        if (this.status !== 'playing') break;
        if (this.enemies.indexOf(e) < 0) continue;
        // 被裂地斩震晕：这一轮什么都不做。眩晕在**这一刻**消费掉，
        // 放在回合开始处递减的话会在敌人行动前就归零，等于白放。
        if (e.stun > 0) {
          e.stun--;
          this.events.push({ kind: 'stunned', enemy: e });
          continue;
        }
        // 区域门禁：玩家不在这一区 → 这只怪待机（不动、不打、也不孵化）。
        // 放在眩晕之后、行动之前：被震晕的仍然算"跳过"，两种"不行动"的语义要分开。
        if (e.region !== undefined && e.region >= 0 &&
            this.regionAt(this.px, this.py) !== e.region) {
          continue;
        }
        const dist = Math.abs(e.x - this.px) + Math.abs(e.y - this.py);
        if (dist <= 1) {
          this.enemyHit(e);
        } else {
          // 每 2 回合逼近一步：所有怪每回合都动会让"绕开"变成不可能
          e.cd++;
          if (e.cd % 2 === 0 || e.kind === 'elite' || e.kind === 'boss') {
            const path = this.findPath(e.x, e.y, this.px, this.py, 260, 0, e.region);
            if (path && path.length > 1) {
              const n = path[1];
              if (!this.enemyAt(n.x, n.y) && (n.x !== this.px || n.y !== this.py)) {
                e.x = n.x; e.y = n.y;
              }
            }
          }
        }
        // 孢子母：孵化
        if (e.arc.spawn) {
          e.cd = (e.cd || 0);
          if (this.turn % e.arc.spawn.every === 0) {
            const spots = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (const s of spots) {
              const nx = e.x + s[0], ny = e.y + s[1];
              if (this.walkable(nx, ny) && !this.enemyAt(nx, ny) && !(nx === this.px && ny === this.py)) {
                const c = this._makeEnemy(nx, ny, this.depth);
                c.name = '幼体';
                c.kind = 'normal';
                const mini = D.enemyById('slime');
                c.arc = mini; c.stats = this._scaleEnemyStats(mini, Math.max(1, this.depth - 1));
                c.hp = c.maxHp = c.stats.hp;
                this.enemies.push(c);
                this.events.push({ kind: 'spawn', enemy: c });
                break;
              }
            }
          }
        }
      }
      this._recomputeFOV();
    }

    /**
     * 潮汐节律。
     *
     * 第一版是"水位只涨不跌 + 水位到顶后不断长出新水域"，跑模拟直接崩了：
     * 60 局里 27 局死于潮水、还有 15 局因为全图被淹而卡死。
     * 问题不在难度，在于**没有节奏**：只涨不跌的水位会变成单向的死亡时钟，
     * 玩家既没有喘息窗口，也没有"趁退潮去探险"的决策。
     *
     * 改成周期性的涨落（一个完整潮汐 = 7 个节拍 = 84 回合）：
     *   0 → 1 → 2 → 3 → 3 → 2 → 1 → 0 …
     * 涨潮时通路变窄、踩水掉血，逼你往前走；
     * 退潮时水面退回基准，给你时间绕路、开宝箱、找泉水。
     * 压力来自"窗口在关闭"，而不是"血条在漏"。
     */
    _tideTick() {
      if (this.turn % this.diff.tideEvery !== 0) return;
      const pattern = [0, 1, 2, 3, 3, 2, 1];
      this.tidePhase = (this.tidePhase || 0) + 1;
      const prev = this.tideLevel;
      this.tideLevel = pattern[this.tidePhase % pattern.length];
      if (this.tideLevel === prev) return;
      this._applyTide();
      this.events.push({ kind: 'tide', level: this.tideLevel, rising: this.tideLevel > prev });
      if (this.tideLevel > prev) this._log('涨潮（水位 ' + this.tideLevel + '）。', 'warn');
      else if (this.tideLevel < prev) this._log('退潮（水位 ' + this.tideLevel + '）。', 'info');
    }

    /**
     * 潮汐结算。
     * 水面 = 「从水源出发、步数 ≤ 当前水位」的所有基准地板/苔草格。
     * 每次重算都从基准地形出发，所以退潮能真正退回去。
     */
    _applyTide() {
      const W = this.W, H = this.H;
      const dist = new Int16Array(W * H).fill(-1);
      const q = [];
      for (const s of this.tideSeeds) {
        const i = s.y * W + s.x;
        if (this.base[i] !== T.WATER) continue;      // 水源必须仍在基准里
        dist[i] = 0; q.push(i);
      }
      let head = 0;
      while (head < q.length) {
        const i = q[head++];
        const d = dist[i];
        if (d >= this.tideLevel) continue;
        const x = i % W, y = (i / W) | 0;
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const n of nb) {
          const nx = x + n[0], ny = y + n[1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (dist[j] >= 0) continue;
          const t = this.base[j];
          // 只淹地板和苔草：墙和岩浆不该被水盖住
          if (t !== T.FLOOR && t !== T.MOSS) continue;
          dist[j] = d + 1;
          q.push(j);
        }
      }
      for (let i = 0; i < W * H; i++) {
        const b = this.base[i];
        if (b === T.WATER) { this.tiles[i] = T.WATER; continue; }
        if (b !== T.FLOOR && b !== T.MOSS) continue;   // 门/宝箱/泉水/楼梯保持原样
        this.tiles[i] = (dist[i] > 0) ? T.WATER : b;
      }
    }

    /* 说明：早期版本这里还有一个 _spreadWater()，让水位到顶后不断长出新的水域。
       实测那是毒药 —— 它把潮汐从"有节奏的压力"变成"单向的死亡时钟"，
       模拟里 60 局有 15 局因为全图被淹而卡死。已删除，改为周期性涨落。 */

    /* ============================================================
       日志
       ============================================================ */
    _log(text, kind) {
      this.logs.push({ text: text, kind: kind || 'info', turn: this.turn });
      if (this.logs.length > 60) this.logs.shift();
    }
    drainEvents() { const e = this.events; this.events = []; return e; }

    /* ============================================================
       无头模拟：给平衡验证用。
       用一个贪心 AI 近似"会玩的玩家"：
         血少就找泉水 → 否则找最近的敌人打 → 清场后去潮汐之门
       验收标准是通关率，不是"感觉差不多"。
       ============================================================ */
    static simulate(n, opts) {
      opts = opts || {};
      const out = {
        n: n, wins: 0, deaths: 0, turns: 0, kills: 0, depth: 0,
        byDepth: {}, relicPick: {}, fightRounds: 0, lootCount: 0,
        rarity: {}, deathCause: {}, avgRelics: 0, itemPower: 0
      };
      for (let i = 0; i < n; i++) {
        const seed = (opts.seedBase || 1) + i * 7919;
        const g = new Game({
          classKey: opts.classKey || pickClass(i),
          difficulty: opts.difficulty || 'standard',
          seed: seed
        });
        const r = g.playHeadless(opts.maxTurns || 1400);
        out.turns += g.turn; out.kills += g.kills;
        out.byDepth[g.depth] = (out.byDepth[g.depth] || 0) + 1;
        out.avgRelics += g.relics.length;
        for (const it of g.bag) out.rarity[it.rarity] = (out.rarity[it.rarity] || 0) + 1;
        for (const s in g.equip) {
          const it = g.equip[s];
          if (it) out.rarity[it.rarity] = (out.rarity[it.rarity] || 0) + 1;
        }
        if (r === 'win') out.wins++;
        else {
          out.deaths++;
          out.deathCause[g.reason || r] = (out.deathCause[g.reason || r] || 0) + 1;
        }
        out.outcome = out.outcome || {};
        out.outcome[r] = (out.outcome[r] || 0) + 1;
        if (r === 'stall' || r === 'timeout') {
          out.stalls = out.stalls || [];
          if (out.stalls.length < 4) out.stalls.push(g.stallInfo);
        }
        for (const id of g.relics) out.relicPick[id] = (out.relicPick[id] || 0) + 1;
      }
      out.turns = Math.round(out.turns / n * 10) / 10;
      out.kills = Math.round(out.kills / n * 10) / 10;
      out.avgRelics = Math.round(out.avgRelics / n * 10) / 10;
      out.winRate = Math.round(out.wins / n * 1000) / 10;
      out.avgRarity = out.rarity;
      return out;
    }

    /**
     * 贪心 AI 走一整局。
     * 返回值区分三件事，因为它们的含义完全不同：
     *   'dead' —— 打不过，需要调平衡
     *   'stall' —— AI 找不到可做的事（通常是路径被堵或逻辑死锁），是 bug
     *   'timeout' —— 回合数用光，说明节奏太慢
     * 混成一个"没通关"就分不清该调数值还是该修 bug。
     */
    playHeadless(maxTurns) {
      const limit = maxTurns || 1200;
      let stall = 0;
      const trace = [];
      while (this.status === 'playing' && this.turn < limit && stall < 40) {
        if (this.pendingRelic) { this._autoRelic(); continue; }
        const before = this.turn;
        this._autoEquip();
        this._autoFuse();                      // 融合：同样的道理，AI 不会用就等于没做
        this._autoShop();
        this._autoSkill();                     // 魂技：该放才放，用不上就留着
        const acted = this._autoStep();
        trace.push(this.depth + ':' + this.px + ',' + this.py + (acted ? '' : '#'));
        if (trace.length > 90) trace.shift();
        if (!acted) { stall++; continue; }
        // "行动了但回合没推进"过去一律算卡死。现在疾影会合法地给出几次免费行动，
        // 所以只在没有免费次数时才这么判 —— 否则新机制一上线，
        // 模拟器就会把正常的技能使用误报成死锁。
        if (this.turn === before && this.freeMoves <= 0) stall++; else stall = 0;
      }
      this.trace = trace;
      if (this.status === 'win') return 'win';
      if (this.status === 'dead') return 'dead';
      {
        // 卡死 / 超时都要留现场快照，否则只能靠猜
        const st = this.stats();
        const meX = this.px, meY = this.py;
        let nd = -1;
        for (const e of this.enemies) {
          const d = Math.abs(e.x - meX) + Math.abs(e.y - meY);
          if (nd < 0 || d < nd) nd = d;
        }
        this.stallInfo = {
          outcome: (stall >= 40) ? 'stall' : 'timeout',
          depth: this.depth, hp: Math.round(this.hp), hpPct: Math.round(this.hp / st.hp * 100),
          atkP: st.atkP, atkM: st.atkM, defP: st.defP, defM: st.defM,
          enemies: this.enemies.length, bossAlive: !!this.bossAlive,
          pos: meX + ',' + meY, exit: this.exit.x + ',' + this.exit.y,
          exitTile: this.tileAt(this.exit.x, this.exit.y),
          pathToExit: !!this.findPath(meX, meY, this.exit.x, this.exit.y, 1200),
          nearestEnemyDist: nd, kills: this.kills,
          standingOn: this.tileAt(meX, meY),
          trace: (this.trace || []).join(' ')
        };
      }
      return (stall >= 40) ? 'stall' : 'timeout';
    }

    _autoRelic() {
      // 优先拿机制型（有 flags 的），否则拿数值最高的
      let best = null, bestScore = -1e9;
      for (const r of this.pendingRelic) {
        let sc = 0;
        if (r.flags) sc += 60;
        if (r.mods) for (const k in r.mods) {
          const v = r.mods[k];
          sc += (k === 'hp' ? v * 0.35 : v * (k === 'spd' ? 1.4 : 1.0));
        }
        if (sc > bestScore) { bestScore = sc; best = r; }
      }
      if (best) this.chooseRelic(best.id);
      else this.pendingRelic = null;
    }

    /* ============================================================
       魂技的 AI 用法
       关键不是"能用就放"，而是"什么时候值得放"。技能是有冷却的有限资源，
       乱放会让模拟出来的通关率偏低（真到关键时刻技能永远在冷却里）。
       所以每个技能都有自己的触发条件，写在下面。
       ============================================================ */
    _autoSkill() {
      const s = this.skill();
      if (!this.skillReady()) return false;
      const me = this;
      const dist = function (e) { return Math.abs(e.x - me.px) + Math.abs(e.y - me.py); };
      const st = this.stats();
      const lowHp = this.hp / st.hp < 0.55;

      if (s.kind === 'burst') {
        // 身边两个以上就赚；只有一个时，只在"这一下能收掉它"时才放
        const adj = this.enemies.filter(function (e) { return dist(e) === 1; });
        const killOne = adj.length === 1 && this._skillWouldKill(adj[0], s);
        if (adj.length >= 2 || killOne) return this.useSkill().ok;
      } else if (s.kind === 'ray') {
        const inRange = this.enemies.filter(function (e) {
          return me.isVisible(e.x, e.y) && dist(e) <= s.range;
        });
        let killable = 0;
        for (const e of inRange) if (this._skillWouldKill(e, s)) killable++;
        if (inRange.length >= 2 || killable >= 1) return this.useSkill().ok;
      } else if (s.kind === 'free') {
        // 追得上人（或要跑）才值得，否则留着当应急
        const near = this.enemies.some(function (e) { return dist(e) <= 6; });
        if (near) return this.useSkill().ok;
      } else if (s.kind === 'buff') {
        const near = this.enemies.some(function (e) { return dist(e) <= 2; });
        if (lowHp && near) return this.useSkill().ok;
      }
      return false;
    }

    /** 魂技对某个敌人的实际伤害（和 _skillHit 共用，避免两处公式漂移） */
    _skillDamage(e, s) {
      const atk = bestAttack(this.stats(), e.stats, this.K);
      return { dmg: Math.max(1, Math.round(atk.base * s.dmgPct)), type: atk.type };
    }
    _skillWouldKill(e, s) { return this._skillDamage(e, s).dmg >= e.hp; }

    /**
     * 融合的 AI 用法：在背包里找一对同品质的、付得起的，合掉。
     * 留一个金币储备 —— 商栈的潮汐圣水在关键时刻是保命的，
     * 把最后一分钱都砸进融合会显著拉低通关率（这正是模拟器该发现的事）。
     * 从最低品质开始找：升掉最没用的那两件，收益最大。
     */
    _autoFuse() {
      if (this.bag.length < 2) return false;
      for (let ri = 0; ri + 1 < D.RARITIES.length; ri++) {
        const key = D.RARITIES[ri].key;
        let first = -1;
        for (let i = 0; i < this.bag.length; i++) {
          if (this.bag[i].rarity !== key) continue;
          if (first < 0) { first = i; continue; }
          const cost = this.fuseCost(this.bag[first], this.bag[i]);
          if (cost < 0) continue;
          if (this.gold < cost + 80) return false;   // 留着买补给
          return this.fuseItems(first, i).ok;
        }
      }
      return false;
    }

    /** 装备评分：AI 用它决定"要不要换"和"要不要买" */
    /**
     * 战力：把一件装备折算成一个可比较的数。
     * **全项目唯一的装备强度口径** —— 界面上的「战力」、自动装备的判定、
     * 模拟器 AI 的取舍，全都走这一个函数。
     */
    power(item) {
      if (!item) return -1;
      const W = D.POWER_W;
      let sc = 0;
      for (const k in item.total) sc += num(item.total[k]) * (W[k] === undefined ? 1 : W[k]);
      let fl = 0;
      for (const k in item.flags) fl++;
      return Math.round(sc + fl * W.flag);
    }

    /**
     * 能不能用这一件替换掉当前那件？ —— **自动装备唯一的判定入口**。
     *
     * 口径（和玩家约定死的）：**品质优先，但绝不静默降级。**
     *   ① 槽位为空                      → 穿
     *   ② 品质更高 且 战力不低            → 换
     *   ③ 品质相当或更低，但战力 ≥ +10%   → 换（好词条的低品质件也有机会）
     *   ④ 其余                          → 不换，**并且必须给出理由**
     *
     * ④ 是这条规则的重点：玩家点了「自动装备」却什么都没发生，
     * 界面上不给理由的话，他只会认为这个功能坏了。
     * 所以失败分支也把 oldPower / newPower 带回去，界面直接把数字念给他听。
     */
    canUpgrade(item, slot) {
      const miss = { ok: false, reason: 'missing', oldPower: -1, newPower: -1, oldRarity: null, newRarity: null };
      if (!item) return miss;
      const cur = this.equip[slot || item.slot];
      const np = this.power(item);
      if (!cur) {
        return { ok: true, reason: 'empty', oldPower: -1, newPower: np, oldRarity: null, newRarity: item.rarity };
      }
      const op = this.power(cur);
      const nr = D.rarRank(item.rarity), or = D.rarRank(cur.rarity);
      const out = { ok: false, reason: 'weaker', oldPower: op, newPower: np, oldRarity: cur.rarity, newRarity: item.rarity };
      if (nr > or && np >= op) { out.ok = true; out.reason = 'better'; return out; }
      if (np >= op * 1.10) { out.ok = true; out.reason = nr > or ? 'better' : 'power'; return out; }
      out.reason = nr < or ? 'rarity-lower' : 'weaker';
      return out;
    }

    /**
     * 自动装备背包里的第 bagIndex 件。
     * 界面（双击 / Shift+右键）和模拟器 AI **共用这一个入口** ——
     * 这样模拟器测出来的行为就是玩家会遇到的行为。
     */
    autoEquip(bagIndex) {
      const it = this.bag[bagIndex];
      if (!it) return { ok: false, reason: 'missing', oldPower: -1, newPower: -1, oldRarity: null, newRarity: null };
      const v = this.canUpgrade(it, it.slot);
      if (!v.ok) return v;
      this.equipFromBag(bagIndex);
      return v;
    }

    /** 贪心 AI 的消费行为：背包快满就清货，看到升级就买，血少就买圣水 */
    _autoShop() {
      if (this.bag.length >= this.bagCap() - 4) this.sellJunk();
      for (let i = this.shopStock.length - 1; i >= 0; i--) {
        const s = this.shopStock[i];
        if (s.type === 'heal') {
          const st = this.stats();
          if (this.hp / st.hp < 0.6 && this.gold >= s.price) this.buyItem(i);
          continue;
        }
        if (this.gold < s.price) continue;
        if (this.canUpgrade(s.item, s.item.slot).ok) this.buyItem(i);
      }
    }

    _autoEquip() {
      // 走**和界面完全同一个入口**。
      // 旧版本这里自带一套 score，权重还和买装备用的那套不一样 ——
      // 于是出现过"买下来了却不肯穿"这种只有对比两处代码才看得出来的毛病。
      for (let i = this.bag.length - 1; i >= 0; i--) this.autoEquip(i);
    }

    /**
     * 一步决策：返回 true 表示这一轮确实消耗了回合。
     *
     * 关键设计是「目标承诺」：一旦选定目标就锁定，直到
     *   到达 / 目标失效（宝箱被开、敌人死了）/ 出现更高优先级的事（残血）
     * 才会重新评估。
     *
     * 为什么非要这样：早先每回合都从头挑一次目标，结果撞上了经典的
     * 阈值抖动 —— 站在 A 格时宝箱距离 9（在范围内）→ 朝宝箱走一格到 B；
     * 站在 B 格时距离 10（超出范围）→ 转回出口，又走回 A。
     * 两个格子之间无限横跳，120 局里 8% 的对局因此跑满回合上限。
     * 轨迹记录下来一眼就能看出来：「15,15 → 14,15 → 15,15 → 14,15 …」
     */
    _autoStep() {
      const st = this.stats();
      const hpPct = this.hp / st.hp;
      let g = this.aiGoal;

      // —— 目标失效检查 ——
      if (g) {
        const dead = (g.type === 'chest' && this.tileAt(g.x, g.y) !== T.CHEST) ||
          (g.type === 'fountain' && this.tileAt(g.x, g.y) !== T.FOUNTAIN) ||
          (g.type === 'enemy' && this.enemies.indexOf(g.ref) < 0) ||
          // 只有泉水会在满血时失去意义。
          // 这条判断第一版写成了"对所有非敌人目标生效"，结果满血时
          // 宝箱目标每轮都被判定失效、每轮重新选最近的那个，
          // 而"最近"会随位置改变 —— 又是两格横跳。
          (g.type === 'fountain' && hpPct > 0.78);
        if (dead) { this.aiGoal = null; g = null; }
      }

      // —— 选目标（只有没有目标时才选）——
      if (!g) {
        if (hpPct < 0.45) {
          const f = this._findTile(T.FOUNTAIN, 'fountain');
          if (f) g = { type: 'fountain', x: f.x, y: f.y };
        }
        // 钱攒到一定程度就去找商栈消费 ——
        // 不然金币在模型里只是一个数字，AI 永远不会花，也就验证不出经济是否成立
        if (!g && this.gold >= 140 && !this.aiBad['shopper']) {
          const sp = this._nearestTile(T.SHOP, 'shop');
          if (sp && sp.d <= 30) g = { type: 'shop', x: sp.x, y: sp.y };
        }
        if (!g && hpPct > 0.55) {
          const c = this._nearestTile(T.CHEST, 'chest');
          if (c && c.d <= 12) g = { type: 'chest', x: c.x, y: c.y };
        }
        if (!g) {
          const t = this._pickTarget();
          if (t) g = { type: 'enemy', ref: t, x: t.x, y: t.y };
        }
        if (!g) g = { type: 'exit', x: this.exit.x, y: this.exit.y };
        this.aiGoal = g;
      }

      // —— 执行 ——
      if (g.type === 'enemy') {
        const e = g.ref;
        if (this.enemies.indexOf(e) < 0) { this.aiGoal = null; return false; }
        if (Math.abs(e.x - this.px) + Math.abs(e.y - this.py) === 1) {
          this.fight(e);
          if (this.status === 'playing') this._afterAction();
          this.aiGoal = null;
          return true;
        }
        if (this._walkToward(e.x, e.y)) return true;
      } else {
        if (g.x === this.px && g.y === this.py) {
          // 已经站到目标格上：如果是商栈就消费一轮，然后这一层不再专程跑商栈
          if (g.type === 'shop') {
            this._autoShop();
            this.aiBad['shopper'] = 1;
          }
          this.aiGoal = null;
          return false;
        }
        if (this._walkToward(g.x, g.y)) return true;
      }
      // 走不到这个目标 → 记进黑名单，这一层不再尝试它。
      // 只清空 aiGoal 是不够的：下一轮重新挑选时会再次选中同一个
      // "最近但在孤立区域里"的目标，于是无限重试。
      this._badGoal(g);
      this.aiGoal = null;

      // —— 兜底：被堵住了就先把贴脸的敌人解决掉 ——
      // 少了这一段，AI 会站在一个"太亏不想打"的敌人旁边、
      // 同时又走不出去，双方互相罚站到天荒地老。
      for (const e of this.enemies) {
        if (Math.abs(e.x - this.px) + Math.abs(e.y - this.py) === 1) {
          this.fight(e);
          if (this.status === 'playing') this._afterAction();
          this.aiGoal = null;
          return true;
        }
      }
      return false;
    }

    /**
     * 「走不到」黑名单的键。
     * 必须和 _nearestTile / _findTile 里查询用的键完全一致 ——
     * 之前这里的三元表达式漏了 shop 分支，商店失败被记成了泉水，
     * 于是同一个走不到的商栈被无限重试，重新引出两格横跳的死循环。
     */
    _badKey(kind, x, y) { return kind + ':' + x + ',' + y; }
    _badGoal(goal) {
      if (!this.aiBad) return;
      if (goal.type === 'enemy') this.aiBad['e' + goal.ref.id] = 1;
      else if (goal.type === 'exit') this.aiBad['exit'] = 1;
      else this.aiBad[this._badKey(goal.type, goal.x, goal.y)] = 1;
    }

    _findTile(t, kind) {
      kind = kind || 'tile';
      for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) {
        if (this.tileAt(x, y) !== t) continue;
        if (this.aiBad && this.aiBad[this._badKey(kind, x, y)]) continue;
        return { x: x, y: y };
      }
      return null;
    }
    _nearestTile(t, kind) {
      kind = kind || 'tile';
      let best = null;
      for (let y = 0; y < this.H; y++) for (let x = 0; x < this.W; x++) {
        if (this.tileAt(x, y) !== t) continue;
        if (this.aiBad && this.aiBad[this._badKey(kind, x, y)]) continue;
        const d = Math.abs(x - this.px) + Math.abs(y - this.py);
        if (!best || d < best.d) best = { x: x, y: y, d: d };
      }
      return best;
    }

    /**
     * 简易战力评估：预测这一场要掉多少血，太亏就先不打
     */
    _pickTarget() {
      const st = this.stats();
      let best = null, bestScore = -1e9;
      for (const e of this.enemies) {
        // 之前判定过"走不到"的敌人不再重复尝试 ——
        // 否则每一轮都会重新锁定它、重新失败，直到判定为卡死
        if (this.aiBad && this.aiBad['e' + e.id]) continue;
        const d = Math.abs(e.x - this.px) + Math.abs(e.y - this.py);
        const myAtk = bestAttack(st, e.stats, this.K);
        const eAtk = bestAttack(e.stats, st, this.K);
        const myRounds = myAtk.base > 0 ? e.hp / myAtk.base : 99;
        const eRounds = eAtk.base > 0 ? st.hp / eAtk.base : 99;
        const cost = Math.min(eRounds, myRounds) * eAtk.base;
        let sc = -cost * 1.1 - d * 0.8 + (e.kind === 'treasure' ? 26 : 0) + (e.isBoss ? 10 : 0);
        if (cost / st.hp > 0.45) sc -= 90;                 // 太亏，先绕开
        if (this.hp / st.hp < 0.5 && cost / st.hp > 0.2) sc -= 60;
        if (sc > bestScore) { bestScore = sc; best = e; }
      }
      return best;
    }

    _walkToward(tx, ty) {
      // 上限给足。水面的额外代价会让 A* 的搜索节点数显著膨胀，
      // 45×35 的地图 + 涨潮，900 个节点根本搜不到远端目标，
      // 于是"可达"被误判成"走不到"，AI 就开始原地罚站。
      const path = this.findPath(this.px, this.py, tx, ty, 4000);
      if (!path || path.length < 2) return false;
      const n = path[1];
      return this.stepTo(n.x, n.y);
    }
  }

  function pickClass(i) {
    const order = ['warlord', 'arcanist', 'ranger', 'warden'];
    return order[i % order.length];
  }

  global.TideCore = {
    Game: Game, RNG: RNG, mulberry32: mulberry32,
    T: T, DECO: DECO, DECO_NAMES: DECO_NAMES,
    rawDamage: rawDamage, bestAttack: bestAttack, num: num,
    WALKABLE: WALKABLE, OPAQUE: OPAQUE
  };
})(typeof window !== 'undefined' ? window : globalThis);
