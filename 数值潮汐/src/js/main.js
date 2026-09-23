/* ============================================================
   数值潮汐 · 主循环与输入
   把「核心逻辑 / 渲染 / 界面 / 音效」四条线接起来，并处理操作。

   关于移动的设计（用户明确要求）：
     单格移动是**基底**：点相邻格、按方向键，都只走一格。
     在基底之上叠两种"更远的移动"：
       · 长按 —— 按住鼠标或方向键不放，就持续朝那个方向 / 那个目标走
       · 点击远处 —— 自动 A* 寻路走过去（有路径预览）
     三种方式最终都拆成一次次 stepTo()，所以规则只有一份，
     不会出现"点着走能穿墙、按键盘不能"这类不一致。
   ============================================================ */
(function (global) {
  'use strict';

  const D = global.TideData;
  const C = global.TideCore;
  const R = global.TideRender;
  const UI = global.TideUI;
  const FX = global.TideFX;
  const AU = global.TideAudio;

  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  const state = {
    game: null,
    running: false,
    raf: 0,
    lastT: 0,
    uiAcc: 0,
    // 移动
    held: {},              // 按住的方向键
    keyTimer: 0,
    moveTarget: null,      // {x,y} 目标格
    moveHold: false,       // 是否处于"按住"状态
    moveTimer: 0,
    path: null,
    hoverCell: null,
    faceLeft: false,
    moving: false
  };

  const REPEAT_FIRST = 175;   // 按住后第一次重复的延迟
  const REPEAT_EVERY = 92;    // 之后的重复间隔
  const WALK_EVERY = 88;      // 自动寻路每步间隔 (ms)

  /* ============================================================
     启动
     ============================================================ */
  /* ============================================================
     出错兜底（v10.5 重做）

     上一版是「全屏覆盖 + 停掉 rAF」，理由是"别给玩家留黑屏"。
     它有个致命前提：假定"任何未捕获错误 = 游戏已经不可用"。
     事实并非如此 —— 浏览器还会在 window 上报**资源加载失败**
     （那种事件没有 message、只有 target），页面里任何一个 404 都能触发。
     于是一个无害的 404 变成一张盖住整个游戏的黑屏，
     玩家看到的正是"一开局就弹出错误、无法开始游戏"。

     现在的规则：
       · 只有带 message / error 的**真 JS 错误**才计入，资源错误一律忽略；
       · 默认只弹一条**可关闭、会自己消失**的左下角提示，**不停机** ——
         先让玩家能继续玩，比什么都重要；
       · 只有短时间内反复出错（真的崩了）才升级成全屏提示。
     ============================================================ */
  const errLog = [];
  let errTimes = [];
  let tipShown = null;

  function recordError(msg) {
    const text = String(msg == null ? '未知错误' : msg).slice(0, 300);
    errLog.unshift(text);
    errLog.length = Math.min(errLog.length, 8);
    // 也留一份在 localStorage：玩家重开之后，我们还能看到上一局到底报了什么
    try { global.localStorage.setItem('tide.errs', JSON.stringify(errLog.slice(0, 5))); } catch (e) { }
    const now = Date.now();
    errTimes.push(now);
    errTimes = errTimes.filter(function (t) { return now - t < 12000; });
    return text;
  }

  function softTip(text) {
    try {
      if (tipShown) { tipShown.remove(); tipShown = null; }
      const el = document.createElement('div');
      el.setAttribute('style',
        'position:fixed;left:12px;bottom:12px;z-index:9000;max-width:430px;' +
        'font:12px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;color:#ccd6e6;' +
        'background:rgba(22,12,14,0.94);border:1px solid rgba(224,82,90,0.42);' +
        'border-radius:8px;padding:9px 13px;box-shadow:0 8px 24px rgba(0,0,0,0.5)');
      el.innerHTML = '<b style="color:#e0525a">出了点小问题</b>' +
        '<span style="color:#61708a">（不影响玩，可以继续；这条会自己消失）</span>' +
        '<div style="color:#8d99ac;margin-top:4px;word-break:break-all">' +
        text.replace(/[<>&]/g, '') + '</div>';
      document.body.appendChild(el);
      tipShown = el;
      setTimeout(function () { if (tipShown === el) { el.remove(); tipShown = null; } }, 15000);
    } catch (e) { }
  }

  /** 真到了这一步才停机：画布拿不到、或者错误在短时间内反复出现 */
  function fatal(msg, hint) {
    try {
      if (global.__tideHardStop) return;
      global.__tideHardStop = true;
      if (state && state.raf) { try { global.cancelAnimationFrame(state.raf); } catch (e) { } }
      const detail = [String(msg || '未知错误').slice(0, 300)].concat(errLog.slice(1)).join('\n');
      const el = document.createElement('div');
      el.setAttribute('style',
        'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(5,7,13,0.94);font:14px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;color:#ccd6e6');
      el.innerHTML =
        '<div style="max-width:480px;padding:26px 28px;border:1px solid rgba(160,200,235,0.26);' +
        'border-radius:10px;background:linear-gradient(180deg,rgba(16,22,35,0.98),rgba(8,12,20,0.99))">' +
        '<div style="font-size:17px;color:#e0525a;margin-bottom:10px">潮水出了点问题</div>' +
        '<div style="color:#8d99ac;margin-bottom:14px">' +
        (hint || '游戏遇到了一个没有预料到的错误，已经停下以免数据错乱。') + '</div>' +
        '<pre id="fatal-detail" style="white-space:pre-wrap;word-break:break-all;font-size:12px;color:#61708a;' +
        'background:rgba(0,0,0,0.35);padding:10px;border-radius:6px;margin:0 0 16px">' +
        detail.replace(/[<>&]/g, '') + '</pre>' +
        '<button id="fatal-restart" style="cursor:pointer;font:inherit;padding:9px 18px;border-radius:6px;' +
        'border:1px solid rgba(126,224,214,0.5);color:#9fe6f2;background:rgba(18,40,48,0.9)">重新开始</button>' +
        '<button id="fatal-copy" style="cursor:pointer;font:inherit;padding:9px 16px;margin-left:8px;' +
        'border-radius:6px;border:1px solid rgba(160,200,235,0.26);color:#8d99ac;background:transparent">复制错误信息</button>' +
        '</div>';
      document.body.appendChild(el);
      document.getElementById('fatal-restart').onclick = function () { global.location.reload(); };
      document.getElementById('fatal-copy').onclick = function () {
        const t = document.getElementById('fatal-detail').textContent;
        try {
          if (global.navigator && global.navigator.clipboard) global.navigator.clipboard.writeText(t);
        } catch (e) { }
      };
    } catch (e) { /* 兜底自己再出错就只能算了 */ }
  }

  function onErrorEvent(msg) {
    const text = recordError(msg);
    if (errTimes.length >= 5) {
      fatal(text, '短时间内连续出错 5 次，游戏已经停下以免数据错乱。');
    } else {
      softTip(text);
    }
  }

  function installErrorNet() {
    // 用捕获阶段：资源加载失败不冒泡，只会在捕获阶段到达 window。
    // 所以必须 capture=true 才收得全，然后靠"有没有 message"把它们筛掉。
    global.addEventListener('error', function (ev) {
      if (!ev || (!ev.message && !ev.error)) return;      // 资源错误：忽略，别拿 404 当崩溃
      onErrorEvent(ev.message || (ev.error && ev.error.message));
    }, true);
    global.addEventListener('unhandledrejection', function (ev) {
      const r = ev && ev.reason;
      if (!r) return;
      onErrorEvent(r.message ? r.message : String(r));
    });
  }

  function boot() {
    installErrorNet();     // 第一件事：先把兜底挂上，后面的初始化出错也有话说
    global.TideArt.buildTiles();
    // 先恢复存档里的视角倍率，再走 UI.init / resize ——
    // 顺序反了的话首次 resize 会按 1× 建画布、随后 setZoom 再重建一次，
    // 玩家会看到开局一瞬间的尺寸跳变。
    // （resize 在容器还没布局时会提前返回，此时 zoom 已经存下来了，
    //   等真正布局好那一次 resize 会按新倍率建画布，不会漏。）
    if (global.TideSettings) R.setZoom(global.TideSettings.get('zoom'));
    UI.init();
    UI.applySettings();      // 先把存档里的音量/缩放应用到运行时，再画第一帧
    UI.showMenu();           // 第 0 层是开始菜单，不是选人界面
    bindGlobalInput();
    state.raf = requestAnimationFrame(loop);
    // 让渲染先完成一次真实尺寸的初始化，再跑调试自动局
    if (global.location.search.indexOf('auto=') >= 0) {
      setTimeout(function () { R.init(); debugAuto(); }, 60);
    }
  }

  /* ============================================================
     调试入口：?auto=职业,难度,种子&walk=N
     自动开局并走 N 步（用游戏自己的寻路，顺便把地图探开）。
     加它是为了能在无头 Edge 里直接 `--screenshot` 出一张确定状态的画面，
     从而把"改渲染代码 → 看画面"变成可循环、可比对的流程。
     正常游玩不会走到这里。
     ============================================================ */
  function debugAuto() {
    const q = {};
    (global.location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      const p = kv.split('=');
      q[p[0]] = decodeURIComponent(p[1] || '');
    });
    if (!q.auto) return false;
    const a = q.auto.split(',');
    const walk = Math.max(0, parseInt(q.walk || '0', 10) || 0);
    start({
      mode: 'normal',
      classKey: a[0] || 'warlord',
      difficulty: a[1] || 'standard',
      seed: a[2] ? (parseInt(a[2], 10) >>> 0) : 20260922
    });
    if (walk > 0) {
      const g = state.game;
      const rng = new C.RNG(999);
      let guard = 0;
      while (g.status === 'playing' && g.turn < walk && guard++ < walk * 4) {
        if (g.pendingRelic) { g.chooseRelic(g.pendingRelic[0].id); continue; }
        // 随机挑一个地板格走过去，把地图探开
        let tgt = null;
        for (let t = 0; t < 40; t++) {
          const x = rng.int(1, g.W - 2), y = rng.int(1, g.H - 2);
          if (g.walkable(x, y)) { tgt = { x: x, y: y }; break; }
        }
        const path = tgt ? g.findPath(g.px, g.py, tgt.x, tgt.y, 3000) : null;
        if (!path || path.length < 2) { g.endTurn(); continue; }
        if (!g.stepTo(path[1].x, path[1].y)) g.endTurn();
      }
      g.drainEvents();
      FX.clear();
      R.markDirty();
      UI.render(g);
    }
    return true;
  }

  function dailySeed() {
    const d = new Date();
    return (d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) >>> 0;
  }

  /** ?meta=0 → 关掉局外加成。平衡测试与"复现某个问题"都需要一个与存档无关的开局。 */
  function metaOff() {
    return /[?&]meta=0(&|$)/.test(global.location.search || '');
  }

  function start(opts) {
    opts = opts || {};
    const p = UI.pick;
    // seed 显式传入时用传入值 —— 自动化测试必须可复现，
    // 否则"亮度 25.3 还是 79.2"完全取决于开局随机到的地图，根本没法判定回归。
    const seed = (opts.seed !== undefined && opts.seed !== null) ? opts.seed
      : (opts.mode === 'daily' ? dailySeed() : undefined);
    state.game = new C.Game({
      classKey: opts.classKey || p.cls,
      difficulty: opts.difficulty || p.diff,
      // 无尽模式**不是**一个新难度：它沿用这一局选的 difficulty，
      // 只是把"到第 N 层结束"这条线拿掉（规则全在 core.js 里）
      endless: opts.mode === 'endless',
      seed: seed,
      // 元进度：默认吃存档里的永久解锁。
      // 优先级写死成三级，别让"谁说了算"变得要靠猜：
      //   ① opts.meta 显式传入（null = 这一局不要局外加成）
      //   ② ?meta=0（平衡测试、复现某个 bug 时需要一个与存档无关的开局）
      //   ③ 存档里的已购集合
      // 存档为空时 effects() 全是中性值，所以自动化路径天然不受影响。
      meta: (opts.meta !== undefined) ? opts.meta
        : (metaOff() ? null : global.TideMeta.owned())
    });
    state.game.runSeq = (state.runSeq || 0) + 1;
    state.moveTarget = null; state.path = null; state.moving = false;
    state.mode = opts.mode || 'normal';
    state.lastLevel = 1;
    FX.clear();
    AU.init();
    UI.showGame();
    R.markDirty();
    UI.render(state.game);
    if (opts.mode === 'daily') UI.toast('每日挑战 · 种子 ' + dailySeed());
  }

  function restart() {
    if (!state.game) { UI.showTitle(); return; }
    start({ mode: state.mode || 'normal' });
  }

  /* ============================================================
     输入
     ============================================================ */
  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right'
  };

  function bindGlobalInput() {
    global.addEventListener('keydown', function (ev) {
      // Esc 的语义是**逐层往回退**，而不是"一键回主菜单"：
      // 先关最上面那层弹窗，全关完了才轮到暂停菜单。
      // 顺序写死在这里，别让每个弹窗自己去抢 Esc —— 那样按键行为会取决于
      // 谁的监听先挂上，改一处就可能把另一处弄坏。
      if (ev.key === 'Escape') {
        if (UI.isInventoryOpen()) { UI.closeInventory(); return; }
        if (UI.isMetaOpen()) { UI.closeMeta(); return; }
        if (UI.isSettingsOpen()) { UI.closeSettings(); return; }
        if (UI.isBoardOpen()) { UI.closeBoard(); return; }
        if (UI.isHelpOpen()) { UI.closeHelp(); return; }
        if (UI.isPauseOpen()) { UI.closePause(); return; }
        // 还没开局 = 在菜单或选人界面。选人界面的"上一层"就是主菜单。
        if (!state.game) { UI.showMenu(); return; }
        // !ev.repeat 是必要的：按住 Esc 时系统会持续发 keydown，
        // 少了这一条就会出现"关掉背包的那一次长按紧接着弹出暂停菜单"。
        if (!ev.repeat && state.game.status === 'playing' && !state.game.pendingRelic) {
          state.held = {};          // 把按住的键清掉，免得关掉菜单后角色自己往前冲
          UI.showPause();
        }
        return;
      }
      // 操作指南的折叠（G）。它不属于游戏状态，所以放在各种输入门禁之前 ——
      // 暂停时也该能收起来（暂停菜单正好会盖住左边那块）。
      if (ev.key === 'g' || ev.key === 'G') {
        if (UI.toggleGuide) UI.toggleGuide();
        return;
      }
      // Tab 也必须拦掉：它在浏览器里是切换焦点，不拦的话一按焦点就跑掉，
      // 之后所有键盘操作全部失效（表现为按什么都没反应）。
      if (/^(Arrow| |Tab)/.test(ev.key)) ev.preventDefault();
      if (!state.game || state.game.status !== 'playing') return;

      // 暂停菜单开着 → 除了 Esc（上面已处理）什么都别做。
      // 集中在这一处而不是散进每个分支：菜单就是"拔掉输入"的地方，
      // 漏掉一条分支的后果是"菜单开着，角色还在走"。
      if (UI.isPauseOpen()) return;

      // 背包打开时，只允许操作背包的按键，不能让角色继续走
      if (UI.isInventoryOpen()) {
        if (ev.key === 'e' || ev.key === 'E' || ev.key === 'i' || ev.key === 'I' ||
            ev.key === 'b' || ev.key === 'B' || ev.key === 'Tab') UI.closeInventory();
        return;
      }
      // 正在选秘藏：方向键移动光标、空格/回车确认。
      // 这一段必须放在"选牌时一切输入都停"之前 —— 选牌本身就是这个状态下
      // 唯一该响应的操作，而它以前只有鼠标入口。
      if (state.game.pendingRelic) {
        if (ev.key === 'ArrowLeft' || ev.key === 'a' || ev.key === 'A') { UI.relicMove(-1); return; }
        if (ev.key === 'ArrowRight' || ev.key === 'd' || ev.key === 'D') { UI.relicMove(1); return; }
        if (ev.key === ' ' || ev.key === 'Enter') { UI.relicConfirm(); return; }
        return;      // 其余按键照旧全部吞掉（走位/背包/技能都不该在选牌时生效）
      }

      const k = KEYMAP[ev.key];
      if (k) {
        if (!state.held[k]) {
          state.held[k] = 1;
          state.keyTimer = REPEAT_FIRST;
          stepDir(k);
        }
        return;
      }
      if (ev.key === 'e' || ev.key === 'E' || ev.key === 'i' || ev.key === 'I' ||
          ev.key === 'b' || ev.key === 'B' || ev.key === 'Tab') {
        UI.toggleInventory('bag');
      } else if (ev.key === 'h' || ev.key === 'H' || ev.key === '?') {
        UI.showHelp();
      } else if (ev.key === 'm' || ev.key === 'M') {
        const on = !AU.isOn();
        AU.toggle(on);
        document.getElementById('btn-sound').classList.toggle('off', !on);
        UI.toast(on ? '音效已开' : '音效已关');
      } else if (ev.key === 'q' || ev.key === 'Q') {
        castSkill();
      } else if (ev.key === '1' || ev.key === '2') {
        // 直接选而不是单键来回切：两个键各对应一个确定的结果，
        // 按几次都不会"切过头"，也不需要玩家记"现在在哪一边"。
        setAttackType(ev.key === '1' ? 'p' : 'm');
      } else if (ev.key === ' ') {
        waitTurn();
      }
    });
    global.addEventListener('keyup', function (ev) {
      const k = KEYMAP[ev.key];
      if (k) delete state.held[k];
    });
    global.addEventListener('blur', function () { state.held = {}; });

  /* 页面失焦 / 被切走 → 把音乐停掉。
     不只是为了礼貌：后台标签页里 setInterval 会被节流到 1s，而排程器是按
     「每 25ms 往前看 0.25 秒」写的 —— 节流之后它一次要补一整秒的音符，
     音符全挤在一起，同时还白烧 CPU。索性停掉，切回来重新起拍。 */
  function musicWake(on) {
    if (on) AU.musicResume(); else AU.musicPause();
  }
  document.addEventListener('visibilitychange', function () { musicWake(!document.hidden); });
  global.addEventListener('focus', function () { musicWake(true); });
  global.addEventListener('blur', function () { musicWake(false); });

    const cv = document.getElementById('view');
    cv.addEventListener('mousedown', function (ev) {
      if (!state.game || state.game.status !== 'playing' || state.game.pendingRelic) return;
      const cell = R.toCell(ev.clientX, ev.clientY);
      if (ev.button === 2) return;
      ev.preventDefault();
      state.downAt = performance.now();
      state.moveTarget = cell;
      state.moveHold = true;
      state.moveTimer = WALK_EVERY;      // 立刻走出第一步
      updatePreviewPath();
    });
    global.addEventListener('mouseup', function () {
      if (!state.moveTarget) return;
      const quick = performance.now() - (state.downAt || 0) < 220;
      const g = state.game;
      const far = g && (Math.abs(state.moveTarget.x - g.px) + Math.abs(state.moveTarget.y - g.py)) > 1;
      // 快速点击远处 → 自动走完剩下的路；按住 → 松手即停
      state.moveHold = false;
      state.autoWalk = quick && far;
      if (!state.autoWalk) state.moveTarget = null;
      updatePreviewPath();
    });
    cv.addEventListener('mouseleave', function () {
      state.moveHold = false; state.moveTarget = null; state.autoWalk = false;
      updatePreviewPath();
    });
    cv.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

  /* 滚轮缩放视角。
     只在"正在玩"的时候响应：标题页/背包/暂停菜单里滚轮不该动视角
     （在背包里滚动是想翻列表，不是想缩放地图）。
     passive:false 是必须的 —— 浏览器默认把 wheel 当被动事件，
     不在监听时声明就没法 preventDefault，页面会跟着一起滚。 */
  cv.addEventListener('wheel', function (ev) {
    if (!state.game || state.game.status !== 'playing') return;
    if (UI.isInventoryOpen() || UI.isPauseOpen() || UI.isHelpOpen() || UI.isMetaOpen()) return;
    ev.preventDefault();
    const z = R.zoomBy(ev.deltaY < 0 ? 1 : -1);
    global.TideSettings.set('zoom', z);
    UI.toast('视角 ' + Math.round(z * 100) + '%');
  }, { passive: false });
    cv.addEventListener('mousemove', function (ev) {
      const cell = R.toCell(ev.clientX, ev.clientY);
      state.hoverCell = cell;
      if (state.game) UI.enemyInfo(state.game, state.game.enemyAt(cell.x, cell.y), ev);
    });
  }

  function updatePreviewPath() {
    const g = state.game;
    if (!g || !state.moveTarget) { state.path = null; return; }
    const t = state.moveTarget;
    if (Math.abs(t.x - g.px) + Math.abs(t.y - g.py) <= 1) { state.path = null; return; }
    state.path = g.findPath(g.px, g.py, t.x, t.y, 700);
  }

  /* ============================================================
     单格移动（基底）
     ============================================================ */
  function stepDir(k) {
    const g = state.game;
    if (!g || g.status !== 'playing' || g.pendingRelic) return;
    const d = DIRS[k];
    if (d[0] < 0) state.faceLeft = true;
    if (d[0] > 0) state.faceLeft = false;
    doStep(g.px + d[0], g.py + d[1]);
  }

  function doStep(x, y) {
    const g = state.game;
    if (!g) return false;
    const dx = x - g.px, dy = y - g.py;
    const willFight = !!g.enemyAt(x, y);
    const before = { hp: g.hp, kills: g.kills, depth: g.depth };
    const ok = g.stepTo(x, y);
    if (ok) {
      // 走进敌人格 = 一次攻击：让角色朝目标做一个小前倾
      if (willFight) R.action(dx, dy);
      afterAction(g, before);
    }
    return ok;
  }

  /** 技能键脉冲一下：把"你按的那一下被收到了"这件事做在界面上 */
  function pulseSkillButton() {
    const b = document.getElementById('btn-skill');
    if (!b) return;
    b.classList.remove('cast');
    void b.offsetWidth;         // 强制重排，否则连续两次放技能时动画不会重播
    b.classList.add('cast');
    setTimeout(function () { b.classList.remove('cast'); }, 480);
  }

  /**
   * 释放魂技。
   * 职责边界要说清楚：**能不能放由模型判断**（g.useSkill() 返回原因），
   * 这里只负责把"为什么不能放"翻译成人话。
   * 把条件写在这一层，模拟器的 AI 就会绕过规则 —— 这个坑上一轮刚踩过。
   */  function castSkill() {
    const g = state.game;
    if (!g || g.status !== 'playing' || g.pendingRelic) return;
    const before = { hp: g.hp, kills: g.kills, depth: g.depth };
    const r = g.useSkill();
    if (!r.ok) {
      if (r.reason === 'cd') UI.toast('魂技还有 ' + r.cd + ' 回合');
      else if (r.reason === 'empty') UI.toast('附近没有目标');
      AU.play('nocd');
      return;
    }
    afterAction(g, before);
  }

  /**
   * 切换出手类型（物理 / 法术）—— 界面层唯一的入口。
   *
   * 它只切"用哪一路结算"，**不算给玩家看哪一路更高** ——
   * 那是玩家自己该做的题。整个函数里没有一次 bestAttack 调用，
   * 这是刻意的：一旦这里偷偷比较了一下，整套"让玩家自己算"的设计就塌了。
   *
   * 和魂技同一条原则：界面不直接改模型语义，收口在这一个函数里，
   * 免得某条路径漏掉音效或校验。
   */
  function setAttackType(t) {
    const g = state.game;
    if (!g || g.status !== 'playing' || g.pendingRelic) return;
    if (t !== 'p' && t !== 'm') return;
    if (g.atkType === t) return;
    g.atkType = t;
    AU.ui();
    // 不在这里手动重绘：UI 的 render(game) 每帧都会跑（见 ui.js 里
    // music() 那条注释），下一帧自然同步。手动重绘反而会引入两次渲染。
  }

  function waitTurn() {
    const g = state.game;
    if (!g || g.status !== 'playing' || g.pendingRelic) return;
    const before = { hp: g.hp, kills: g.kills, depth: g.depth };
    g.endTurn();
    afterAction(g, before);
  }

  /** 把这一轮产生的事件翻译成音效 / 粒子 / 界面更新 */
  function afterAction(g, before) {
    const evs = g.drainEvents();
    FX.consume(evs, {
      cx: (x) => x * R.TILE + R.TILE / 2 - R.cam.x,
      cy: (y) => y * R.TILE + R.TILE / 2 - R.cam.y,
      w: R.view.w, h: R.view.h, game: g
    });
    for (const ev of evs) {
      if (ev.kind === 'hit' || ev.kind === 'fight') {
        for (const r of (ev.rounds || [])) {
          if (r.dodge) continue;
          if (r.crit) AU.play('crit');
          else AU.play(r.type === 'm' ? 'magic' : 'hit', (r.dmg || 0) > 24);
          if (r.heal) AU.play('heal');
        }
        if (g.hp < before.hp) AU.play('hurt');
      } else if (ev.kind === 'kill') { AU.play('kill'); }
      else if (ev.kind === 'skill') {
        // 四个层次一起上，缺一个都会"没感觉"：
        //   音     各技能独立音色（听出来的信息量最大）
        //   动作   角色身上浮现施法姿态（这个动作属于玩家自己）
        //   特效   每个技能的招牌形状（地裂 / 水束 / 残影 / 护盾罩）
        //   界面   技能键脉冲一下，确认"你按的那一下被收到了"
        AU.play('skill', ev.key);
        R.castSkill(ev);
        pulseSkillButton();
        UI.toast(ev.moves
          ? ('【' + ev.name + '】额外行动 ' + ev.moves + ' 次')
          : ('【' + ev.name + '】' + (ev.hits ? '命中 ' + ev.hits + ' 个敌人' : '已生效')));
      }
      else if (ev.kind === 'gold') { AU.play('coin'); }
      else if (ev.kind === 'fuse') { AU.play('levelup'); UI.toast('融合出「' + ev.item.name + '」· ' + ev.item.rarityName); }
      else if (ev.kind === 'loot') { AU.play('loot', ev.item.rarity); UI.toast('掉落：' + ev.item.name + '（' + ev.item.rarityName + '）'); }
      else if (ev.kind === 'bagfull') { UI.toast('背包已满 —— 按 E 卖掉一些'); }
      else if (ev.kind === 'chest') { AU.play('chest'); }
      else if (ev.kind === 'heal') { AU.play('heal'); }
      else if (ev.kind === 'tide') { AU.play('tide', ev.rising); }
      else if (ev.kind === 'descend') { AU.play('descend'); UI.toast('下潜到第 ' + ev.depth + ' 层'); }
      else if (ev.kind === 'region') {
        // 换区域是"事件"不是"流水账"：给横幅 + 独立音色，
        // 不塞进已经被掉落 / 融合 / 金币占满的 toast 里
        AU.play('region', ev.rtype);
        UI.regionBanner(ev);
      }
      else if (ev.kind === 'death') { AU.play('death'); }
      else if (ev.kind === 'win') { AU.play('win'); }
      else if (ev.kind === 'shop' && ev.open) {
        // 踩到潮汐商栈：自动切到商店页
        UI.openInventory('shop');
        AU.play('coin');
      } else if (ev.kind === 'sell' || ev.kind === 'buy') { }
    }
    // 升级了就在角色头上撒一把金粒子
    if (g.kills > before.kills && g.level() > (state.lastLevel || 1)) {
      AU.play('levelup');
      g.events.push({ kind: 'levelup' });
      FX.consume(g.drainEvents(), {
        cx: (x) => x * R.TILE + R.TILE / 2 - R.cam.x,
        cy: (y) => y * R.TILE + R.TILE / 2 - R.cam.y,
        w: R.view.w, h: R.view.h, game: g
      });
    }
    state.lastLevel = g.level();
    if (g.status === 'dead' || g.status === 'win') {
      setTimeout(function () { UI.showOver(g); }, 620);
    }
    R.markDirty();
    UI.render(g);
    if (state.moveTarget && (state.autoWalk || state.moveHold)) updatePreviewPath();
    else state.path = null;
  }

  /* ============================================================
     主循环
     ============================================================ */
  function loop(t) {
    state.raf = requestAnimationFrame(loop);
    const dt = Math.min(64, t - (state.lastT || t));
    state.lastT = t;
    const g = state.game;
    if (!g) return;

    const blocked = UI.isInventoryOpen() || UI.isHelpOpen() || UI.isPauseOpen() || !!g.pendingRelic;

    FX.update();

    // —— 方向键长按连走 ——
    if (Object.keys(state.held).length) {
      state.keyTimer -= dt;
      if (state.keyTimer <= 0) {
        state.keyTimer = REPEAT_EVERY;
        const k = Object.keys(state.held)[0];
        if (g.status === 'playing' && !blocked) stepDir(k);
      }
    } else {
      state.keyTimer = REPEAT_FIRST;
    }

    // —— 鼠标长按 / 点击寻路 ——
    if (state.moveTarget && g.status === 'playing' && !blocked) {
      if (state.moveHold || state.autoWalk) {
        state.moveTimer -= dt;
        if (state.moveTimer <= 0) {
          state.moveTimer = WALK_EVERY;
          const tgt = state.moveTarget;
          const d = Math.abs(tgt.x - g.px) + Math.abs(tgt.y - g.py);
          if (d <= 1) {
            if (!doStep(tgt.x, tgt.y)) { state.moveTarget = null; state.autoWalk = false; }
            else if (!state.moveHold) { state.moveTarget = null; state.autoWalk = false; }
          } else {
            const path = g.findPath(g.px, g.py, tgt.x, tgt.y, 3000);
            if (path && path.length > 1) {
              if (!doStep(path[1].x, path[1].y)) { state.moveTarget = null; state.autoWalk = false; }
            } else { state.moveTarget = null; state.autoWalk = false; }
            updatePreviewPath();
          }
        }
      }
    } else { state.path = null; }

    // —— 渲染（dt 传进去，插值才不会受帧率影响）——
    R.render(g, { faceLeft: state.faceLeft, path: state.path }, FX.offset(), dt);

    // —— 界面不再每 66ms 重建 DOM ——
    // 这是个回合制游戏，状态只在玩家动作后变化，已经由 afterAction 驱动。
    // 之前那个 15fps 的轮询重建 40 个格子 + 12 行属性 + 5 个槽位，
    // 是纯粹的浪费，而且会造成肉眼可见的输入迟滞。
  }

  /* ============================================================
     对外
     ============================================================ */
  global.TideMain = {
    boot: boot,
    start: start,
    restart: restart,
    refresh: function () { if (state.game) UI.render(state.game); },
    /* 背包 / 商店里的操作（融合、出售、购买）也会往事件队列里推东西，
       但它们的入口在 ui.js。用完必须回来消费一次事件队列 ——
       否则音效、飘字、提示条全都不出现。
       玩家反馈的"融合功能可以，但没有弹出东西"就是这么来的。 */
    flush: function () {
      const g = state.game;
      if (g) afterAction(g, { hp: g.hp, kills: g.kills, depth: g.depth });
    },
    chooseRelic: function (id) {
      const g = state.game;
      if (!g) return;
      g.chooseRelic(id);
      afterAction(g, { hp: g.hp, kills: g.kills, depth: g.depth });
    },
    get game() { return state.game; },
    set game(v) { state.game = v; },
    get state() { return state; },
    /* 界面上的技能键要调它。界面**不**直接调 g.useSkill()，
       因为那样会跳过音效/飘字/震屏这一整套反馈。 */
    castSkill: castSkill,
    setAttackType: setAttackType,
    /* 渲染层拿不到 2D 上下文之类的情况下，用它弹人话而不是每帧抛错 */
    fatal: fatal
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
