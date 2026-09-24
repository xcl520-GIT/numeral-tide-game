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

  /**
   * 按**指定类型**算一次攻击，不做择优。
   *
   * 这是"出题不给答案"里的那一半：引擎只在玩家选定之后负责把账算准。
   * 和 bestAttack 并列存在、共用同一个 rawDamage —— 伤害公式永远只有一份，
   * 不会出现"择优时算一套、结算时算另一套"的漂移。
   *
   * 注意它**不碰真实伤害**（type 't'）：真实伤害的定义就是"不走这条公式"，
   * 它由调用方直接扣血。这里只处理需要在物理/法术之间做选择的那部分。
   */
  function attackVia(st, dv, type, K) {
    if (type === 'm') return { base: rawDamage(st.atkM, st.penM, dv.defM, K), type: 'm' };
    return { base: rawDamage(st.atkP, st.penP, dv.defP, K), type: 'p' };
  }

  /* ============================================================
     敌人标签 —— 从 stats 推导，绝不手写

     这不是新设定，是把本来就在数据里、却没人看得见的事实命名出来：
     data.js 的 ENEMIES[brute].note 写着「物防极高、法防为零 —— 该换法术打」，
     那句话一直躺在源码里，玩家永远读不到。

     为什么抗性必须按**比例**判定、而不是设绝对阈值：
     _scaleEnemyStats() 给 defP / defM 乘的是同一个系数，
     所以两者的比例关系不随深度变化，而绝对值会整体膨胀。
     若用绝对阈值，第 3 层之后所有敌人都被标成"高物抗"，标签当场开始撒谎。
     ============================================================ */
  function tagsOf(st, arc) {
    const t = [];
    const p = num(st.defP), m = num(st.defM);
    if (p > 0 && m > 0) {
      if (p >= m * 1.8) t.push(D.TAGS.P);
      else if (m >= p * 1.8) t.push(D.TAGS.M);
    } else if (p > 0) t.push(D.TAGS.P);
    else if (m > 0) t.push(D.TAGS.M);
    // 「法术」：只会用法术打人 —— 它决定反击时走哪一路
    if (num(st.atkM) > 0 && num(st.atkP) <= 0) t.push(D.TAGS.SPELL);
    if (num(st.leech) > 0) t.push(D.TAGS.LEECH);
    if (arc) {
      if (arc.spawn) t.push(D.TAGS.SUMMON);        // 行为型：只能从模板读，它不是数值
      if (arc.kind === 'elite') t.push(D.TAGS.ELITE);
      if (arc.kind === 'boss') t.push(D.TAGS.BOSS);
    }
    return t;
  }

  /* ============================================================
     敌人姿态 —— 防御的零和重分配
     ============================================================ */

  /**
   * 这只怪配不配拥有姿态。
   * 三条边界，每条都有理由：
   *   ① 双侧防御都 >= minDef —— 某侧是 0 的话，"x0.5 硬化对侧"毫无意义
   *      （0 乘任何数还是 0），姿态会变成纯装饰。
   *   ② 排除宝箱怪 —— 它是奖励型遭遇，不是用来教抗性的。
   *   ③ 排除已经有固定抗性标签的敌人 —— 让"读标签"和"读姿态"各管一半敌人，
   *      否则同一只怪身上两条线索互相削弱，玩家会两条都不信。
   */
  function canStance(st, arc) {
    const S = D.STANCE;
    if (!S) return false;
    if (arc && arc.kind === 'treasure') return false;
    if (num(st.defP) < S.minDef || num(st.defM) < S.minDef) return false;
    const t = tagsOf(st, arc);
    if (t.indexOf(D.TAGS.P) >= 0 || t.indexOf(D.TAGS.M) >= 0) return false;
    return true;
  }

  function stanceFlip(s) { return s === 'p' ? 'm' : 'p'; }

  /**
   * 按姿态调整后的**防御视图**。
   * 关键：返回新对象，**绝不修改 st 本身**。
   * 直接改 st.defP 再改回来是这里最容易犯的错 —— 中途任何 return/异常
   * 都会让防御永久留在错误值上，而且这种 bug 在模拟里只表现为
   * "通关率莫名偏低"，几乎不可能定位。
   */
  function stanceDef(st, stance) {
    const S = D.STANCE;
    if (!stance || !S) return st;
    const isP = (stance === 'p');
    return {
      defP: num(st.defP) * (isP ? S.hard : S.soft),
      defM: num(st.defM) * (isP ? S.soft : S.hard)
    };
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
      // AI 的"算错率"。只影响模拟器 —— 真人玩家的失误率由真人决定。
      // 做成构造参数而不是常量，是因为平衡结论应该是"通关率 vs 失误率"的曲线，
      // 而不是一个假装所有玩家水平相同的数字。
      this.aiFumble = num(opts.aiFumble);
      // 克制奖励倍率。允许覆盖，是为了把它的影响从别的改动里单独拆出来量。
      this.counterBonus = (opts.counterBonus === undefined)
        ? D.COMBAT.counterBonus : num(opts.counterBonus);
      // 战斗内的姿态轮换（v11.3-b）。默认开。
      // 关掉它得到的是一个**干净对照组**：姿态不翻面时，逐轮重算与
      // 开战前算一次结果完全相同，随机流也完全相同 ——
      // 于是"通关率变了多少"可以百分之百归因到这一件事上，
      // 而不是"改了 AI 策略 + 改了结算"两件事混在一起。
      this.aiStance = (opts.aiStance === undefined) ? true : !!opts.aiStance;
      // 群战：踩上敌人格时，把主角**正交相邻**（上下左右）的敌人一并拉进这场
      // 对决，最多 4 个。关掉它 = 回到 v11.3 的一对一。
      // 这与 aiStance 是同一类开关：重标基线时，"通关率变了多少"必须能被拆成
      // "群战造成的"和"数值改造成的"两份，否则改完什么都归因不了。
      // 同理**必须在这里声明**，不能等第一场战斗再挂上去（隐藏类迁移的教训）。
      this.squad = (opts.squad === undefined) ? true : !!opts.squad;
      // 槽位指派（v11.4-h）：玩家身旁的那几格**由外层分配**给不同的怪，
      // 而不是让每只怪各自寻路到玩家。关掉它就是"各自寻路"的对照组 ——
      // 这是本轮要证明的那件事，对照组必须真实存在。
      this.slots = (opts.slots === undefined) ? true : !!opts.slots;
      // 战斗中的世界时钟（v11.4-h）：一场仗的每一**轮**推进一次敌人的行动时钟，
      // 而不是整场只推进一次。关掉它 = 回到"战斗期间地图冻结"（对照组）。
      this.tick = (opts.tick === undefined) ? true : !!opts.tick;
      // 被惊动的房间每回合都挪（v11.4-h）。
      // 这一步必须放在**分格之后** —— 外部参考里的顺序是"先分格，再加速"，
      // 而 v11.4-g 的实测正是这条的反证：目标格没分掉时，加速只是
      // 让它们更快地排进同一条队，四邻 1.04 → 1.05，纹丝不动。
      // 区域门禁已经保证了"此刻玩家就在这个房间里"，所以这里不需要额外的惊动标记。
      this.alert = (opts.alert === undefined) ? true : !!opts.alert;

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
      // 逐回合模式里"正在进行的那场对决"。
      // **必须在这里声明**，不能等到第一场战斗再 this.liveFight = ... ——
      // 给一个已经定型的对象新增字段会让它发生隐藏类迁移，而 Game 实例
      // 在 playHeadless 的每一轮循环里都被访问，指向旧 map 的内联缓存
      // 会全部失效。实测代价：整局慢 3 倍（741ms → 2149ms，n=20），
      // 而战斗只占整局的 1.5% —— 症状出现在离改动最远的地方。
      this.liveFight = null;
      this.devourStacks = 0;
      this.skillCd = 0;          // 魂技冷却剩余回合
      this.skillUses = 0;        // 一局里放过几次魂技（平衡分析用）
      this.freeMoves = 0;        // 免费行动次数（疾影）—— 不推进潮汐，敌人也不动
      this.buffs = [];           // 临时增益（魂技），随回合递减
      // 默认出手类型 = 这个职业**基础双攻更高**的那一路。
      // 为什么要给默认值、而不是让玩家一开局就必须先选：
      // 一个秘仪（atkM 46 / atkP 12）若默认按物理出手，会在学会切换之前
      // 先怀疑"这游戏是不是坏了"。
      // 关键边界：这个默认值**完全不看敌人** —— 它只是"你惯用哪一路"，
      // 不替玩家做任何一道题。一旦它开始参考敌防，整套设计就塌了。
      this.atkType = (num(this.cls.stats.atkP) >= num(this.cls.stats.atkM)) ? 'p' : 'm';

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
    level() {
      // 等级封顶，见 PROGRESSION.maxLevel 那段注释。
      // 在这里夹而不是在别处：level() 是等级的唯一读法 —— 面板、HUD、
      // 升级提示全都走它，夹一处就等于全都夹住了。
      const raw = 1 + Math.floor(this.kills / D.PROGRESSION.levelEvery);
      const cap = D.PROGRESSION.maxLevel || raw;
      return Math.min(cap, raw);
    }

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
      // 吞噬：每层 +2 物攻，**读的时候也夹一次**。
      // 写的时候夹只让那个数字本身干净；读的时候夹才是给玩家的保证 ——
      // 面板上的物攻永远不会超过上限，不管层数是哪条路径加上去的。
      if (this.devourStacks) {
        const dvs = Math.min(this.devourStacks, D.COMBAT.devourMaxStacks);
        s.atkP = num(s.atkP) + dvs * D.COMBAT.devourAtkPerStack;
      }
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
        dmgOut: 0,       // 输出增伤（疾影的爆发窗口走这里）
        // 针对词条。注意这是**白名单**汇总，新字段不加进来会被静默忽略 ——
        // 那种失败不报错，只是"秘藏看起来拿到了但完全不生效"。
        //
        // ⚠ 白名单里只能放**数字型**字段：take() 对白名单内的字段一律走
        //   f[k] = num(f[k]) + num(fl[k])。vsTag 是字符串，一旦写进来，
        //   num('召唤') = 0，标签会被静默清零 —— 实测踩过这个坑。
        //   所以 vsTag 由下面 vsMul 那个分支自己赋值，不进白名单。
        vsMul: 0
      };
      const take = function (fl) {
        if (!fl) return;
        for (const k in fl) {
          // 只认**数字型**字段。这条守卫是必需的，而且理由并不显然：
          // 下面 vsMul 那个分支会凭空创建 f.vsTag 这个键，而 vsTag
          // 就排在同一个 flags 对象里、紧接着被遍历到 —— 于是它会通过
          // `k in f` 检查、掉进数字累加分支：num('召唤') = 0，标签当场被清零。
          // 症状极具迷惑性：vsMul 正常，只有标签变成 0，且不报任何错。
          //
          // 用通用守卫而不是给 vsTag 开特例，是为了挡住"以后任何人往 flags
          // 里加字符串/布尔字段"这一整类问题 —— 特例只能挡住已经踩过的那一个。
          if (typeof fl[k] !== 'number') continue;
          if (!(k in f)) continue;
          if (k === 'doubleAtSpd') f[k] = (f[k] && f[k] < fl[k]) ? f[k] : fl[k];
          else if (k === 'vsMul') {
            // 取**更强**的那一条，而不是相加。
            // 相加会让"两条针对不同标签"在某只同时具备两个标签的怪身上
            // 叠成 +85%，那是把克制变成了超模；取 max 才是"你选了一条路线"。
            if (num(fl.vsMul) > num(f.vsMul)) {
              f.vsMul = num(fl.vsMul);
              f.vsTag = fl.vsTag || '';
            }
          }
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

    /* 「有没有待选秘藏」只能由这一个函数回答。

       踩过的坑（真的把玩家卡死过）：_offerRelics() 在秘藏池抽干时返回**空数组**，
       而空数组在 JS 里是**真值** —— 于是 `if (this.pendingRelic)` 一律误判成
       "正在等玩家选"，把移动/技能输入永久拒掉；而界面层那边用 .length 判断，
       得到的却是"没有待选"，面板不弹。两个口径之间的那条缝，玩家就走不出去了：
       点不动、也没有面板可关。

       口径统一之后，空数组不再可能造成卡死。 */
    hasPendingRelic() {
      return Array.isArray(this.pendingRelic) && this.pendingRelic.length > 0;
    }

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
      // 本层已击杀数：给"这一层刷够了就走"用（见 PROGRESSION.leaveLayerAfterKills）。
      // 与 aiGoal/aiBad 同一处声明 + 重置：换层必须归零，否则第二层一开局
      // 就以为"刷够了"、直接冲出口。
      this.layerKills = 0;

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

      /* —— 10. 连通性兜底 —— */
      // 分区必须放在连通性兜底**之后**：兜底会凿开墙、增加可走格，
      // 在那之前算出来的区域会因为新增的通道而失准。
      this._ensureConnectivity();
      /* —— 10b. 分区（房间） —— */
      this._buildRegions(depth);
      /* —— 10c. 敌人：**一堆 = 一个房间** ——
         顺序必须是"先分区、再布点"。反过来的话，堆是围着随机点长的，
         一半的堆会跨在两个区的边界上 —— 而区域门禁只放行玩家所在那一区，
         于是"一个房间里的四只"进场时只剩两只，群战从源头上就不可能。 */
      this._spawnEnemies(depth);
      this._applyRegionFlavor();   // 依赖 e.region，必须在敌人落位之后

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

    /**
     * 当前层的机制主题。
     * 层数超出主题表定义范围时沿用最后一个 —— 无尽模式靠这条兜底，
     * 而不是让第 6 层之后突然失去身份。
     */
    themeAt(depth) {
      const T = D.THEMES;
      if (!T || T.length < 2) return null;
      const i = Math.min(depth, T.length - 1);
      return (i >= 1) ? T[i] : null;
    }

    _enemyPool(depth) {
      const pool = [];
      const tb = num(this.diff.tierBoost);
      const theme = this.themeAt(depth);
      for (const e of D.ENEMIES) {
        let w = e.weight;
        // 精英权重随深度上升；深渊额外加成，让"石甲兽 + 幽魂"这种
        // 需要切换伤害类型的组合更早出现
        if (e.tier >= 2) w *= (1 + (depth - 1) * 0.34 + tb * 0.5 * (e.tier - 1));
        if (e.tier >= 3) w *= (1 + (depth - 1) * 0.30);
        if (e.tier === 1 && depth > 3) w *= 0.6;
        // 机制主题：给本层主打的标签加权。
        // 宝箱怪被排除 —— 它是**奖励型遭遇**（loot.chance 1.0），
        // 被主题放大等于悄悄改变掉落经济，而它本来就不是用来教抗性的。
        if (theme && e.kind !== 'treasure' &&
            tagsOf(e.stats, e).indexOf(theme.tag) >= 0) {
          w *= theme.mul;
        }
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
      const e = {
        id: ++SEQ, x: x, y: y, arc: arc, name: arc.name, kind: arc.kind || 'normal',
        stats: st, hp: st.hp, maxHp: st.hp, cd: 0, hitFlash: 0,
        tags: tagsOf(st, arc),    // 建怪时算一次：结算、UI、模拟都要用，别各算一遍
        // 初始姿态随机：如果恒定从同一侧开始，玩家会背成"前 3 回合用法术"，
        //  memorize 一个常数不等于读懂一个机制。
        stance: canStance(st, arc) ? (this.rng.chance(0.5) ? 'p' : 'm') : null,
        stanceT: D.STANCE.every, stanceFx: 0,
        region: this.regionAt(x, y),
        // 槽位：由 _assignSlots 每回合重新分配。**必须在这里声明**，
        // 不能等第一次分配再挂上去 —— 给成型对象新增字段会让它发生隐藏类迁移，
        // 而这个字段每回合都要读一次（这个坑在本项目里踩过，整局慢 3 倍）。
        slot: null
      };
      this._decideEnemy(e);          // 出生即带意图，否则第 1 回合看不见预告
      return e;
    }

    _makeBoss(x, y, depth) {
      const arc = this.rng.pick(D.BOSSES);
      const C = D.DEPTH_CFG, s = this.diff.enemyScale;
      const mult = (1 + C.enemyHpPerDepth * (depth - 1) * 0.5 + s * (depth - 1) * 0.5) *
        this.endlessBoost(depth);
      const st = {};
      for (const k in arc.stats) st[k] = k === 'leech' ? arc.stats[k] : Math.round(arc.stats[k] * mult);
      for (const key of ['penP', 'penM', 'crit', 'dodge']) if (!(key in st)) st[key] = 0;
      const e = {
        id: ++SEQ, x: x, y: y, arc: arc, name: arc.name, kind: 'boss',
        stats: st, hp: st.hp, maxHp: st.hp, cd: 0, hitFlash: 0, isBoss: true,
        tags: tagsOf(st, arc),
        stance: canStance(st, arc) ? (this.rng.chance(0.5) ? 'p' : 'm') : null,
        stanceT: D.STANCE.every, stanceFx: 0,
        region: this.regionAt(x, y)
      };
      this._decideEnemy(e);
      return e;
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

      // 6) 玩家所在的区域。
      // **敌人不在这里绑**：本函数现在跑在敌人布点之前（见 _buildLevel 的顺序），
      // 绑区域与 _applyRegionFlavor 都挪到 _spawnEnemies 之后。
      this.playerRegion = this.regionAt(this.px, this.py);
      // 出生点所在的区域开局就算"认得"，否则标签会以"未知"的样子
      // 出现在玩家脚底下，而玩家明明就站在里面
      if (!this.regionVisited) this.regionVisited = {};
      if (this.playerRegion >= 0) this.regionVisited[this.playerRegion] = 1;
    }

    /**
     * 敌人布点：**一堆 = 一个房间**。
     *
     * 为什么必须这样放（这是 v11.4-g 整轮取证的最后一块拼图）：
     * 实测"玩家所在区域里、距离 >1 的怪"平均只有 **1.68 只** ——
     * 因为每层 13 只怪被 5 个区域摊开，玩家每次进房只碰上 2~3 只。
     * 四邻要站满得先**有**第四只：没有第四只，任何"让它们更快/更会站位"的
     * 改动都是在优化一个不存在的东西 —— v11.4-g 的三条机制全部无功而返，
     * 根因就在这里（同侧排队假说已被数据否掉：目标格冲突率只有 1.7%）。
     *
     * 三条边界：
     *   · 堆**不许跨区**（regionAt 校验）。跨区的那部分会被区域门禁关在门外，
     *     "一个房间四只"会缩水成两只；
     *   · 堆内部只走**正交**邻格（含斜角不行）：群战的判据是主角的上下左右，
     *     斜着贴住的在结算里根本不算"围在一起"；
     *   · 一堆 2~4 只。参战上限就是 4，第 5 只只会站在圈外挨打。
     */
    _spawnEnemies(depth) {
      const M = D.MAP;
      const count = Math.round(M.enemiesBase * (1 + (depth - 1) * 0.16) * num(this.diff.enemyMul));
      const occ = new Set([this.px + ',' + this.py]);
      const NB4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let placed = 0;

      /* 找锚点：本区的一块空地，且**离出生点 >=4**。
         贴脸刷怪不是"围攻"，是伏击 —— 玩家会被开局第一回合的遭遇
         直接教坏（"这游戏只能硬碰硬"）。 */
      const anchorIn = (reg) => {
        for (let t = 0; t < 10; t++) {
          const p = this._regionFreeTile(reg.id);
          if (!p) return null;
          if (occ.has(p.x + ',' + p.y)) continue;
          if (Math.abs(p.x - this.px) + Math.abs(p.y - this.py) < 4) continue;
          return p;
        }
        return null;
      };

      if (this.regions && this.regions.length) {
        /* 堆的规模与堆的数量（v11.4-h 修正）
           ------------------------------------------------
           第一版是"每个房间都放 round(count / 房间数) 只"，实测每间只有 **2 只**——
           而 2 只永远凑不出 1v3、1v4：四邻要站满得先**有**第四只。
           实测证据：玩家所在区里"想动的怪"平均只有 1.02 只。
           改成"每堆 3~5 只、只占一部分房间、其余房间空着"：
             · 堆够大，进房才可能被围；
             · 空房间是**刻意的** —— 每间房都有怪会让走廊变成排队送死，
               而"这间是空的"正好是节奏里的呼吸点，也让"进房"这个动作有悬念。
           总只数不变（count），所以这一条不动经济、不动总量，只改分布。 */
        const PACK = 4;
        const numPacks = Math.max(1, Math.min(this.regions.length, Math.round(count / PACK)));
        const packSizes = [];
        for (let i = 0; i < numPacks; i++) packSizes.push(0);
        for (let i = 0; i < count; i++) packSizes[i % numPacks]++;
        packSizes.sort(function (a, b) { return b - a; });
        const order = this.regions.slice();
        for (let i = order.length - 1; i > 0; i--) {
          const j = this.rng.int(0, i);
          const t = order[i]; order[i] = order[j]; order[j] = t;
        }
        for (let pi = 0; pi < numPacks && pi < order.length; pi++) {
          const reg = order[pi];
          const per = packSizes[pi];
          if (placed >= count) break;
          const a = anchorIn(reg);
          if (!a) continue;
          occ.add(a.x + ',' + a.y);
          this.enemies.push(this._makeEnemy(a.x, a.y, depth));
          placed++;
          const blob = [{ x: a.x, y: a.y }];
          const want = Math.min(per - 1, count - placed);
          for (let i = 0; i < want; i++) {
            const cands = [];
            for (const b of blob) for (const d of NB4) {
              const nx = b.x + d[0], ny = b.y + d[1];
              if (this.regionAt(nx, ny) !== reg.id) continue;   // 不许跨区
              if (occ.has(nx + ',' + ny) || !this.walkable(nx, ny)) continue;
              cands.push({ x: nx, y: ny });
            }
            if (!cands.length) break;
            const p = this.rng.pick(cands);
            occ.add(p.x + ',' + p.y);
            this.enemies.push(this._makeEnemy(p.x, p.y, depth));
            blob.push(p);
            placed++;
          }
        }
      }

      // 兜底：区域太少 / 堆放不下时的余数，回到"离起点远"的均匀撒
      let guard = 0;
      while (placed < count && guard++ < count * 4) {
        const p = this._randomFloor(occ, { x: this.px, y: this.py }, 5);
        if (!p) break;
        occ.add(p.x + ',' + p.y);
        this.enemies.push(this._makeEnemy(p.x, p.y, depth));
        placed++;
      }
      this._tagEnemyRegions();
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
    /* ============================================================
       可中断的对决（v11.2-m）

       改造前：_duel 是一个 while 循环，一口气算完整场，再把 res.log 交给界面。
       界面只能**回放** —— 玩家看得见谁先出手，但中间没有任何一个时刻
       能改变什么。那不是"打仗"，是"看结算"。

       现在把"算一轮"从"算一场"里拆出来：

         newDuel(...)            建一场，返回一个可以逐轮推进的句柄
         duel.step(玩家选的路)    推进**一轮**
         duel.runAuto(pick)      循环 step，直到分出胜负

       于是 fight()（无头模拟、冒烟里的伤害数学、所有非交互路径）与战斗界面
       走的是**同一个 step** —— 界面只是把 pick 换成了人在点按钮。
       这条是硬要求：复刻一份核心逻辑已经踩过一次坑，两份实现一旦漂移，
       平衡数据全是假的，而且很久都不会有人发现。

       为什么玩家每**轮**只做一次选择、而不是每次出手都选：
       速度碾压和连击词条会给同一方追加出手。那几次追加用的是同一套属性、
       是同一个决定的延续，不是新的决定。逐次问一遍就是假决策 ——
       玩家会发现自己只是在重复点同一个按钮。

       为什么这里**不**结算伤害类型以外的东西：
       选定哪一路伤害，是"读敌人姿态 / 读双防"这件事的全部回报。
       魂技、撤离属于别的机制，要各自单独定价（见提交信息里的边界说明）。
       ============================================================ */
    /**
     * 建一场可中断的对决。
     * @param {object} A 攻方面板（含 hp/maxHp）
     * @param {object} B 守方面板
     * @param {object} af A 的 flags
     * @param {boolean} aFirst 平手时 A 是否先手
     * @param {object} aInfo {name, isPlayer, atkType}
     */
    newDuel(A, B, af, bf, aFirst, aInfo, bInfo) {
      const g = this, K = this.K, C = D.COMBAT;
      // 1vN 的入口（v11.4-a）。B / bf / bInfo 允许是单个（旧调用点、
      // 冒烟里的合成对决、以及所有"只应有一只怪"的路径），也允许是等长数组。
      // 单元素必须与旧的单值调用**逐位相同** —— 第 1 步的验收标准就是这个，
      // 所以这里只做归一化：不引入新分支、不消耗随机数、不改日志字段。
      const Bs = Array.isArray(B) ? B : [B];
      const bfS = Array.isArray(bf) ? bf : [bf || {}];
      const bIS = Array.isArray(bInfo) ? bInfo : [bInfo];
      const a = {
        name: aInfo.name, hp: A.hp, maxHp: A.maxHp || A.hp, st: A, flags: af || {},
        dodge: num(A.dodge), isPlayer: !!aInfo.isPlayer,
        // 必须显式搬过来。漏了它，strike 里 `src.atkType` 恒为 undefined，
        // 手动选型会被**静默丢弃**：玩家选了法术照样按物理打，
        // 克制奖励永不触发，而界面看不出任何异常。
        atkType: (aInfo.atkType === 'p' || aInfo.atkType === 'm') ? aInfo.atkType : null
      };
      // 敌方单位数组。N=1 时 bs[0] 的内容与上面那个单一对象逐字相同。
      //
      // 为什么每只怪要各自带 src / stance / idx：
      //   · src    —— 各自的姿态时钟源，否则群战里"谁该翻面"说不清；
      //   · stance —— 各自的姿态，N=1 时就是 duel.b.stance；
      //   · idx    —— 同速时的稳定排序键，也供界面按序号选目标。
      const bs = [];
      for (let i = 0; i < Bs.length; i++) {
        const Bx = Bs[i], bx = bfS[i] || {}, bIx = bIS[i] || {};
        bs.push({
          name: bIx.name, hp: Bx.hp, maxHp: Bx.maxHp || Bx.hp, st: Bx, flags: bx,
          dodge: num(Bx.dodge), isPlayer: !!bIx.isPlayer,
          wet: num(Bx.wet),         // 潮湿是挂在敌人身上的状态，结算时读这里
          stance: Bx.stance || null, // 姿态：只重分配防御，不改变总量
          tags: Bx.tags || [],      // 针对词条要判定的目标标签
          src: bIx.src || null,     // 它的模型对象：姿态时钟靠它继续走
          idx: i
        });
      }
      // 敌人的**模型对象**。有它，姿态时钟才能在战斗里继续走。
      //
      // 为什么这条是必需的、而不是锦上添花：v11.4-f（A1）之前实测 83% 的对决
      // 在第 1 轮就分胜负（普通怪 92%），而精英是 66%、首领只有 37%。也就是说
      // "每轮选一次"对杂兵根本没多出任何决定 —— 它退化成开战前选一次。
      // 真正需要它的，恰恰是那些能打 2~6 轮的精英与首领。
      // 而如果姿态不翻面，那 6 轮里最优解从头到尾是同一个，
      // 逐轮再选一遍仍然是假决策。姿态翻面才把"轮"变成有意义的时间单位。
      // A1 之后这条时钟不再只是给精英用的：野生普通怪已经是 2.4 / 2.4 / 2.0 轮，
      // 每一场杂兵仗都会真的走完它。
      // 冒烟里的伤害数学不传它（那种合成对决本来就不该有姿态轮换）。
      // 1vN 之后每条敌人都各自持有一个 src（见上面的 bs 构造）——
      // 于是语义从"整场共用一个姿态时钟"变成"每只怪有自己的"。
      // 兼容别名：界面（ui.js:1915/1970 读 duel.b.st / duel.b.stance）与
      // 旧断言读的都是 duel.b，它必须仍然是"第一个敌人"。
      const b = bs[0];
      const bSrc = bs[0].src;
      const roundLog = [];
      // 先手权：速度高者先手；平手看参数。整场只判一次 ——
      // 中途重判会让"谁先手"随回合漂移，而意图预告是按当前顺序推出来的，
      // 漂移就等于预告在说谎。
      // 出手顺序：按速度从高到低；同速时 aFirst 决定"玩家"与**第一个**敌人的
      // 先后，敌人之间按 idx 稳定排序。
      //
      // 这套比较器在 bs.length === 1 时必须退化成旧的二元比较
      // (a.spd === b.spd ? aFirst : a.spd > b.spd) ? [a,b] : [b,a]：
      // 同速 -> 命中 x === a 那一支 -> 由 aFirst 决定；异速 -> 直接比速度。
      //
      // 认人必须用**同一性**（x === a），不能用 x.isPlayer：
      // 冒烟里的合成对决不传 isPlayer，标志位是假的；更要紧的是，
      // 那时 a.idx 是 undefined，落到最后的 x.idx - y.idx 会返回 NaN，
      // 而返回 NaN 的比较器等于把顺序交给引擎实现 —— 那就不是等价重构了。
      const order = [a].concat(bs).sort(function (x, y) {
        const sx = num(x.st.spd), sy = num(y.st.spd);
        if (sx !== sy) return sy - sx;
        const ax = (x === a), ay = (y === a);
        if (ax && ay) return 0;
        if (ax) return aFirst ? -1 : 1;
        if (ay) return aFirst ? 1 : -1;
        return x.idx - y.idx;
      });
      let round = 0, capped = false, finished = false, flipped = false;

      function atkOf(x) { return bestAttack(x.st, x === a ? b.st : a.st, K); }

      function strike(src, dst, atkType) {
        if (src.hp <= 0) return 0;
        // 防守方带姿态时，用**调整后的防御视图**结算。
        // 玩家没有姿态，stanceDef 会原样返回 st，所以这里不需要分支。
        const dv = stanceDef(dst.st, dst.stance);
        let atk, countered = false;
        if (src.isPlayer && atkType) {
          // 玩家自己选的那一路，由调用方逐轮传进来（界面上就是那个按钮）。
          // 引擎不再替他算 —— 这是本次改动的地基。
          atk = attackVia(src.st, dv, atkType, K);
          // 判定"选对了没有"：用 bestAttack 当裁判，而不是自己再写一遍比较。
          // 于是 bestAttack 从「替玩家做决定」降级为「给玩家的答案打分」——
          // 比较逻辑只剩一份，永远不会和结算漂移。
          countered = (bestAttack(src.st, dv, K).type === atk.type);
        } else {
          // 敌人没有"选择"：它按自己最强的一路打。
          atk = bestAttack(src.st, dv, K);
        }
        let dmg = atk.base;
        let crit = false, dodged = false, extra = [];
        // 闪避
        const dg = num(dst.dodge) + num(dst.flags.dodge);
        if (dg > 0 && g.rng.chance(Math.min(0.7, dg))) {
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
        if (num(src.flags.echo) > 0 && atk.type === 'm' && g.rng.chance(num(src.flags.echo))) {
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
        // 针对词条：目标带上了对应标签才生效。
        // 走的是和上面完全同一套 flags 通道 —— 结算不需要知道
        // "这个 +45% 是灭卵者给的还是别的东西给的"。
        if (num(src.flags.vsMul) > 0 && src.flags.vsTag &&
            num(dst.tags ? dst.tags.length : 0) > 0 &&
            dst.tags.indexOf(src.flags.vsTag) >= 0) {
          dmg *= (1 + num(src.flags.vsMul)); extra.push('克·' + src.flags.vsTag);
        }
        // 暴击
        const critChance = num(src.st.crit);
        if (critChance > 0 && g.rng.chance(Math.min(0.85, critChance))) {
          dmg *= C.critMul; crit = true;
        }
        // 残血加防
        if (num(dst.flags.lastStand) > 0 && dst.hp / dst.maxHp < 0.4) {
          dmg *= 1 / (1 + num(dst.flags.lastStand)); extra.push('坚守');
        }
        dmg = Math.max(1, Math.round(dmg));
        dst.hp -= dmg;
        // 克制奖励：选对的那一路，追加一段**真实伤害**（不走 rawDamage、无视防御）。
        //
        // 为什么必须是真实伤害，而不是"再多打 X 点普通伤害"：
        //   ① 它要**看得见**。白字和橙/紫数字并排跳出来，"我读对了"的收益
        //      才是可读的；藏进一个乘法系数里，玩家永远感觉不到自己赚了。
        //   ② 主题上它是对的 —— 你找到了防御的缝隙，那部分伤害无从被防。
        //      潮水不跟你讲防御。
        // 量由 this.counterBonus 控制（模拟器可覆盖，方便把它的影响单独量出来）。
        let counter = 0;
        const cb = num(g.counterBonus);
        if (countered && cb > 0) {
          counter = Math.max(1, Math.round(dmg * cb));
          dst.hp -= counter;
          extra.push('克制' + counter);
        }
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
        // 反伤。它**不走 rawDamage**，是直接扣血的 —— 语义上一直是真实伤害。
        // 单独带一个 reflect 字段，而不是让画面去 parse extra 里的 "反伤12" 字符串：
        // 主伤害和反伤是两笔钱，飘字要分开跳；而 parse 文案的做法
        // 会随文案改动静默失效（文案一改，"反伤"两个字对不上就再也不显示了）。
        let back = 0;
        if (num(dst.flags.thorns) > 0) {
          back = Math.round(dmg * num(dst.flags.thorns));
          src.hp -= back;
          if (back > 0) extra.push('反伤' + back);
        }
        roundLog.push({
          r: round, from: src.name, to: dst.name, dmg: dmg, type: atk.type,
          crit: crit, heal: heal, extra: extra.join(' '),
          reflect: back,
          // 克制奖励单独带字段：它是**另一笔**伤害，飘字要单独跳一个白字。
          // 和反伤同一个道理 —— 混进 dmg 里，玩家只会以为"我这一下打出了这么多数"。
          counter: counter
        });
        return dmg;
      }

      /**
       * 回合上限的收场判定。
       *
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
      function capOut() {
        capped = true;
        // 1vN 里对手是**一个整体**，所以右边用全体敌人的剩余血量比之和。
        // N=1 时这个和就是那唯一的敌人，于是与旧式完全等价。
        // 这里的 Math.max(0, ...) 对 N=1 是空操作：能走到 capOut 就说明
        // 双方都还活着（死了的那支会先走 finished 分支）。
        const ra = a.hp / a.maxHp;
        let foeHp = 0, foeMax = 0;
        for (let i = 0; i < bs.length; i++) {
          foeHp += Math.max(0, bs[i].hp);
          foeMax += bs[i].maxHp;
        }
        const rb = foeMax > 0 ? foeHp / foeMax : 0;
        if (ra <= rb) a.hp = 0;
        else for (let i = 0; i < bs.length; i++) bs[i].hp = 0;
      }

      /**
       * 本轮的敌方目标：want 优先（单位对象或下标），否则第一个还活着的敌人。
       * 返回 null 表示敌方全灭 —— 调用方决定拿它怎么办（step 里退回 bs[0]，
       * 那是为了与旧行为逐位相同）。
       */
      function pickFoe(want) {
        let t = null;
        if (typeof want === 'number') t = bs[want] || null;
        else if (want && bs.indexOf(want) >= 0) t = want;
        if (t && t.hp > 0) return t;
        for (let i = 0; i < bs.length; i++) if (bs[i].hp > 0) return bs[i];
        return null;
      }
      /** 场上敌人是否全部倒下。N=1 时它就是 `b.hp <= 0`。 */
      function allFoesDown() {
        for (let i = 0; i < bs.length; i++) if (bs[i].hp > 0) return false;
        return true;
      }

      const duel = {
        a: a, b: b, bs: bs, order: order, log: roundLog,
        /** 谁是玩家 —— 界面据此决定给哪一边开指令菜单。 */
        player: a.isPlayer ? a : (b.isPlayer ? b : null),
        /** 这一轮谁先出手。玩家比敌人慢时，界面要先把对方那一手演完。 */
        firstActor: order[0],
        get round() { return round; },
        get finished() { return finished; },
        get capped() { return capped; },
        /** 刚刚这一轮敌人翻面了吗 —— 界面据此给一次强调提示。 */
        get lastFlip() { return flipped; },

        /**
         * 推进**一轮**，返回这一轮新增的明细（供演出逐条播）。
         * @param {string} playerType 玩家这一轮选的路（'p' / 'm'）；
         *   不传或不是这两个值 = 让引擎按最优打（敌人一直如此，非交互路径也如此）。
         */
        step(playerType, wantTarget) {
          if (finished) return [];
          const from = roundLog.length;
          round++;
          for (let i = 0; i < order.length; i++) {
            const src = order[i];
            if (src.hp <= 0) continue;
            // 目标：玩家出手时是他这一轮选的那个（wantTarget 可以是单位对象，
            // 也可以是 bs 的下标 —— 界面与模拟器两条入口）；没选、或选的那个
            // 已经倒了，就退回"第一个还活着的敌人"。敌人出手时目标恒为玩家：
            // 敌人之间不会互殴，也不存在"该打谁"这个选择。
            //
            // `|| bs[0]` 那一截不是装饰。旧代码在"唯一的对手已经死了"时
            // **仍然会让玩家对着尸体挥一刀**（会消耗随机数、会写一条明细），
            // 所以这里必须保留同一个行为，否则随机流就漂了。
            // 认"这是不是玩家"必须用 src === a，不能用 src.isPlayer ——
            // 理由同上面的 order 比较器：合成对决的 isPlayer 是假的，
            // 用标志位会让单位去打自己。
            const dst = (src === a)
              ? (pickFoe(wantTarget) || bs[0])
              : a;
            // 选的那一路只作用在**本轮的玩家出手**上（含下面的追加击）。
            const t = (src.isPlayer && (playerType === 'p' || playerType === 'm'))
              ? playerType : null;
            strike(src, dst, t);
            // 一个对手倒下不再等于整轮结束：只有"场上敌方全灭"或"玩家倒下"才停。
            // N=1 时这与旧的 `if (dst.hp <= 0) break;` 完全等价 ——
            // 唯一的对手倒下，就是敌方全灭。
            if (dst.hp <= 0 && (allFoesDown() || a.hp <= 0)) break;
            // 速度碾压：快的一方多打一次
            const gap = num(src.st.spd) - num(dst.st.spd);
            if (gap >= C.speedGap && src.hp > 0 && dst.hp > 0) strike(src, dst, t);
            // 连击词条：达标就每轮两次
            if (num(src.flags.doubleAtSpd) > 0 && num(src.st.spd) >= num(src.flags.doubleAtSpd) &&
                src.hp > 0 && dst.hp > 0) strike(src, dst, t);
          }
          // 一轮打完，推进敌人的姿态时钟。
          //
          // 为什么放在**一轮结束**而不是开始：第一轮必须用玩家在开战前
          // （地图上 / 意图预告里）看到的那一面。差一格的话，他读到的信息
          // 和打出来的结果就永远错开半拍 —— 而这种错位不会表现成
          // "数值不对"，只会被感觉成"这游戏有时候算错"。
          //
          // 只在双方都还活着时推进：让一只刚被打死的怪再翻一次姿态，
          // 只会往事件流里塞一条指向尸体的通知。
          flipped = false;
          for (let i = 0; i < bs.length; i++) {
            const u = bs[i];
            // 每只活着的敌人各自推进自己的姿态时钟。
            // 旧式是 `if (bSrc && a.hp > 0 && b.hp > 0)`，N=1 时逐字等价。
            if (u.src && a.hp > 0 && u.hp > 0) {
              const was = u.stance;
              g._tickStance(u.src);
              u.stance = u.src.stance;
              if (u.stance !== was) flipped = true;
            }
          }
          // 结束条件是「玩家倒下」或「**敌方全灭**」，不是「第一只倒下」。
          // 写成 b.hp <= 0 的话，群战打到第一只就收场：后面几只一次都没
          // 挨打、也没被结算（实测 killed=1，而剩下的血还是满的）。
          // N=1 时 allFoesDown() 就是 b.hp <= 0，所以这条对单敌逐位等价。
          if (a.hp <= 0 || allFoesDown()) finished = true;
          else if (round >= C.maxRounds) { capOut(); finished = true; }
          return roundLog.slice(from);
        },

        /**
         * 一口气跑完（无头模拟、冒烟、以及"不需要玩家选择"的路径）。
         * pick(duel) 在每一轮开始前被问一次；返回 null = 让引擎按最优打。
         */
        runAuto(pick) {
          // 必须写成 duel.step —— step 是**对象的方法**，不是闭包函数。
          // 写成裸 step(...) 会解析到外层作用域，运行时报 "step is not defined"。
          //
          // pick 现在允许返回两种东西：
          //   'p' / 'm' / null   —— 只选路（旧行为，也是所有非交互路径的形态）
          //   {type, target}     —— 选路 + 选目标（第 2 步的菜单走这条）
          // 归一化放在这里，step 因此只需要一个 (路, 目标) 的实现。
          while (!finished) {
            const r = pick ? pick(duel) : null;
            if (r && typeof r === 'object') duel.step(r.type, r.target);
            else duel.step(r, null);
          }
        },

        result() {
          return {
            aHp: Math.max(0, Math.round(a.hp)), bHp: Math.max(0, Math.round(b.hp)),
            // bsHp / foesDown 是给 1vN 用的新读法；aHp / bHp 保持旧语义
            // （bHp = 第一个敌人），因为 _fightSettle 与界面读的就是它。
            bsHp: bs.map(function (u) { return Math.max(0, Math.round(u.hp)); }),
            foesDown: allFoesDown(),
            rounds: round, aWin: allFoesDown() && a.hp > 0, dead: a.hp <= 0,
            capped: capped, log: roundLog
          };
        }
      };
      return duel;
    }

    /**
     * 一次性算完整场。返回每轮的明细，供飘字与日志使用。
     *
     * 现在它只是 newDuel + runAuto 的一层壳 —— 规则仍然只有一份。
     * aInfo.atkType 是「开战前就定死的那一路」：冒烟里的伤害数学、
     * 无头模拟器的旧策略都走这条。逐回合选型不经过这里。
     */
    _duel(A, B, af, bf, aFirst, aInfo, bInfo) {
      const fixed = (aInfo.atkType === 'p' || aInfo.atkType === 'm') ? aInfo.atkType : null;
      const d = this.newDuel(A, B, af, bf, aFirst, aInfo, bInfo);
      d.runAuto(function () { return fixed; });
      return d.result();
    }

    /**
     * 开局：把面板快照搬进对决，但**不结算**。
     *
     * 拆出这一层是为了让"进入战斗"和"战斗结束"可以发生在两个不同的时刻。
     * 逐回合模式下这两件事之间隔着玩家的每一次点击；一键模式下它们紧挨着。
     * 无论哪种，写回模型的动作都只有 _fightSettle 一处 —— 免得某条路径漏写
     * this.hp / enemy.hp，出现"界面显示已经打死了、模型里它还在"的鬼故事。
     */
    /**
     * 群战名单：被踩中的那一只 + 主角**正交相邻**（上下左右）的敌人，最多 4 个。
     *
     * 为什么围着**主角**取四邻、而不是围着目标：玩家看到的画面是
     * 「我站在哪儿、身边围着几只」—— 决策依据是他的位置，不是那只怪的。
     * 为什么含脚下那只：stepTo 只走一格，被踩中的那只本来就落在主角的
     * 四邻里，所以"最多 4 个"是精确的，不是"4 + 1"。
     * squad 关掉时退化成只打那一只 —— 那就是重标基线用的对照组。
     */
    _squadAt(x, y) {
      if (!this.squad) {
        const only = this.enemyAt(x, y);
        return only ? [only] : [];
      }
      const list = [];
      const add = (ex, ey) => {
        const e = this.enemyAt(ex, ey);
        if (e && list.indexOf(e) < 0) list.push(e);
      };
      add(x, y);                       // 被踩中的那只排第一 = 默认目标
      add(this.px + 1, this.py);
      add(this.px - 1, this.py);
      add(this.px, this.py + 1);
      add(this.px, this.py - 1);
      return list.slice(0, 4);
    }

    _fightBegin(foes, atkType) {
      const st = this.stats();
      const fl = this.flags();
      // 参战名单：单个敌人（旧调用点、冒烟里的合成对决）或一个数组（群战）。
      // 归一化只在这里做一次 —— 这层之下只剩"一场对决"这一种形态。
      const list = Array.isArray(foes) ? foes.slice() : [foes];
      const enemy = list[0];                  // 旧字段：第一个敌人
      const hp0 = this.hp;                    // 战斗场景回放要用它推血条
      const ehp0 = enemy.hp;
      const A = Object.assign({}, st); A.hp = this.hp; A.maxHp = st.hp;
      const Bs = [], bInfos = [], ehp0s = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const B = Object.assign({}, e.stats); B.hp = e.hp; B.maxHp = e.maxHp;
        B.wet = e.wet || 0;          // 潮湿状态要带进结算
        B.stance = e.stance || null; // 姿态同理，不带上就会「看得见、打不着」
        B.tags = e.tags || [];       // 针对词条要在结算里读到它
        Bs.push(B);
        ehp0s.push(e.hp);
        // src 让姿态时钟能在战斗里继续走。aiStance 关掉时**不传**，
        // 那场战斗的姿态就固定在开战那一刻 —— 对照组要的正是这个。
        bInfos.push({ name: e.name, src: this.aiStance ? e : null });
      }
      // atkType === null 是**显式**的"不必在这里预选"：逐轮模式由 picker
      // 每一轮现选，此时预选一次不但是浪费，还会白白消耗掉一个随机数，
      // 把对照组的随机流弄脏。undefined 才走 attackTypeFor
      // —— 那是"开战时用哪一路"的唯一收口。
      const resolved = (atkType === undefined) ? this.attackTypeFor(enemy)
        : ((atkType === 'p' || atkType === 'm') ? atkType : null);
      const duel = this.newDuel(A, Bs, fl, null, true,
        { name: this.cls.name, isPlayer: true, atkType: resolved }, bInfos);
      // 刻意**不**把句柄挂在 this 上。无头模拟每局要开 34 场战斗，
      // 而给 Game 实例新增一个字段会让它的隐藏类发生迁移 ——
      // playHeadless 里所有指向旧 map 的内联缓存随之全部重建。
      // 实测的后果非常反直觉：战斗本身只占整局的 1.5%，
      // 整局却因此慢了 3 倍（741ms → 2149ms，n=20）。
      // 句柄由调用方持有：一键路径直接往下传，逐回合路径才显式存起来。
      return {
        enemy: enemy, enemies: list, duel: duel,
        hp0: hp0, ehp0: ehp0, ehp0s: ehp0s, atkType: resolved
      };
    }

    /**
     * 收尾：把对决的结果写回模型，并推出那个"战斗已发生"的事件。
     * 只在这里改 this.hp / enemy.hp —— 状态源只有一个。
     */
    _fightSettle(L, played) {
      if (!L) return null;
      const list = L.enemies || [L.enemy];
      const enemy = list[0];
      const res = L.duel.result();
      this.hp = res.aHp;
      // 逐只写回。res.bsHp 与 list 一一对应（newDuel 是按同一个顺序建的）。
      // i === 0 时它逐位等于旧的 res.bHp，所以单敌路径没有任何变化。
      for (let i = 0; i < list.length; i++) {
        list[i].hp = res.bsHp[i];
        list[i].hitFlash = 12;
      }
      const ev = {
        kind: 'fight', enemy: enemy, enemies: list, rounds: res.log,
        target: enemy, capped: res.capped,
        // 起始血量。让界面自己从结束血量倒推也能work，但那样血条会在
        // 「克制奖励 / 反伤 / 吸血」这些额外项上和真实值慢慢漂开 ——
        // 边界一多就一定会错，而且错得很隐蔽（血条看起来一直在动）。
        aHp0: L.hp0, bHp0: L.ehp0, bHp0s: L.ehp0s || [L.ehp0]
      };
      // played = 这场仗的演出已经由战斗界面逐轮做过了。
      // 这时**不能**再推一个 fight 事件：上层（main.js 的 afterAction）
      // 会把它当成"还有一场仗要播"，于是刚打完的战斗原地再演一遍。
      if (!played) this.events.push(ev);
      if (res.capped) this._log('与 ' + enemy.name + '僵持不下 —— 先撑不住的一方倒下了。', 'warn');
      // 倒下的一起结算：掉落 / 升级（每 4 杀）/ 秘藏（每 6 杀）/ 吞噬栈
      // 都按**只数**全额计入。这是有意为之 —— 否则"多打几只"会变成惩罚，
      // 正好和群战的意图相反。代价（一轮挨 N 次打）在别处付。
      let killed = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].hp <= 0) { this._killEnemy(list[i], true); killed++; }
      }
      if (killed > 0) {
        return { win: true, died: res.dead, rounds: res.log, killed: killed };
      }
      if (res.dead) {
        this._die(this._killerName(res, list));
        return { win: false, died: true, rounds: res.log };
      }
      return { win: false, died: false, rounds: res.log };
    }

    /**
     * "谁把你打死的"。群战里不能再写死 list[0] —— 那会把死因记到一只
     * 可能已经倒下的怪头上，而 deathCause 是模拟器要统计的东西。
     *
     * 判据取自对决明细：最后一条"打到玩家身上"的记录，它的出手方就是凶手。
     * 一条都没有时（例如死于自己的反伤）退回第一只 ——
     * 单敌时这两条路都指向同一个名字，与旧实现逐字相同。
     */
    _killerName(res, list) {
      const lg = res.log || [];
      for (let i = lg.length - 1; i >= 0; i--) {
        if (lg[i].to === this.cls.name) return lg[i].from;
      }
      return (list && list.length) ? list[0].name : this.cls.name;
    }

    /**
     * 玩家主动开战（走进敌人格）——**一键打完**的版本。
     *
     * 逐回合模式下这条路径不会被走到（stepTo 会改走 _fightBegin +
     * 战斗界面驱动），但无头模拟、冒烟里的直接调用、以及将来任何
     * "不需要人做决定"的场景都靠它。让它们共用 _fightSettle，
     * 就不会出现"模拟里赢了、游戏里没赢"的分叉。
     */
    /**
     * @param {function} picker 可选。逐轮选路器：每轮开打前被问一次该走哪一路。
     *   给了它，atkType 就不再被使用，也不会为它消耗随机数。
     */
    fight(foes, atkType, picker) {
      const L = this._fightBegin(foes, atkType);
      const list = L.enemies;
      const fixed = L.atkType;
      const me = this;
      /* 每一轮开打前先推进一次世界（见 _fightRoundTick）。
         放在 runAuto 的 pick 里而不是对决内部：对决不认识地图，
         而这件事需要地图（区域、寻路、槽位、谁还站着）。 */
      const tick = function (d) {
        me._fightRoundTick(list);
        return picker ? picker(d) : fixed;
      };
      L.duel.runAuto(tick);
      return this._fightSettle(L);
    }

    /* ============================================================
       逐回合对决的两个入口（v11.3-b）

       它们存在的全部理由：把"选择"从开战前那一刻挪到每一轮开始之前。
       在此之前，玩家能选的只是"用物理还是法术走进去"，
       进去了就只剩看结算 —— 而那时这游戏 83% 的仗只有一轮，
       那一次选择几乎等于没有选择。（A1 之后野生普通怪 2.4 / 2.4 / 2.0 轮，
       每轮选一次才真的成立。）
       ============================================================ */
    /**
     * 玩家选定这一路，推进**一轮**。
     * @returns {object|null} {rounds, aHp, bHp, aMax, bMax, stance, flipped,
     *                         round, finished}
     *   rounds 只含**这一轮新增**的明细 —— 界面要逐条演，
     *   把整场的日志反复交出去会让演出无限重播。
     */
    duelRound(playerType, target) {
      const L = this.liveFight;
      if (!L) return null;
      const d = L.duel;
      const from = d.log.length;
      // 逐回合路径也要推进 —— 玩家在战斗画面里停多久，
      // 房间里的其他怪就该走多远。少了这一句，人工打的仗和模拟器跑的仗
      // 会是两种不同的游戏，而那是本项目最忌讳的分叉。
      this._fightRoundTick(L.enemies);
      d.step(playerType, target);
      return {
        rounds: d.log.slice(from),
        aHp: d.a.hp, bHp: d.b.hp,
        // 每只敌人各自回一份血量：界面的"敌群列表"要各自推进自己的血条。
        // bHp 仍然是第一只（旧字段，别删 —— 旧断言读它）。
        bsHp: d.bs.map(function (u) { return u.hp; }),
        aMax: d.a.maxHp, bMax: d.b.maxHp,
        stance: d.b.stance, flipped: d.lastFlip,
        round: d.round, finished: d.finished
      };
    }

    /**
     * 战斗界面的收尾：把结果写回模型，再走一次常规的回合结算。
     *
     * 顺序不能反 —— _afterAction 会让敌人动、让潮汐涨，那些事件必须
     * 发生在"这场仗已经算完"之后。反过来的话，玩家会看到潮汐在他
     * 还没打完的时候涨了，而敌人会在他还站在战斗画面里时从背后打他。
     */
    finishDuel() {
      const L = this.liveFight;
      if (!L) return null;
      this.liveFight = null;
      const res = this._fightSettle(L, true);
      if (this.status === 'playing') this._afterAction();
      return res;
    }

    /** 敌人主动打你：只打一下（不是整场对决）。否则一步一死，太难。 */
    /** 姿态推进：每行动 every 次切到对侧，并把"刚切过"标给渲染层。 */
    _tickStance(e) {
      if (!e.stance) return;
      const S = D.STANCE;
      if (e.stanceT === undefined) e.stanceT = S.every;
      e.stanceT--;
      if (e.stanceT > 0) return;
      e.stance = stanceFlip(e.stance);
      e.stanceT = S.every;
      e.stanceFx = 24;                       // 渲染读它做一次强调闪光（和 hitFlash 同一套）
      this.events.push({ kind: 'stance', enemy: e, stance: e.stance });
    }

    /**
     * 敌人这一下大概打多少 —— 意图预告要显示的那个数。
     *
     * 只算**确定性**部分：攻防公式 + 残血加防。不含暴击 / 闪避的随机。
     * 为什么不显示期望值：一旦数字里混了随机，玩家就会经常遇到
     * "写着 23 结果挨了 44"，而意图预告的**全部价值就在于可信**。
     * 宁可少显示一个数，也不能显示一个不准的数。
     * 暴击 / 闪避用单独的标记提示（crit / dodge 两个布尔），不揉进数字里。
     *
     * 这份计算和 enemyHit() 的第 1~2 步必须逐字一致，否则数字就开始骗人 ——
     * 改动 enemyHit 时务必同时改这里。
     */
    /**
     * 开战时用哪一路伤害 —— **唯一的收口**。
     *
     * HUD 的手动选择、AI 的选择、以及"走路撞上敌人"的意外开战，
     * 全部经过这里。漏掉任何一条路径，那条路径就会悄悄退回默认类型，
     * 而玩家看到的是"我明明选了法术，它却按物理打了" —— 这种 bug
     * 不会报错，只会让玩家觉得这游戏不讲道理。
     */
    attackTypeFor(enemy) {
      if (this.headless) return this._autoAtkType(enemy);
      return this.atkType || 'p';
    }

    /**
     * 模拟器 AI 的伤害类型选择 —— **手动化之后唯一真正影响平衡的变量**。
     *
     * fumble 模拟"玩家算错了"。它必须是显式参数，而不是藏在某个写死的分支里：
     * 因为"引擎替玩家算"和"玩家自己算"这两者的差别，对**不同水平的玩家**是
     * 完全不同的。同一个改动，认真读面板的玩家几乎不受影响，不看面板的玩家
     * 可能损失一半输出。所以结论不该是一个数，而应该是一条曲线。
     *
     * fumble = 0 时这里**不消耗任何随机数** —— 于是整局的随机流与改造前
     * 完全一致，给出了一个可以逐位比对的干净对照组。
     */
    _autoAtkType(e) {
      return this._autoAtkTypeLive(e.stats, e.stance);
    }

    /**
     * 按"当前的"防御视图与姿态算一遍该走哪一路。
     *
     * 参数从"一只敌人"改成"一份防御数据 + 一个姿态"，是为了让**战斗中途**
     * 也能调用它：姿态会在战斗里翻面，而翻面之后的最优解和开战前那个
     * 很可能不是同一路。这时候如果 AI 还抱着开战时的答案，
     * 它就是一个"看完被告知答案就不再抬头"的玩家 ——
     * 用它的成绩去评估难度，会得出一个系统性偏低的通关率。
     */
    _autoAtkTypeLive(defStats, stance) {
      const best = bestAttack(this.stats(), stanceDef(defStats, stance), this.K);
      const f = num(this.aiFumble);
      if (f > 0 && this.rng.chance(f)) return best.type === 'p' ? 'm' : 'p';
      return best.type;
    }

    /**
     * 无头模拟的**逐轮**选路器。返回 null 表示"这一局不用逐轮选"。
     *
     * 关键在**什么时候重新读**：只有当题目变了（敌人姿态翻面）才重掷一次。
     *
     * 这不是偷懒省性能，是模型正确性。fumble 模拟的是"你有没有看准面板"。
     * 面板一个字没变的时候让 AI 重新掷骰子，等于假设玩家每轮都会重新怀疑
     * 自己一次 —— 那会把"每轮可以重选"这个界面改动变成一份白拿的收益。
     * 实测过：那样做的通关率比对照组高 11.4pp（standard 51.3 → 61.7），
     * 而真正的机制（姿态在战斗里翻面）只值 -1.0pp。
     * 两份数字差一个数量级，混在一起就什么都归因不了。
     *
     * 只有在姿态不会在战斗里翻面（aiStance 关）时才返回 null ——
     * 那种情况下逐轮重算和开战前算一次结果完全一致，
     * 白跑一轮只会白耗随机数，把"能不能逐位比对"这件事毁掉。
     */
    _autoPicker() {
      if (!this.aiStance) return null;
      const g = this;
      let lastSig = null, lastPick = null;
      return function (d) {
        // "题目"= 场上敌人的姿态组合（谁还活着、各自哪一面硬化）。
        // 只有它变了才重新读 —— 理由见上面那段长注释：面板一个字没变时重掷
        // 骰子，等于假设玩家每轮都重新怀疑自己一次（实测白拿 +11.4pp）。
        //
        // 单敌时它退化成原来的 `lastStance !== d.b.stance`，**随机数消耗也
        // 一模一样**（每个敌人恰好一次 _autoAtkTypeLive），对照组因此仍然干净。
        let sig = '';
        for (let i = 0; i < d.bs.length; i++) {
          const u = d.bs[i];
          sig += (u.hp > 0 ? String(u.stance) : '-') + '|';
        }
        if (sig !== lastSig) {
          lastSig = sig;
          lastPick = g._autoPickFor(d);
        }
        return lastPick;
      };
    }

    /**
     * AI 这一轮"打谁 + 走哪路"。**纯数学，不消耗随机数。**
     *
     * 选目标的规则：先看"几下能打死"（越少越好），并列时取这一下伤害更高的。
     * 为什么不选"血最少的"：血少但物法双抗很高的怪，打上去只是白费轮次；
     * "几下能打死"同时吃进了血量与防御这两件事。
     * 顺序上先算伤害再问类型 —— _autoAtkTypeLive 会消耗随机数，
     * 而每个敌人只调一次，单敌时与旧实现逐位一致。
     */
    _autoPickFor(d) {
      const st = this.stats(), K = this.K;
      let bestIdx = -1, bestType = null, bestNeed = Infinity, bestDmg = -1;
      for (let i = 0; i < d.bs.length; i++) {
        const u = d.bs[i];
        if (u.hp <= 0) continue;
        const dv = stanceDef(u.st, u.stance);
        const type = this._autoAtkTypeLive(u.st, u.stance);
        const dmg = Math.max(1, attackVia(st, dv, type, K).base);
        const need = Math.ceil(u.hp / dmg);
        if (need < bestNeed || (need === bestNeed && dmg > bestDmg)) {
          bestNeed = need; bestDmg = dmg; bestIdx = i; bestType = type;
        }
      }
      if (bestIdx < 0) return null;
      return { type: bestType, target: bestIdx };
    }

    _enemyPreview(e) {
      const st = this.stats(), fl = this.flags();
      const atk = bestAttack(e.stats, st, this.K);
      let dmg = atk.base;
      if (num(fl.lastStand) > 0 && this.hp / st.hp < 0.4) dmg *= 1 / (1 + num(fl.lastStand));
      dmg = Math.max(1, Math.round(dmg));
      return {
        dmg: dmg, type: atk.type,
        crit: num(e.stats.crit) > 0,
        dodge: (num(st.dodge) + num(fl.dodge)) > 0,
        lethal: dmg >= this.hp
      };
    }

    /**
     * 为一只敌人预告它「下一手打算做什么」。
     *
     * 诚实边界要说清楚：预告描述的是 **"若你原地不动，它会怎么做"**。
     * 玩家自己走开或走上去，行动当然会变 —— 而那是玩家亲手造成的、
     * 完全可预期。真正的说谎是另一种：界面自己"预测"一遍、
     * 执行时再决策一遍，两段逻辑漂移。所以这里算出来的 intent
     * 就是唯一的依据来源，界面只负责显示，不负责推算。
     *
     * 道具型 / 姿态型是**位置无关**的，所以那两条是精确预告，不是估计。
     */
    /* 槽位指派（v11.4-h）——**围而不堵**
       ------------------------------------------------------------
       外部参考（L4D 的 attack slots、阿卡姆的攻击令牌、Unity 社区的 Surround AI）
       在这一点上高度一致：**让每只怪各自寻路到玩家是行不通的**，
       要有一个外层把"玩家身旁的那几格"分配给它们。

       原因是数学上的：目标集只有玩家四邻那 4 格，从同一侧来的怪对这 4 格的
       路径长度排序高度一致，于是每只怪都"理性地"选同一个最优格 ——
       那不是 bug，是各自寻路到同一目标的必然均衡。
       实测把这条钉死了：目标格冲突率只有 1.7%（**没有排队**），
       但它们走得动却落不到玩家四邻的比例是 86% —— 不是堵住了，
       是排在同一条线上、从同一个方向来。

       做法（参考里最省的版本，不需要匈牙利算法）：
         · 取玩家四邻里可走的格作为槽位；
         · 把本区最近的 ≤4 只怪与槽位做一次全排列匹配（最多 4! = 24 次比较），
           取"总曼哈顿距离最小"的那个排列；
         · 每只怪寻路到**自己的槽位**，不再寻路到玩家。
       用曼哈顿距离而不是真路径：这里只需要一个**分配**，
       真路径交给各自的 A*，代价小一个数量级。
       玩家挪一格就重算（24 次比较，可以忽略）——
       这也顺带解决了"玩家一动手，所有怪又挤回同一格"。 */
    _assignSlots() {
      if (!this.slots) { for (const e of this.enemies) e.slot = null; return; }
      // 注意：**不能在这里先把所有人的槽位清空**。
      // 粘性要读的就是"上一回合分到的那一格"，先清掉等于把粘性关掉 ——
      // 而这个 bug 的症状是"什么都没变"（数值与不加粘性时逐位相同），
      // 比崩溃难查得多。清理放在最后：既没粘住、也没分到的才作废。
      const NB = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      const open = [];
      for (const d of NB) {
        const x = this.px + d[0], y = this.py + d[1];
        if (this.walkable(x, y)) open.push({ x: x, y: y });
      }
      if (!open.length) return;
      const r = this.regionAt(this.px, this.py);
      /* 粘性：上一回合已经拿到槽位、槽位仍然开放、且自己离它 <=3 的，直接续用。
         ------------------------------------------------------------
         不这么做会出现**抢椅子**：玩家每挪一格就重分一次，而"最近的 4 只"
         与"4 个槽位"的最小指派两次可能给出不同的配对 —— 两只怪于是每回合
         互换槽位，两个都走不到，却在数据上表现为"它们一直在动"，
         从别的指标完全看不出来。这是这一整套里最隐蔽的一种失败。 */
      const taken = {}, stuck = new Set();
      for (const e of this.enemies) {
        if (e.region !== r || e.hp <= 0 || e.stun > 0 || !e.slot) continue;
        if (Math.abs(e.x - this.px) + Math.abs(e.y - this.py) <= 1) continue;
        let si = -1;
        for (let s = 0; s < open.length; s++) {
          if (open[s].x === e.slot.x && open[s].y === e.slot.y) { si = s; break; }
        }
        if (si < 0 || taken[si]) continue;
        if (Math.abs(e.x - e.slot.x) + Math.abs(e.y - e.slot.y) > 3) continue;
        taken[si] = 1;
        stuck.add(e);
      }
      const cand = [];
      for (const e of this.enemies) {
        if (e.region !== r || e.hp <= 0 || e.stun > 0) continue;
        const d2 = Math.abs(e.x - this.px) + Math.abs(e.y - this.py);
        if (d2 <= 1) continue;        // 贴身了：它这一步是出手，不是移动
        if (stuck.has(e)) continue;   // 已经粘住的：不参与重分
        cand.push({ e: e, d: d2 });
      }
      if (!cand.length) return;
      cand.sort(function (a, b) { return a.d - b.d; });
      const freeCount = open.length - Object.keys(taken).length;
      const head = cand.slice(0, Math.max(0, freeCount));
      if (!head.length) return;
      let best = null, bestCost = Infinity;
      const used = [], perm = [];
      for (const s in taken) used[s] = 1;   // 被粘住的槽位不参与重分
      const walk = function (i, cost) {
        if (cost >= bestCost) return;
        if (i === head.length) { bestCost = cost; best = perm.slice(); return; }
        for (let s = 0; s < open.length; s++) {
          if (used[s]) continue;
          used[s] = 1; perm[i] = s;
          walk(i + 1, cost + Math.abs(head[i].e.x - open[s].x) + Math.abs(head[i].e.y - open[s].y));
          used[s] = 0;
        }
      };
      walk(0, 0);
      if (!best) return;
      for (let i = 0; i < head.length; i++) head[i].e.slot = open[best[i]];
      // 没粘住也没分到槽位的：槽位作废。
      // 留着过期槽位比没有更糟 —— 它会朝一个玩家早就不在的格子走。
      for (const e of this.enemies) {
        if (!e.slot || stuck.has(e)) continue;
        let kept = false;
        for (let i = 0; i < head.length; i++) if (head[i].e === e) { kept = true; break; }
        if (!kept) e.slot = null;
      }
    }

    /**
     * 让一只怪朝目标挪一步。**只挪，不打** —— 出手是 enemyHit 的事，
     * 它只在回合推进里结算。这条边界不能糊：让"挪动的那个函数"顺手打一下，
     * 玩家就会在战斗画面里被画面外的怪打死，而那条伤害没有任何演出能解释。
     * @returns {boolean} 真的挪动了吗
     */
    _stepEnemyTowardPlayer(e) {
      // 贴身了就该出手，不该挪
      if (Math.abs(e.x - this.px) + Math.abs(e.y - this.py) <= 1) return false;
      let tx = this.px, ty = this.py;
      if (e.slot) {
        // 已经站在自己的槽位上就**停下**。少了这一条，它会继续朝玩家挤，
        // 把刚分好的四邻又挤成一个方向 —— 那就白分了。
        if (e.x === e.slot.x && e.y === e.slot.y) return false;
        tx = e.slot.x; ty = e.slot.y;
      }
      const path = this.findPath(e.x, e.y, tx, ty, 260, 0, e.region);
      if (!path || path.length < 2) return false;
      const n = path[1];
      if (this.enemyAt(n.x, n.y) || (n.x === this.px && n.y === this.py)) return false;
      e.x = n.x; e.y = n.y;
      return true;
    }

    /* 战斗中的世界时钟（v11.4-h）——治"冻结税"
       ------------------------------------------------------------
       两条时间轴对不上：一场仗打 2~3 **轮**，而整局只推进 1 个**回合**
       （_afterAction 在整场对决收尾时才走一次）。于是整个战斗期间地图是冻结的，
       旁边那只怪一步也没挪 —— 实测被冻结的世界回合占整局的 **9.4%**，
       也就是"玩家对全体怪物享有约 1.1 倍额外相对速度"，而且战斗越频繁越高。

       改前的 A1 看不到这件事：那时一场仗就是 1 轮，1 仗 ≈ 1 回合，两条轴一致。
       是 A1 把战斗拉长之后，这个税才第一次出现。

       注意它**不是**"让敌人变快"：这里推进的是它们本来就有的时钟（cd），
       只是把"一轮 = 一个世界回合"这条对齐。整场仗里它们能挪的次数
       仍然是 轮数/2 —— 与在战斗外跑同样多的世界回合完全一致。

       参与者排除在外：它们正在对决里挨打，模型坐标不该被另一个循环再改一次。
       潮汐**不**跟着走 —— 潮水按回合涨，那是它自己的时钟。 */
    _fightRoundTick(participants) {
      if (!this.tick) return;
      const r = this.regionAt(this.px, this.py);
      this._assignSlots();
      for (const e of this.enemies) {
        if (participants && participants.indexOf(e) >= 0) continue;
        if (e.region !== r || e.stun > 0) continue;
        e.cd++;
        if (this.alert || e.cd % 2 === 0 || e.kind === 'elite' || e.kind === 'boss') {
          this._stepEnemyTowardPlayer(e);
        }
      }
    }

    _decideEnemy(e) {
      const gated = (e.region !== undefined && e.region >= 0 &&
                     this.regionAt(this.px, this.py) !== e.region);
      const dist = Math.abs(e.x - this.px) + Math.abs(e.y - this.py);
      let it;
      if (e.stun > 0) it = { kind: 'stunned' };
      else if (gated) it = { kind: 'idle' };
      else if (dist <= 1) {
        const pv = this._enemyPreview(e);
        it = { dmg: pv.dmg, type: pv.type, crit: pv.crit, dodge: pv.dodge, lethal: pv.lethal };
        it.kind = 'strike';
      } else it = { kind: 'approach' };

      // 顺带会发生的事：用和实际执行**同一套判断**推导，不做第二份实现。
      // 孵化在 endTurn 里判的是 this.turn % every === 0，而那一刻 turn 已经 +1，
      // 所以在这里要提前一格判。
      if (e.arc && e.arc.spawn &&
          (this.turn + 1) % e.arc.spawn.every === 0) it.spawn = true;
      // _tickStance 是 "先减、减到 0 才切"，所以剩 1 就是"下一次行动必定切"。
      if (e.stance && e.stanceT === 1) it.shift = stanceFlip(e.stance);

      e.intent = it;
    }

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
      this.layerKills++;
      if (enemy.kind === 'elite') this.eliteKills++;
      if (enemy.kind === 'boss') this.bossKills++;
      this.events.push({ kind: 'kill', enemy: enemy });
      const fl = this.flags();
      // 叠层也夹住。不夹的话 devourStacks 会一路涨到几百：面板虽然被夹住了，
      // 但这个数字会被别处读到（平衡统计、调试输出、将来的界面）。
      if (num(fl.devour) > 0) {
        this.devourStacks = Math.min(D.COMBAT.devourMaxStacks,
          this.devourStacks + num(fl.devour));
      }

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
      const out = [];
      const pool = D.RELICS.filter((r) => !this.hasRelic(r.id));
      while (out.length < D.PROGRESSION.offerCount && pool.length) {
        out.push(pool.splice(this.rng.int(0, pool.length - 1), 1)[0]);
      }
      // 池子不够就把候选补满（对齐《云顶之弈》：永远给满、永远能选一张继续）。
      // 这一条同时消掉了"空候选"这个状态本身 —— 而不是在每个读它的地方打补丁。
      while (out.length < D.PROGRESSION.offerCount) {
        out.push(D.RELIC_FALLBACKS[(out.length + this.depth) % D.RELIC_FALLBACKS.length]);
      }
      return out;
    }

    chooseRelic(id) {
      const fb = D.RELIC_FALLBACKS.filter((f) => f.id === id)[0];
      if (fb) { this._grantFallback(fb); this.pendingRelic = null; return; }
      this.relics.push(id);
      this.pendingRelic = null;
      const r = this._relicById(id);
      if (r) this._log('获得秘藏：' + r.name, 'good');
      this.events.push({ kind: 'relic', id: id });
    }

    /** 兑现一张「潮汐馈赠」。
     *  池子抽干之后这个阶段仍然存在（不弹空面板、也不把输入挡住），
     *  只是选项换成即时收益。 */
    _grantFallback(fb) {
      const gr = fb.grant || {};
      const st = this.stats();
      if (gr.gold) {
        const amount = D.RELIC_FALLBACK.goldBase + this.depth * D.RELIC_FALLBACK.goldPerDepth;
        this.gold += amount;
        this.events.push({ kind: 'gold', amount: amount });
        this._log('潮汐馈赠：+' + amount + ' 金币。', 'good');
      } else if (gr.healFrac) {
        const heal = Math.round(st.hp * gr.healFrac);
        this.hp = Math.min(st.hp, this.hp + heal);
        this.events.push({ kind: 'heal', amount: heal });
        this._log('潮汐馈赠：回复 ' + heal + ' 点生命。', 'good');
      } else if (gr.item) {
        const it = this.makeItem({ depth: this.depth + 1 });
        if (this.bag.length < this.bagCap()) {
          this.bag.push(it);
          this.events.push({ kind: 'loot', item: it });
          this._log('潮汐馈赠：' + it.name + '（' + it.rarityName + '）', 'loot');
        } else {
          const amount = D.RELIC_FALLBACK.goldBase;
          this.gold += amount;
          this.events.push({ kind: 'gold', amount: amount });
          this._log('背包已满，馈赠折算为 ' + amount + ' 金币。', 'warn');
        }
      }
      this.events.push({ kind: 'relic', id: fb.id });
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
      if (this.status !== 'playing' || this.hasPendingRelic()) return false;
      if (!this.walkable(x, y)) return false;
      const e = this.enemyAt(x, y);
      if (e) {
        // 一次接触 = 把这一圈一起拉进来。名单在这里定下来，
        // 之后开的这场对决就与地图上谁还站在旁边无关了。
        const squad = this._squadAt(x, y);
        if (!this.headless) {
          // 逐回合：这里只**开局**，每一轮选哪一路交给战斗界面。
          //
          // 绝不在这里调 _afterAction —— 收尾必须等对决真正打完。
          // 提前收尾的后果是"你倒下了"的结算面板会和战斗演出同时出现，
          // 玩家看到的是自己一边挨打一边被宣告死亡。
          const L = this._fightBegin(squad);
          this.liveFight = L;
          this.events.push({
            kind: 'duel', enemy: e, enemies: squad, target: e, duel: L.duel,
            aHp0: L.hp0, bHp0: L.ehp0, bHp0s: L.ehp0s
          });
          return true;
        }
        // 无头模拟：一路按 AI 的策略打完，不需要人做决定。
        // 开的时传 null（= 别在这里预选，省下那一个随机数）；
        // 关的时走 attackTypeFor，和 v11.3-a 的路径**逐字相同** ——
        // 对照组的意义就在这里，少一个随机数它就不是对照组了。
        if (this.aiStance) this.fight(squad, null, this._autoPicker());
        else this.fight(squad, this.attackTypeFor(e));
        if (this.status === 'playing') this._afterAction();
        return true;
      }

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
      return this.status === 'playing' && !this.hasPendingRelic() && this.skillCd <= 0;
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
      if (this.hasPendingRelic()) return { ok: false, reason: 'pending' };
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
      // to = 落点。**必须有**：技能会顺带推进一回合，敌人随后就会自己走回来，
      // 所以"事后读 e.x"读到的是它走回来的位置，不是被掀开的位置 ——
      // 那条断言会随敌人 AI 的任何改动而失败，而它本来想测的是击退。
      this.events.push({ kind: 'knock', enemy: e, from: { x: ox, y: oy }, to: { x: cx, y: cy } });
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
        // 踩水是真实伤害：它不走 rawDamage，无视一切防御。
        // 标出来是为了让画面能给出正确的颜色 —— 玩家看到冷白色的数字，
        // 就会明白"这不是它能防住的东西"，而不必读任何说明。
        this.events.push({ kind: 'corrode', dmg: dmg, type: 't' });
        if (this.hp <= 0) { this._die('潮水'); return; }
      }

      // 敌人行动
      // 每回合先把"玩家身旁那几格"分给不同的怪。
      // 放在敌人循环**之前**，因为分配是这一回合整体的事，
      // 边打边分会让先行动的怪占便宜、后行动的白跑一步。
      this._assignSlots();
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
        // 姿态推进。放在"确认这一轮真的要行动"之后 ——
        // 被震晕或不在同一区的怪不消费姿态，否则玩家会看到
        // "它明明没动，姿态却变了"，节奏线索当场断掉。
        this._tickStance(e);
        const dist = Math.abs(e.x - this.px) + Math.abs(e.y - this.py);
        if (dist <= 1) {
          this.enemyHit(e);
        } else {
          // 逼近节奏：默认每 2 回合挪一步 —— 所有怪每回合都动会让"绕开"变成不可能。
          // 但**玩家所在的那个房间**（区域门禁已经筛过）是惊动的：每回合都挪。
          // 没有这一步，它们在 1 格/回合的玩家面前永远追不上 ——
          // 玩家会在空地上把甲虫一只只点名，而"围上来"始终只是文案。
          e.cd++;
          if (this.alert || e.cd % 2 === 0 || e.kind === 'elite' || e.kind === 'boss') {
            this._stepEnemyTowardPlayer(e);
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
                // 换掉模板之后必须**重算姿态**。
                // _makeEnemy 是按随机模板建的，可能抽到镜影而带上了姿态；
                // 这里把 arc/stats 覆盖成黏液怪之后，那份姿态就变成了无主之物，
                // 会让一只 2/2 的小怪挂着"硬化"光环、并持续制造假的姿态切换事件。
                c.stance = canStance(c.stats, mini) ? (this.rng.chance(0.5) ? 'p' : 'm') : null;
                c.stanceT = D.STANCE.every;
                this.enemies.push(c);
                this.events.push({ kind: 'spawn', enemy: c });
                break;
              }
            }
          }
        }
      }
      this._recomputeFOV();
      // 意图预告：敌人全部行动完之后，为**下一回合**重算一遍预告。
      // 必须放在敌人行动之后 —— 放在之前，玩家看到的就不是预告而是回放。
      for (const e2 of this.enemies) this._decideEnemy(e2);
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
          seed: seed,
          aiFumble: opts.aiFumble,
          counterBonus: opts.counterBonus,
          // 战斗内姿态轮换的开关。**必须能被外面关掉**：
          // 开着跑出来的通关率和关着跑出来的差多少，就是这条机制的全部代价，
          // 而"代价"这件事只能靠对照实验回答，不能靠看代码猜。
          aiStance: opts.aiStance,
          squad: opts.squad,
          slots: opts.slots,
          tick: opts.tick,
          alert: opts.alert
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
      this.headless = true;   // 让 attackTypeFor 走 AI 的选择
      const limit = maxTurns || 1200;
      let stall = 0;
      const trace = [];
      while (this.status === 'playing' && this.turn < limit && stall < 40) {
        if (this.hasPendingRelic()) { this._autoRelic(); continue; }
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
        if (r.grant) {
          // 补位卡（潮汐馈赠）：只有在候选里只剩馈赠时，才需要比较彼此。
          const st = this.stats();
          if (r.grant.gold) sc += 20 + this.depth * 4;
          if (r.grant.healFrac) sc += (this.hp < st.hp * 0.7) ? 55 : 10;
          if (r.grant.item) sc += 34;
        } else {
          // 真秘藏是**永久**的，必须永远优先于一次性馈赠。
          // 这条基线要高于馈赠的最高分（55），否则 AI 会在收尾时拿 40 金币
          // 换掉一件永久秘藏 —— 实测过：漏的那一刻，恰好是最低分的
          // batfang(0.14) 和 gambler(-8.6) 被换掉，秘藏分布直接偏掉 8%。
          sc += 70;
          if (r.flags) sc += 60;
          if (r.mods) for (const k in r.mods) {
            const v = r.mods[k];
            sc += (k === 'hp' ? v * 0.35 : v * (k === 'spd' ? 1.4 : 1.0));
          }
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
        /* 触发条件 = “身边有人”，不再是“这一下能收掉它”。
           ------------------------------------------------------------
           旧条件里的 killOne 是**旧战斗长度的残留**：那时杂兵一刀就死
           （实测普通怪 92% 在第一轮分胜负），“裂地斩能收掉它”几乎总成立，
           这条分支也就几乎总能命中。
           普通怪血量按 A1 上调之后，一刀收掉不再可能 —— 它变成**永不成立**：
           实测破军一整局有 58% 的概率一次魂技都不放（其余三个职业 0~10%）。
           那不只是“AI 变保守”：它让魂技这个机制在模拟器里**完全不存在**，
           而模拟器的通关率正是本作唯一的验收标准。冒烟抓到的是同一件事。
           而这个技能的全部价值本来也不在那一刀伤害（0.90×），
           在“揀开一格 + 撞墙震晕 + 不吃反击”—— 也就是它文案里写的
           「被贴身就一定能反打」。贴身本身就是它要解决的压力，
           所以贴身就是它的触发条件。冷却 10 回合是它自己的限流，
           AI 不需要再替它省一次。 */
        const adj = this.enemies.filter(function (e) { return dist(e) === 1; });
        if (adj.length >= 1) return this.useSkill().ok;
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
      const st = this.stats();
      const dv = stanceDef(e.stats, e.stance);
      // 魂技的类型由**文案声明**（裂地斩=物理、潮语洪流=法术），不再自动择优。
      // 原来这里用 bestAttack，会出现"文案写着物理、实际打出法术伤害"——
      // 那是系统骗人：玩家照着面板做的构筑会莫名其妙失效，而且无从察觉。
      // 没有 dtype 的技能（纯增益类）沿用择优，因为它们本来就不产生伤害。
      const atk = s.dtype ? attackVia(st, dv, s.dtype, this.K)
                          : bestAttack(st, dv, this.K);
      let base = atk.base;
      // 针对词条必须在这里也生效。
      // 少了这一段会出现最坏的一种不一致：秘藏写着「对召唤物 +45%」，
      // 普攻吃到了、魂技没吃到 —— 玩家只能认为是 bug，而且他会开始不信任所有面板数字。
      const fl = this.flags();
      if (num(fl.vsMul) > 0 && fl.vsTag && e.tags && e.tags.indexOf(fl.vsTag) >= 0) {
        base *= (1 + num(fl.vsMul));
      }
      return { dmg: Math.max(1, Math.round(base * s.dmgPct)), type: atk.type };
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
        // ★ v11.4-e：本层刷够了就不主动找架打，直接往下走。
        //   潮汐会无限补充敌人，而"打最近的敌人"这条策略加上它，
        //   会让 AI 永远在打、永远不离开（实测第 4 层 700 杀、满血、
        //   2400 回合撞上限）。见 PROGRESSION.leaveLayerAfterKills。
        //   被堵住时仍然会打 —— 下面那段"贴脸兜底"没动。
        if (!g && this.layerKills < D.PROGRESSION.leaveLayerAfterKills) {
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
          // AI 也必须按**群战**打，否则它按 1v1 打、玩家按 1v4 打，
          // 模拟器给出的通关率就和真人脱节了（它现在只是下限）。
          const sq = this._squadAt(e.x, e.y);
          if (this.aiStance) this.fight(sq, null, this._autoPicker());
          else this.fight(sq, this.attackTypeFor(e));
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
          // AI 也必须按**群战**打，否则它按 1v1 打、玩家按 1v4 打，
          // 模拟器给出的通关率就和真人脱节了（它现在只是下限）。
          const sq = this._squadAt(e.x, e.y);
          if (this.aiStance) this.fight(sq, null, this._autoPicker());
          else this.fight(sq, this.attackTypeFor(e));
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
    rawDamage: rawDamage, bestAttack: bestAttack, tagsOf: tagsOf, num: num,
    // attackVia 要给界面用：战斗菜单上那两行"攻 X → 防 Y"就是它算的。
    // 让界面自己复刻一遍公式是绝对的禁区 —— 复刻件一旦和真公式漂移，
    // 菜单会持续给出错的入参，而玩家会先怀疑自己算错。
    attackVia: attackVia,
    canStance: canStance, stanceDef: stanceDef, stanceFlip: stanceFlip,
    WALKABLE: WALKABLE, OPAQUE: OPAQUE
  };
})(typeof window !== 'undefined' ? window : globalThis);
