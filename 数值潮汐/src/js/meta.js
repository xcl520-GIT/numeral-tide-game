/* ============================================================
   数值潮汐 · 元进度存档层（局外成长）

   分工（三层，各归各位，别混）：
     data.js     解锁表 + 加成折算（纯函数，模型层直接用）
     本文件       localStorage 读写、购买、结算入账
     core.js      只在显式传入 owned 时才应用加成

   为什么存档要单独一层：**localStorage 是不可信输入。**
   它会被玩家手改（单机游戏里这本来就是玩法的一部分）、会被旧版本留下、
   会被别的标签页写坏、会在隐私模式下直接抛异常。
   所以 load() 的职责不是"读出来"，而是"读出来并保证它长得像一份合法存档" ——
   任何字段缺失 / 类型不对 / 越界，都就地修正，绝不让 NaN 或幽灵解锁
   一路流进战斗公式。存档坏了顶多从头开始，不能变成打不开游戏。
   ============================================================ */
(function (global) {
  const M = global.TideData.META;

  function blank() {
    return {
      crystals: 0,   // 当前持有
      total: 0,      // 累计获得（只用于展示"一共挖到过多少"）
      owned: {},     // { 解锁id: 1 }
      runs: 0,       // 总局数
      wins: 0,       // 通关次数
      best: 0,       // 历史最深层
      /**
       * 本机排行榜（v11-6）。这是一份绿色免安装单机包，**没有服务器** ——
       * 所以榜只存在玩家自己的存档里，界面上也必须这么说，
       * 否则玩家会以为"我的分数上传了、别人能看到"。
       */
      board: []
    };
  }

  const intOr = function (v, d, min, max) {
    const n = Math.floor(Number(v));
    if (!isFinite(n)) return d;
    return Math.max(min, Math.min(max, n));
  };

  /** 把任意输入修成一份合法存档。**绝不抛异常**，永远返回可用对象。 */
  function sanitize(raw) {
    const out = blank();
    if (!raw || typeof raw !== 'object') return out;
    out.crystals = intOr(raw.crystals, 0, 0, 1e9);
    out.total = intOr(raw.total, out.crystals, 0, 1e9);
    out.runs = intOr(raw.runs, 0, 0, 1e9);
    out.wins = intOr(raw.wins, 0, 0, 1e9);
    out.best = intOr(raw.best, 0, 0, 999);
    // 已购集合要过两道关：
    //   ① 只认解锁表里真实存在的 id —— 少了这条，手改一个 "god": 1 进去
    //      就会变成"合法"解锁一路带到模型层；
    //   ② 对前置封闭 —— 买了「潮汐馈赠」就必须也有「祖传遗物」。
    //      少了这条，手改一个 { gift: 1 } 就能白拿稀有开局装备，等于绕开付费链。
    // 前置还可能再套前置，所以反复收敛到不动点（最多绕解锁表一圈）。
    if (raw.owned && typeof raw.owned === 'object') {
      for (const u of M.unlocks) if (raw.owned[u.id]) out.owned[u.id] = 1;
      for (let pass = 0; pass <= M.unlocks.length; pass++) {
        let dropped = false;
        for (const id in out.owned) {
          const u = M.unlockById(id);
          if (u && u.req && !out.owned[u.req]) { delete out.owned[id]; dropped = true; }
        }
        if (!dropped) break;
      }
    }
    if (Array.isArray(raw.board)) {
      const max = (global.TideData.SCORE && global.TideData.SCORE.boardMax) || 10;
      for (const e of raw.board) {
        if (out.board.length >= max) break;
        const se = sanitizeEntry(e);
        if (se) out.board.push(se);
      }
      out.board.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return (b.depth || 0) - (a.depth || 0);
      });
    }
    if (out.wins > out.runs) out.wins = out.runs;
    if (out.total < out.crystals) out.total = out.crystals;
    return out;
  }

  /**
   * 单条排行记录。**同样是不可信输入**：存档会被手改、会跨版本残留。
   * 这里把每个字段夹到合理范围 —— 榜是要画出来的，
   * 一个 NaN 分就会让第一名显示成 "NaN"，整块界面看起来像坏了。
   */
  function sanitizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const str = function (v, max, d) {
      const s = String(v === undefined || v === null ? d : v);
      return s.slice(0, max);
    };
    const parts = [];
    if (Array.isArray(e.parts)) {
      for (const p of e.parts.slice(0, 8)) {
        if (!p || typeof p !== 'object') continue;
        parts.push({
          label: str(p.label, 28, ''),
          value: intOr(p.value, 0, -1e9, 1e9)
        });
      }
    }
    return {
      score: intOr(e.score, 0, 0, 1e9),
      mode: str(e.mode, 10, '普通'),
      clsName: str(e.clsName, 16, '?'),
      diffName: str(e.diffName, 12, '?'),
      depth: intOr(e.depth, 1, 1, 999),
      kills: intOr(e.kills, 0, 0, 1e6),
      elites: intOr(e.elites, 0, 0, 1e6),
      bosses: intOr(e.bosses, 0, 0, 1e6),
      win: e.win ? 1 : 0,
      turns: intOr(e.turns, 0, 0, 1e7),
      seed: intOr(e.seed, 0, 0, 4294967295),
      date: str(e.date, 20, ''),
      parts: parts
    };
  }

  /**
   * 往本机排行榜插一条，返回名次（1 起；没上榜返回 0）。
   *
   * 为什么榜放在存档层而不是界面层：它要做三件只有存档层做得了的事 ——
   * 净化（存档可被手改）、限长（只留前 N）、跨会话存活。
   * 界面只负责把它画出来。
   */
  function addScore(entry) {
    const e = sanitizeEntry(entry);
    if (!e) return 0;
    const m = load();
    m.board.push(e);
    m.board.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return (b.depth || 0) - (a.depth || 0);   // 同分看谁走得更深
    });
    const max = (global.TideData.SCORE && global.TideData.SCORE.boardMax) || 10;
    if (m.board.length > max) m.board.length = max;
    const at = m.board.indexOf(e);
    save(m);
    return at < 0 ? 0 : at + 1;
  }

  let cache = null;

  function load() {
    if (cache) return cache;
    let raw = null;
    try {
      const s = global.localStorage && global.localStorage.getItem(M.saveKey);
      if (s) raw = JSON.parse(s);
    } catch (e) { raw = null; }   // 读坏了/JSON 坏了 → 当新档。绝不能因此打不开游戏
    cache = sanitize(raw);
    return cache;
  }

  function save(m) {
    cache = sanitize(m);
    try {
      if (global.localStorage) global.localStorage.setItem(M.saveKey, JSON.stringify(cache));
    } catch (e) { /* 隐私模式 / 配额满：内存里还是对的，不打断游戏 */ }
    return cache;
  }

  /** 已购集合的**副本**（给模型层的那一份）。外面怎么改都动不到存档。 */
  function owned() {
    const m = load(), o = {};
    for (const k in m.owned) o[k] = 1;
    return o;
  }

  /** 开局加成，直接喂给 new Game({ meta: ... }) */
  function effects() { return M.effects(load().owned); }

  /** 购买。返回 { ok, reason?, cost?, meta? } —— 不抛异常，失败也有理由。 */
  function buy(id) {
    const m = load();
    const v = M.canBuy(m.owned, m.crystals, id);
    if (!v.ok) return v;
    m.owned[id] = 1;
    m.crystals -= v.cost;
    save(m);
    return { ok: true, cost: v.cost, unlock: M.unlockById(id), meta: m };
  }

  /**
   * 一局结束入账。
   *
   * **必须幂等**：结算界面会被重绘、玩家会连点两次「再来一局」、
   * 死亡动画可能触发两次。少了这一层，同一局的结晶会凭空翻倍，
   * 而元进度翻倍是不可逆的（玩家已经花掉了）。
   * 所以由调用方给一个 runId，同一局只结一次。
   */
  let lastSettled = null;
  function settle(g, runId) {
    const m = load();
    const detail = M.settle(g);
    if (runId && lastSettled === runId) {
      return { gain: 0, duplicate: true, meta: m, detail: detail };
    }
    m.crystals += detail.gain;
    m.total += detail.gain;
    m.runs += 1;
    if (detail.win) m.wins += 1;
    if (detail.depth > m.best) m.best = detail.depth;
    save(m);
    if (runId) lastSettled = runId;
    return { gain: detail.gain, duplicate: false, meta: m, detail: detail };
  }

  /** 清空进度（设置里用，也为测试留一个确定的重来点） */
  function reset() { cache = blank(); save(cache); return cache; }

  global.TideMeta = {
    blank: blank, sanitize: sanitize, load: load, save: save,
    owned: owned, effects: effects, buy: buy, settle: settle, reset: reset,
    addScore: addScore, sanitizeEntry: sanitizeEntry
  };
})(window);
