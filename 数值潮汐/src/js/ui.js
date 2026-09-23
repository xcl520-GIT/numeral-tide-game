/* ============================================================
   数值潮汐 · 界面层 v4.1

   主要变化：
   1. 背包从「侧栏里挤 20 个小格子」改成**独立整屏界面**（参考《我的世界》）：
      左边是角色 + 装备槽，右边是 40 格网格，底下是出售区。
      装备靠**拖拽**完成 —— 25px 的小格子用点击来"装备/卸下"太容易误操作。
   2. 新增金币与商店。商店与背包共用同一个界面，切成两个标签页。
   3. 侧栏保留属性面板（这是决策依据，必须常驻），
      但背包/装备槽改为"入口 + 摘要"，详细操作进整屏界面。
   ============================================================ */
(function (global) {
  'use strict';

  const D = global.TideData;
  const A = global.TideArt;
  const I = global.TideIcons;
  const C = global.TideCore;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function icon(name, size, cls) { return I ? I.svg(name, size || 18, cls) : ''; }

  function statVal(key, v) {
    const meta = D.STATS[key] || {};
    if (meta.pct) return Math.round(v * 100) + '%';
    return String(Math.round(v));
  }
  function statName(key) { return (D.STATS[key] || {}).name || key; }
  function slotLabel(slot) {
    for (const s of D.EQUIP_SLOTS) if (s.key === slot) return s.name;
    return slot;
  }

  const pick = { cls: 'warlord', diff: 'standard' };
  let invOpen = false;
  let invTab = 'bag';

  /* ============================================================
     开始界面的动态潮汐背景
     ============================================================ */
  let bgRaf = 0;
  function tideBackground(cv) {
    const c = cv.getContext('2d');
    // 拿不到 2D 上下文就别画背景。它只是标题页的装饰 ——
    // 而这个是**每帧**都在跑的循环：一旦 getContext 返回 null，
    // 就会每帧抛一次错。配上"任何错误都全屏停机"的兜底，
    // 几帧之内游戏就被锁死在标题页外面（"一开局就弹出错误、无法开始游戏"）。
    // 原则：**装饰不该有能力弄坏游戏。**
    if (!c) return;
    let t = 0;
    const motes = [];
    for (let i = 0; i < 70; i++) {
      motes.push({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 2.2, s: 0.0004 + Math.random() * 0.0016 });
    }
    function frame() {
      try {
        drawFrame();
      } catch (e) {
        // 画不出来就安静地停掉这个循环，别让它每帧污染错误日志
        return;
      }
      t += 1;
      bgRaf = requestAnimationFrame(frame);
    }
    function drawFrame() {
      const w = cv.width, h = cv.height;
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#080c18');
      g.addColorStop(0.45, '#0a1526');
      g.addColorStop(1, '#061019');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.save();
      for (let i = 0; i < 5; i++) {
        const x = w * (0.12 + i * 0.19) + Math.sin(t * 0.004 + i) * 26;
        const lg = c.createLinearGradient(x, 0, x + 90, h);
        lg.addColorStop(0, 'rgba(90,180,210,0.055)');
        lg.addColorStop(1, 'rgba(90,180,210,0)');
        c.fillStyle = lg;
        c.beginPath();
        c.moveTo(x, 0); c.lineTo(x + 70, 0); c.lineTo(x + 190, h); c.lineTo(x + 60, h);
        c.closePath(); c.fill();
      }
      c.restore();
      for (const m of motes) {
        m.y -= m.s * 16;
        if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); }
        c.fillStyle = 'rgba(150,220,235,' + (0.10 + m.r * 0.06).toFixed(3) + ')';
        c.beginPath();
        c.arc(m.x * w + Math.sin(t * 0.01 + m.y * 9) * 12, m.y * h, m.r, 0, Math.PI * 2);
        c.fill();
      }
      const layers = [
        { y: 0.72, a: 16, f: 0.0042, s: 0.9, col: 'rgba(24,74,104,0.55)' },
        { y: 0.79, a: 22, f: 0.0033, s: 1.4, col: 'rgba(31,92,128,0.60)' },
        { y: 0.86, a: 14, f: 0.0055, s: 2.0, col: 'rgba(43,126,160,0.55)' },
        { y: 0.93, a: 20, f: 0.0026, s: 2.7, col: 'rgba(70,170,200,0.42)' }
      ];
      for (const L of layers) {
        c.beginPath();
        c.moveTo(0, h);
        for (let x = 0; x <= w; x += 6) {
          const y = h * L.y + Math.sin(x * L.f + t * 0.02 * L.s) * L.a
            + Math.sin(x * L.f * 2.7 + t * 0.031 * L.s) * L.a * 0.35;
          c.lineTo(x, y);
        }
        c.lineTo(w, h);
        c.closePath();
        c.fillStyle = L.col;
        c.fill();
        c.beginPath();
        for (let x = 0; x <= w; x += 6) {
          const y = h * L.y + Math.sin(x * L.f + t * 0.02 * L.s) * L.a
            + Math.sin(x * L.f * 2.7 + t * 0.031 * L.s) * L.a * 0.35;
          if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.strokeStyle = 'rgba(150,235,255,0.16)';
        c.lineWidth = 1.2;
        c.stroke();
      }
    }
    const resize = function () {
      const r = cv.parentElement.getBoundingClientRect();
      // 容器还没布局时宽高可能是 0/NaN：给画布一个最小值，
      // 免得后面 createLinearGradient 之类拿到非有限值直接抛错
      cv.width = Math.max(1, Math.floor(r.width || 0));
      cv.height = Math.max(1, Math.floor(r.height || 0));
    };
    resize();
    global.addEventListener('resize', resize);
    frame();
  }

  /* ============================================================
     开始菜单（第 0 层）
     游戏的第一个界面，职责只有「去哪」：开始 / 无尽 / 排行榜 / 设置 / 退出。
     选职业与选难度往后挪一层 —— 那一步是「配置这一局」，不是「启动游戏」。
     ============================================================ */
  function buildMenu() {
    if (!$('menu-screen')) return;
    tideBackground($('menu-bg'));
    $('btn-menu-start').onclick = function () { global.TideAudio.ui(); showTitle(); };
    $('btn-menu-endless').onclick = function () {
      const MU = global.TideMeta;
      if (!MU.load().wins) { global.TideAudio.ui(true); toast('无尽模式要先通关一次'); return; }
      // 无尽模式的规则还没接上时**不许开局** —— 宁可按钮没反应，
      // 也不要进到一个"规则没定义"的局里（那种局面最难排查）
      if (!global.TideEndless) { global.TideAudio.ui(true); toast('无尽模式还没就绪'); return; }
      global.TideAudio.ui();
      global.TideMain.start({ mode: 'endless' });
    };
    $('btn-menu-board').onclick = function () { global.TideAudio.ui(); showBoard(); };
    $('btn-menu-settings').onclick = function () { global.TideAudio.ui(); showSettings(); };
    $('btn-menu-quit').onclick = function () { quitGame(); };
    bindSettings();
    if ($('guide-toggle')) $('guide-toggle').onclick = function () { global.TideAudio.ui(); toggleGuide(); };
    renderMenu();
  }

  /** 菜单上会变的部分：无尽模式的解锁状态、排行榜的一句话摘要 */
  function renderMenu() {
    const m = global.TideMeta ? global.TideMeta.load() : { wins: 0, best: 0 };
    const unlocked = !!m.wins;
    const eb = $('btn-menu-endless');
    if (eb) {
      eb.disabled = !unlocked;
      eb.classList.toggle('locked', !unlocked);
    }
    const note = $('menu-endless-note');
    if (note) note.textContent = unlocked ? '一直往下打 · 按分数排名' : '未解锁 · 先通关一次';
    const bn = $('menu-board-note');
    if (bn) {
      const b = m.board && m.board.length ? m.board[0] : null;
      bn.textContent = b ? ('最高 ' + b.score + ' 分 · ' + b.clsName) : '本机最高分 · 还没有记录';
    }
  }

  function showMenu() {
    closeHelp(); closeSettings(); closeBoard(); closePause();
    invOpen = false; syncInventory();
    $('menu-screen').classList.remove('hidden');
    $('title-screen').classList.add('hidden');
    $('game-screen').classList.add('hidden');
    $('over-modal').classList.add('hidden');
    relicShown = '';
    renderMenu();
    global.TideAudio.music('title');
    global.TideMain.game = null;
    setTimeout(function () { global.TideRender.resize(); }, 30);
  }

  /* ============================================================
     设置
     ============================================================ */
  let settingsOpen = false, boardOpen = false;
  function isSettingsOpen() { return settingsOpen; }
  function isBoardOpen() { return boardOpen; }

  /** 把存档里的设置应用到运行时。开局、清档、启动都走这一个函数 ——
      散着写迟早会漏一处，症状是"设置了但这次没生效"。 */
  function applySettings() {
    const s = global.TideSettings.load();
    global.TideAudio.setVolume(s.volSfx, s.volBgm);
    global.TideRender.setZoom(s.zoom);
    return s;
  }

  function renderSettings() {
    const s = global.TideSettings.load();
    if (!$('set-vol-sfx')) return;
    const pct = function (v) { return Math.round(v * 100) + '%'; };
    $('set-vol-sfx').value = Math.round(s.volSfx * 100);
    $('set-vol-bgm').value = Math.round(s.volBgm * 100);
    $('set-vol-sfx-num').textContent = pct(s.volSfx);
    $('set-vol-bgm-num').textContent = pct(s.volBgm);
    const steps = global.TideRender.ZOOM_STEPS;
    let zi = steps.indexOf(global.TideRender.zoom);
    if (zi < 0) zi = 0;
    $('set-zoom').min = 0;
    $('set-zoom').max = steps.length - 1;
    $('set-zoom').value = zi;
    $('set-zoom-num').textContent = pct(global.TideRender.zoom);
    const s2 = global.TideSettings.load();
    $('set-guide-toggle').textContent = s2.guide ? '展开' : '收起';
    $('set-note').textContent = '设置立即生效，自动保存。清空存档不会动设置，反之亦然。';
  }

  function showSettings() {
    settingsOpen = true;
    renderSettings();
    $('settings-modal').classList.remove('hidden');
  }
  function closeSettings() {
    settingsOpen = false;
    if ($('settings-modal')) $('settings-modal').classList.add('hidden');
  }

  function bindSettings() {
    if (!$('settings-modal')) return;
    const onRange = function (id, fn) {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', function () { fn(Number(el.value)); renderSettings(); });
      el.addEventListener('change', function () { fn(Number(el.value)); renderSettings(); });
    };
    onRange('set-vol-sfx', function (v) {
      global.TideSettings.set('volSfx', v / 100);
      global.TideAudio.setVolume(v / 100, null);
      global.TideAudio.ui();          // 每动一格给一声，边调边听
    });
    onRange('set-vol-bgm', function (v) {
      global.TideSettings.set('volBgm', v / 100);
      global.TideAudio.setVolume(null, v / 100);
    });
    onRange('set-zoom', function (v) {
      const steps = global.TideRender.ZOOM_STEPS;
      const z = steps[Math.max(0, Math.min(steps.length - 1, Math.round(v)))];
      global.TideSettings.set('zoom', z);
      global.TideRender.setZoom(z);
    });
    $('set-guide-toggle').onclick = function () {
      const s = global.TideSettings.load();
      global.TideSettings.set('guide', !s.guide);
      global.TideAudio.ui();
      renderSettings();
      if (global.TideUI.applyGuide) global.TideUI.applyGuide();
    };
    $('btn-wipe').onclick = function () {
      const b = $('btn-wipe');
      // 两步确认：清档不可逆，一次点击就抹掉几十局进度太狠了。
      // 但也不能用 window.confirm（WebView2 里会打断渲染且样式突兀）。
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1';
        b.textContent = '再点一次确认清空';
        global.TideAudio.ui(true);
        setTimeout(function () {
          if (b.dataset.armed === '1') {
            b.dataset.armed = '';
            b.textContent = '清空全部存档';
            renderSettings();
          }
        }, 4000);
        return;
      }
      b.dataset.armed = '';
      b.textContent = '清空全部存档';
      global.TideMeta.reset();
      global.TideSettings.reset();
      applySettings();
      renderSettings();
      renderMenu();
      global.TideAudio.ui(true);
      toast('存档与设置已清空');
    };
  }

  /* ---- 排行榜 ---- */
  function showBoard() {
    boardOpen = true;
    renderBoard();
    $('board-modal').classList.remove('hidden');
  }
  function closeBoard() {
    boardOpen = false;
    if ($('board-modal')) $('board-modal').classList.add('hidden');
  }
  function renderBoard() {
    const box = $('board-list');
    if (!box) return;
    const m = global.TideMeta.load();
    const list = m.board || [];
    if (!list.length) {
      box.innerHTML = '<div class="board-empty">还没有记录。打完一局就会出现在这里 ——' +
        '普通模式按通关/最深层计，无尽模式按分数计。</div>';
      return;
    }
    box.innerHTML = list.map(function (b, i) {
      const medal = i === 0 ? 'gold' : (i === 1 ? 'silver' : (i === 2 ? 'bronze' : ''));
      return '<div class="board-row ' + medal + '">' +
        '<span class="board-rank">' + (i + 1) + '</span>' +
        '<span class="board-score">' + b.score + '</span>' +
        '<span class="board-meta">' + esc(b.mode) + ' · ' + esc(b.clsName) + ' · ' +
        esc(b.diffName) + ' · 第 ' + b.depth + ' 层 · ' + esc(b.date) + '</span>' +
        '</div>';
    }).join('');
  }

  /* ---- 退出游戏 ---- */
  /**
   * WebView2 里网页不能自己关窗，必须由宿主（启动器）来关，
   * 所以给宿主发一条消息，由 launcher.cs 处理。
   * 在普通浏览器里没有宿主 —— 这时要**说实话**，而不是让按钮看起来坏了。
   */
  function quitGame() {
    global.TideAudio.ui(true);
    try {
      const wv = global.chrome && global.chrome.webview;
      if (wv && wv.postMessage) { wv.postMessage('quit'); return; }
    } catch (e) { }
    toast('浏览器里请直接关掉标签页；桌面版（数值潮汐.exe）在这里会退出游戏');
  }

  /* ============================================================
     开始界面
     ============================================================ */
  function buildStart() {
    tideBackground($('title-bg'));
    try {
      const saved = global.localStorage && global.localStorage.getItem('tide.pick');
      if (saved) { const o = JSON.parse(saved); pick.cls = o.cls || pick.cls; pick.diff = o.diff || pick.diff; }
    } catch (e) { }
    renderClassPicker();
    renderDiffPicker();
    $('btn-start').onclick = function () { global.TideMain.start({ mode: 'normal' }); global.TideAudio.ui(); };
    $('btn-daily').onclick = function () { global.TideMain.start({ mode: 'daily' }); global.TideAudio.ui(); };
    $('btn-help').onclick = function () { showHelp(); global.TideAudio.ui(); };
    const snd = $('btn-sound');
    snd.onclick = function () {
      const on = !global.TideAudio.isOn();
      global.TideAudio.toggle(on);
      snd.classList.toggle('off', !on);
      global.TideAudio.ui();
    };
  }
  function savePick() {
    try { global.localStorage.setItem('tide.pick', JSON.stringify(pick)); } catch (e) { }
  }

  function renderClassPicker() {
    const box = $('class-pick');
    box.innerHTML = D.CLASSES.map(function (c) {
      const s = c.stats;
      const bars = [['hp', 190], ['atkP', 52], ['atkM', 52], ['defP', 22], ['spd', 30], ['crit', 0.20]]
        .map(function (b) {
          const v = s[b[0]] || 0;
          const pct = Math.max(3, Math.min(100, Math.round(v / b[1] * 100)));
          const meta = D.STATS[b[0]];
          return '<div class="bar-row"><span class="bl">' + meta.short + '</span>' +
            '<span class="bar"><i style="width:' + pct + '%;background:' + meta.color + '"></i></span></div>';
        }).join('');
      return '<button class="cls-card' + (pick.cls === c.key ? ' on' : '') + '" data-cls="' + c.key + '">' +
        '<img class="cls-art" src="' + A.heroDataURL(c, 104) + '" alt="">' +
        '<div class="cls-info">' +
        '<div class="cls-name">' + esc(c.name) + '<em>' + esc(c.title) + '</em></div>' +
        '<div class="cls-play">' + esc(c.playstyle) + '</div>' +
        '<div class="cls-bars">' + bars + '</div>' +
        '<div class="cls-pass"><b>' + esc(c.passive.name) + '</b>' + esc(c.passive.text) + '</div>' +
        '<div class="cls-blurb">' + esc(c.blurb) + '</div>' +
        '</div></button>';
    }).join('');
    box.querySelectorAll('.cls-card').forEach(function (el) {
      el.onclick = function () { pick.cls = el.dataset.cls; savePick(); global.TideAudio.ui(); renderClassPicker(); };
    });
  }

  function renderDiffPicker() {
    const box = $('diff-pick');
    box.innerHTML = D.DIFF_ORDER.map(function (k) {
      const d = D.DIFFICULTIES[k];
      return '<button class="diff-card' + (pick.diff === k ? ' on' : '') + '" data-diff="' + k + '">' +
        '<div class="d-name">' + esc(d.name) + '</div>' +
        '<div class="d-tag">' + esc(d.tag) + '</div>' +
        '<div class="d-blurb">' + esc(d.blurb) + '</div>' +
        '<div class="d-meta">层数 ' + d.depth + ' · 潮汐每 ' + d.tideEvery + ' 回合</div>' +
        '</button>';
    }).join('');
    box.querySelectorAll('.diff-card').forEach(function (el) {
      el.onclick = function () { pick.diff = el.dataset.diff; savePick(); global.TideAudio.ui(); renderDiffPicker(); };
    });
  }

  /* ============================================================
     提示气泡（v10.2 重构）

     旧做法是给每个容器各挂一个 mousemove（侧栏装备槽一个、背包一个、
     商店一个、秘藏一个），结果是"漏一个地方就少一处提示"，
     而且每加一个新界面都要记得再挂一次。

     现在改成**整份文档上挂一个委托**：任何带 data-tip 属性的元素
     都会被自动识别。新增界面只要写上属性，提示就自动有。
     ============================================================ */
  let ttEl = null, tipTarget = null;

  function tooltip(html, ev) {
    if (!ttEl) ttEl = $('tooltip');
    if (!html) { ttEl.classList.add('hidden'); return; }
    ttEl.innerHTML = html;
    ttEl.classList.remove('hidden');
    if (ev) positionTip(ev);
  }
  function positionTip(ev) {
    if (!ttEl || ttEl.classList.contains('hidden')) return;
    const r = ttEl.getBoundingClientRect();
    let x = ev.clientX + 18, y = ev.clientY + 14;
    if (x + r.width > global.innerWidth - 10) x = ev.clientX - r.width - 18;
    if (y + r.height > global.innerHeight - 10) y = global.innerHeight - r.height - 10;
    ttEl.style.left = Math.max(6, x) + 'px';
    ttEl.style.top = Math.max(6, y) + 'px';
  }
  function hideTip() {
    if (ttEl) ttEl.classList.add('hidden');
    tipTarget = null;
  }

  /** 从元素上的 data-* 还原出要显示的内容 */
  function resolveTip(el) {
    const g = global.TideMain.game;
    if (!g) return '';
    const kind = el.dataset.tip;
    if (kind === 'stat') return statTooltip(el.dataset.stat);
    if (kind === 'sell') {
      return '<div class="tt-name">出售区</div><div class="tt-desc">把背包装备拖到这里换成金币。' +
        '出售价是身价的 ' + Math.round(D.LOOT.sellRate * 100) + '%。<br>' +
        '商店定价是身价的 ' + Math.round(D.LOOT.shopMarkup * 100) + '%，' +
        '所以买回来再卖出去永远亏。</div>';
    }
    if (kind === 'relic') {
      let r = null;
      for (const x of D.RELICS) if (x.id === el.dataset.relic) r = x;
      if (!r) return '';
      const sc = D.SCHOOLS[r.school] || {};
      return '<div class="tt-head" style="--rc:' + (sc.color || '#cbb994') + '">' +
        '<span class="tt-ico">' + icon(r.icon, 26) + '</span>' +
        '<span><b class="tt-name">' + esc(r.name) + '</b><i class="tt-sub">' +
        esc(sc.name || '') + '秘藏 · 已生效</i></span></div>' +
        '<div class="tt-body"><div class="tt-line mech"><span>' + icon('shining-heart', 14) +
        '效果</span><em>' + esc(r.text) + '</em></div></div>' +
        '<div class="tt-hint">秘藏不可更换，一局内持续生效</div>';
    }
    // 商栈的消耗品（潮汐圣水）不是装备，单独一张卡
    if (kind === 'heal') {
      const s = g.shopStock[+el.dataset.idx];
      if (!s) return '';
      return '<div class="tt-head"><span class="tt-ico">' + icon(s.icon, 26) + '</span>' +
        '<span><b class="tt-name">' + esc(s.name) + '</b>' +
        '<i class="tt-sub">潮汐商栈 · 补给</i></span></div>' +
        '<div class="tt-body"><div class="tt-line mech"><span>' + icon('shining-heart', 14) +
        '效果</span><em>' + esc(s.text) + '</em></div></div>' +
        '<div class="tt-cmp"><b>售价 ' + s.price + ' 金币</b></div>' +
        '<div class="tt-hint">点击右侧按钮购买</div>';
    }
    if (kind !== 'item') return '';

    const k = el.dataset.kind;
    const opts = { ctx: k };
    let item = null;
    if (k === 'equip') {
      item = g.equip[el.dataset.slot];
      // 空槽位也给一张卡：告诉玩家这里装什么、怎么装 —— 比什么都不弹更好懂
      if (!item) {
        return '<div class="tt-name">' + esc(slotLabel(el.dataset.slot)) + '</div>' +
          '<div class="tt-desc">空槽位。把背包装备拖到左侧对应槽位就能穿上。</div>';
      }
    } else if (k === 'bag') {
      item = g.bag[+el.dataset.idx];
    } else if (k === 'shop') {
      const s = g.shopStock[+el.dataset.idx];
      if (!s || !s.item) return '';
      item = s.item;
      opts.price = s.price;
      // 商店里同样显示与身上那件的差值 —— 这才是"该不该买"的判断依据
      opts.compare = true;
    }
    if (!item) return '';
    return itemTooltip(item, g, opts);
  }

  function bindTips() {
    document.addEventListener('mousemove', function (ev) {
      if (dragItem) { hideTip(); return; }
      const el = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null;
      if (!el) { hideTip(); return; }
      if (el === tipTarget) { positionTip(ev); return; }
      tipTarget = el;
      tooltip(resolveTip(el), ev);
    });
    document.addEventListener('mouseleave', hideTip);
    global.addEventListener('blur', hideTip);
  }

  function statTooltip(key) {
    const m = D.STATS[key];
    if (!m) return '';
    const g = global.TideMain.game;
    const v = g ? (g.stats()[key] || 0) : 0;
    return '<div class="tt-name">' + esc(m.name) + '</div>' +
      '<div class="tt-line imp"><span>当前值</span><b>' + statVal(key, v) + '</b></div>' +
      '<div class="tt-desc">' + esc(m.desc) + '</div>';
  }

  /**
   * 装备详情卡。
   * 这是玩家最需要的一张卡 —— 掉落装备的全部意义都在这里，
   * 所以必须写全：基础属性 / 词条 / 机制效果 / 与身上那件的逐项差值 / 身价。
   */
  function itemTooltip(item, game, opts) {
    opts = opts || {};
    const rar = D.rarityByKey(item.rarity);
    const compare = (opts.compare === false) ? null : (game ? game.equip[item.slot] : null);
    const isEquipped = compare === item;
    const diff = {};
    if (compare && !isEquipped) {
      const keys = {};
      for (const k in item.total) keys[k] = 1;
      for (const k in compare.total) keys[k] = 1;
      for (const k in keys) diff[k] = (item.total[k] || 0) - (compare.total[k] || 0);
    }

    let h = '<div class="tt-head" style="--rc:' + rar.color + '">' +
      '<span class="tt-ico">' + icon(item.icon, 28) + '</span>' +
      '<span><b class="tt-name" style="color:' + rar.color + '">' + esc(item.name) + '</b>' +
      '<i class="tt-sub">' + esc(rar.name) + ' · ' + esc(slotLabel(item.slot)) +
      ' · 深度 ' + item.depth + (isEquipped ? ' · <em class="tt-now">已装备</em>' : '') +
      '</i></span></div>';

    // —— 属性与词条 ——
    const impl = [], affix = [], mech = [];
    for (const line of item.text) {
      if (line.kind === 'imp') impl.push(line);
      else if (line.kind === 'affix') affix.push(line);
      else mech.push(line);
    }
    h += '<div class="tt-body">';
    if (impl.length) {
      h += '<div class="tt-sec">基础属性</div>';
      for (const l of impl) {
        h += '<div class="tt-line imp"><span>' + esc(statName(l.stat)) + '</span>' +
          '<b>' + (l.value >= 0 ? '+' : '') + statVal(l.stat, l.value) + '</b>' +
          (diff[l.stat] ? cmpTag(diff[l.stat], l.stat) : '') + '</div>';
      }
    }
    if (affix.length) {
      h += '<div class="tt-sec">词条</div>';
      for (const l of affix) {
        h += '<div class="tt-line affix"><span>' + icon(l.icon, 14) + esc(l.name) + '</span>' +
          '<b>' + (l.value >= 0 ? '+' : '') + statVal(l.stat, l.value) + '</b>' +
          (diff[l.stat] ? cmpTag(diff[l.stat], l.stat) : '') + '</div>';
      }
    }
    if (mech.length) {
      h += '<div class="tt-sec">机制效果</div>';
      for (const l of mech) {
        h += '<div class="tt-line mech"><span>' + icon(l.icon, 14) + esc(l.name) + '</span>' +
          '<em>' + esc(l.text) + '</em></div>';
      }
    }
    h += '</div>';

    // —— 战力：一个能一眼比较的数 ——
    // 没有它，"这件是不是更好"就只能靠感觉，而感觉恰恰是玩家最不信任的东西。
    // 战力在模型层算（core.power），界面只负责显示 —— 与自动装备判定同源。
    if (game && typeof game.power === 'function') {
      const pw = game.power(item);
      let line = '战力 <em class="tt-pw">' + pw + '</em>';
      if (!isEquipped && compare) {
        const d = pw - game.power(compare);
        line += ' <span class="' + (d > 0 ? 'up' : (d < 0 ? 'dn' : 'eq')) + '">(' +
          (d > 0 ? '+' : '') + d + ')</span>';
      }
      // 用独立的 tt-power 类、不要复用 tt-cmp：
      // 复用会让"对比区块"这个选择器命中错元素（旧断言就这么被我搞挂过一次）。
      h += '<div class="tt-power"><b>' + line + '</b></div>';
    }

    // —— 与已装备的对比 ——
    if (compare && !isEquipped) {
      const parts = [];
      for (const k in diff) {
        if (!diff[k]) continue;
        const m = D.STATS[k] || {};
        parts.push('<span class="' + (diff[k] > 0 ? 'up' : 'dn') + '">' + (m.short || k) +
          ' ' + (diff[k] > 0 ? '+' : '') + statVal(k, diff[k]) + '</span>');
      }
      h += '<div class="tt-cmp"><b>对比已装备的「' + esc(compare.name) + '」</b>' +
        (parts.length ? parts.join('') : '<span class="eq">完全一致</span>') + '</div>';
    } else if (!compare) {
      h += '<div class="tt-cmp"><b>' + esc(slotLabel(item.slot)) + '槽位为空</b>' +
        '<span class="eq">穿上后立刻生效</span></div>';
    }

    // —— 价值 ——
    if (game) {
      let v = '身价 ' + game.itemValue(item);
      if (opts.price !== undefined) v += ' · 商店售价 ' + opts.price + ' 金币';
      else v += ' · 可卖 ' + game.sellPrice(item) + ' 金币';
      h += '<div class="tt-cmp"><b>' + v + '</b></div>';
    }

    // —— 操作提示：按上下文给，不写通用废话 ——
    if (opts.hint !== false) {
      const k = opts.ctx || '';
      h += '<div class="tt-hint">' + (k === 'shop' ? '点击右侧按钮购买'
        : k === 'equip' ? '拖到背包或出售区可以卸下 / 变卖'
          : '拖到左侧槽位穿戴 · 拖到出售区变卖') + '</div>';
    }
    return h;
  }
  function cmpTag(d, statKey) {
    return '<i class="tt-d ' + (d > 0 ? 'up' : 'dn') + '">' + (d > 0 ? '+' : '') + statVal(statKey, d) + '</i>';
  }

  /* ============================================================
     游戏 HUD / 侧栏
     ============================================================ */
  let lastSig = '';
  const logSeen = { n: 0 };

  function buildGame() {
    $('btn-bag').onclick = function () { toggleInventory(); };
    // 点 HUD 上的魂技键 = 按 Q。走 TideMain 是为了复用同一套音效/飘字/震屏反馈
    $('btn-skill').onclick = function () {
      if (global.TideMain && global.TideMain.castSkill) global.TideMain.castSkill();
    };
    $('btn-help2').onclick = function () { global.TideAudio.ui(); showHelp(); };
    // 战斗回放的跳过键
    const bSkip = $('bs-skip');
    if (bSkip) bSkip.onclick = function () { skipBattle(); };

    // 出手类型开关：点击走 TideMain 的收口，和魂技按钮同一个模式 ——
    // 界面不直接改模型，免得校验/音效在两条路径上不一致。
    const atkSw = $('atk-switch');
    if (atkSw) {
      atkSw.addEventListener('click', function (ev) {
        const b = ev.target && ev.target.closest ? ev.target.closest('.atk-opt') : null;
        if (!b) return;
        if (global.TideMain && global.TideMain.setAttackType) {
          global.TideMain.setAttackType(b.dataset.atk);
        }
      });
    }
    $('btn-restart').onclick = function () { global.TideAudio.ui(); showTitle(); };
    $('btn-close-relic').classList.add('hidden');

    // 属性行的悬停由 document 级委托统一处理（见 bindTips），这里不再单独挂

    // 侧栏的装备槽是只读摘要，点击打开完整界面
    $('equip-panel').addEventListener('click', function () { openInventory('bag'); });

    // 秘藏条的悬停同样走 document 级委托
  }

  function toggleInventory(tab) {
    if (tab) invTab = tab;
    invOpen = !invOpen;
    syncInventory();
    global.TideAudio.ui();
  }
  function openInventory(tab) {
    invTab = tab || invTab;
    invOpen = true;
    syncInventory();
  }
  function closeInventory() { invOpen = false; syncInventory(); }

  function syncInventory() {
    const el = $('inv-screen');
    if (!el) return;
    el.classList.toggle('hidden', !invOpen);
    $('btn-bag').classList.toggle('on', invOpen);
    if (invOpen) renderInventory(global.TideMain.game);
  }

  /* ============================================================
     主渲染
     ============================================================ */
  function render(game) {
    if (!game) return;
    const st = game.stats();
    const fl = game.flags();

    // BGM 强度：涨潮（水位 ≥2）或残血时切到危机段落。
    // 这里用**氛围**而不是提示条，是因为它是持续状态而不是事件：
    // 事件用提示条（会消失），状态用氛围（一直在，玩家不看也知道情况不对）。
    // 这个调用会每帧经过，所以 music() 必须幂等 —— 见 audio.js 的 bgmApply。
    global.TideAudio.music('game', (game.tideLevel >= 2 || game.hp / st.hp < 0.35) ? 2 : 1);

    // 无尽模式没有"总层数"这回事。写 "4 / 4" 会让玩家以为快结束了
    $('h-depth').textContent = game.endless
      ? (game.depth + ' / \u221e')
      : (game.depth + ' / ' + game.diff.depth);
    $('h-kills').textContent = game.kills;
    $('h-turn').textContent = game.turn;
    renderGuide(game);
    $('h-gold').textContent = game.gold;
    const tideWord = ['平静', '微涨', '上涨', '满潮'][Math.min(3, game.tideLevel)] || '满潮';
    const tideEl = $('h-tide');
    tideEl.textContent = tideWord + ' ' + game.tideLevel;
    tideEl.className = 'h-tide lv' + game.tideLevel;

    // 出手类型开关的状态同步。只在真的变化时改 DOM —— 这段每帧都过。
    const atkSwEl = $('atk-switch');
    if (atkSwEl) {
      const at = game.atkType || 'p';
      if (atkSwEl._sig !== at) {
        atkSwEl._sig = at;
        const opts = atkSwEl.querySelectorAll('.atk-opt');
        for (let oi = 0; oi < opts.length; oi++) {
          opts[oi].classList.toggle('on', opts[oi].dataset.atk === at);
        }
      }
    }

    const hpPct = Math.max(0, Math.min(100, game.hp / st.hp * 100));
    $('hero-hp-fill').style.width = hpPct + '%';
    $('hero-hp-text').textContent = Math.max(0, Math.round(game.hp)) + ' / ' + Math.round(st.hp);
    $('hero-hp-fill').classList.toggle('low', hpPct < 32);
    $('hero-lv').textContent = 'Lv ' + game.level();
    const need = D.PROGRESSION.levelEvery;
    $('hero-xp-fill').style.width = ((game.kills % need) / need * 100) + '%';
    $('hero-name').textContent = game.cls.name;
    $('hero-title').textContent = game.cls.title;
    if ($('hero-art').dataset.key !== game.cls.key) {
      $('hero-art').src = A.heroDataURL(game.cls, 76);
      $('hero-art').dataset.key = game.cls.key;
    }
    $('hero-pass').innerHTML = '<b>' + esc(game.cls.passive.name) + '</b>' + esc(game.cls.passive.text);
    $('hero-foot').textContent = '剩余机会 ' + game.lives + ' · 秘藏 ' + game.relics.length;

    /* ============================================================
       魂技（设计取自《元气骑士》）
       冷却必须一眼看得见：技能类设计的挫败感几乎都来自"按了没反应"，
       而玩家分不清"没反应"和"还在冷却"。
       签名挂在下元素身上（_sig），省一个模块级变量，也避免每帧重建 DOM。
       ============================================================ */
    const sk = game.skill();
    const skReady = game.skillReady();
    const skBtn = $('btn-skill');
    if (skBtn) {
      skBtn.textContent = game.skillCd > 0 ? (sk.name + ' · ' + game.skillCd) : sk.name;
      skBtn.classList.toggle('ready', skReady);
      skBtn.classList.toggle('cooling', !skReady);
      skBtn.title = sk.name + '（Q）· ' + sk.text +
        (game.skillCd > 0 ? '　冷却还有 ' + game.skillCd + ' 回合' : '　已就绪');
      // 冷却刚好转好时弹一下。技能类设计的标配是"主动告诉玩家好了" ——
      // 否则玩家要么一直盯着冷却条，要么干脆想不起来还有这个技能。
      if (skReady && skBtn._wasReady === false) {
        skBtn.classList.remove('cast');
        void skBtn.offsetWidth;
        skBtn.classList.add('cast');
        setTimeout(function () { skBtn.classList.remove('cast'); }, 480);
      }
      skBtn._wasReady = skReady;
    }

    const sp = $('skill-panel');
    if (sp) {
      const sig = sk.key + '|' + game.skillCd + '|' + (skReady ? 1 : 0);
      if (sp._sig !== sig) {
        sp._sig = sig;
        const pct = sk.cd > 0
          ? Math.max(0, Math.min(100, Math.round((1 - game.skillCd / sk.cd) * 100))) : 100;
        sp.innerHTML =
          '<div class="sk-head">' +
          '<span class="sk-ico">' + icon(sk.icon, 18) + '</span>' +
          '<span class="sk-meta"><b>' + esc(sk.name) + '</b><i>' +
          (skReady ? '就绪 · 按 Q 释放' : '冷却中 · 还有 ' + game.skillCd + ' 回合') +
          '</i></span></div>' +
          '<div class="sk-text">' + esc(sk.text) + '</div>' +
          '<div class="sk-cd' + (skReady ? ' ready' : '') + '">' +
          '<span>' + (skReady ? '就绪' : (game.skillCd + ' / ' + sk.cd)) + '</span>' +
          '<span class="bar"><i style="width:' + pct + '%"></i></span></div>';
      }
    }

    const bb = $('hero-buffs');
    if (bb) {
      const chips = [];
      for (const b of (game.buffs || [])) {
        chips.push('<span class="buff-chip">' + icon(b.icon, 12) + '<b>' + esc(b.name) +
          '</b> ' + b.turns + ' 回合</span>');
      }
      if (game.freeMoves > 0) {
        chips.push('<span class="buff-chip">' + icon('running-shoe', 12) +
          '<b>免费行动</b> ' + game.freeMoves + ' 次</span>');
      }
      const bsig = chips.join('');
      if (bb._sig !== bsig) { bb._sig = bsig; bb.innerHTML = bsig; }
    }

    // 属性面板：只有值变了才重建 DOM。这是整屏刷新里最贵的一块。
    const sig = D.CORE_STATS.concat(D.SUB_STATS).map(function (k) {
      return statVal(k, k === 'dodge' ? (st[k] || 0) : (st[k] || 0));
    }).join('|') + '#' + (fl.doubleAtSpd || 0) + '#' + (st.spd || 0);
    if (sig !== lastSig) {
      lastSig = sig;
      const rows = [];
      for (const k of D.CORE_STATS) rows.push(statRow(k, st[k], st, fl));
      for (const k of D.SUB_STATS) rows.push(statRow(k, st[k] || 0, st, fl, true));
      $('stat-panel').innerHTML = rows.join('');
    }

    $('equip-panel').innerHTML = D.EQUIP_SLOTS.map(function (s) {
      const it = game.equip[s.key];
      const rar = it ? D.rarityByKey(it.rarity) : null;
      return '<button class="eq-slot' + (it ? ' filled' : '') + '" data-tip="item"' +
        ' data-kind="equip" data-slot="' + s.key + '"' +
        (it ? ' style="--rc:' + rar.color + '"' : '') + '>' +
        '<span class="eq-ico">' + icon(it ? it.icon : s.icon, 24) + '</span>' +
        '<span class="eq-meta"><i>' + esc(s.name) + '</i><b>' + (it ? esc(it.name) : '空') + '</b></span>' +
        '</button>';
    }).join('');

    $('bag-count').textContent = game.bag.length + '/' + game.bagCap();

    $('relic-list').innerHTML = game.relics.length
      ? game.relics.map(function (id) {
        let r = null;
        for (const x of D.RELICS) if (x.id === id) r = x;
        if (!r) return '';
        const sc = D.SCHOOLS[r.school] || {};
        return '<span class="relic-chip" data-tip="relic" style="--rc:' + (sc.color || '#cbb994') + '" data-relic="' + r.id + '">' +
          icon(r.icon, 15) + '</span>';
      }).join('')
      : '<span class="muted">尚未获得秘藏。每击杀 ' + D.PROGRESSION.relicEvery + ' 个敌人给一次三选一。</span>';

    const logs = game.logs.slice(-7);
    $('log-box').innerHTML = logs.map(function (l) {
      return '<div class="log ' + (KIND_CLASS[l.kind] || 'i') + '">' + esc(l.text) + '</div>';
    }).join('');

    if (game.pendingRelic && game.pendingRelic.length) showRelicModal(game);
    else $('relic-modal').classList.add('hidden');

    if (invOpen) renderInventory(game);
  }

  const KIND_CLASS = { info: 'i', good: 'g', warn: 'w', bad: 'b', loot: 'l' };
  function statRow(key, v, st, fl, sub) {
    const m = D.STATS[key];
    let extra = '';
    if (key === 'spd' && fl && fl.doubleAtSpd && st.spd >= fl.doubleAtSpd) extra = '<i class="on">连击</i>';
    return '<div class="stat-row' + (sub ? ' sub' : '') + '" data-tip="stat" data-stat="' + key + '">' +
      '<span class="s-ico" style="color:' + m.color + '">' + icon(m.icon, 16) + '</span>' +
      '<span class="s-name">' + esc(m.short) + '</span>' +
      '<span class="s-val" style="color:' + m.color + '">' + statVal(key, v) + extra + '</span>' +
      '</div>';
  }

  /* ============================================================
     整屏背包 / 商店
     ============================================================ */
  function itemCellHTML(item, attrs, size) {
    if (!item) return '<div class="inv-slot empty" ' + attrs + '></div>';
    const rar = D.rarityByKey(item.rarity);
    return '<div class="inv-slot filled" ' + attrs + ' style="--rc:' + rar.color + '">' +
      icon(item.icon, size || 26) + '<i class="inv-dot" style="background:' + rar.color + '"></i></div>';
  }

  function renderInventory(game) {
    if (!game) return;
    const st = game.stats();

    $('inv-gold').innerHTML = icon('coins', 18) + '<b>' + game.gold + '</b>';
    $('inv-tab-bag').classList.toggle('on', invTab === 'bag');
    $('inv-tab-shop').classList.toggle('on', invTab === 'shop');
    $('inv-pane-bag').classList.toggle('hidden', invTab !== 'bag');
    $('inv-pane-shop').classList.toggle('hidden', invTab !== 'shop');

    if (invTab === 'bag') {
      $('inv-hero-art').src = A.heroDataURL(game.cls, 132);
      $('inv-hero-name').textContent = game.cls.name;
      $('inv-hero-sub').textContent = game.cls.title + ' · Lv ' + game.level();
      $('inv-hero-hp').textContent = Math.round(game.hp) + ' / ' + Math.round(st.hp);

      $('inv-equip').innerHTML = D.EQUIP_SLOTS.map(function (s) {
        const it = game.equip[s.key];
        return '<div class="inv-eq-wrap">' +
          itemCellHTML(it, 'data-tip="item" data-kind="equip" data-slot="' + s.key + '"', 30) +
          '<span class="inv-eq-label">' + esc(s.name) + '</span></div>';
      }).join('');

      const cells = [];
      for (let i = 0; i < game.bagCap(); i++) {
        cells.push(itemCellHTML(game.bag[i], 'data-tip="item" data-kind="bag" data-idx="' + i + '"', 26));
      }
      $('inv-grid').innerHTML = cells.join('');
      $('inv-bag-count').textContent = game.bag.length + ' / ' + game.bagCap();
      $('inv-sell-hint').textContent = '拖到这里出售';
      $('inv-sell-value').textContent = dragItem ? ('+' + game.sellPrice(dragItem) + ' 金币') : '';
      $('inv-sell').classList.toggle('hot', !!dragItem);
    } else {
      const atShop = game.tileAt(game.px, game.py) === C.T.SHOP;
      $('inv-shop-note').innerHTML = atShop
        ? '<b class="ok">已抵达潮汐商栈</b> —— 可以直接交易'
        : '<b class="warn">需要站在潮汐商栈上才能交易</b> —— 地图上的金色摊位，小地图上也是金色标记';
      $('btn-shop-refresh').disabled = !atShop || game.gold < D.LOOT.refreshCost;
      $('btn-shop-refresh').innerHTML = '刷新货架 · ' + icon('coins', 13) + ' ' + D.LOOT.refreshCost;

      $('inv-shop').innerHTML = game.shopStock.map(function (s, i) {
        if (s.type === 'heal') {
          return '<div class="shop-card heal" data-tip="heal" data-idx="' + i + '">' +
            '<span class="sc-ico">' + icon(s.icon, 30) + '</span>' +
            '<span class="sc-main"><b>' + esc(s.name) + '</b><i>' + esc(s.text) + '</i></span>' +
            '<button class="sc-buy" data-buy="' + i + '"' + (atShop && game.gold >= s.price ? '' : ' disabled') + '>' +
            '<span>' + s.price + '</span></button></div>';
        }
        const rar = D.rarityByKey(s.item.rarity);
        const afford = atShop && game.gold >= s.price;
        return '<div class="shop-card" data-tip="item" data-kind="shop" data-idx="' + i + '"' +
          ' style="--rc:' + rar.color + '">' +
          '<span class="sc-ico">' + icon(s.item.icon, 30) + '</span>' +
          '<span class="sc-main"><b style="color:' + rar.color + '">' + esc(s.item.name) + '</b>' +
          '<i>' + esc(rar.name) + ' · ' + esc(slotLabel(s.item.slot)) + '</i></span>' +
          '<button class="sc-buy" data-buy="' + i + '"' + (afford ? '' : ' disabled') + '>' +
          '<span>' + s.price + '</span></button></div>';
      }).join('') || '<div class="muted" style="padding:18px">货架空了。刷新或者继续下潜。</div>';
    }
  }

  /* ============================================================
     拖拽
     用指针事件手写，不用 HTML5 DnD ——
     原生 DnD 在 file:// 与 WebView2 里的行为不一致，而且拖影无法自定义。
     ============================================================ */
  let dragItem = null, dragFrom = null, ghost = null;
  let flashIdx = -1;        // 刚融合出来的那件在背包里的下标（要高亮一下）

  function beginDrag(ev, kind, ref, item) {
    dragItem = item;
    dragFrom = { kind: kind, ref: ref };
    ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.setProperty('--rc', D.rarityByKey(item.rarity).color);
    ghost.innerHTML = icon(item.icon, 30);
    document.body.appendChild(ghost);
    moveGhost(ev);
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragUp);
    tooltip('');
    if (invOpen) renderInventory(global.TideMain.game);
  }
  function moveGhost(ev) {
    if (!ghost) return;
    ghost.style.left = (ev.clientX - 20) + 'px';
    ghost.style.top = (ev.clientY - 20) + 'px';
  }
  function onDragMove(ev) {
    moveGhost(ev);
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const sell = t && t.closest('#inv-sell');
    $('inv-sell').classList.toggle('over', !!sell);
    if (t) {
      const cell = t.closest('.inv-slot, .inv-eq-wrap');
      document.querySelectorAll('.drop-hot').forEach(function (e) { e.classList.remove('drop-hot'); });
      if (cell) {
        const target = cell.classList.contains('inv-eq-wrap') ? cell.firstChild : cell;
        if (target) target.classList.add('drop-hot');
        hintFuse(target, ev);
      }
    }
  }

  /**
   * 拖拽经过一个"可以融合"的目标时，把结果写进气泡。
   * 融合是破坏性操作（吃掉两件装备 + 金币），**绝不能松手之后才知道会发生什么** ——
   * 这一条比"能不能融合"本身更重要。
   */
  function hintFuse(target, ev) {
    if (!target || !dragFrom || dragFrom.kind !== 'bag' || !target.dataset) return;
    const toIdx = target.dataset.idx;
    if (toIdx === undefined || +toIdx === dragFrom.ref) return;
    const g = global.TideMain.game;
    if (!g) return;
    const a = g.bag[dragFrom.ref], b = g.bag[+toIdx];
    const cost = g.fuseCost(a, b);
    if (cost < 0) return;
    const r = g.fuseResult(a, b);
    const afford = g.gold >= cost;
    tooltip('<div class="tt-name">融合 → ' + esc(r.rarity.name) + '「' + esc(b.name) + '」</div>' +
      '<div class="tt-desc">用「' + esc(a.name) + '」+「' + esc(b.name) + '」合成一件 ' +
      esc(r.rarity.name) + ' 装备，占用' + esc(slotLabel(r.slot)) + '槽位。<br>花费 ' +
      cost + ' 金币' + (afford ? '' : ' —— <b>金币不够，还差 ' + (cost - g.gold) + '</b>') + '。</div>' +
      '<div class="tt-hint">松手即融合，两件材料都会被消耗</div>', ev);
  }
  function onDragUp(ev) {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragUp);
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.drop-hot').forEach(function (e) { e.classList.remove('drop-hot'); });
    $('inv-sell').classList.remove('over');

    const g = global.TideMain.game;
    if (!g || !dragItem) { dragItem = null; dragFrom = null; return; }
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const item = dragItem, from = dragFrom;
    dragItem = null; dragFrom = null;
    if (!t) { renderInventory(g); return; }

    // 1) 拖到出售区
    if (t.closest('#inv-sell')) {
      if (from.kind === 'bag') {
        const before = g.gold;
        g.sellItem(from.ref);
        if (g.gold > before) global.TideAudio.play('loot', 'rare');
      }
      afterInvAction(g);
      return;
    }

    // 2) 拖到装备槽
    const eqWrap = t.closest('.inv-eq-wrap');
    if (eqWrap) {
      const slot = eqWrap.querySelector('.inv-slot').dataset.slot;
      if (from.kind === 'bag') {
        const it = g.bag[from.ref];
        if (it && it.slot === slot) g.equipFromBag(from.ref);
        else if (it) toast(it.name + ' 不能装在「' + slotLabel(slot) + '」');
      } else if (from.kind === 'equip' && from.ref !== slot) {
        toast('装备不能跨槽位拖拽');
      }
      afterInvAction(g);
      return;
    }

    // 3) 拖到背包格
    const bagCell = t.closest('#inv-grid .inv-slot');
    if (bagCell) {
      const toIdx = +bagCell.dataset.idx;
      if (from.kind === 'equip') {
        g.unequip(from.ref);                       // 走一步"卸下"，落在背包末尾
      } else if (from.kind === 'bag' && toIdx !== from.ref) {
        const a = g.bag[from.ref], b = g.bag[toIdx];
        const cost = g.fuseCost(a, b);
        if (cost >= 0) {
          // 同品质 → 融合（设计取自《元气骑士》的武器融合）。
          // 拖拽过程中已经用气泡写清了结果与花费，所以这里直接执行。
          const r = g.fuseItems(from.ref, toIdx);
          if (r.ok) {
            global.TideAudio.play('loot', 'epic');
            toast('融合出「' + r.item.name + '」· ' + r.item.rarityName + '（-' + r.cost + ' 金币）');
            flashIdx = g.bag.length - 1;      // 产物落在背包末尾，得让它自己闪一下
          } else if (r.reason === 'gold') {
            toast('融合需要 ' + r.cost + ' 金币，还差 ' + (r.cost - g.gold));
          }
        } else {
          // 其余情况是单纯换位：只整理顺序，不动数值
          const moved = g.bag.splice(from.ref, 1)[0];
          if (moved) g.bag.splice(Math.min(toIdx, g.bag.length), 0, moved);
        }
      }
      afterInvAction(g);
      // 融合产物的高亮：只弹一句提示是不够的 ——
      // 玩家一定会去背包里找"刚合出来的那件"，那就得让它自己跳出来
      if (flashIdx >= 0) {
        const grid = $('inv-grid');
        const cell = grid ? grid.querySelector('.inv-slot[data-idx="' + flashIdx + '"]') : null;
        if (cell) {
          cell.classList.add('just-made');
          setTimeout(function () { cell.classList.remove('just-made'); }, 1000);
        }
        flashIdx = -1;
      }
      return;
    }
    renderInventory(g);
  }

  function afterInvAction(g) {
    // 必须走 flush（= 消费一次事件队列），不能只 refresh：
    // 融合/出售/购买都会产生事件，音效、飘字、提示条全靠这一步
    global.TideMain.flush();
    if (invOpen) renderInventory(g);
  }

  function bindInventory() {
    /* 双击 / Shift+右键 → 自动装备。
       两条入口走**同一个函数**，判定口径也只有一份（在模型层 core.canUpgrade）。
       失败也一定要说话：玩家点了却没反应，只会认为这个功能坏了。 */
    function autoEquipAt(el, g) {
      if (!g || !el) return false;
      const idx = parseInt(el.dataset.idx, 10);
      if (!(idx >= 0)) return false;
      const item = g.bag[idx];
      const r = g.autoEquip(idx);
      global.TideAudio.ui(!r.ok);
      const nm = item ? item.name : '装备';
      if (r.ok) {
        toast(r.reason === 'empty'
          ? ('已穿戴「' + nm + '」')
          : ('已换上「' + nm + '」· 战力 ' + r.oldPower + ' → ' + r.newPower));
      } else if (r.reason === 'rarity-lower') {
        toast('未替换：' + nm + ' 品质更低，战力也没强过 10%（' +
          r.newPower + ' vs ' + r.oldPower + '）');
      } else {
        toast('未替换：' + nm + ' 战力 ' + r.newPower + ' 低于已穿戴的 ' + r.oldPower);
      }
      // 走既有的「背包里做完一件事」路径：它内部会 flush（消费事件队列）。
      // 只调 renderInventory 的话，装备事件的音效与飘字会被静默丢掉
      // —— 症状是"换了装备但没声音"，而且很难联想到是刷新路径的问题。
      afterInvAction(g);
      return r.ok;
    }

    $('inv-screen').addEventListener('dblclick', function (ev) {
      const el = ev.target.closest('.inv-slot.filled');
      if (!el || el.dataset.kind !== 'bag') return;
      autoEquipAt(el, global.TideMain.game);
    });
    $('inv-screen').addEventListener('contextmenu', function (ev) {
      const el = ev.target.closest('.inv-slot.filled');
      if (!el || el.dataset.kind !== 'bag') return;
      // 只有 Shift+右键才接管；普通右键仍然拦掉（不弹浏览器菜单），但不做别的
      ev.preventDefault();
      if (!ev.shiftKey) return;
      autoEquipAt(el, global.TideMain.game);
    });

    $('inv-screen').addEventListener('mousedown', function (ev) {
      const cell = ev.target.closest('.inv-slot.filled');
      const g = global.TideMain.game;
      if (!cell || !g) return;
      const kind = cell.dataset.kind;
      if (kind === 'bag') {
        const it = g.bag[+cell.dataset.idx];
        if (it) { ev.preventDefault(); beginDrag(ev, 'bag', +cell.dataset.idx, it); }
      } else if (kind === 'equip') {
        const it = g.equip[cell.dataset.slot];
        if (it) { ev.preventDefault(); beginDrag(ev, 'equip', cell.dataset.slot, it); }
      }
    });
    // 背包/装备槽/出售区的悬停统一由 document 级委托处理

    $('inv-close').onclick = function () { closeInventory(); global.TideAudio.ui(); };
    $('inv-tab-bag').onclick = function () { invTab = 'bag'; renderInventory(global.TideMain.game); global.TideAudio.ui(); };
    $('inv-tab-shop').onclick = function () { invTab = 'shop'; renderInventory(global.TideMain.game); global.TideAudio.ui(); };
    $('btn-sell-junk').onclick = function () {
      const g = global.TideMain.game;
      if (!g) return;
      const got = g.sellJunk();
      if (got) global.TideAudio.play('loot', 'rare');
      afterInvAction(g);
    };
    $('btn-shop-refresh').onclick = function () {
      const g = global.TideMain.game;
      if (!g) return;
      if (g.refreshShop()) { global.TideAudio.play('loot', 'uncommon'); afterInvAction(g); }
    };
    $('inv-shop').addEventListener('click', function (ev) {
      const btn = ev.target.closest('.sc-buy');
      if (!btn) return;
      const g = global.TideMain.game;
      if (!g) return;
      const i = +btn.dataset.buy;
      if (g.tileAt(g.px, g.py) !== C.T.SHOP) { toast('需要站在潮汐商栈上才能交易'); return; }
      if (g.buyItem(i)) { global.TideAudio.play('loot', 'epic'); afterInvAction(g); }
    });
    // 商店卡片的悬停也走 document 级委托（data-tip="item" data-kind="shop"）
  }

  /* ============================================================
     敌人信息面板
     ============================================================ */
  let hoveredEnemy = null;
  function enemyInfo(game, e, ev) {
    const el = $('enemy-info');
    if (!el) return;
    if (!e || !game.isVisible(e.x, e.y)) {
      if (hoveredEnemy !== null) { el.classList.add('hidden'); hoveredEnemy = null; }
      return;
    }
    if (hoveredEnemy === e) { placeEnemyInfo(el, ev); return; }
    hoveredEnemy = e;
    const st = game.stats();
    // 姿态会改变防御，这里必须算进去。
    // 原实现直接用 e.stats.defP，所以敌人硬化时它给出的"建议"是**错的** ——
    // 面板说该打法术，实际物理更疼。一个会撒谎的面板比没有面板更糟。
    const dv = C.stanceDef(e.stats, e.stance);
    const kindWord = e.kind === 'boss' ? '首领' : e.kind === 'elite' ? '精英' : e.kind === 'treasure' ? '宝箱' : '普通';

    let h = '<div class="ei-head"><b>' + esc(e.name) + '</b><i>' + kindWord + '</i></div>';
    h += '<div class="ei-hp"><span>生命</span><b>' + Math.round(e.hp) + ' / ' + e.maxHp + '</b></div>';
    // 标签：玩家判断"该用什么打"的第一手依据，放在最上面。
    // 它由 core 的 tagsOf() 从 stats 推导，所以永远和实际结算一致 —— 不会撒谎。
    if (e.tags && e.tags.length) {
      h += '<div class="ei-tags">' + e.tags.map(function (t) {
        return '<span class="ei-tag">' + esc(t) + '</span>';
      }).join('') + '</div>';
    }
    h += '<div class="ei-grid">';
    for (const k of ['atkP', 'atkM', 'defP', 'defM', 'spd']) {
      const v = Math.round(e.stats[k] || 0);
      const m = D.STATS[k];
      if (!v) continue;
      h += '<div class="ei-s"><i style="color:' + m.color + '">' + icon(m.icon, 13) + '</i>' +
        m.short + '<b>' + v + '</b></div>';
    }
    h += '</div>';
    // —— 姿态：它直接改变上面那张表的"对方防御"，必须写出来 ——
    // 否则玩家看到 39 却不知道它是从 26 来的，那张表就不可验算，
    // 而"可验算"正是"让玩家自己算"能成立的前提。
    if (e.stance) {
      h += '<div class="ei-stance ' + e.stance + '">姿态 · 硬化' +
        (e.stance === 'p' ? '物理' : '法术') +
        '　对方防御 ×' + D.STANCE.hard + ' / ×' + D.STANCE.soft +
        (e.stanceT !== undefined ? '　' + e.stanceT + ' 回合后切换' : '') + '</div>';
    }

    // —— 出题，不给答案 ——
    // 这里原来是「建议法术：每轮约 37，4 轮击杀」和「预计这场要掉 210 血」，
    // 那是引擎替玩家把题做了。现在只给**计算的所需对象**。
    //
    // "有效防御"这个中间量要给：它只是一次减法，玩家能当场验算；
    // 而它恰好把"两次除法再比较"简化成"比一个数" —— 少了它，
    // 这个面板就从"可以心算"退化成"要掏计算器"，设计会直接失效。
    h += '<div class="ei-calc">';
    h += '<div class="ei-calc-h"><span>你出手</span><span>攻击</span><span>穿透</span>' +
      '<span>对方防御</span><span>有效</span></div>';
    const rows = [
      { k: '物理', cls: 'p', atk: st.atkP, pen: st.penP, raw: e.stats.defP, def: dv.defP },
      { k: '法术', cls: 'm', atk: st.atkM, pen: st.penM, raw: e.stats.defM, def: dv.defM }
    ];
    for (const r of rows) {
      const shown = Math.round(r.def);
      const rawShown = Math.round(r.raw);
      const mul = (r.raw > 0) ? (r.def / r.raw) : 1;
      // 有倍率时把"原始值 ×倍率"标出来，玩家可以自己验算这一格
      const note = (Math.abs(mul - 1) > 0.01)
        ? '<em>' + rawShown + '×' + mul.toFixed(1) + '</em>' : '';
      const eff = Math.max(0, shown - Math.round(r.pen));
      h += '<div class="ei-calc-r ' + r.cls + '">' +
        '<span>' + r.k + '</span>' +
        '<b>' + Math.round(r.atk) + '</b>' +
        '<b>' + Math.round(r.pen) + '</b>' +
        '<b>' + shown + note + '</b>' +
        '<b class="eff">' + eff + '</b></div>';
    }
    h += '</div>';
    if (e.stats.leech) h += '<div class="ei-warn">它吸血 ' + Math.round(e.stats.leech * 100) + "%</div>";
    // 状态行：这两个状态直接改变"该怎么打"，必须写在玩家看得到的地方
    if (e.stun > 0) {
      h += '<div class="ei-warn" style="color:#ffe08a">✦ 被震晕 ' + e.stun + ' 回合 · 这期间它不会动</div>';
    }
    if (e.wet > 0) {
      h += '<div class="ei-warn" style="color:#8fdff0">≈ 潮湿 ' + e.wet + ' 回合 · 受到的法术伤害 +' +
        Math.round(D.COMBAT.wetAmp * 100) + '%</div>';
    }
    el.innerHTML = h;
    el.classList.remove('hidden');
    placeEnemyInfo(el, ev);
  }
  function placeEnemyInfo(el, ev) {
    const r = el.getBoundingClientRect();
    let x = ev.clientX + 18, y = ev.clientY - r.height / 2;
    if (x + r.width > global.innerWidth - 8) x = ev.clientX - r.width - 18;
    if (y < 8) y = 8;
    if (y + r.height > global.innerHeight - 8) y = global.innerHeight - r.height - 8;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  /* ============================================================
     战斗场景（v11.2-h）

     「外面是 2D 箱庭探索，进战斗换成左右对峙的回合画面」。

     为什么值得单独开一块、而不是继续在地图上飘字：
     地图上的演出只能把 res.log 里每一条伤害**一次性**砸出来 ——
     玩家看不见谁先出手、看不见对方姿态什么时候切、也看不见自己挨了多少。
     那不是"打仗"，是"看结算"。

     本版只做**回放**：出手类型在开战前选定（HUD 的 1 / 2），场景逐轮演出来。
     逐回合的**指令输入**是下一步 —— 那要把 _duel 改成可中断的，
     属于模型层改动，不和表现层混在一个提交里。
     ============================================================ */
  let bsTimer = null, bsSkip = false, bsDone = null;

  function isBattleOpen() {
    const el = $('battle-screen');
    return !!(el && !el.classList.contains('hidden'));
  }

  function skipBattle() { if (isBattleOpen()) bsSkip = true; }

  /**
   * 无条件关掉战斗层（切屏 / 重开时用）。
   * 刻意不复用 endBattle：那个会调 done()，而切屏时我们**不想**再跑收尾 ——
   * 那时游戏可能已经被重置，收尾会读到半截状态。
   */
  function closeBattle() {
    if (bsTimer) { clearTimeout(bsTimer); bsTimer = null; }
    const el = $('battle-screen');
    if (el) el.classList.add('hidden');
    const fx = $('bs-fx');
    if (fx) fx.innerHTML = '';
    bsDone = null; bsSkip = false;
  }

  function endBattle() {
    if (bsTimer) { clearTimeout(bsTimer); bsTimer = null; }
    const el = $('battle-screen');
    if (el) el.classList.add('hidden');
    const fx = $('bs-fx');
    if (fx) fx.innerHTML = '';
    const d = bsDone;
    bsDone = null; bsSkip = false;
    if (d) d();
  }

  /* ---- 战斗背景：用真实地图瓦片拼 ---- */
  let bsBg = null, bsBgKey = '';

  /**
   * 拼一张战斗背景。
   *
   * 为什么是"拼瓦片"而不是"手画一张背景图"：
   * 风格一致性靠**复用同一批素材**达成。手画的背景过两个版本就会和地图脱节 ——
   * 地图换了配色、加了新瓦片，背景还停在上一版的观感上，而且没人会想起来同步。
   *
   * 为什么洞顶不铺墙瓦片：网格化的墙铺到整屏尺寸，一眼就能看出重复。
   * 而"黑掉的洞顶"既自然又便宜 —— 战斗发生在洞里，头顶本来就该是暗的。
   */
  /**
   * 拼一张战斗背景 —— 一个**带透视的房间**。
   *
   * 为什么必须带透视：平面的贴图 + 暗角，人眼读出来是"一张画"，
   * 精灵贴在上面就像飘在虚空里。地平线 + 向灭点收束的地面，才给出"空间"。
   *
   * 透视的做法（纯 2D canvas，不用任何 3D 库）：
   *   地面按**等比数列**分行 —— 每行到地平线的距离是上一行的 r 倍。
   *   等比分行的间距恰好对应"深度等距"在屏幕上的投影，
   *   所以看起来是真的往远处收，而不是把条纹挤在一起。
   *   每行的格子宽度与"该行到地平线的距离"成正比，
   *   于是横向也一起收束 —— 两个方向同时收，才是透视。
   *
   * 瓦片仍然用**真实地图瓦片**：风格一致性靠复用同一批素材达成，
   * 手画的背景过两个版本就会和地图脱节。
   */
  /**
   * 拼一张战斗背景 —— 一间**封闭的屋子**。
   *
   * 为什么不是"地平线 + 向灭点收束的地面"：
   * 那是洞窟/旷野的几何 —— 只有一个灭点、没有边界，读起来就是"外面"。
   * 房间的几何是另一回事：一个**矩形后墙** + 四条从屏幕边缘收向它的棱。
   * 眼睛判断"这是一间屋子"靠的正是那几条棱和四个角；
   * 四块材质光拼在一起不叫房间，有了骨架才叫。
   *
   * 透视怎么做的（纯 2D canvas，不用 3D 库）：
   * 每个面先 clip 到自己的四边形，再在里面铺材质。
   * 地面用**等比数列分行**（每行到后墙根的距离是上一行的 R 倍）——
   * 等比间距恰好对应"深度等距"在屏幕上的投影，所以是真的往远处收；
   * 每行的格子宽又与"该行到后墙根的距离"成正比，横向一起收。
   *
   * 瓦片仍然用真实地图瓦片：风格一致性靠复用同一批素材达成。
   */
  function bsBackdrop(game) {
    const rk = (game.regionTypeAt ? game.regionTypeAt(game.px, game.py) : 'normal') || 'normal';
    if (bsBg && bsBgKey === rk) return bsBg;
    const reg = D.REGIONS[rk] || D.REGIONS.normal;
    const W = 1280, H = 800;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    const tiles = A.tiles || {};
    const SPR = A.TILE || 32;
    const names = ['floor0', 'floor1', 'floor2', 'floor3'];

    /* —— 房间的几何 ——
       全部就是这一个矩形 + 四条棱，其它都是材质。 */
    const bx0 = Math.round(W * 0.255), bx1 = Math.round(W * 0.745);
    const by0 = Math.round(H * 0.155), by1 = Math.round(H * 0.595);

    c.fillStyle = '#03050a';
    c.fillRect(0, 0, W, H);

    const face = function (pts, draw) {
      c.save();
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.closePath();
      c.clip();
      draw();
      c.restore();
    };

    /* ① 地面：等比数列分行的透视。收敛目标是后墙下沿 —— 地面"铺到后墙根"为止 */
    face([[0, H], [W, H], [bx1, by1], [bx0, by1]], function () {
      const R = 0.845, span = H - by1;
      let near = H, d = 0;
      while (near > by1 + 1 && d < 64) {
        const far = by1 + (near - by1) * R;
        const bandH = Math.max(1, near - far);
        const halfW = W * 0.95 * ((near - by1) / span);
        const tw = Math.max(6, bandH * 2.6);
        const cnt = Math.max(1, Math.ceil(halfW * 2 / tw));
        for (let k = 0; k < cnt; k++) {
          const x = (W / 2) - halfW + k * tw;
          const img = tiles[names[((k * 3 + d * 7) % 4 + 4) % 4]];
          if (img) c.drawImage(img, x, far, tw + 1, bandH + 1);
        }
        near = far; d++;
      }
      const g = c.createLinearGradient(0, by1, 0, by1 + span * 0.74);
      g.addColorStop(0, 'rgba(4,6,10,0.88)');
      g.addColorStop(0.5, 'rgba(4,6,10,0.30)');
      g.addColorStop(1, 'rgba(4,6,10,0)');
      c.fillStyle = g;
      c.fillRect(0, by1, W, span);
    });

    /* ② 洞顶：越靠后越黑。顶面不铺瓦片 —— 洞里本来就看不见顶的细节，
       铺了反而会和地面抢注意力，而玩家的视线应该落在那两个精灵上 */
    face([[0, 0], [W, 0], [bx1, by0], [bx0, by0]], function () {
      const g = c.createLinearGradient(0, 0, 0, by0);
      g.addColorStop(0, '#03050a');
      g.addColorStop(0.70, '#080c14');
      g.addColorStop(1, '#0e141e');
      c.fillStyle = g;
      c.fillRect(0, 0, W, by0);
    });

    /* ③ 左右墙 */
    const wallImg = tiles['wall15'] || tiles['wall0'];
    const wallFace = function (x0, x1, gx0, gx1) {
      const ws = SPR * 3.2;
      if (wallImg) {
        for (let y = -ws; y < H + ws; y += ws) {
          for (let x = Math.min(x0, x1) - ws; x < Math.max(x0, x1) + ws; x += ws) {
            c.drawImage(wallImg, x, y, ws, ws);
          }
        }
      }
      // 越靠后越暗 —— 瓦片本身不带深度信息，是这道光把它推远的
      const g = c.createLinearGradient(gx0, 0, gx1, 0);
      g.addColorStop(0, 'rgba(3,5,10,0.08)');
      g.addColorStop(1, 'rgba(3,5,10,0.90)');
      c.fillStyle = g;
      c.fillRect(Math.min(x0, x1) - 6, -6, Math.abs(x1 - x0) + 12, H + 12);
    };
    face([[0, 0], [bx0, by0], [bx0, by1], [0, H]], function () {
      wallFace(0, bx0, 0, bx0);
    });
    face([[W, 0], [bx1, by0], [bx1, by1], [W, H]], function () {
      wallFace(W, bx1, W, bx1);
    });

    /* ④ 后墙 */
    c.save();
    c.beginPath(); c.rect(bx0, by0, bx1 - bx0, by1 - by0); c.clip();
    {
      const ws = SPR * 3.2;
      if (wallImg) {
        for (let y = by0 - ws; y < by1 + ws; y += ws) {
          for (let x = bx0 - ws; x < bx1 + ws; x += ws) c.drawImage(wallImg, x, y, ws, ws);
        }
      }
      const g = c.createLinearGradient(0, by0, 0, by1);
      g.addColorStop(0, 'rgba(3,5,10,0.66)');
      g.addColorStop(1, 'rgba(3,5,10,0.32)');
      c.fillStyle = g;
      c.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
    }
    c.restore();

    /* ⑤ 棱线 —— 房间的骨架。
       这一步才是"屋子"与"洞窟"的分界：没有这几条线，四块材质只是碰巧
       拼在一起；有了它们，眼睛才读得出"这是一间有四个角的房间"。 */
    c.strokeStyle = 'rgba(2,4,8,0.82)';
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(-4, -4); c.lineTo(bx0, by0);
    c.moveTo(W + 4, -4); c.lineTo(bx1, by0);
    c.moveTo(-4, H + 4); c.lineTo(bx0, by1);
    c.moveTo(W + 4, H + 4); c.lineTo(bx1, by1);
    c.moveTo(bx0, by0); c.lineTo(bx1, by0);
    c.moveTo(bx0, by0); c.lineTo(bx0, by1);
    c.moveTo(bx1, by0); c.lineTo(bx1, by1);
    c.moveTo(bx0, by1); c.lineTo(bx1, by1);
    c.stroke();
    // 墙脚与墙头各给一条极淡的高光，免得房间只剩一个黑框
    c.strokeStyle = 'rgba(150,205,230,0.11)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(bx0, by1); c.lineTo(bx1, by1);
    c.moveTo(bx0, by0); c.lineTo(bx1, by0);
    c.stroke();

    /* ⑥ 后墙上的两支火把。贴在远墙上、尺寸小 —— 它们的作用是
       "给这个房间一个光源"，而不是"两个抢眼的物件" */
    const emberTile = tiles['prop_brazier0'];
    if (emberTile) {
      const es = SPR * 1.9;
      const ey = by0 + (by1 - by0) * 0.30;
      c.drawImage(emberTile, bx0 + (bx1 - bx0) * 0.14 - es / 2, ey, es, es);
      c.drawImage(emberTile, bx0 + (bx1 - bx0) * 0.86 - es / 2, ey, es, es);
    }

    /* ⑦ 区域染色 + 暗角 */
    c.fillStyle = reg.tint;
    c.fillRect(0, 0, W, H);
    const gv = c.createRadialGradient(W / 2, H * 0.58, H * 0.24, W / 2, H * 0.58, H * 1.06);
    gv.addColorStop(0, 'rgba(0,0,0,0)');
    gv.addColorStop(1, 'rgba(0,0,0,0.86)');
    c.fillStyle = gv;
    c.fillRect(0, 0, W, H);

    bsBg = cv.toDataURL();
    bsBgKey = rk;
    return bsBg;
  }

  /** 标签 / 姿态 的图标徽章。用图标而不是文字：一眼认得出的东西不该要人读。 */
  const TAG_ICON = {
    '高物抗': 'checked-shield', '高法抗': 'shield-reflect', '法术': 'magic-swirl',
    '召唤': 'cactus', '汲血': 'droplets', '精英': 'crown', '首领': 'crown',
    '群居': 'sound-waves'
  };
  function bsBadges(elId, foe) {
    const el = $(elId);
    if (!el) return;
    if (!foe) { el.innerHTML = ''; return; }
    let h = '';
    if (foe.stance) {
      h += '<span class="bs-badge stance-' + foe.stance + '" title="姿态：硬化' +
        (foe.stance === 'p' ? '物理' : '法术') + '">' +
        icon(foe.stance === 'p' ? 'checked-shield' : 'shield-reflect', 12) + '</span>';
    }
    const tg = foe.tags || [];
    for (let i = 0; i < tg.length; i++) {
      const ic = TAG_ICON[tg[i]];
      h += '<span class="bs-badge tag" title="' + esc(tg[i]) + '">' +
        (ic ? icon(ic, 12) : esc(tg[i])) + '</span>';
    }
    el.innerHTML = h;
  }

  /** 火盆余烬。橙色、从两个火盆的位置往上飘，和尘埃区分开（暖色 / 冷色）。 */
  function bsEmber() {
    const el = $('bs-ember');
    if (!el || el.children.length) return;
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('span');
      // 起点对应背景里那两支远墙火把的屏幕位置（画布 30% / 70%
      // 经 cover 缩放裁切后约落在 24% / 65% 处），别让火星凭空冒出来
      // 起点对应后墙上那两支火把（画布 x 约 33% / 69%，经 cover 缩放后）
      const left = (i % 2 === 0) ? (31 + Math.random() * 4) : (67 + Math.random() * 4);
      s.style.left = left.toFixed(1) + '%';
      s.style.animationDelay = (-Math.random() * 5).toFixed(1) + 's';
      s.style.animationDuration = (3.4 + Math.random() * 3).toFixed(1) + 's';
      const sz = 2 + Math.random() * 2.5;
      s.style.width = sz.toFixed(1) + 'px';
      s.style.height = sz.toFixed(1) + 'px';
      el.appendChild(s);
    }
  }

  /** 环境尘埃。只在第一次铺，之后靠 CSS 无限循环 —— 不占每帧预算。 */
  function bsAmbient() {
    const amb = $('bs-ambient');
    if (!amb || amb.children.length) return;
    for (let i = 0; i < 20; i++) {
      const s = document.createElement('span');
      s.style.left = (Math.random() * 100).toFixed(1) + '%';
      s.style.animationDelay = (-Math.random() * 11).toFixed(1) + 's';
      s.style.animationDuration = (8 + Math.random() * 8).toFixed(1) + 's';
      const sz = 2 + Math.random() * 3;
      s.style.width = sz.toFixed(1) + 'px';
      s.style.height = sz.toFixed(1) + 'px';
      amb.appendChild(s);
    }
  }

  /** 播一次战斗。ev 就是 core 推的 fight 事件（携带 res.log 与起始血量）。 */
  function playBattle(game, ev, done) {
    const el = $('battle-screen');
    if (!el) { if (done) done(); return; }
    const rounds = (ev.rounds || []).slice();
    const foe = ev.enemy;
    const heroName = game.cls.name;
    const aMax = Math.max(1, Math.round(game.stats().hp));
    const bMax = Math.max(1, Math.round(foe.maxHp));
    let aHp = (ev.aHp0 === undefined) ? game.hp : ev.aHp0;
    let bHp = (ev.bHp0 === undefined) ? bMax : ev.bHp0;

    bsSkip = false; bsDone = done || null;
    // 背景：真实瓦片拼的地下城 + 按当前区域染色
    const bd = $('bs-backdrop');
    if (bd) {
      bd.style.backgroundImage = 'url(' + bsBackdrop(game) + ')';
      bd.style.backgroundSize = 'cover';
      bd.style.backgroundPosition = 'center bottom';
      bd.style.backgroundRepeat = 'no-repeat';
    }
    bsAmbient();
    bsEmber();
    $('bs-hero-name').textContent = heroName;
    $('bs-foe-name').textContent = foe.name;
    $('bs-foe-tags').textContent = '';
    // 标签与姿态做成图标徽章：纯文字要读，图标一眼就认出。
    // 图标全部来自已内联的 icons.js，不引入任何新素材。
    bsBadges('bs-foe-badges', foe);
    bsBadges('bs-hero-badges', null);
    // 精灵用 paintXxx + toCanvas(N) **原生放大**，而不是把小图交给 CSS 拉伸。
    // toCanvas 内部把 imageSmoothingEnabled 关掉了，放大出来是干净的像素块；
    // CSS 拉伸会走双线性插值，把像素画的边缘糊成一片。
    const hArt = $('bs-hero-art');
    if (hArt.dataset.key !== game.cls.key) {
      // 'side' = 侧面，且默认朝右 —— 我方在左、敌方在右，正好相对。
      // ⚠ paintHero 只认 'down' | 'up' | 'side'，传别的值不报错、
      //   静默落到默认分支（正面）。这个坑我连踩两次：
      //   先是 'right'（以为侧面），后是 'up'（把"背朝我们"理解成背对镜头）。
      // 'up' = 背对镜头。相机在主角背后，所以看到的是他的背影 ——
      // 这正是"视角在主角这边、与对面对峙"。（上一版按"侧面"做成了 'side'，
      // 那是侧拍视角；这句话说的是**机位**。）
      try { hArt.src = A.paintHero(game.cls, 'up', 0).toCanvas(8).toDataURL(); }
      catch (err) { hArt.src = A.heroDataURL(game.cls, 192, 'right'); }
      hArt.dataset.key = game.cls.key;
    }
    const fArt = $('bs-foe-art');
    if (fArt.dataset.key !== foe.arc.id) {
      // 敌人远 -> 小。8 倍给主角（近）、4 倍给敌人（远）—— 这就是"近大远小"
      try { fArt.src = A.paintMonster(foe.arc.shape).toCanvas(4).toDataURL(); }
      catch (err) {
        // 退化路径：实在烤不出来也比空白强，至少玩家看得出是谁
        try { fArt.src = A.monsterSprite(foe.arc.shape, foe.arc.id, 0).toDataURL(); }
        catch (e2) { fArt.src = ''; }
      }
      fArt.dataset.key = foe.arc.id;
    }
    // 地面反光：把同一张精灵图镜像贴在脚下。
    // 湿地/石板地有倒影，这一层几乎是"立体感"里性价比最高的一条 ——
    // 它让精灵"站在地上"，而不是"浮在背景前面"。
    const hSrc = hArt.src, fSrc = fArt.src;
    const hr = $('bs-hero-refl'), fr = $('bs-foe-refl');
    if (hr) hr.style.backgroundImage = hSrc ? ('url(' + hSrc + ')') : '';
    if (fr) fr.style.backgroundImage = fSrc ? ('url(' + fSrc + ')') : '';

    const lg = $('bs-log');
    lg.innerHTML = '';
    $('bs-fx').innerHTML = '';
    bsBars(aHp, aMax, bHp, bMax);
    $('bs-round').textContent = '交锋 ' + rounds.length + ' 轮';
    el.classList.remove('hidden');

    let i = 0;
    const tick = function () {
      if (bsSkip || i >= rounds.length) {
        if (bsSkip) {
          // 跳过时把血条推到终局 —— 血条停在中间比不播还糟
          aHp = game.hp;
          bHp = Math.max(0, Math.round(foe.hp));
          bsBars(aHp, aMax, bHp, bMax);
        }
        bsTimer = setTimeout(endBattle, bsSkip ? 140 : 700);
        return;
      }
      const r = rounds[i++];
      // 血量从闭包传进去，不从 DOM 文本里读回来 ——
      // 状态源只有一个，显示层永远不是状态源。
      stepRound(r, heroName, aHp, bHp, function (nextA, nextB) {
        aHp = nextA; bHp = nextB;
      }, aMax, bMax);
      bsTimer = setTimeout(tick, bsDelay(r));
    };
    // 第一击**同步**打出来，不先愣半秒 —— 空场最伤"这是战斗"的感觉。
    // 附带好处：定时器驱动的画面截出来是不确定的，同步的这一击是确定的。
    if (rounds.length) {
      const r0 = rounds[i++];
      stepRound(r0, heroName, aHp, bHp, function (nextA, nextB) {
        aHp = nextA; bHp = nextB;
      }, aMax, bMax);
      bsTimer = setTimeout(tick, bsDelay(r0));
    } else {
      tick();
    }
  }

  /**
   * 推血条。
   *
   * 两层：`.fill` 掉得快（0.18s），`.ghost` 掉得慢（延迟 0.22s、0.45s 收拢）。
   * 这样挨打时会**先掉实条、再看到红条慢慢收**，中间那截红色就是"这一下掉了多少"。
   * 单层血条只有一个最终值 —— 玩家知道"我现在是多少"，但不知道"刚才发生了什么"。
   */
  function bsBars(aHp, aMax, bHp, bMax) {
    const ap = Math.max(0, Math.min(100, aHp / aMax * 100));
    const bp = Math.max(0, Math.min(100, bHp / bMax * 100));
    // 残影只降不升：回血时不该看到红条往回长
    const setBar = function (fillId, ghostId, pct) {
      const f = $(fillId), g = $(ghostId);
      if (!f) return;
      const prev = parseFloat(f.style.width) || 100;
      f.style.width = pct + '%';
      if (g) g.style.width = Math.max(pct, prev) + '%';
    };
    setBar('bs-hero-hp', 'bs-hero-ghost', ap);
    setBar('bs-foe-hp', 'bs-foe-ghost', bp);
    const at = $('bs-hero-hptext'), bt = $('bs-foe-hptext');
    if (at) at.textContent = Math.max(0, Math.round(aHp)) + ' / ' + Math.round(aMax);
    if (bt) bt.textContent = Math.max(0, Math.round(bHp)) + ' / ' + Math.round(bMax);
  }

  /** 受击反馈：闪白 + 火花 + 微震。三样一起上才有"打到了"的手感。 */
  function bsImpact(side, dmg, kind) {
    const sideEl = $(side === 'hero' ? 'bs-hero-side' : 'bs-foe-side');
    const stage = $('bs-stage');
    if (sideEl) {
      sideEl.classList.remove('flash');
      void sideEl.offsetWidth;
      sideEl.classList.add('flash');
      setTimeout(function () { sideEl.classList.remove('flash'); }, 200);
    }
    if (stage) {
      stage.classList.remove('quake');
      void stage.offsetWidth;
      stage.classList.add('quake');
      setTimeout(function () { stage.classList.remove('quake'); }, 260);
    }
    const fx = $('bs-fx');
    if (!fx) return;
    const n = Math.min(14, 5 + Math.round((dmg || 0) / 8));
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.className = 'bs-spark ' + (kind || 'p');
      s.style.left = ((side === 'hero' ? 27 : 73) + (Math.random() * 10 - 5)) + '%';
      s.style.top = (42 + Math.random() * 12) + '%';
      const a = Math.random() * Math.PI * 2;
      const d = 26 + Math.random() * 54;
      s.style.setProperty('--sx', (Math.cos(a) * d).toFixed(0) + 'px');
      s.style.setProperty('--sy', (Math.sin(a) * d).toFixed(0) + 'px');
      fx.appendChild(s);
      s.addEventListener('animationend', function () {
        if (s.parentNode) s.parentNode.removeChild(s);
      });
    }
  }

  /** 出手越快越短、暴击留久一点 —— 节奏本身就是信息 */
  function bsDelay(r) {
    if (r.dodge) return 380;
    return r.crit ? 620 : 460;
  }

  function bsPulse(sel, cls, ms) {
    const n = $(sel);
    if (!n) return;
    n.classList.remove(cls);
    void n.offsetWidth;               // 强制重排，动画才能重放
    n.classList.add(cls);
    setTimeout(function () { n.classList.remove(cls); }, ms);
  }

  function bsPop(text, kind, side, size) {
    const fx = $('bs-fx');
    if (!fx) return;
    const d = document.createElement('span');
    d.className = 'bs-dmg ' + kind;
    d.textContent = text;
    d.style.left = ((side === 'hero' ? 27 : 73) + (Math.random() * 12 - 6)) + '%';
    if (size) d.style.fontSize = size + 'px';
    d.style.setProperty('--dx', (Math.random() * 26 - 13) + 'px');
    fx.appendChild(d);
    d.addEventListener('animationend', function () {
      if (d.parentNode) d.parentNode.removeChild(d);
    });
  }

  function bsLine(r) {
    const lg = $('bs-log');
    if (!lg) return;
    const line = document.createElement('div');
    line.className = 'bs-line';
    let s = '<b>' + esc(r.from) + '</b> → <b>' + esc(r.to) + '</b>　';
    s += r.dodge ? '<em>闪避</em>' : '<em class="' + (r.type || 'p') + '">' + r.dmg + '</em>';
    if (r.crit) s += '　暴击';
    if (r.counter > 0) s += '　<span class="t">克 ' + r.counter + '</span>';
    if (r.reflect > 0) s += '　<span class="t">反 ' + r.reflect + '</span>';
    if (r.heal) s += '　<span class="hp">吸 +' + r.heal + '</span>';
    line.innerHTML = s;
    lg.appendChild(line);
    while (lg.childNodes.length > 5) lg.removeChild(lg.firstChild);
  }

  function stepRound(r, heroName, curA, curB, setHp, aMax, bMax) {
    const toHero = (r.to === heroName);
    const fromHero = (r.from === heroName);
    const targetSide = toHero ? 'hero' : 'foe';
    // 出手方冲锋（朝对手方向），受击方挨完抖一下
    bsPulse(fromHero ? 'bs-hero-side' : 'bs-foe-side', fromHero ? 'lunge-r' : 'lunge-l', 340);
    bsLine(r);
    if (r.dodge) {
      bsPop('闪避', 'dodge', targetSide);
      return;
    }
    let a = toHero ? undefined : null;
    let dealt = (r.dmg || 0) + (r.counter || 0);
    bsPop(r.dmg, (r.crit ? 'crit-' : '') + (r.type || 'p'), targetSide, r.crit ? 30 : 24);
    bsImpact(targetSide, r.dmg, r.crit ? 'crit' : (r.type || 'p'));
    if (r.counter > 0) bsPop(r.counter, 'true', targetSide, 17);
    setTimeout(function () { bsPulse(toHero ? 'bs-hero-side' : 'bs-foe-side', 'flinch', 300); }, 150);
    let na = toHero ? curA - dealt : curA;
    let nb = toHero ? curB : curB - dealt;
    if (r.reflect > 0) {
      if (fromHero) na -= r.reflect; else nb -= r.reflect;
      bsPop(r.reflect, 'true', fromHero ? 'hero' : 'foe', 17);
    }
    if (r.heal > 0) {
      if (fromHero) na = Math.min(aMax, na + r.heal); else nb = Math.min(bMax, nb + r.heal);
      bsPop('+' + r.heal, 'heal', fromHero ? 'hero' : 'foe', 17);
    }
    setHp(na, nb);
    bsBars(na, aMax, nb, bMax);
  }

  /* ============================================================
     弹窗
     ============================================================ */
  let relicShown = '';
  /* 选牌界面的键盘选中项。
     为什么要有它：三选一是"这一局的走向"，而鼠标是唯一入口的话，
     键盘玩家会在这里被迫摸鼠标 —— 恰好是节奏最要紧的一刻。
     存的是**下标**而不是 id：卡片顺序由 pendingRelic 决定，
     存下标才能让 ← → 的语义稳定（相邻就是相邻）。 */
  let relicSel = 0;

  function showRelicModal(game) {
    const sig = game.pendingRelic.map(function (r) { return r.id; }).join(',');
    // 弹窗**已经关着**时，即使候选 id 与上一轮完全相同也要重画：
    // 只比 sig 就提前返回的话，上一轮留下的键盘光标会被带进新一次选择
    // （而 sig 相同恰恰意味着我们一定会提前返回 —— 这俩是同一件事的两面）。
    const wasHidden = $('relic-modal').classList.contains('hidden');
    if (!wasHidden && relicShown === sig) return;
    relicShown = sig;
    relicSel = 0;                       // 每次新开都回到第一张，别沿用上一轮的光标
    const box = $('relic-modal');
    box.classList.remove('hidden');
    $('relic-cards').innerHTML = game.pendingRelic.map(function (r) {
      const sc = D.SCHOOLS[r.school] || {};
      return '<button class="relic-card" data-id="' + r.id + '" style="--rc:' + (sc.color || '#cbb994') + '">' +
        '<span class="rc-ico">' + icon(r.icon, 42) + '</span>' +
        '<span class="rc-school">' + esc(sc.name || '') + '</span>' +
        '<b class="rc-name">' + esc(r.name) + '</b>' +
        '<span class="rc-text">' + esc(r.text) + '</span>' +
        '</button>';
    }).join('');
    const cards = $('relic-cards').querySelectorAll('.relic-card');
    Array.prototype.forEach.call(cards, function (el, i) {
      el.onclick = function () {
        global.TideAudio.relic();
        global.TideMain.chooseRelic(el.dataset.id);
        relicShown = '';
      };
      // 鼠标移上去也同步键盘光标：两套输入不该各记一套状态，
      // 否则"我明明指着 B，按空格却选了 A"。
      el.onmouseenter = function () { relicSel = i; applyRelicSel(); };
    });
    applyRelicSel();
    global.TideAudio.relic();
  }

  /** 把选中态画到卡片上。键盘光标与鼠标悬停必须长得**不一样** ——
      悬停是"可能会点"，选中是"按空格就选它"。分不清的话，
      玩家不知道自己那一按会落到谁头上。 */
  function applyRelicSel() {
    const cards = $('relic-cards') ? $('relic-cards').querySelectorAll('.relic-card') : [];
    if (!cards.length) return;
    if (relicSel < 0) relicSel = 0;
    if (relicSel >= cards.length) relicSel = cards.length - 1;
    Array.prototype.forEach.call(cards, function (el, i) {
      el.classList.toggle('on', i === relicSel);
    });
  }

  /** ← → 移动选中项（两端回绕） */
  function relicMove(dir) {
    const cards = $('relic-cards') ? $('relic-cards').querySelectorAll('.relic-card') : [];
    if (!cards.length) return -1;
    relicSel = (relicSel + (dir > 0 ? 1 : -1) + cards.length) % cards.length;
    applyRelicSel();
    global.TideAudio.ui();
    return relicSel;
  }

  /** 空格 / 回车确认**当前选中**的那一张 */
  function relicConfirm() {
    const cards = $('relic-cards') ? $('relic-cards').querySelectorAll('.relic-card') : [];
    if (!cards.length) return false;
    const el = cards[Math.max(0, Math.min(cards.length - 1, relicSel))];
    if (!el) return false;
    global.TideAudio.relic();
    global.TideMain.chooseRelic(el.dataset.id);
    relicShown = '';
    return el.dataset.id;
  }

  function relicSelectedIndex() { return relicSel; }

  function showOver(game) {
    const win = game.status === 'win';
    const box = $('over-modal');
    box.classList.remove('hidden');
    /* 局外结算。一局只结一次 —— 标记直接打在**这一局的 game 对象**上。
       为什么不用外部 runId：game 对象天然是每局一个新的，于是"幂等"
       不依赖调用方记得传 id（那种约定迟早会被漏掉，而漏掉的后果是
       同一局结晶翻倍，不可逆 —— 玩家可能已经花掉了）。 */
    if (!game._metaSettled) {
      game._metaSettled = true;
      const r = global.TideMeta.settle(game);
      game._metaGain = r.gain;
      game._metaCrystals = r.meta.crystals;
      /* 写榜跑在**同一道幂等闸门里面**，不是外面。
         结算界面会被重绘、玩家会连点「再来一局」——
         排在闸门外的写榜会把这些重复调用变成榜上好几条同样的记录，
         而榜是删不掉的。 */
      game._score = global.TideData.scoreOf(game);
      game._boardRank = global.TideMeta.addScore({
        score: game._score.total,
        mode: game.endless ? '无尽' : (win ? '通关' : '阵亡'),
        clsName: game.cls.name,
        diffName: game.diff.name,
        depth: game.depth,
        kills: game.kills,
        elites: game.eliteKills || 0,
        bosses: game.bossKills || 0,
        win: win ? 1 : 0,
        turns: game.turn,
        seed: game.seed,
        date: new Date().toISOString().slice(0, 10),
        parts: game._score.parts
      });
    }
    $('over-title').textContent = win ? '潮水退去' : '你沉下去了';
    $('over-title').className = win ? 'win' : 'lose';
    /* 分数块放在结算最上面：这一屏要回答的第一个问题是
       "我这一局值多少"，结晶是第二位的（那是局外的账）。 */
    const sc = game._score || global.TideData.scoreOf(game);
    $('over-body').innerHTML =
      '<div class="ov-score">' +
      '<b>' + sc.total + '</b><i>分</i>' +
      (game._boardRank ? '<span class="rank">本机第 ' + game._boardRank + ' 名</span>' : '') +
      '</div>' +
      '<div class="ov-parts">' +
      sc.parts.map(function (p) {
        return '<span><i>' + esc(p.label) + '</i><b>' + p.value + '</b></span>';
      }).join('') +
      (sc.mul !== 1 ? '<span class="mul"><i>难度系数</i><b>×' + sc.mul + '</b></span>' : '') +
      '</div>' +
      '<div class="ov-grid">' +
      ov('到达深度', game.endless
        ? (game.depth + ' 层（无尽）')
        : (game.depth + ' / ' + game.diff.depth)) +
      ov('击杀', game.kills) +
      ov('回合', game.turn) +
      ov('秘藏', game.relics.length) +
      ov('金币', game.gold) +
      ov('难度', game.diff.name) +
      '</div>' +
      '<div class="ov-crystal">' + icon('gems', 17) +
      '<b>潮汐结晶 +' + game._metaGain + '</b>' +
      '<span class="muted">（共 ' + game._metaCrystals + '，回标题页可兑换永久增益）</span></div>' +
      '<div class="ov-sub">' + (game.endless
        ? '潮汐没有底 —— 这一口气撑到了第 ' + game.depth + ' 层。种子 ' + game.seed
        : (win
          ? '第 ' + game.diff.depth + ' 层的潮汐之主已经倒下。种子 ' + game.seed
          : '死因：' + esc(game.reason || '未知') + '。种子 ' + game.seed)) + '</div>';
    $('btn-again').onclick = function () { global.TideAudio.ui(); global.TideMain.restart(); };
    $('btn-title').onclick = function () { global.TideAudio.ui(); showTitle(); };
  }
  function ov(k, v) {
    return '<div class="ov-item"><i>' + esc(k) + '</i><b>' + esc(v) + '</b></div>';
  }

  let helpOpen = false;
  function showHelp() { helpOpen = !helpOpen; $('help-modal').classList.toggle('hidden', !helpOpen); }
  function closeHelp() { helpOpen = false; $('help-modal').classList.add('hidden'); }

  /* 潮汐结晶弹窗。
     为什么是弹窗而不是标题页上的第三块区块：标题页在 exe 的 1380×880
     窗口里已经装满了，再加一块会把「开始下潜」挤出可视区。
     而**程序化 click() 测不出这个** —— 它不关心元素在不在屏幕里，
     所以冒烟全绿、真人一打开就是"卡住"。这是测试的结构性盲区，见第 28 节断言。 */
  let metaOpen = false;
  function showMeta() {
    metaOpen = true;
    renderMetaPanel();
    $('meta-modal').classList.remove('hidden');
  }
  function closeMeta() { metaOpen = false; $('meta-modal').classList.add('hidden'); }
  function isMetaOpen() { return metaOpen; }

  /* ============================================================
     ESC 暂停菜单
     规则都在这里，界面只负责画；按钮走 inline onclick（和「玩法说明」同一套），
     省得在 buildStart 里再挂一遍监听。
     ============================================================ */
  let pauseOpen = false;
  function isPauseOpen() { return pauseOpen; }

  function showPause() {
    pauseOpen = true;
    renderPausePanel();
    $('pause-modal').classList.remove('hidden');
  }
  function closePause() {
    pauseOpen = false;
    $('pause-modal').classList.add('hidden');
  }

  /** 把"这一局打到哪了"写在菜单上 —— 暂停时最想知道的就是这个 */
  function renderPausePanel() {
    const g = global.TideMain.game;
    const sub = $('pause-stats');
    if (sub && g) {
      const st = g.stats();
      sub.textContent = g.cls.name + ' · ' + g.diff.name +
        ' · 深度 ' + g.depth + ' / ' + g.diff.depth +
        ' · 击杀 ' + g.kills + ' · 回合 ' + g.turn +
        ' · 生命 ' + Math.round(g.hp) + ' / ' + Math.round(st.hp);
    }
    const sb = $('btn-pause-sound');
    if (sb) sb.textContent = global.TideAudio.isOn() ? '音效：开' : '音效：关';
  }

  function pauseHelp() { closePause(); showHelp(); }
  function pauseSound() {
    const on = !global.TideAudio.isOn();
    global.TideAudio.toggle(on);
    const b = document.getElementById('btn-sound');
    if (b) b.classList.toggle('off', !on);
    renderPausePanel();
    toast(on ? '音效已开' : '音效已关');
  }
  function pauseRestart() {
    closePause();
    global.TideAudio.ui();
    global.TideMain.restart();
  }
  function pauseTitle() {
    closePause();
    global.TideAudio.ui();
    showMenu();          // "放弃并返回"回的是主菜单：那一层才是真正的出口
  }

  /* ============================================================
     局内左侧「操作指南」（v11-8）

     内容全部来自 data.js 的 KEYS —— 那是全项目唯一一份"按什么键做什么事"的表。
     这里只负责**按当前界面过滤**并画出来。

     为什么必须跟着界面变：一份"什么都列"的静态表在背包打开时是错的 ——
     那时 WASD 不走位、Q 不放技能。指南写着能按、实际按不动，
     玩家会先怀疑自己按错了（这类 bug 几乎不会被反馈回来）。
     ============================================================ */
  let guideOpen = null;      // null = 还没从存档里读过

  function guideScope(game) {
    if (game && game.hasPendingRelic() ) return 'relic';
    if (invOpen) return 'inv';
    return 'game';
  }

  function renderGuide(game) {
    const panel = $('guide-panel'), body = $('guide-body');
    if (!panel || !body || !game) return;
    if (guideOpen === null) guideOpen = global.TideSettings.get('guide') !== false;
    panel.classList.remove('hidden');
    panel.classList.toggle('collapsed', !guideOpen);
    const scope = guideScope(game);
    const rows = (D.KEYS || []).filter(function (k) { return k.scope.indexOf(scope) >= 0; });
    const sig = scope + '|' + rows.length + '|' + (guideOpen ? 1 : 0);
    if (body._sig === sig) return;      // 没变就不重画（render 每帧都会经过这里）
    body._sig = sig;
    body.innerHTML = rows.map(function (k) {
      return '<div class="gd-row"><b>' + esc(k.label) + '</b><i>' + esc(k.text) + '</i></div>';
    }).join('');
  }

  function toggleGuide() {
    guideOpen = !(guideOpen === null ? (global.TideSettings.get('guide') !== false) : guideOpen);
    global.TideSettings.set('guide', guideOpen);
    const body = $('guide-body');
    if (body) body._sig = '';           // 逼它重画
    if (global.TideMain && global.TideMain.game) renderGuide(global.TideMain.game);
    return guideOpen;
  }

  /* ============================================================
     区域横幅（v11-5）

     进入一个新区域时报一句"我到了哪儿"。
     它和 toast 的分工是「事件 vs 流水账」：
       掉一件装备是流水账 —— toast，窄条、靠边、错过了也不心疼；
       踏进危险区是事件 —— 横幅，居中、带危险度星、挡住中央两秒。
     事件值得被看见、流水账不该，所以没有把两者合并成一个组件。
     ============================================================ */
  let bannerT = 0;

  function regionBanner(ev) {
    const el = $('region-banner');
    if (!el || !ev) return;
    const n = Math.max(1, Math.min(3, ev.danger || 1));
    el.innerHTML = '<i>进入</i><b>' + esc(ev.name || '未知区') + '</b><span>' +
      '\u2605'.repeat(n) + '</span>';
    el.className = 'show r-' + (ev.rtype || 'normal');
    clearTimeout(bannerT);
    bannerT = setTimeout(function () {
      el.className = 'r-' + (ev.rtype || 'normal');
    }, 2200);
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('on'); }, 1700);
  }

  /* ============================================================
     场景切换
     ============================================================ */
  /* ============================================================
     潮汐结晶：局外永久解锁
     规则全在 data.js（META）与 meta.js（存档），这里只负责画出来。
     ============================================================ */
  function renderMetaPanel() {
    const MU = global.TideMeta;
    const m = MU.load();
    const grid = $('meta-grid');
    if (!grid) return;        // 面板不在当前页面上（比如局内）→ 直接跳过，别把界面搞崩
    // 结晶数量显示在两处：标题页按钮上、弹窗标题里。两处都判空 ——
    // 少一个元素不该让整个面板挂掉（标题页和弹窗本来就可以分开调整）。
    const cry1 = $('meta-crystals'), cry2 = $('meta-modal-count');
    if (cry1) cry1.textContent = m.crystals;
    if (cry2) cry2.textContent = m.crystals;
    const hint = $('meta-hint');
    if (hint) {
      hint.textContent = m.runs
        ? ('已下潜 ' + m.runs + ' 次 · 通关 ' + m.wins + ' 次 · 最深层 ' + m.best +
          ' · 累计结晶 ' + m.total)
        : '还没有结晶。死一次就有了 —— 深度和击杀都算数。';
    }

    grid.innerHTML = D.META.unlocks.map(function (u) {
      const has = !!m.owned[u.id];
      const v = D.META.canBuy(m.owned, m.crystals, u.id);
      // 四种状态各自要能说清"为什么现在买不了"。
      // 只把按钮置灰而不给理由，玩家会以为坏了 —— 这是界面层最容易偷的懒。
      let state = 'buy', note = '花费 ' + u.cost + ' 结晶';
      if (has) { state = 'owned'; note = '已解锁'; }
      else if (v.reason === 'req') {
        const pre = D.META.unlockById(u.req);
        state = 'locked'; note = '需先解锁「' + (pre ? pre.name : u.req) + '」';
      } else if (v.reason === 'poor') { state = 'poor'; note = '还差 ' + v.need + ' 结晶'; }
      return '<button class="meta-card ' + state + '" data-meta="' + u.id + '">' +
        '<span class="meta-ico">' + icon(u.icon, 22) + '</span>' +
        '<span class="meta-body"><b>' + esc(u.name) + '</b><i>' + esc(u.desc) + '</i></span>' +
        '<span class="meta-cost">' + (has ? '✓' : u.cost) + '</span>' +
        '<span class="meta-note">' + esc(note) + '</span>' +
        '</button>';
    }).join('');

    Array.prototype.forEach.call(grid.querySelectorAll('[data-meta]'), function (el) {
      el.onclick = function () {
        const r = MU.buy(el.dataset.meta);
        global.TideAudio.ui(!r.ok);
        if (!r.ok) {
          if (r.reason === 'poor') toast('结晶不够，还差 ' + r.need);
          else if (r.reason === 'req') toast('要先解锁前置项');
          else if (r.reason === 'owned') toast('已经解锁过了');
          return;
        }
        toast('已解锁「' + r.unlock.name + '」—— 下一局开始生效');
        renderMetaPanel();
      };
    });
  }

  function showTitle() {
    closeHelp();
    closeBattle();          // 模态层必须逐个登记 —— 漏一个的后果是它永远开着
    invOpen = false; syncInventory();
    $('title-screen').classList.remove('hidden');
    if ($('menu-screen')) $('menu-screen').classList.add('hidden');
    $('game-screen').classList.add('hidden');
    $('over-modal').classList.add('hidden');
    $('meta-modal').classList.add('hidden');
    metaOpen = false;
    $('pause-modal').classList.add('hidden');
    pauseOpen = false;
    relicShown = '';
    renderClassPicker();
    renderDiffPicker();
    renderMetaPanel();                        // 刷新标题页按钮上的结晶数
    global.TideAudio.music('title');          // 标题页：静谧段（只有低音，慢）
    global.TideMain.game = null;
    setTimeout(function () { global.TideRender.resize(); }, 30);
  }
  function showGame() {
    closeHelp();
    closeBattle();
    invOpen = false; syncInventory();
    $('title-screen').classList.add('hidden');
    if ($('menu-screen')) $('menu-screen').classList.add('hidden');
    $('game-screen').classList.remove('hidden');
    $('over-modal').classList.add('hidden');
    relicShown = '';
    lastSig = '';
    $('pause-modal').classList.add('hidden');
    pauseOpen = false;
    global.TideAudio.music('game', 1);        // 局内：探索段，强度随后由 render() 接管
    setTimeout(function () { global.TideRender.init(); global.TideRender.resize(); }, 30);
  }

  global.TideUI = {
    init: function () { buildMenu(); buildStart(); buildGame(); bindInventory(); bindTips(); },
    showMenu: showMenu,
    renderMenu: renderMenu,
    showSettings: showSettings,
    closeSettings: closeSettings,
    isSettingsOpen: isSettingsOpen,
    renderSettings: renderSettings,
    showBoard: showBoard,
    closeBoard: closeBoard,
    isBoardOpen: isBoardOpen,
    renderBoard: renderBoard,
    applySettings: applySettings,
    quitGame: quitGame,
    render: render,
    enemyInfo: enemyInfo,
    playBattle: playBattle,
    isBattleOpen: isBattleOpen,
    skipBattle: skipBattle,
    closeBattle: closeBattle,
    showTitle: showTitle,
    showGame: showGame,
    showOver: showOver,
    renderMetaPanel: renderMetaPanel,
    showMeta: showMeta,
    closeMeta: closeMeta,
    relicMove: relicMove,
    relicConfirm: relicConfirm,
    relicSelectedIndex: relicSelectedIndex,
    isMetaOpen: isMetaOpen,
    showPause: showPause,
    closePause: closePause,
    isPauseOpen: isPauseOpen,
    pauseHelp: pauseHelp,
    pauseSound: pauseSound,
    pauseRestart: pauseRestart,
    pauseTitle: pauseTitle,
    showHelp: showHelp,
    closeHelp: closeHelp,
    tooltip: tooltip,
    toast: toast,
    regionBanner: regionBanner,
    toggleGuide: toggleGuide,
    /* 指南的观测量：当前是哪一套、画了几行、展开还是收起。
       "指南有没有跟着界面变"必须能断言 —— 它正是这个面板存在的理由。 */
    guideState: function () {
      const panel = $('guide-panel'), body = $('guide-body');
      if (!panel || !body) return null;
      const g = global.TideMain ? global.TideMain.game : null;
      return {
        scope: g ? guideScope(g) : null,
        rows: body.querySelectorAll('.gd-row').length,
        open: !panel.classList.contains('collapsed'),
        hidden: panel.classList.contains('hidden'),
        text: body.textContent || ''
      };
    },
    /* 横幅是不是正显示着、显示的是哪一类、里面的字是什么 ——
       这三件事都要能断言，否则"进新区域会报一声"只是口头承诺。 */
    regionBannerState: function () {
      const el = $('region-banner');
      if (!el) return null;
      const cls = el.className || '';
      const m = /r-([a-z]+)/.exec(cls);
      return { shown: cls.indexOf('show') >= 0, rtype: m ? m[1] : null, text: el.textContent || '' };
    },
    openInventory: openInventory,
    closeInventory: closeInventory,
    toggleInventory: toggleInventory,
    isInventoryOpen: function () { return invOpen; },
    get pick() { return pick; },
    isHelpOpen: function () { return helpOpen; }
  };
})(window);
