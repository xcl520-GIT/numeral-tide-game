/* ============================================================
   数值潮汐 · 玩家设置（音量 / 视角 / 界面开关）

   单独成层的理由和 meta.js 一样：**localStorage 是不可信输入。**
   它会被玩家手改、会被旧版本留下、会在隐私模式下直接抛异常。
   所以这里的职责也是"读出来并保证它长得像一份合法设置"，
   而不是"读出来就用" —— 一个 NaN 音量足以让整个音频层静音或爆音。

   为什么音效和 BGM 是**两个独立的量**：
   它们的合理比例因人而异。合成一条总音量之后，
   "音乐太吵"就只剩"把刀剑声一起关掉"这一个解法了。
   ============================================================ */
(function (global) {
  const KEY = 'tide.settings';

  const DEFAULTS = {
    // 默认 1.0 = 与"还没有音量功能"时完全一致的混音。
    // 不给老玩家一个突然的变化：滑块是让他往下调的，不是让他先被吓一跳的。
    volSfx: 1,       // 音效 0..1
    volBgm: 1,       // BGM 0..1（BGM 本身的音符音量已经压得很低）
    zoom: 1,         // 视角缩放档位（合法档位以 render.js 的 ZOOM_STEPS 为准）
    guide: true      // 左侧操作指南是否展开
  };

  function clamp01(v, d) {
    const n = Number(v);
    if (!isFinite(n)) return d;
    return Math.max(0, Math.min(1, n));
  }

  /** 把任意输入修成一份合法设置。绝不抛异常，永远返回可用对象。 */
  function sanitize(raw) {
    const out = {};
    const r = (raw && typeof raw === 'object') ? raw : {};
    out.volSfx = clamp01(r.volSfx, DEFAULTS.volSfx);
    out.volBgm = clamp01(r.volBgm, DEFAULTS.volBgm);
    // 缩放只做粗校验（合法档位由 render.setZoom 再夹一次）——
    // 两处都夹不是重复，是"谁都能单独扛住坏数据"
    const z = Number(r.zoom);
    out.zoom = (isFinite(z) && z >= 0.4 && z <= 3) ? z : DEFAULTS.zoom;
    // 只有显式的 false 才算关闭；缺字段 = 默认开
    out.guide = !(r.guide === false);
    return out;
  }

  let cache = null;

  function load() {
    if (cache) return cache;
    let raw = null;
    try {
      const s = global.localStorage && global.localStorage.getItem(KEY);
      if (s) raw = JSON.parse(s);
    } catch (e) { raw = null; }   // 读坏了/JSON 坏了 → 用默认值，不能因此打不开游戏
    cache = sanitize(raw);
    return cache;
  }

  function all() { const s = load(), o = {}; for (const k in s) o[k] = s[k]; return o; }
  function get(k) { return load()[k]; }

  function set(k, v) {
    const s = load();
    if (!(k in DEFAULTS)) return all();
    s[k] = v;
    cache = sanitize(s);
    try {
      if (global.localStorage) global.localStorage.setItem(KEY, JSON.stringify(cache));
    } catch (e) { /* 隐私模式 / 配额满：内存里还是对的，不打断游戏 */ }
    return all();
  }

  function reset() {
    cache = sanitize({});
    try { if (global.localStorage) global.localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { }
    return all();
  }

  global.TideSettings = {
    DEFAULTS: DEFAULTS, sanitize: sanitize,
    all: all, get: get, set: set, reset: reset, load: load
  };
})(window);
