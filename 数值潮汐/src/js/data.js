/* ============================================================
   数值潮汐 · 数据层 v4
   所有可调数值集中在这里，逻辑层不写死任何数字。

   设计原则（沿用并强化）：
   1. 每件遗物 / 每件传说装备都必须**改变某个约束边界**，而不只是加数值。
      「物理攻击 +6」是填充物，「速度达到 24 时每轮打两次」才是构筑点。
   2. 敌人必须偏科。全属性均衡的敌人只会让玩家无脑输出；
      偏科才会逼出「这一刀该用物理还是法术」的决策。
   3. 装备词条的数值区间随品质、随深度缩放，但**区间来源唯一**，
      不允许在两个表里各写一份（这个坑在 v3 踩过：同名字段被 Object.assign 静默覆盖）。
   ============================================================ */
(function (global) {
  'use strict';

  /* ============================================================
     一、战斗常数
     伤害 = 攻击 × K / (有效防御 + K)，有效防御 = max(0, 防御 − 对方穿透)
     K=50 时：防御 50 减免 50%，100 减免 66.7%，200 减免 80%。
     K 越小，堆防御的边际收益越容易爆炸，所以它必须是个显式常数。
     ============================================================ */
  const COMBAT = {
    K: 50,
    critMul: 1.9,
    speedGap: 18,      // 速度差达到该值，快的一方每轮多打一次
    // 一场对决的回合上限。超过就按剩余生命比例判定胜负，
    // 而不是"谁也没死"—— 否则吸血型敌人会和玩家形成永久僵持。
    maxRounds: 40,
    wetAmp: 0.25,      // 「潮湿」状态：受到的法术伤害 +25%（潮语洪流留下的破绽）
    /* 克制奖励：普攻选对伤害类型时，追加一段**真实伤害**（无视防御）。
       它的作用不是"补偿难度"，而是把「读懂敌人」变成**正收益**：
       只惩罚选错、不奖励选对，玩家学到的会是"别乱选"，而不是"要去看"。
       默认 0 —— 先让重构本身可验证（逐位对照），再单独打开它量影响。 */
    counterBonus: 0.25,

    /* 吞噬（遗物）的成长：每层 +2 物攻，但**有上限**。
       为什么必须封顶：它每击杀永久叠层、原实现无上限。实测深渊一局 70 杀
       就是 +280~420 物攻，而破军基础物攻只有 44 —— 6~10 倍。
       后果直接量得到：1v1 场次里玩家平均要打出 957 点伤害才杀得掉一只怪（v11.4-f 之前的口径），
       敌人一辈子没机会出手（均掉血 1.4），"每轮选一次"这类决策全部退化。
       上限取 10 层 = +20 物攻（对基础 44 是 +45%）：仍是爽点，但不再无限。
       放在这里而不是散在 core.js 里，是为了让"它有多强"只有一个出处。 */
    devourAtkPerStack: 2,
    devourMaxStacks: 10
  };

  /* ============================================================
     二、属性表
     core=true 的 8 项进属性面板主区，其余进副区。
     ============================================================ */
  const STATS = {
    hp:    { name: '生命上限', short: '生命', icon: 'hearts',           color: '#ff6b7a', core: true,  pct: false, desc: '归零即失败' },
    atkP:  { name: '物理攻击', short: '物攻', icon: 'broadsword',       color: '#ffa04d', core: true,  pct: false, desc: '物理伤害的基础值' },
    atkM:  { name: '法术攻击', short: '法攻', icon: 'magic-swirl',      color: '#a78bfa', core: true,  pct: false, desc: '法术伤害的基础值' },
    penP:  { name: '物理穿透', short: '物穿', icon: 'armor-punch',      color: '#fb923c', core: true,  pct: false, desc: '直接削减对手物防' },
    penM:  { name: '法术穿透', short: '法穿', icon: 'magic-shield',     color: '#8b5cf6', core: true,  pct: false, desc: '直接削减对手法防' },
    defP:  { name: '物理防御', short: '物防', icon: 'checked-shield',   color: '#60a5fa', core: true,  pct: false, desc: '按 K/(K+防) 递减减伤' },
    defM:  { name: '法术防御', short: '法防', icon: 'shield-reflect',   color: '#22d3ee', core: true,  pct: false, desc: '同物防，管法术那一路' },
    spd:   { name: '速度',     short: '速度', icon: 'wingfoot',         color: '#34d399', core: true,  pct: false, desc: '领先 18 点可每轮多打一次' },
    crit:  { name: '暴击率',   short: '暴击', icon: 'crossed-swords',   color: '#fbbf24', core: false, pct: true,  desc: '暴击造成 1.9 倍伤害' },
    leech: { name: '吸血',     short: '吸血', icon: 'droplets',         color: '#f472b6', core: false, pct: true,  desc: '按造成伤害的比例回血' },
    dodge: { name: '闪避',     short: '闪避', icon: 'dodging',          color: '#93c5fd', core: false, pct: true,  desc: '完全免掉一次攻击' },
    luck:  { name: '幸运',     short: '幸运', icon: 'clover',           color: '#86efac', core: false, pct: false, desc: '提升装备掉落品质' }
  };
  const CORE_STATS = ['hp', 'atkP', 'atkM', 'penP', 'penM', 'defP', 'defM', 'spd'];
  const SUB_STATS = ['crit', 'leech', 'dodge', 'luck'];

  /* ============================================================
     三、职业
     每个职业给一组**有方向**的初始面板 + 一条改变约束的被动。
     外观差异靠 heroStyle（躯干色 / 披风色 / 武器类型），
     武器类型直接决定 art.js 里画哪把武器的像素图。
     ============================================================ */
  const CLASSES = [
    {
      key: 'warlord', name: '破军', title: '重刃武士',
      weapon: 'greatsword', blurb: '把敌人剁碎，是最好的防御。',
      playstyle: '物攻流 · 越杀越强',
      stats: { hp: 130, atkP: 44, atkM: 8, penP: 6, penM: 0, defP: 12, defM: 4, spd: 11, crit: 0.05, leech: 0, dodge: 0, luck: 0 },
      passive: { key: 'slayer', name: '嗜血斩', text: '每击杀一名敌人，永久获得 +2 物攻、+1 物穿' },
      style: { skin: '#e8b48a', hair: '#8a4b2a', body: '#b8434a', trim: '#f0c04a', cloth: '#5b2b30', metal: '#c9d4e0' }
    },
    {
      key: 'arcanist', name: '秘仪', title: '潮语术士',
      weapon: 'staff', blurb: '让石头长出裂缝，只需要一句正确的话。',
      playstyle: '法伤流 · 击杀回血',
      stats: { hp: 96, atkP: 12, atkM: 46, penP: 0, penM: 8, defP: 5, defM: 12, spd: 10, crit: 0.05, leech: 0, dodge: 0.04, luck: 1 },
      passive: { key: 'attunement', name: '潮语共鸣', text: '用法术击杀敌人时，回复 10% 最大生命' },
      style: { skin: '#e8b48a', hair: '#2f5fa8', body: '#4a3f8f', trim: '#7ee0d6', cloth: '#2b2a52', metal: '#9ad8ff' }
    },
    {
      key: 'ranger', name: '疾风', title: '潮痕游侠',
      weapon: 'bow', blurb: '先开火的人，才有资格谈防御。',
      playstyle: '速度流 · 抢先手',
      stats: { hp: 108, atkP: 34, atkM: 14, penP: 5, penM: 3, defP: 6, defM: 8, spd: 26, crit: 0.14, leech: 0, dodge: 0.08, luck: 1 },
      passive: { key: 'firstblood', name: '先手', text: '每场战斗的第一轮必定先攻，且该轮伤害 +40%' },
      style: { skin: '#dfae82', hair: '#3f6b3a', body: '#3f7a52', trim: '#d9c27a', cloth: '#2f4a35', metal: '#b8c4b0' }
    },
    {
      key: 'warden', name: '铁壁', title: '潮汐守誓者',
      weapon: 'hammer', blurb: '你尽管冲，最后站着的一定是我。',
      playstyle: '坦克流 · 残血更硬',
      stats: { hp: 168, atkP: 28, atkM: 16, penP: 4, penM: 4, defP: 18, defM: 18, spd: 8, crit: 0.03, leech: 0.04, dodge: 0, luck: 0 },
      passive: { key: 'oath', name: '不退之誓', text: '生命低于 50% 时，双防 +60%；每场战斗结束后回复 8% 最大生命' },
      style: { skin: '#d9a878', hair: '#c9c9d4', body: '#7d8794', trim: '#f0d060', cloth: '#4a525e', metal: '#dfe8f2' }
    }
  ];
  const classByKey = function (k) {
    for (const c of CLASSES) if (c.key === k) return c;
    return CLASSES[0];
  };

  /* ============================================================
     魂技 —— 每个职业一个主动技能 + 冷却（设计取自《元气骑士》）

     元气骑士里最提气的一环是"每个角色有自己的技能"：它和普攻是两种东西 ——
     普攻负责"一直有输出"，技能负责"在正确的时机换一个局面"。
     所以这里四个技能都不做纯数值加成，各自换掉一种压力：

       裂地斩    换掉走位压力（被贴身就一定能反打，且不吃反击）
       潮语洪流  换掉距离压力（隔着半张图也能先手削一刀）
       疾影      换掉回合压力（额外行动，且不推进潮汐）
       不退之壁  换掉血量压力（残血时的保命符）

       群攻（v11.4-k）：被围住时"一次只打一个"本身就成了一种压力。
       裂地斩本来就打满四邻、潮语洪流打 4 个、疾影这一轮横扫 ——
       三个输出职业各有一条"被围住反而不亏"的路。铁壁不参与：
       它的答案是"硬"，把反伤与双防当群战的解法；
       给四个职业各塞一个横扫，反而把职业差异抹平了。

     规则全部在模型层（core.js 的 useSkill），界面只负责把它画出来 ——
     否则模拟器的 AI 学不会用它，平衡数据就会虚高。
     ============================================================ */
  const SKILLS = {
    warlord: {
      key: 'quake', name: '裂地斩', icon: 'armor-punch', cd: 10, cost: 1,
      kind: 'burst', radius: 1, dmgPct: 0.90, tint: '#e0a860',
      // dtype = 这个技能**固定**打哪一路。文案里已经写死了「物理伤害」/
      // 「法术伤害」，代码必须兑现它 —— 否则就是系统骗人。
      dtype: 'p',
      knockback: 1, stun: 1,
      text: '对相邻的每个敌人各造成一次物理伤害（不吃反击），并把它们掀开一格；' +
        '撞在墙上掀不动的会被震晕 1 回合'
    },
    arcanist: {
      key: 'torrent', name: '潮语洪流', icon: 'waves', cd: 9, cost: 1,
      /* count 3 → 4（v11.4-k）：群战的名单上限就是 4（主角四邻），
         打 3 个永远差一个 —— 而"差一个"在一场 1v4 里是致命的：
         留下的那只下一轮照样打你。4 是让这条技能在群战里成立的**最小**值。 */
      kind: 'ray', count: 4, range: 7, dmgPct: 0.85, tint: '#8fdff0',
      dtype: 'm',
      wet: 2,
      text: '对视野内最近的 4 个敌人各造成一次法术伤害，并让它们「潮湿」2 回合 —— ' +
        '潮湿期间受到的法术伤害 +25%'
    },
    ranger: {
      key: 'blitz', name: '疾影', icon: 'running-shoe', cd: 8, cost: 0,
      kind: 'free', moves: 2, dmgOut: 0.35, cleave: 0.5, tint: '#7ee0d6',
      text: '获得 2 次免费行动（不推进潮汐、敌人也不会动），期间你的攻击 +35%、普攻横扫一圈'
    },
    warden: {
      key: 'bulwark', name: '不退之壁', icon: 'stone-wall', cd: 12, cost: 1,
      kind: 'buff', turns: 3, mul: { defP: 2.5, defM: 2.5 }, healPct: 0.22,
      flags: { thorns: 0.5 }, tint: '#f0d060',
      text: '3 回合内双防 ×2.5、反弹 50% 受到的伤害，并立刻回复 22% 生命'
    }
  };
  const skillByClass = function (k) { return SKILLS[k] || SKILLS.warlord; };

  /* ============================================================
     魂技在**对决里**的本轮效果（v11.5 P3 第二步）

     为什么单独一张表、而不是往 SKILLS 里加字段：
     SKILLS 描述的是"这个技能在地图上做什么"（范围、落点、掀开、潮湿……），
     而对决里只有"我方一个单位、对方至多四个单位"这一个场景，
     "最近的 4 个敌人""相邻每个敌人"这些概念一个都不成立。
     两套语义共用一张表，迟早会有一处读到另一处的字段 ——
     这张表只回答一件事：**这一轮的算式被改成了什么**。

     取值口径（按工作单定稿）：
       quake   裂地斩   本轮伤害 ×1.6，但本轮自身受伤 ×0.5
       torrent 潮语洪流 本轮无视姿态，按对方**弱化侧**结算
       blitz   疾影     本回合额外一次出手（不额外推进回合）
       bulwark 不退之壁 本轮免伤，并把**本来要挨的**那笔伤害的 40% 反弹回去

     每条都带 text：它是**给玩家看的那一句**，和数值写在同一行 ——
     文案与代码分家是本项目明令禁止的事（"面板文案必须说代码做的事"）。
     ============================================================ */
  const DUEL_SKILL = {
    quake:   { dmgOut: 1.6, taken: 0.5, short: '伤 ×1.6 / 受伤 ×0.5',
               text: '本轮伤害 ×1.6，自身受伤 ×0.5' },
    torrent: { breakStance: true,         short: '无视姿态 · 打弱化侧',
               text: '本轮无视姿态，按对方弱化侧结算' },
    blitz:   { extra: 1,                  short: '本回合多打一次',
               text: '本回合额外出手一次（不额外推进回合）' },
    bulwark: { taken: 0, thorns: 0.4,     short: '本轮免伤 · 反伤 40%',
               text: '本轮免伤，并反弹本来要挨的那笔伤害的 40%' }
  };

  /**
   * 取某个魂技在对决里的本轮效果。
   * 认的是 **s.key**（'quake' / 'torrent' / 'blitz' / 'bulwark'）——
   * 也就是"这个技能本来是哪个职业的技"，它在三选一（v11.4-q）之后
   * 不随"谁拿着它"改变，所以带着破军技的秘仪拿到的仍是重击那一套。
   * 返回 null = 这个技能没有对决形态（界面据此把它灰掉，不是藏起来）。
   */
  const duelSkillFx = function (s) {
    if (!s || !s.key) return null;
    return DUEL_SKILL[s.key] || null;
  };

  /* ============================================================
     四、品质
     权重随深度平移：浅层几乎只有普通/精良，深层才见得到传说。
     color 同时用于 UI 描边与掉落光柱。
     ============================================================ */
  const RARITIES = [
    { key: 'common',    name: '普通', color: '#9aa4b2', glow: 'rgba(154,164,178,.35)', affixes: 0, weight: 100, power: 1.00 },
    { key: 'uncommon',  name: '精良', color: '#5fbf6a', glow: 'rgba(95,191,106,.40)',  affixes: 1, weight: 46,  power: 1.18 },
    { key: 'rare',      name: '稀有', color: '#4a9df0', glow: 'rgba(74,157,240,.45)',  affixes: 2, weight: 17,  power: 1.42 },
    { key: 'epic',      name: '史诗', color: '#b06cf0', glow: 'rgba(176,108,240,.50)', affixes: 3, weight: 5,   power: 1.72 },
    { key: 'legendary', name: '传说', color: '#f0a03c', glow: 'rgba(240,160,60,.60)',  affixes: 4, weight: 1.2, power: 2.15 }
  ];
  const rarityByKey = function (k) {
    for (const r of RARITIES) if (r.key === k) return r;
    return RARITIES[0];
  };
  /** 品质档位排序：common=0 … legendary=4。**全项目只用这一个顺序。** */
  const rarRank = function (k) {
    for (let i = 0; i < RARITIES.length; i++) if (RARITIES[i].key === k) return i;
    return -1;
  };

  /* ============================================================
     战力权重 —— **全项目唯一的装备强度口径**

     为什么必须只有一份：在这之前项目里同时存在两套算法
     （买装备用的 _itemScore、自动装备用的局部 score），权重还不一样。
     后果不是"数字不好看"，而是 AI 会「买下来了却不肯穿」——
     那种行为从外部看只是"AI 有点怪"，根因却是两个公式各自演化。

     权重的来由（按"一单位换多少"排，不是拍脑袋）：
       攻击 / 穿透 / 防御    主要乘区，1.0 上下
       速度                 影响先手（先手 = 少吃一轮伤害），给 1.5
       生命上限             按 0.3 折 —— 一场战斗的伤害远大于几十点血，
                            血在这里是"续航"不是"爆发"
       暴击 / 吸血 / 闪避     概率型，按期望收益折成固定点数
       机制型词条(flags)     无法线性量化，统一给一格的分
     ============================================================ */
  const POWER_W = {
    hp: 0.30, atkP: 1.00, atkM: 1.00, penP: 1.20, penM: 1.20,
    defP: 1.10, defM: 1.10, spd: 1.50,
    crit: 60, leech: 80, dodge: 60, luck: 3,
    flag: 35
  };

  /* ============================================================
     五、装备基底
     每个基底给一组**固有**属性（implicit），再叠加词条。
     bias 决定这件装备偏向哪一路，让「刷到的东西」自然有取舍：
     看到板甲就该知道它换不来速度。
     ============================================================ */
  const EQUIP_SLOTS = [
    { key: 'weapon',  name: '武器', icon: 'broadsword' },
    { key: 'helm',    name: '头盔', icon: 'visored-helm' },
    { key: 'chest',   name: '胸甲', icon: 'breastplate' },
    { key: 'boots',   name: '靴子', icon: 'leather-boot' },
    { key: 'trinket', name: '饰品', icon: 'ring' }
  ];

  const BASES = [
    /* —— 武器：决定你主要靠哪一路输出 —— */
    { id: 'shortsword', slot: 'weapon', name: '短剑',       icon: 'pointy-sword',  tier: 1, imp: { atkP: 9,  spd: 2 } },
    { id: 'greatsword', slot: 'weapon', name: '巨剑',       icon: 'broadsword',    tier: 2, imp: { atkP: 16, spd: -2 } },
    { id: 'warhammer',  slot: 'weapon', name: '战锤',       icon: 'warhammer',     tier: 2, imp: { atkP: 13, penP: 6 } },
    { id: 'dagger',     slot: 'weapon', name: '匕首',       icon: 'plain-dagger',  tier: 1, imp: { atkP: 6,  crit: 0.06 } },
    { id: 'longbow',    slot: 'weapon', name: '长弓',       icon: 'pocket-bow',    tier: 2, imp: { atkP: 10, spd: 5 } },
    { id: 'apprentice', slot: 'weapon', name: '学徒法杖',   icon: 'wizard-staff',  tier: 1, imp: { atkM: 10, penM: 3 } },
    { id: 'runestaff',  slot: 'weapon', name: '符文法杖',   icon: 'fairy-wand',    tier: 2, imp: { atkM: 17, penM: 8 } },
    { id: 'orb',        slot: 'weapon', name: '潮汐宝珠',   icon: 'crystal-ball',  tier: 3, imp: { atkM: 14, defM: 8 } },

    /* —— 头盔 —— */
    { id: 'leathercap', slot: 'helm', name: '皮盔',   icon: 'helmet',         tier: 1, imp: { defP: 4, dodge: 0.03 } },
    { id: 'ironhelm',   slot: 'helm', name: '铁盔',   icon: 'visored-helm',   tier: 1, imp: { defP: 8 } },
    { id: 'magehood',   slot: 'helm', name: '秘法兜帽', icon: 'hood',         tier: 2, imp: { defM: 9, atkM: 4 } },
    { id: 'crown',      slot: 'helm', name: '潮冠',   icon: 'crown',          tier: 3, imp: { defM: 7, luck: 3 } },

    /* —— 胸甲 —— */
    { id: 'clothrobe',  slot: 'chest', name: '布袍',  icon: 'robe',           tier: 1, imp: { defM: 6, hp: 14 } },
    { id: 'chainmail',  slot: 'chest', name: '锁甲',  icon: 'chain-mail',     tier: 2, imp: { defP: 11, hp: 22 } },
    { id: 'plate',      slot: 'chest', name: '板甲',  icon: 'breastplate',    tier: 3, imp: { defP: 17, defM: 6, spd: -3 } },
    { id: 'scalevest',  slot: 'chest', name: '鳞背心', icon: 'scale-mail',    tier: 2, imp: { defP: 7, defM: 7 } },

    /* —— 靴子 —— */
    { id: 'sandals',    slot: 'boots', name: '布鞋',   icon: 'sandal',         tier: 1, imp: { spd: 3 } },
    { id: 'leatherboot',slot: 'boots', name: '皮靴',   icon: 'leather-boot',   tier: 1, imp: { spd: 5, dodge: 0.03 } },
    { id: 'platedboot', slot: 'boots', name: '铁靴',   icon: 'metal-boot',     tier: 2, imp: { defP: 7, spd: -2 } },
    { id: 'windstep',   slot: 'boots', name: '疾风踏', icon: 'wingfoot',       tier: 3, imp: { spd: 11, dodge: 0.06 } },

    /* —— 饰品 —— */
    { id: 'copperring', slot: 'trinket', name: '铜戒',   icon: 'ring',           tier: 1, imp: { crit: 0.05 } },
    { id: 'amethyst',   slot: 'trinket', name: '紫晶坠', icon: 'gem-pendant',    tier: 2, imp: { atkM: 8, defM: 5 } },
    { id: 'skullcharm', slot: 'trinket', name: '骸骨符', icon: 'skull-ring',     tier: 2, imp: { leech: 0.06, atkP: 4 } },
    { id: 'tidewell',   slot: 'trinket', name: '潮汐心', icon: 'heart-bottle',   tier: 3, imp: { hp: 40, defM: 6 } },
    { id: 'gamblers',   slot: 'trinket', name: '赌徒骰', icon: 'rolling-dices',  tier: 3, imp: { crit: 0.12, luck: 4, hp: -18 } }
  ];
  const basesForSlot = function (slot) { return BASES.filter(function (b) { return b.slot === slot; }); };

  /* ============================================================
     六、词条池
     数值按 [min,max] 线性插值，再乘 (1 + 0.18×深度) 和品质 power。
     flags 类词条是构筑点，稀有度足够高才可能出现（weight 低）。
     ============================================================ */
  const AFFIXES = [
    { id: 'hp',      name: '生命',     icon: 'hearts',        stat: 'hp',    min: 10,  max: 22,  weight: 10 },
    { id: 'atkp',    name: '物攻',     icon: 'broadsword',    stat: 'atkP',  min: 3,   max: 8,   weight: 10 },
    { id: 'atkm',    name: '法攻',     icon: 'magic-swirl',   stat: 'atkM',  min: 3,   max: 8,   weight: 10 },
    { id: 'penp',    name: '物穿',     icon: 'armor-punch',   stat: 'penP',  min: 2,   max: 6,   weight: 8 },
    { id: 'penm',    name: '法穿',     icon: 'magic-shield',  stat: 'penM',  min: 2,   max: 6,   weight: 8 },
    { id: 'defp',    name: '物防',     icon: 'checked-shield',stat: 'defP',  min: 3,   max: 9,   weight: 10 },
    { id: 'defm',    name: '法防',     icon: 'shield-reflect',stat: 'defM',  min: 3,   max: 9,   weight: 10 },
    { id: 'spd',     name: '速度',     icon: 'wingfoot',      stat: 'spd',   min: 1,   max: 4,   weight: 9 },
    { id: 'crit',    name: '暴击率',   icon: 'crossed-swords',stat: 'crit',  min: 0.02,max: 0.06,weight: 7, pct: true },
    { id: 'leech',   name: '吸血',     icon: 'droplets',      stat: 'leech', min: 0.02,max: 0.05,weight: 5, pct: true },
    { id: 'dodge',   name: '闪避',     icon: 'dodging',       stat: 'dodge', min: 0.01,max: 0.04,weight: 5, pct: true },
    { id: 'luck',    name: '幸运',     icon: 'clover',        stat: 'luck',  min: 1,   max: 3,   weight: 5 },

    /* —— 构筑型词条：给机制，不给数字 —— */
    { id: 'thorns',  name: '荆棘',     icon: 'cactus',        flags: { thorns: 0.20 },  weight: 3, rare: true,
      text: '受到攻击时反弹 20% 伤害' },
    { id: 'echo',    name: '回响',     icon: 'sound-waves',   flags: { echo: 0.22 },    weight: 3, rare: true,
      text: '法术伤害有 22% 概率翻倍' },
    { id: 'exec',    name: '处决',     icon: 'swordman',      flags: { execute: 0.15 }, weight: 2, rare: true,
      // 原来的文案是「伤害 +15%→直接斩杀阈值」：它同时说了两件互相矛盾的事，
      // 而代码里**没有斩杀**，只有"低于 32% 时伤害 +15%"。玩家会照着一个
      // 不存在的斩杀线去构筑。文案必须说代码做的事，一个字都不多。
      text: '目标生命低于 32% 时，伤害 +15%' },
    { id: 'swift',   name: '疾行',     icon: 'running-shoe',  flags: { firstStrike: 0.28 }, weight: 3, rare: true,
      text: '速度高于目标时，伤害 +28%' },
    { id: 'regen',   name: '再生',     icon: 'regeneration',  flags: { regenAfterWin: 0.10 }, weight: 3, rare: true,
      text: '战斗胜利后回复 10% 生命' },
    // 吞噬系：devour 是**层数**，每层再 +2 物攻（见 core.js 的 stats()）。
    // 所以 flags.devour 2 / 3 对应的实际收益是 +4 / +6 物攻 ——
    // 文案原来写的是 +2 / +3，少算了一半。改文案而不是改数值：
    // 数值一动就会移动三档平衡基线，那该是单独的一次决定。
    // —— v11.4-c：那个"单独的一次决定"到了。见 COMBAT.devourMaxStacks
    //    上面的实测数据。上限 +20 物攻，文案同步写明。
    { id: 'devour',  name: '吞噬',     icon: 'tooth',         flags: { devour: 2 },     weight: 2, rare: true,
      text: '每击杀一名敌人，物理攻击 +4（最多 +20）' },
    { id: 'vampiric',name: '血契',     icon: 'vampire-dracula', flags: { leechBonusIfBleed: 0.5 }, weight: 2, rare: true,
      text: '生命低于一半时，吸血效果 +50%' },
    { id: 'bulwark', name: '壁垒',     icon: 'stone-wall',    flags: { lastStand: 0.55 }, weight: 2, rare: true,
      text: '生命低于 40% 时，双防 +55%' },
    { id: 'double',  name: '连击',     icon: 'crossed-swords',flags: { doubleAtSpd: 26 }, weight: 2, rare: true,
      text: '速度达到 26 时，每轮攻击两次' },

    /* 横扫（v11.4-k）—— 全项目第一条**限定部位**的词条。
       为什么要能限定部位：它不是数值，是"你怎么打"。挂在鞋子上
       （"疾风踏：普攻横扫一圈"）读起来就不对，而玩家遇到想不通的规则时
       第一反应是怀疑显示错了，不是怀疑设计。所以加一个 slot 字段，
       让"武器词条"成为一种真实约束。
       45% 是量出来的起点：它要够到"1v4 比 1v1 打四次划算"，
       又不能高到把单挑也变成横扫 —— 那时"踩进多只"这个取舍就没了。 */
    { id: 'cleave',  name: '横扫',     icon: 'cut-palm',      flags: { cleave: 0.45 },  weight: 6, rare: true,
      slot: 'weapon',
      text: '普攻同时波及同场的其他敌人，各造成 45% 伤害' }
  ];
  const affixById = function (k) {
    for (const a of AFFIXES) if (a.id === k) return a;
    return AFFIXES[0];
  };

  /* ============================================================
     七、遗物（潮汐秘藏，三选一）
     与装备的区别：遗物不进背包、不可替换、一局累积；
     装备可以换。两者都给机制，但遗物的机制更极端。
     ============================================================ */
  const RELICS = [
    { id: 'doublecut', name: '连环斩',   icon: 'cut-palm',      school: 'physical',
      text: '速度达到 26 时，每轮普攻两次', flags: { doubleAtSpd: 26 } },
    { id: 'overkill',  name: '过量打击', icon: 'barbed-sun',    school: 'physical',
      text: '物理攻击 +16，物理防御 −6',  mods: { atkP: 16, defP: -6 } },
    { id: 'sunder',    name: '破甲',     icon: 'armor-punch',   school: 'physical',
      text: '物穿 +14',                  mods: { penP: 14 } },
    { id: 'sweep',     name: '潮汐横扫', icon: 'cut-palm',      school: 'physical',
      text: '普攻同时波及同场的其他敌人，各造成 35% 伤害', flags: { cleave: 0.35 } },
    { id: 'ripple',    name: '涟漪',     icon: 'waves',         school: 'arcane',
      text: '普攻同时波及同场的其他敌人，各造成 30% 伤害', flags: { cleave: 0.30 } },

    { id: 'echoRune',  name: '奥术回响', icon: 'sound-waves',   school: 'arcane',
      text: '法术伤害有 28% 概率翻倍',   flags: { echo: 0.28 } },
    { id: 'focus',     name: '元素聚焦', icon: 'magic-swirl',   school: 'arcane',
      text: '法术攻击 +18，生命上限 −20', mods: { atkM: 18, hp: -20 } },
    { id: 'rift',      name: '裂隙',     icon: 'magic-shield',  school: 'arcane',
      text: '法穿 +14，法术攻击 +6',     mods: { penM: 14, atkM: 6 } },

    { id: 'ironlaw',   name: '铁律',     icon: 'stone-wall',    school: 'bulwark',
      text: '双防 +12',                  mods: { defP: 12, defM: 12 } },
    { id: 'thornsR',   name: '荆棘之心', icon: 'cactus',        school: 'bulwark',
      text: '反弹 26% 受到的伤害',       flags: { thorns: 0.26 } },
    { id: 'lastStand', name: '不动如山', icon: 'checked-shield',school: 'bulwark',
      text: '生命低于 40% 时，双防 +60%', flags: { lastStand: 0.6 } },
    { id: 'mountain',  name: '山岳之躯', icon: 'hearts',        school: 'bulwark',
      text: '生命上限 +70',              mods: { hp: 70 } },

    { id: 'firstMove', name: '先制之刃', icon: 'wingfoot',      school: 'tempo',
      text: '速度高于目标时伤害 +34%',   flags: { firstStrike: 0.34 } },
    { id: 'shadow',    name: '影踪',     icon: 'dodging',       school: 'tempo',
      text: '闪避 +16%，速度 +4',        mods: { dodge: 0.16, spd: 4 } },
    { id: 'haste',     name: '疾风靴',   icon: 'running-shoe',  school: 'tempo',
      text: '速度 +9',                   mods: { spd: 9 } },

    { id: 'batfang',   name: '血蝠之牙', icon: 'droplets',      school: 'vitality',
      text: '吸血 +14%',                 mods: { leech: 0.14 } },
    { id: 'furnace',   name: '生命熔炉', icon: 'heart-bottle',  school: 'vitality',
      text: '生命上限 +90，法攻 +6',     mods: { hp: 90, atkM: 6 } },
    { id: 'devourR',   name: '吞噬者',   icon: 'tooth',         school: 'vitality',
      // 同「吞噬」：devour 是层数，每层 ×2 物攻 → 实际 +6 物攻/击杀
      text: '每击杀一名敌人永久 +6 物攻（最多 +20）', flags: { devour: 3 } },

    { id: 'allround',  name: '全能之印', icon: 'shining-heart', school: 'universal',
      text: '全部核心属性 +5',           mods: { hp: 25, atkP: 5, atkM: 5, penP: 5, penM: 5, defP: 5, defM: 5, spd: 5 } },
    { id: 'gambler',   name: '赌徒之心', icon: 'rolling-dices', school: 'universal',
      text: '暴击率 +16%，生命上限 −25', mods: { crit: 0.16, hp: -25 } },
    { id: 'scavenger', name: '拾荒者',   icon: 'treasure-map',  school: 'universal',
      text: '幸运 +8，装备掉率 +12%',    mods: { luck: 8 }, flags: { dropBonus: 0.12 } },

    /* ---- 针对词条（v11.2-c）----------------------------------------
       这一组不是"+X 数值"，而是"+X 数值，**对某一类敌人**"。
       作用是把「敌人标签」从展示信息变成**构筑决策的依据**：

         · 你走到三层（孵化场，孢子母权重 x3）→「灭卵者」在这一层特别值钱
         · 二层是帷幕（幽魂/祷者）→「禁咒」值钱
         · 五层深渊口（汲血）→「血债」值钱

       于是秘藏三选一不再只看"哪个数字大"，而要看"我接下来要下哪一层"。
       19 + 3 = 22 件秘藏，对 8 个标签，决策面从「8 + 19」变成「8 x 22」。

       数值刻意给得比通用秘藏高（40~45% vs 16~18 的通用增伤），
       因为它们**有前提**：敌人不是那一类时，这张牌一文不值。
       有前提的强牌才叫克制，没前提的强牌叫超模。 */
    { id: 'spawnbane', name: '灭卵者',   icon: 'broken-bone',  school: 'physical',
      text: '对「召唤」标签的敌人伤害 +45%',
      flags: { vsMul: 0.45, vsTag: '召唤' } },
    { id: 'silence',   name: '禁咒',     icon: 'magic-shield', school: 'arcane',
      text: '对「法术」标签的敌人伤害 +40%',
      flags: { vsMul: 0.40, vsTag: '法术' } },
    { id: 'blooddebt', name: '血债',     icon: 'skull-ring',   school: 'vitality',
      text: '对「汲血」标签的敌人伤害 +40%',
      flags: { vsMul: 0.40, vsTag: '汲血' } }
  ];

  /* ============================================================
     秘藏补位选项（「潮汐馈赠」）

     为什么必须存在这么一组东西：
     秘藏池是有限的（19 个），而秘藏每 6 次击杀发一次、没有次数上限 ——
     所以池子**一定会被抽干**。抽干之后如果候选列表变成空的，就会同时触发两件坏事：
        · 界面层看到 length === 0，不弹面板
        · 模型层看到 pendingRelic 是真值（空数组也是真值），把输入永久拒掉
     玩家于是卡死在"点不动、也没面板可关"的状态里。

     这里的做法对齐《云顶之弈》的强化选择：**候选永远给满，永远能选一张继续**。
     池子还有秘藏时，行为跟以前完全一样；不够的位子才由馈赠补上。

     数值刻意保守：它只是补位，不该比一件真秘藏更值钱，
     否则玩家会盼着池子早点空。
     ============================================================ */
  const RELIC_FALLBACKS = [
    { id: 'fbGold', name: '潮汐馈赠 · 金', icon: 'coins',         school: 'universal',
      text: '立刻获得一笔金币（随深度增加）', grant: { gold: true } },
    { id: 'fbHeal', name: '潮汐馈赠 · 泉', icon: 'health-potion', school: 'universal',
      text: '立刻回复一半生命上限',           grant: { healFrac: 0.5 } },
    { id: 'fbItem', name: '潮汐馈赠 · 器', icon: 'chest',         school: 'universal',
      text: '立刻获得一件装备',               grant: { item: true } }
  ];

  const RELIC_FALLBACK = { goldBase: 60, goldPerDepth: 40 };

  const SCHOOLS = {
    physical:  { name: '物理', color: '#ffa04d' },
    arcane:    { name: '法术', color: '#a78bfa' },
    bulwark:   { name: '壁垒', color: '#60a5fa' },
    tempo:     { name: '疾行', color: '#34d399' },
    vitality:  { name: '汲血', color: '#f472b6' },
    universal: { name: '通识', color: '#cbb994' }
  };

  /* ============================================================
     八、敌人
     shape 交给 art.js 的怪物绘制器：按体型/眼数/特征参数化生成像素图，
     不需要逐张手绘图集，也不会出现「编号猜错」的问题。
     affixes 决定它的偏科：石甲兽物防极高法防为零，玩家必须改用法术。
     ============================================================ */
  const ENEMIES = [
    { id: 'slime',  name: '黏液怪', tier: 1, weight: 10, kind: 'normal',
      shape: { body: 'blob', w: 20, h: 15, eye: 2, color: '#5fc98a', accent: '#2f8a58', spikes: 0, arms: 0 },
      stats: { hp: 115, atkP: 6, atkM: 4, defP: 2, defM: 2, spd: 8 },
      note: '平庸的杂兵，用来试刀' },

    { id: 'brute',  name: '石甲兽', tier: 1, weight: 8, kind: 'normal',
      shape: { body: 'brute', w: 22, h: 19, eye: 2, color: '#8d939c', accent: '#5a6069', spikes: 3, arms: 2 },
      stats: { hp: 100, atkP: 9, atkM: 0, defP: 26, defM: 0, spd: 6 },
      note: '物防极高、法防为零 —— 该换法术打' },

    { id: 'wraith', name: '幽魂',   tier: 1, weight: 8, kind: 'normal',
      shape: { body: 'ghost', w: 18, h: 20, eye: 2, color: '#9fb3e8', accent: '#5a6fb8', spikes: 0, arms: 2, ghost: true },
      stats: { hp: 85, atkP: 0, atkM: 11, defP: 0, defM: 28, spd: 11 },
      note: '法防极高、物防为零 —— 该换物理打' },

    { id: 'runner', name: '疾风兽', tier: 1, weight: 8, kind: 'normal',
      shape: { body: 'beast', w: 24, h: 16, eye: 2, color: '#e0a45a', accent: '#a06a2a', spikes: 4, arms: 0 },
      stats: { hp: 102, atkP: 8, atkM: 0, defP: 3, defM: 3, spd: 26 },
      note: '速度极快，会抢在你前面出手' },

    { id: 'spawner', name: '孢子母', tier: 2, weight: 4, kind: 'elite',
      shape: { body: 'blob', w: 22, h: 20, eye: 3, color: '#b06cd0', accent: '#6a3a86', spikes: 5, arms: 2 },
      stats: { hp: 70, atkP: 6, atkM: 14, defP: 8, defM: 12, spd: 7 },
      spawn: { every: 3, count: 1 }, note: '每 3 回合孵化一只黏液怪，拖久了会被围死' },

    { id: 'priest', name: '祷者',   tier: 2, weight: 5, kind: 'elite',
      shape: { body: 'robed', w: 18, h: 21, eye: 2, color: '#e8e0c8', accent: '#a89060', spikes: 0, arms: 2 },
      stats: { hp: 52, atkP: 0, atkM: 15, defP: 10, defM: 20, spd: 9, leech: 0.25 },
      note: '会吸血，拖久了你吃亏' },

    { id: 'titan',  name: '巨兽',   tier: 2, weight: 4, kind: 'elite',
      shape: { body: 'brute', w: 26, h: 24, eye: 1, color: '#b06a4a', accent: '#6e3a24', spikes: 5, arms: 2 },
      stats: { hp: 140, atkP: 26, atkM: 0, defP: 15, defM: 11, spd: 5 },
      note: '血厚、打得疼、跑得慢' },

    { id: 'mirror', name: '镜影',   tier: 3, weight: 2, kind: 'elite',
      shape: { body: 'robed', w: 20, h: 22, eye: 4, color: '#7ee0e8', accent: '#2f8a9a', spikes: 2, arms: 2 },
      stats: { hp: 110, atkP: 19, atkM: 19, defP: 19, defM: 19, spd: 16 },
      note: '全属性均衡，没有明显弱点' },

    { id: 'mimic',  name: '宝箱怪', tier: 2, weight: 3, kind: 'treasure',
      shape: { body: 'mimic', w: 22, h: 18, eye: 2, color: '#c9a04a', accent: '#7a5a1a', spikes: 6, arms: 0 },
      stats: { hp: 60, atkP: 18, atkM: 0, defP: 22, defM: 4, spd: 4 },
      loot: { chance: 1.0, bonus: 1 }, note: '伪装成宝箱。杀它必掉装备，而且品质更好' }
  ];
  const enemyById = function (k) {
    for (const e of ENEMIES) if (e.id === k) return e;
    return ENEMIES[0];
  };

  /* Boss：每层深处镇守一只，杀掉才能开启潮汐之门 */
  const BOSSES = [
    /* bossBehavior 是 P4 给每个 Boss 挂的那条专属行为。
       它同时是**唯一的开关点**：模板上不写，这只 Boss 就只有数值差别（旧行为）。
       为什么放在数据表而不是写死在代码里：这三个值不是"规则"，
       是**这两只怪的设定**——它们改起来应该像改血线一样轻。 */
    { id: 'tidelord', name: '潮汐之主', tier: 4, bossBehavior: 'tide',
      shape: { body: 'ghost', w: 30, h: 30, eye: 3, color: '#4fb8d8', accent: '#1a5a72', spikes: 6, arms: 2, crown: true },
      stats: { hp: 320, atkP: 34, atkM: 30, defP: 24, defM: 24, spd: 16, leech: 0.15 },
      note: '本层的潮水由它驱动。它一死，水位就会退。' },
    { id: 'bonelord', name: '骨潮督军', tier: 4, bossBehavior: 'summon',
      shape: { body: 'brute', w: 30, h: 30, eye: 2, color: '#ded6c0', accent: '#8a7f66', spikes: 8, arms: 2, crown: true },
      stats: { hp: 360, atkP: 42, atkM: 12, defP: 30, defM: 18, spd: 12 },
      /* 复用孢子母那条孵化的**同一份**机制。为什么要挂到 Boss 上：
         它的台词本来就是"把死在潮水里的东西都叫了起来"，
         而在此之前这句话一个字都没实现。每 4 回合一只幼体。 */
      spawn: { every: 4, count: 1 },
      note: '它把死在潮水里的东西都叫了起来。' },
    { id: 'deepmaw', name: '渊喉', tier: 4, bossBehavior: 'roar',
      shape: { body: 'beast', w: 32, h: 26, eye: 6, color: '#a04a7a', accent: '#5a1a3a', spikes: 10, arms: 0, crown: true },
      stats: { hp: 400, atkP: 38, atkM: 24, defP: 20, defM: 26, spd: 20, leech: 0.2 },
      note: '它吃东西的时候，整层地板都在动。' }
  ];

  /* ============================================================
     九、难度
     ============================================================ */
  const DIFFICULTIES = {
    casual: {
      key: 'casual', name: '休闲', tag: '潮水很慢',
      blurb: '敌人成长慢，战后回血比标准多，还有一次复活机会。适合先熟悉属性玩法。',
      depth: 3, enemyScale: 0.092, enemyMul: 0.85, healAfterWin: 0.040,
      tideEvery: 16, healFountain: 2, tierBoost: 0, extraLife: 1
    },
    standard: {
      key: 'standard', name: '标准', tag: '原本的潮汐',
      blurb: '敌人随深度变强，回血有限，潮水每 12 回合涨落一次。',
      depth: 4, enemyScale: 0.165, enemyMul: 1.00, healAfterWin: 0.040,
      tideEvery: 12, healFountain: 1, tierBoost: 0, extraLife: 0
    },
    abyss: {
      key: 'abyss', name: '深渊', tag: '潮水不留情',
      blurb: '敌人成长极快、精英成群，潮水每 8 回合就涨一次。',
      depth: 5, enemyScale: 0.250, enemyMul: 1.85, healAfterWin: 0.024,
      tideEvery: 8, healFountain: 0, tierBoost: 1, extraLife: 0,
      /* P5（v11.7）：速度碾压的阈值 —— 深渊比全局（18）更宽。
         为什么只有深渊需要：全局 18 的意思是"快的一方每轮多打一次"
         （core.js 的 step），而游侠基础速度就是 26，对杂兵（速度 4~16）
         **开局**就踩线。实测速度差 ≥18 的一轮结束率 76%、<18 只有 19.8%
         （差 56.2pp），而三档里"一轮结束"不达标的只有深渊
         （休闲 27% / 标准 29.8% / 深渊 39.5%，线是 35%）。
         抬到 26 之后深渊 39.5% → 32.8%（达标），且**休闲/标准逐位不变**
         （实测三种阈值下都逐位相同）。
         代价已记账：深渊通关率 −2.0pp、第 1 层死亡 +9（n=200 口径）。
         **删掉这一行即回退**（回到全局 18）。 */
      speedGap: 26
    }
  };
  const DIFF_ORDER = ['casual', 'standard', 'abyss'];

  /* ============================================================
     十、地图
     45×35 的洞窟：BSP 切房间 + 走廊连通 + 细胞自动机磨圆。
     视口比地图小，相机跟随 —— 这样才有"探索"的感觉，
     而不是一眼看完整个棋盘。
     ============================================================ */
  const MAP = {
    W: 45, H: 35,
    rooms: 13,
    roomMin: 5, roomMax: 11,
    waterPatches: 5,      // 初始水洼数量（潮汐的源头）
    grassPatches: 8,
    chests: 4,
    shops: 2,             // 每层几处潮汐商栈
    enemiesBase: 9,       // 每层基础敌人数（再乘难度系数）
    brazierEvery: 9,      // 每隔几格放一支火把
    rocks: 0.03
  };

  const DEPTH_CFG = {
    enemyHpPerDepth: 0.34,      // 每下一层，敌人生命 ×(1+0.34n)
    enemyAtkPerDepth: 0.26,
    enemyDefPerDepth: 0.18,
    itemLevelPerDepth: 1.0
  };

  /* 掉落与交易
     valueOf 决定一件装备的"身价"，售价和商店定价都由它派生 ——
     只在一处定义，避免出现"卖得比买得贵"这种套利漏洞。 */
  const LOOT = {
    baseChance: 0.34,
    eliteBonus: 0.32,
    treasureChance: 1.0,
    chestChance: 1.0,
    luckPerPoint: 0.012,
    backpackSize: 40,           // 参考《我的世界》：整屏网格，不够用是设计事故
    sellRate: 0.35,             // 出售价 = 身价 × 这个比例
    shopMarkup: 1.75,           // 商店售价 = 身价 × 这个比例
    /* 装备融合（设计取自《元气骑士》的武器融合）：
       两件同品质 → 一件高一档。费用从**结果的身价**派生。

       两条约束缺一不可：
       ① 必须 ≥ 结果的售价（sellRate 0.35）—— 否则"融合完再卖掉"是净赚回路；
       ② 必须和商店价可比（shopMarkup 1.75）—— 定成 0.40 时一件传说只要 58 金币，
          而商店卖同款要 256，于是融合变成"无脑变强"的按钮。
          实测：0.40 时标准难度通关率从 60.5% 飙到 79%，掉落里史诗/传说数量翻了四倍。
          0.90 仍然比商店便宜（融合要自己出材料），但不再是免费午餐。 */
    fuseRate: 0.90,
    fuseMin: 40,
    shopSlots: 5,
    refreshCost: 40,
    goldPerKill: 3,
    goldPerDepth: 2,
    goldElite: 9,
    goldBoss: 70,
    goldChest: 16,
    goldChestPerDepth: 9
  };

  /* 撤离（v11.5 P3 第三步）的**定价三件套** —— 改价只改这一处。

     为什么要"先定价再实现"（工作单里 A4 那条）：撤离如果免费，
     它就不是一个决策，而是一个免死按钮 —— 打不过就撤，于是"打不过"
     这件事不再有任何后果，而整部游戏的难度都建在那件事上。

     三件：
       lootMul   本场**已经倒下**的敌人，金币与掉落掷骰都减半。
                 没倒下的敌人当然什么都不掉（它们还活着）。
                 注意它只在这个人自己撤的时候生效 —— 那是"你放弃了战场"，
                 而不是"系统扣了你一半"。
       tideBeat  立刻推进的潮汐节拍数。这是**时间**那一侧的代价：
                 潮水不等你，撤退是拿地图压力换命。
       aiFleeAt  AI 判据：**预期本轮承伤 ≥ 剩余生命 × 这个系数**就撤（默认 1.0 = 会被打死）。

     ⚠ `aiFleeAt` 之前叫 `aiDmgFrac`、默认 0.30（工作单原文"预期本轮承伤 >
     剩余血量 30% 时撤"）。实测那个值是**语义错了**，不是数写小了：
       · 它算的是"这一轮疼不疼"，不是"这一场会不会输" —— 上一轮的疼下一轮照样能打，
         撤了却把整场的收益全丢掉；
       · 群战里它把所有活着的敌人的攻击**加起来**，4 只 × 15 点轻松越过剩余血的 30%，
         于是"被围观 = 必撤"，而那恰恰是群战机制存在的场合。
     实测（n=300×3）：22 次/局 ≈ 逢战必撤，通关率 −19.6 / −15.0 / −13.7pp，
     每局击杀 24.9 → 16.0。改成一个自限的应急出口之后见本轮的平衡读数。

     ── 下面这两条是"买到什么"，2026-09-24 补 ──
     上面三件全是**代价**。实测（n=300×3）只带代价的撤离是严格劣势的选项：
     AI 按判据撤 → 通关率 −26.0 / −17.0 / −14.7pp，击杀 24.9 → 14.6。
     根因不是判据写错，是这个游戏里**撤离换不到安全**：
     战斗从"相邻"开始，撤完敌人还在旁边还醒着，下一回合照样打你。
     所以撤离必须同时买到一次**脱离接触**，否则它不是一个决策，只是一个陷阱。

       pushBack   撤完把玩家沿"远离那只敌人"的主轴推开几格（尽力而为）
       graceTurns 被你甩开的那只，几回合不追（1 = 只放这一回合） */
  const FLEE = {
    lootMul: 0.5,
    tideBeat: 1,
    aiFleeAt: 1.0,
    /* 撤完之后 AI 会**真的跑开**几回合（v11.6）。
       没有它就会出现"撤离循环"：贴着敌人、每回合判"下一击会死"、每回合都撤 ——
       实测 casual 25 次/局，其中绝大多数是**同一个局面被反复撤**
       （次数越高反而说明它不是应急出口，而是卡住了）。 */
    aiRetreat: 3,
    /* 撤离的**冷却**（回合）。v11.6 终检逮到的洞：
       没有冷却时"每回合都撤"= 每回合都不挨打（脱接触让那只怪这一回合不追），
       实测把一局拖到回合上限（深渊出现 1 例 timeout，trace 是两格震荡）。
       冷却不是惩罚节奏，是把"应急出口"这个定位钉死 ——
       它本来就该是一次性的脱身，不是一种打法。 */
    cd: 3,
    pushBack: 1,
    graceTurns: 1
  };

  /* 遗物三选一节奏 */
  const PROGRESSION = {
    relicEvery: 6,              // 每击杀 6 个敌人给一次三选一
    offerCount: 3,
    levelEvery: 4,              // 每 4 个击杀升 1 级
    levelGain: { hp: 12, atkP: 2, atkM: 2, defP: 1, defM: 1 },

    /* 等级上限。为什么必须有：levelGain.atkP=2 ÷ levelEvery=4 = **每杀 +0.5
       物攻，原本无上限**。卡死局面实测 kills=714 → Lv179 → +358 物攻，
       而基础物攻只有 44。它和"吞噬"是同一类雪球，处置也一致：封顶。
       20 这个数是量出来的 —— 深渊一局平均 75 杀 ≈ Lv19，正常局几乎不受
       影响，而失控局从 +358 被压到 +38。
       注意它**没有**解决装备那条链（卡死局面 defP 231~299 是装备堆出来的），
       那需要单独一轮。 */
    maxLevel: 20,

    /* 模拟器 AI 的「这一层该走了」阈值：本层击杀达到这个数就不再主动找架打。
       为什么必须有它：潮汐会**无限**补充敌人（v2 的既有设计），而 AI 的策略
       是"打最近的敌人"。两者放在一起 → 它永远在打、永远不离开，靠击杀回血
       一直是满血，直到撞上 2400 回合上限（实测 900 局里 4 局）。
       一个真人不会在一层里刷 24 只以上的杂兵 —— 那是潮汐在补，不是关卡。
       注意这条**只改模拟器的策略，不改任何游戏规则**：真人想刷依然可以。
       它影响的是"通关率这个数字算的是谁" —— 算一个会走的玩家，
       而不是一台刷怪机。 */
    leaveLayerAfterKills: 24
  };

  /* ============================================================
     敌人标签 —— 给玩家看的「决策依据」

     ★ 设计取舍：属性型标签（高物抗 / 高法抗 / 法术 / 汲血）由 core.js 的
       tagsOf() 从 stats **推导**，这里只定义**名字**。
       为什么不手写：标签是玩家据以做决策的信息，一旦它和实际结算不一致，
       那就是"系统骗人"，比没有标签更糟。而 stats 会被 _scaleEnemyStats()
       按深度整体放大 —— 手写的抗性标签迟早和缩放后的真实数值脱节。

       行为型标签（召唤 / 精英 / 首领）推导不出来，因为它是行为不是数值，
       由 core.js 从 arc（敌人模板）上读，同样不在这里手写。
     ============================================================ */
  const TAGS = {
    P: '高物抗',
    M: '高法抗',
    SPELL: '法术',
    SUMMON: '召唤',
    LEECH: '汲血',
    ELITE: '精英',
    BOSS: '首领',
    SWARM: '群居'
  };

  /* ============================================================
     每层机制主题 —— 让「层」有身份，而不是随机杂糅

     取向是**权重倾斜**，不是池子限定。限定（"第 1 层只出石甲兽和幽魂"）
     会让每层反而更单调、而且一眼看穿；倾斜是"这一层石甲兽明显多一些"，
     玩家自己发现规律 —— 这是教学，不是说明书。

     另一条边界：主题只**激活已有内容**，不新增任何敌人。
     石甲兽（defP 26 / defM 0）和幽魂（defP 0 / defM 28）本来就在池子里，
     它们存在的唯一意义就是逼玩家换伤害类型；但原版精英权重只有杂兵的一半，
     再加上 bestAttack 替玩家自动择优，这份设计从来没有被真正用起来。
     主题做的只是把已经写好的东西推到前台。
     ============================================================ */
  const THEMES = [
    null,                                              // 索引 0 占位：层数从 1 开始
    { key: 'bedrock', name: '岩床',   tag: TAGS.P,      mul: 2.2,
      blurb: '甲壳越来越厚 —— 试试别用物理' },
    { key: 'veil',    name: '帷幕',   tag: TAGS.M,      mul: 2.2,
      blurb: '法术在回声里打转 —— 试试别用法术' },
    { key: 'brood',   name: '孵化场', tag: TAGS.SUMMON, mul: 3.0,
      blurb: '有什么在不停地产卵 —— 拖下去会被围死' },
    { key: 'mirror',  name: '镜域',   tag: TAGS.ELITE,  mul: 1.7,
      blurb: '每一只都难缠 —— 挑软的打，或者先变强' },
    { key: 'maw',     name: '深渊口', tag: TAGS.LEECH,  mul: 1.8,
      blurb: '它们靠你的血活着 —— 速战，别拖' }
  ];

  /* ============================================================
     敌人姿态（v11.2-b）

     一句话：**零和重分配**，不是加数值。
     硬化物理 = defP x1.5 且 defM x0.5，硬化法术反之。
     总量守恒带来一个关键性质：「选对」赚到的正好等于「选错」亏掉的，
     所以这套机制的平均强度是 1.0 —— 它只改变**方差**，不改变难度。
     若改成"只加不减"，那就是凭空加难度：三档基线全线漂移，还不好归因。

     谁配拥有姿态：双侧防御都 >= minDef、**且没有固定抗性标签**的敌人。
     这条边界把敌人干净地分成两类，立意很明确：
       · 有抗性标签（石甲兽 / 幽魂 / 祷者）→ 弱点固定，靠**读标签**打
       · 无抗性标签（镜影 / 巨兽 / 孢子母 / 首领）→ 弱点轮换，靠**读意图**打
     两种线索各管一半敌人，玩家不会在同一只怪身上同时收到两条互相打架的提示。

     镜影（defP 19 / defM 19，注释写着「没有明显弱点」）因此从最无聊的敌人
     变成这套机制的门面 —— 它每一轮都恰好露出一个不同的破绽。
     ============================================================ */
  const STANCE = {
    /* 每行动 2 次切换一次（v11.4-f 由 3 改 2）。
       为什么要重标：姿态的价值是“这一轮该打哪一路会变”，
       而它只在敌人活得够久时才兑现。旧值 3 是配**旧战斗长度**定的：
       那时杂兵一刀就死（普通怪 92% 在第一轮分胜负），能打 3 轮以上的只有精英，
       于是 every=3 恰好等于“精英战里翻一次”。
       普通怪血量上调之后，一场仗变成 2~3 轮，every=3 反而变成
       “整场都看不到翻面”——机制还在，玩家一次也遇不到。
       2 让一场 3 轮的仗至少翻一次。
       注意它**不改变难度**：硬化 ×1.5 / 软化 ×0.5 是零和重分配，
       平均强度恒为 1.0，改的只是“翻面的频率”——也就是这条线索的可读性。 */
    every: 2,
    hard: 1.5,     // 硬化侧倍率
    soft: 0.5,     // 另一侧倍率
    minDef: 6      // 双侧防御都 >= 此值才配拥有姿态
  };

  /* ============================================================
     元进度（局外）：「潮汐结晶」与永久解锁

     为什么元进度要写成**数据层里的纯函数**：
     本作唯一的验收标准是模拟器跑出来的通关率。元进度如果默认生效，
     通关率就不再是"这个版本的难度"，而变成"我解锁了多少" —— 基准数据直接作废。
     所以这里切成三块，各归各位：
       · 解锁表 + 加成折算  → 这里（纯函数，没有任何存储依赖）
       · localStorage 读写  → meta.js（界面侧）
       · 模型层             → 只在**显式传入 owned 时**才应用
     模拟器从不传 owned，于是天然拿不到元进度。这条不靠自觉，靠结构。
     ============================================================ */
  const META = {
    saveKey: 'tide.meta',

    /* 一局的结算：结晶 = 深度×12 + 击杀×2 + 通关加成。
       定价锚点（为什么是这些数）：
         标准难度典型死亡局（深度 1、击杀 6）≈ 24
         标准难度典型通关局（深度 4、击杀 65）= 178
       全套解锁合计 1330 → 8~10 局能买掉大半。
       再便宜就变"局外刷分"，再贵就变"元进度形同虚设"。 */
    settle(g) {
      const win = g.status === 'win';
      const base = g.depth * 12 + g.kills * 2;
      return {
        win: win,
        depth: g.depth,
        kills: g.kills,
        gain: Math.round(win ? base * 1.6 + 120 : base)
      };
    },

    /* 解锁项。req 是前置（必须按顺序买，给玩家一条明确的路线）。
       effect 是原始形态，真正合并成"一份开局加成"的是 effects()。 */
    unlocks: [
      { id: 'pouch1', name: '行囊', icon: 'backpack', cost: 60,
        effect: { gold: 120 }, desc: '开局就带 120 金币' },
      { id: 'pouch2', name: '鼓胀的行囊', icon: 'backpack', cost: 150, req: 'pouch1',
        effect: { gold: 180 }, desc: '开局再多 180 金币（与上一项叠加）' },
      { id: 'bag1', name: '补给袋', icon: 'gem-pendant', cost: 90,
        effect: { bagCap: 4 }, desc: '背包 +4 格' },
      { id: 'bag2', name: '补给箱', icon: 'gems', cost: 190, req: 'bag1',
        effect: { bagCap: 4 }, desc: '背包再多 4 格' },
      { id: 'heirloom', name: '祖传遗物', icon: 'ring', cost: 130,
        effect: { startRarity: 'uncommon' }, desc: '开局就带一件精良装备' },
      { id: 'gift', name: '潮汐馈赠', icon: 'crown', cost: 300, req: 'heirloom',
        effect: { startRarity: 'rare' }, desc: '开局带一件稀有装备（覆盖上一项，不叠加）' },
      { id: 'ember', name: '一线生机', icon: 'shining-heart', cost: 240,
        effect: { lives: 1 }, desc: '每局多一次复活机会' },
      { id: 'vigor', name: '潮汐体魄', icon: 'hearts', cost: 170,
        effect: { hpMul: 0.08 }, desc: '生命上限 +8%' }
    ],

    unlockById(id) {
      for (let i = 0; i < META.unlocks.length; i++) if (META.unlocks[i].id === id) return META.unlocks[i];
      return null;
    },

    /** 品质档位。委托给数据层的 rarRank —— 一处定义、两处使用，不许各写一份。 */
    rarRank(k) { return rarRank(k); },

    /** 能不能买（纯判断，不改状态）→ { ok, reason } */
    canBuy(owned, crystals, id) {
      const u = META.unlockById(id);
      if (!u) return { ok: false, reason: 'unknown' };
      if (owned && owned[id]) return { ok: false, reason: 'owned' };
      if (u.req && !(owned && owned[u.req])) return { ok: false, reason: 'req' };
      if (crystals < u.cost) return { ok: false, reason: 'poor', need: u.cost - crystals };
      return { ok: true, cost: u.cost };
    },

    /**
     * 已购集合 → 一份开局加成。
     * **这是元进度唯一的出口**：模型层只认这份对象，不认识任何 id。
     * 加一项新解锁时只要往 unlocks 里加一条，模型层不必改 —— 但新出现的
     * 字段必须在这里折出来，否则它会静默地什么都不做。
     */
    effects(owned) {
      const out = { gold: 0, bagCap: 0, lives: 0, hpMul: 1, startRarity: null };
      if (!owned) return out;
      for (const u of META.unlocks) {
        if (!owned[u.id]) continue;
        const e = u.effect || {};
        if (e.gold) out.gold += e.gold;
        if (e.bagCap) out.bagCap += e.bagCap;
        if (e.lives) out.lives += e.lives;
        if (e.hpMul) out.hpMul += e.hpMul;
        // 起始装备品质取**最高**那一档：两件都买时是覆盖而不是给两件。
        // 给两件会让"开局强度"变成一个难标定的量，而覆盖只是把起点抬高一点。
        if (e.startRarity && META.rarRank(e.startRarity) > META.rarRank(out.startRarity)) {
          out.startRarity = e.startRarity;
        }
      }
      return out;
    }
  };

  /* ============================================================
     区域类型（v11-5）

     地图每层切成 4~6 个区域，每个区域一个类型。
     为什么要有类型而不是"整层一个难度"：那样"往哪走"就没有决策了 ——
     反正走哪边都是被一群同强度的怪围上来。
     有了类型，压力从"一路被追"变成**"要不要踏进去"**：
     危险区是你自己选的，奖励区也是。

     danger 只用来做 UI 提示与怪物强度的微调，**不参与结算公式** ——
     真正的强度来自区域里怪物自身的属性。
     ============================================================ */
  /* ============================================================
     守位 / 惊动半径（v11.4-i）

     为什么这三个数要一起定义、而且必须**两两留间隔**：
     惊动与脱离如果共用同一个半径，玩家在边界上左右走一步就会让整堆怪
     反复醒来/睡下，队形抽搐，而且从数据上看不出是"阈值抖动"——
     只会表现为"群战占比时高时低"。所以脱离半径必须比惊动半径大。

     alertR 取 8 的理由（这是个**时间**常数，不是距离常数）：
     玩家 1 格/回合、怪 0.5 格/回合，双方相向 ⇒ 接触时刻 t* = d / 1.5。
     d=8 时 t* ≈ 5.3 回合 —— 整堆同速行军时堆内间距**不缩不放**，
     所以半径的作用不是"让它们多走几格"，而是**给行军留出足够的回合数**；
     真正把距离归零的是玩家自己的冲锋。d 太小（比如 3）时，堆还在门外
     就被惊动，来不及展开成两路纵队，接触瞬间仍然只有前排一只。

     returnAfter 取 10：脱离是"连续 10 回合都在圈外"才算数，
     否则玩家在圈边拉扯一下，整堆就开始回家，堆形从半路散掉。
     ============================================================ */
  const PACK = {
    alertR: 8,        // 进这个距离就醒（曼哈顿距离）
    disengageR: 10,   // 退到这么远之外才可能脱战（必须 > alertR）
    returnAfter: 10   // 圈外连续这么多回合 → 开始回巢
  };

  const REGIONS = {
    normal: { key: 'normal', name: '普通区', color: '#5a6a80', tint: 'rgba(90,106,128,0.10)',  danger: 1, enemMul: 1.00 },
    elite:  { key: 'elite',  name: '精英区', color: '#b06cf0', tint: 'rgba(176,108,240,0.14)', danger: 2, enemMul: 1.25 },
    reward: { key: 'reward', name: '奖励区', color: '#e0b060', tint: 'rgba(224,176,96,0.13)',  danger: 1, enemMul: 0.80 },
    hazard: { key: 'hazard', name: '危险区', color: '#e0727a', tint: 'rgba(224,114,122,0.14)', danger: 3, enemMul: 1.15 },
    gate:   { key: 'gate',   name: '守门区', color: '#7ee0d6', tint: 'rgba(126,224,214,0.14)', danger: 2, enemMul: 1.10 }
  };

  /* ============================================================
     分数（v11-6 排行榜）

     为什么分数必须是一个**只有一个执行点**的纯函数：
     排行榜是跨局比较的东西。普通模式和无尽模式如果各算各的，
     "无尽 3000 分"和"标准 3000 分"谁更厉害就永远说不清。

     为什么难度是**乘系数**而不是加分：
     加分会让"深渊打到第 2 层"看起来比"标准打到第 3 层"分高，
     玩家于是会去刷低难度 —— 这与"难度该被奖励"是反的。
     乘法保证同一份战绩、难度越高分越高。

     为什么通关奖励给得比"多打一层"高得多：
     否则普通模式的最优策略会变成"在最后一层门口反复刷怪"，
     而不是把路走完。
     ============================================================ */
  const SCORE = {
    perDepth: 100,
    perKill: 10,
    perElite: 50,
    perBoss: 300,
    winBonus: 800,
    diffMul: { casual: 0.8, standard: 1.0, abyss: 1.25 },
    boardMax: 10
  };

  /**
   * 一局的分数与逐项明细（排行榜要能解释这个数字是怎么来的）。
   * @param {object} g 一局结束时的 game 对象
   */
  function scoreOf(g) {
    if (!g) return { total: 0, base: 0, mul: 1, parts: [], win: 0 };
    const d = Math.max(1, g.depth || 1);
    const win = (g.status === 'win') ? 1 : 0;
    const parts = [
      { label: '到达深度 ×' + SCORE.perDepth, value: d * SCORE.perDepth },
      { label: '击杀 ×' + SCORE.perKill, value: (g.kills || 0) * SCORE.perKill },
      { label: '精英 ×' + SCORE.perElite, value: (g.eliteKills || 0) * SCORE.perElite },
      { label: '守卫 ×' + SCORE.perBoss, value: (g.bossKills || 0) * SCORE.perBoss },
      { label: '走出潮汐', value: win * SCORE.winBonus }
    ];
    let base = 0;
    for (const p of parts) base += p.value;
    const key = (g.diff && g.diff.key) || g.difficultyId || 'standard';
    const mul = SCORE.diffMul[key] === undefined ? 1 : SCORE.diffMul[key];
    return { total: Math.round(base * mul), base: base, mul: mul, parts: parts, win: win };
  }

  /* ============================================================
     按键表（v11-8）

     这是**唯一一份**"按什么键 → 做什么事"的对照表：
       ① 局内左侧的操作指南由它渲染（按当前界面过滤）
       ② 冒烟测试逐条把它按下去，验证每个键真的有效

     为什么必须只有一份：按键说明一旦散成三处（玩法弹窗、暂停菜单、
     操作指南），改一处忘一处是必然的。而玩家看到指南与实际不符时，
     第一反应是"我按错了"—— 这类 bug 几乎不会被反馈回来。

     scope 的取值就是"这份说明在哪个界面成立"：
       game  局内（可以走位、放技能）
       inv   背包打开时（那时 WASD 不走位 —— 静态表在这里就是错的）
       relic 三选一时（那时只认左右和确认）
     ============================================================ */
  const KEYS = [
    { act: 'move', scope: ['game'], label: '方向键 / WASD',
      keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'],
      text: '走一格（按住连续走）' },
    { act: 'wait', scope: ['game'], label: '空格', keys: [' '],
      text: '原地等一回合' },
    // 出手类型：文案只说明"由哪一侧防御抵挡"，**不写"哪个更好"** ——
    // 操作指南一旦开始给答案，前面那套"让玩家自己算"就白做了。
    { act: 'atkP', scope: ['game'], label: '1', keys: ['1'],
      text: '出手切到物理 —— 由对方的物理防御抵挡' },
    { act: 'atkM', scope: ['game'], label: '2', keys: ['2'],
      text: '出手切到法术 —— 由对方的法术防御抵挡' },
    { act: 'skill', scope: ['game'], label: 'Q', keys: ['q'],
      text: '释放魂技（冷却写在这颗键上）' },
    { act: 'bag', scope: ['game'], label: 'E', keys: ['e', 'i', 'b', 'Tab'],
      text: '打开背包与商店' },
    { act: 'help', scope: ['game'], label: 'H', keys: ['h', '?'],
      text: '玩法说明' },
    { act: 'mute', scope: ['game'], label: 'M', keys: ['m'],
      text: '静音开关' },
    { act: 'pause', scope: ['game'], label: 'Esc', keys: ['Escape'],
      text: '逐层往回退；全关完 → 暂停菜单' },
    { act: 'guide', scope: ['game'], label: 'G', keys: ['g'],
      text: '折叠 / 展开这份指南' },
    { act: 'autoEquip', scope: ['game'], label: '双击 / Shift + 右键', keys: [],
      text: '自动装备（更强才换，更弱会说理由）' },
    { act: 'zoom', scope: ['game'], label: '滚轮', keys: [],
      text: '缩放视角（只改看的，不改玩法）' },
    { act: 'closeInv', scope: ['inv'], label: 'E / Esc', keys: ['e', 'Escape'],
      text: '关闭背包' },
    { act: 'bagTab', scope: ['inv'], label: '点击页签', keys: [],
      text: '在「背包」和「商店」之间切换' },
    { act: 'relicMove', scope: ['relic'], label: '← →', keys: ['ArrowLeft', 'ArrowRight'],
      text: '移动光标' },
    { act: 'relicPick', scope: ['relic'], label: '空格 / 回车', keys: [' ', 'Enter'],
      text: '确认选中的那一张' }
  ];

  global.TideData = {
    COMBAT: COMBAT,
    REGIONS: REGIONS,
    KEYS: KEYS,
    SCORE: SCORE, scoreOf: scoreOf,
    POWER_W: POWER_W, rarRank: rarRank,
    STATS: STATS, CORE_STATS: CORE_STATS, SUB_STATS: SUB_STATS,
    CLASSES: CLASSES, classByKey: classByKey,
    SKILLS: SKILLS, skillByClass: skillByClass, duelSkillFx: duelSkillFx,
    RARITIES: RARITIES, rarityByKey: rarityByKey,
    EQUIP_SLOTS: EQUIP_SLOTS, BASES: BASES, basesForSlot: basesForSlot,
    AFFIXES: AFFIXES, affixById: affixById,
    RELICS: RELICS, SCHOOLS: SCHOOLS,
  RELIC_FALLBACKS: RELIC_FALLBACKS, RELIC_FALLBACK: RELIC_FALLBACK,
    TAGS: TAGS, THEMES: THEMES, STANCE: STANCE, PACK: PACK,
    ENEMIES: ENEMIES, enemyById: enemyById, BOSSES: BOSSES,
    DIFFICULTIES: DIFFICULTIES, DIFF_ORDER: DIFF_ORDER,
    MAP: MAP, DEPTH_CFG: DEPTH_CFG, LOOT: LOOT, PROGRESSION: PROGRESSION, FLEE: FLEE,
    META: META
  };
})(typeof window !== 'undefined' ? window : globalThis);
