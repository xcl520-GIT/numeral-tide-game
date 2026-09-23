/* ============================================================
   数值潮汐 · 音频层
   全部用 Web Audio 现场合成，**零音频文件**。
   理由是发行要求"一个文件夹带走"：塞 20 个 wav 会让体积从 1MB 变成 20MB，
   而且合成音可以按参数实时变化（伤害越高音越高），比固定采样更贴场景。
   ============================================================ */
(function (global) {
  'use strict';

  let ac = null, master = null, enabled = true, ambient = null;
  let lastPlay = {};

  /* 音效与 BGM 走**两条独立支路**，再汇到 master。
     为什么不是一条总音量：两者的合理比例因人而异。合成一条之后，
     "音乐太吵"就只剩"把刀剑声一起关掉"这一个解法了。
     初始值是 1.0 = 与加音量功能之前完全一致的混音，不给老玩家一个突然的变化。 */
  const VOL = { sfx: 1, bgm: 1 };
  let sfxBus = null, musicBus = null;

  function ctx() {
    if (!ac) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) { enabled = false; return null; }
      try {
        ac = new AC();
        master = ac.createGain();
        master.gain.value = 0.30;
        master.connect(ac.destination);
        sfxBus = ac.createGain();
        sfxBus.gain.value = VOL.sfx;
        sfxBus.connect(master);
        musicBus = ac.createGain();
        musicBus.gain.value = VOL.bgm;
        musicBus.connect(master);
      } catch (e) {
        // 没有声卡 / 被策略拦截 / 上下文数量超限 —— 直接安静下来。
        // 这里必须吞掉异常：创建失败曾经把整个按钮的点击处理器一起中断，
        // 表现是"点开始没反应"，而且完全看不出和音频有关。
        ac = null; enabled = false; return null;
      }
    }
    try { if (ac.state === 'suspended') ac.resume(); } catch (e) { }
    return ac;
  }

  /** 简单的限流：同一类音效 40ms 内只响一次，避免连击时糊成噪音 */
  function gate(key, ms) {
    const now = performance.now();
    if (lastPlay[key] && now - lastPlay[key] < (ms || 40)) return false;
    lastPlay[key] = now;
    return true;
  }

  function tone(opts) {
    if (!enabled) return;
    const a = ctx(); if (!a) return;
    // at：绝对时间。BGM 排程必须按音频时钟的时间点发声，不能是「现在就响」——
    // 定时器精度只有 ~15ms，还会被后台标签页节流。
    const t0 = (opts.at === undefined ? a.currentTime : opts.at);
    const dur = opts.dur || 0.12;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = opts.type || 'square';
    osc.frequency.setValueAtTime(opts.f0, t0);
    if (opts.f1 !== undefined && opts.f1 !== opts.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.f1), t0 + dur);
    }
    const vol = (opts.vol === undefined ? 0.25 : opts.vol);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc;
    if (opts.filter) {
      const bq = a.createBiquadFilter();
      bq.type = 'lowpass';
      bq.frequency.value = opts.filter;
      osc.connect(bq); node = bq;
    }
    node.connect(g);
    g.connect(opts.bus === 'music' ? (musicBus || master) : (sfxBus || master));
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(opts) {
    if (!enabled) return;
    const a = ctx(); if (!a) return;
    const t0 = (opts.at === undefined ? a.currentTime : opts.at);
    const dur = opts.dur || 0.12;
    const len = Math.max(1, Math.floor(a.sampleRate * dur));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource();
    src.buffer = buf;
    const bq = a.createBiquadFilter();
    bq.type = opts.type || 'bandpass';
    bq.frequency.value = opts.freq || 900;
    bq.Q.value = opts.q || 1.2;
    const g = a.createGain();
    g.gain.value = opts.vol === undefined ? 0.24 : opts.vol;
    src.connect(bq); bq.connect(g);
    g.connect(opts.bus === 'music' ? (musicBus || master) : (sfxBus || master));
    src.start(t0);
  }

  /* ============================================================
     对外接口。
     每一个方法都包一层 try/catch —— 音频是"锦上添花"，
     任何音频异常都不允许向上冒泡。踩过一次：
     按钮的 onclick 是 `TideAudio.ui(); TideMain.start();`，
     音频抛异常导致 start() 根本没执行，表现为"点开始没反应"。
     ============================================================ */
  function guard(fn) {
    return function () {
      if (!enabled) return undefined;
      try { return fn.apply(null, arguments); } catch (e) { return undefined; }
    };
  }

  /* ============================================================
     背景音乐 · 程序化音序器（零音频文件）

     为什么不能拿 setInterval 直接发声：
     定时器精度只有 ~15ms、还会被后台标签页节流到 1s，直接发声会一顿一顿。
     标准做法是「提前排程」：定时器每 25ms 醒一次，把未来 0.25 秒内该响的音符
     按**绝对时间**交给音频时钟，由音频线程精确执行。主线程再卡也不走音。

     另一条必须守住的性质：**不发声的时候不能还在算。**
     静音 / 失焦 / 不在游戏里 → 直接停掉定时器，而不是把 master 增益拧到 0
     （增益为 0 时振荡器仍在跑，笔记本风扇会告诉你这件事）。

     乐思：铺底交给已有的 ambient 低鸣，这里只叠低音 + 琶音 + 危机段落的浪声。
     ============================================================ */
  const BGM = {
    timer: null,
    step: 0,
    nextT: 0,
    scene: 'off',   // 'off' | 'title' | 'game'
    level: 0,       // 0 静谧 / 1 探索 / 2 危机
    tempo: 92
  };

  // A 小调五声音阶（A C D E G）。选五声是因为它**没有小二度**，
  // 程序怎么排列都不会难听 —— 这是程序化作曲最省事也最稳的地基。
  const SCALE = [220.00, 261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33];
  // 一小节一个和弦根音，走 Am - F - C - G：起 → 落 → 起 → 落，就是潮汐。
  const BASS = [110.00, 87.31, 130.81, 98.00];
  // 16 步琶音走势。**写死而不是随机**：随机每次都不一样，听起来像没写完，
  // 而且改动之后无法判断到底是变好了还是变坏了。
  const ARP = [0, 2, 4, 2, 3, 5, 4, 2, 0, 2, 4, 6, 5, 4, 2, 1];

  function bgmSchedule(when, step) {
    const s = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const lv = BGM.level;
    // 低音：每 4 步（四分音符）一下
    if (s % 4 === 0) {
      tone({ at: when, bus: 'music', type: 'sine', f0: BASS[bar], dur: 0.9, vol: 0.085, filter: 500 });
    }
    // 琶音：静谧段落只留一半音符，探索以上走完整琶音
    if (lv >= 1 || s % 4 === 2) {
      const f = SCALE[ARP[s] % SCALE.length];
      tone({
        at: when, bus: 'music', type: 'triangle', f0: f * 2,
        dur: lv >= 2 ? 0.16 : 0.26, vol: lv >= 2 ? 0.035 : 0.05
      });
    }
    // 危机段落：叠一层浪拍岸和一声底鼓，把紧张度推上去
    if (lv >= 2) {
      if (s === 0 || s === 8) {
        noise({ at: when, bus: 'music', freq: 900, dur: 0.5, vol: 0.05, q: 0.5, type: 'lowpass' });
      }
      if (s === 4 || s === 12) {
        tone({ at: when, bus: 'music', type: 'sine', f0: 120, f1: 60, dur: 0.14, vol: 0.06 });
      }
    }
  }

  function bgmTick() {
    const a = ac;
    if (!a || !enabled || BGM.scene === 'off') return;
    const beat = 60 / BGM.tempo / 2;      // 八分音符
    const horizon = a.currentTime + 0.25; // 往前看 0.25 秒
    let spin = 0;
    while (BGM.nextT < horizon && spin++ < 64) {
      if (BGM.nextT < a.currentTime) BGM.nextT = a.currentTime + 0.02;
      bgmSchedule(BGM.nextT, BGM.step);
      BGM.nextT += beat;
      BGM.step++;
    }
  }

  function bgmStart() {
    const a = ctx();
    if (!a || !enabled || BGM.scene === 'off') { bgmStop(); return; }
    if (BGM.timer) return;
    BGM.nextT = a.currentTime + 0.06;
    BGM.timer = setInterval(bgmTick, 25);
  }

  function bgmStop() {
    if (BGM.timer) { clearInterval(BGM.timer); BGM.timer = null; }
  }

  /**
   * 切换场景 / 强度。
   * **必须幂等**：它会被渲染循环每帧调用，一旦有副作用（比如每次都把
   * BGM.step 归零），音乐就会卡在第 0 步反复重来。
   */
  function bgmApply(scene, level) {
    const nextScene = scene || 'off';
    const nextLevel = (nextScene === 'title') ? 0 : Math.max(0, Math.min(2, level || 0));
    if (nextScene === BGM.scene && nextLevel === BGM.level) return;
    BGM.scene = nextScene;
    BGM.level = nextLevel;
    BGM.tempo = nextScene === 'title' ? 72 : (nextLevel >= 2 ? 108 : 92);
    BGM.step = 0;
    if (nextScene === 'off') bgmStop(); else bgmStart();
  }

  const RAW = {
    init: function () {
      const a = ctx();
      if (a) RAW.ambient(true);
    },
    toggle: function (on) {
      enabled = !!on;
      if (master) { try { master.gain.value = enabled ? 0.30 : 0; } catch (e) { } }
      // 静音要**停掉音序器**，不是把增益拧到 0 ——
      // 增益为 0 时振荡器还在跑，笔记本的风扇会告诉你这件事。
      if (enabled) bgmStart(); else bgmStop();
    },
    isOn: function () { return enabled; },
    ambient: function (on) {
      const a = ctx(); if (!a) return;
      if (!on) { if (ambient) { try { ambient.forEach(function (n) { n.stop(); }); } catch (e) { } ambient = null; } return; }
      if (ambient) return;
      const nodes = [];
      const g = a.createGain();
      g.gain.value = 0.035;
      g.connect(musicBus || master);      // 铺底属于音乐，跟着 BGM 音量走
      [55, 82.4, 110].forEach(function (f, i) {
        const o = a.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * (1 + i * 0.004);
        const gg = a.createGain();
        gg.gain.value = 0.5 / (i + 1);
        o.connect(gg); gg.connect(g);
        o.start();
        nodes.push(o);
      });
      const len = a.sampleRate * 4;
      const buf = a.createBuffer(1, len, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
      const src = a.createBufferSource();
      src.buffer = buf; src.loop = true;
      const bq = a.createBiquadFilter();
      bq.type = 'lowpass'; bq.frequency.value = 320;
      const ng = a.createGain(); ng.gain.value = 0.35;
      src.connect(bq); bq.connect(ng); ng.connect(g);
      src.start();
      nodes.push(src);
      ambient = nodes;
    },

    step: function () { if (!gate('step', 70)) return; noise({ freq: 420, dur: 0.055, vol: 0.10, q: 0.8 }); },
    hit: function (big) {
      if (!gate('hit', 30)) return;
      tone({ type: 'square', f0: big ? 200 : 320, f1: 70, dur: big ? 0.16 : 0.09, vol: 0.20, filter: 2000 });
      noise({ freq: big ? 700 : 1200, dur: 0.07, vol: 0.16, q: 0.7 });
    },
    magic: function () {
      if (!gate('magic', 30)) return;
      tone({ type: 'triangle', f0: 780, f1: 260, dur: 0.13, vol: 0.16 });
      tone({ type: 'sine', f0: 1560, f1: 520, dur: 0.10, vol: 0.09 });
    },
    /* 魂技：比普攻更"重"的一声。四个技能各给一个音色 ——
       和上一条同理：都响同一声音，玩家的记忆里就只剩"放了技能"，
       而不是"放了裂地斩"。听觉比视觉更容易被记住。
       这些音色都刻意和普攻（方波）/法术（三角波）拉开距离。 */
    skill: function (key) {
      if (key === 'quake') {
        // 地裂：低频闷响 + 碎石
        tone({ type: 'square', f0: 150, f1: 52, dur: 0.30, vol: 0.22, filter: 900 });
        noise({ freq: 420, dur: 0.26, vol: 0.18, q: 0.5 });
      } else if (key === 'torrent') {
        // 潮语洪流：水声 —— 先上扫再落下，两段叠一层
        tone({ type: 'sine', f0: 320, f1: 900, dur: 0.14, vol: 0.16 });
        tone({ type: 'sine', f0: 900, f1: 260, dur: 0.24, vol: 0.14 });
        noise({ freq: 1800, dur: 0.22, vol: 0.11, q: 0.9 });
      } else if (key === 'blitz') {
        // 疾影：短促的破空声，不能拖沓
        noise({ freq: 2600, dur: 0.10, vol: 0.15, q: 1.1 });
        tone({ type: 'triangle', f0: 1200, f1: 420, dur: 0.08, vol: 0.11 });
      } else if (key === 'bulwark') {
        // 不退之壁：厚实的钟鸣 + 一层低鸣，要有"撑住了"的感觉
        tone({ type: 'triangle', f0: 300, f1: 300, dur: 0.30, vol: 0.16, filter: 1400 });
        tone({ type: 'sine', f0: 600, f1: 588, dur: 0.34, vol: 0.10 });
        tone({ type: 'sine', f0: 150, f1: 120, dur: 0.36, vol: 0.12 });
      } else {
        tone({ type: 'sawtooth', f0: 180, f1: 760, dur: 0.16, vol: 0.20, filter: 2600 });
        tone({ type: 'square', f0: 760, f1: 120, dur: 0.22, vol: 0.15, filter: 1800 });
        noise({ freq: 1400, dur: 0.16, vol: 0.13, q: 0.6 });
      }
    },
    /* 技能没好：一句短促的"咔"，明确告诉玩家"不是没反应，是还不能放" */
    nocd: function () {
      tone({ type: 'square', f0: 220, f1: 180, dur: 0.06, vol: 0.10, filter: 900 });
    },
    crit: function () {
      tone({ type: 'square', f0: 900, f1: 220, dur: 0.14, vol: 0.20 });
      tone({ type: 'sawtooth', f0: 1400, f1: 400, dur: 0.10, vol: 0.10 });
    },
    kill: function () {
      tone({ type: 'triangle', f0: 300, f1: 60, dur: 0.24, vol: 0.20 });
      noise({ freq: 500, dur: 0.16, vol: 0.14, q: 0.6 });
    },
    hurt: function () {
      if (!gate('hurt', 60)) return;
      tone({ type: 'sawtooth', f0: 180, f1: 90, dur: 0.16, vol: 0.18, filter: 900 });
    },
    loot: function (rarity) {
      const base = rarity === 'legendary' ? 380 : rarity === 'epic' ? 340 : 300;
      [0, 4, 7, 12].forEach(function (semi, i) {
        setTimeout(function () {
          try { tone({ type: 'triangle', f0: base * Math.pow(2, semi / 12) * 2, dur: 0.20, vol: 0.13 }); } catch (e) { }
        }, i * 55);
      });
    },
    relic: function () {
      [0, 5, 9, 12, 16].forEach(function (s, i) {
        setTimeout(function () {
          try { tone({ type: 'sine', f0: 440 * Math.pow(2, s / 12), dur: 0.34, vol: 0.15 }); } catch (e) { }
        }, i * 80);
      });
    },
    chest: function () {
      noise({ freq: 300, dur: 0.20, vol: 0.16, q: 0.5 });
      tone({ type: 'triangle', f0: 520, f1: 780, dur: 0.22, vol: 0.14 });
    },
    /** 金币：两个短促的高音，像硬币碰在一起 */
    coin: function () {
      if (!gate('coin', 45)) return;
      tone({ type: 'square', f0: 1180, f1: 1560, dur: 0.06, vol: 0.10 });
      setTimeout(function () {
        try { tone({ type: 'square', f0: 1560, dur: 0.05, vol: 0.07 }); } catch (e) { }
      }, 52);
    },
    heal: function () {
      tone({ type: 'sine', f0: 520, f1: 880, dur: 0.28, vol: 0.15 });
      tone({ type: 'sine', f0: 780, f1: 1200, dur: 0.24, vol: 0.08 });
    },
    tide: function (rising) {
      noise({ freq: rising ? 240 : 160, dur: rising ? 1.8 : 1.2, vol: 0.20, q: 0.4, type: 'lowpass' });
      tone({ f0: rising ? 90 : 140, f1: rising ? 150 : 70, dur: 1.6, vol: 0.10 });
    },
    descend: function () {
      tone({ type: 'sine', f0: 620, f1: 120, dur: 0.7, vol: 0.20 });
      tone({ type: 'triangle', f0: 310, f1: 60, dur: 0.9, vol: 0.14 });
    },
    levelup: function () {
      [0, 4, 7, 11, 14, 19].forEach(function (s, i) {
        setTimeout(function () {
          try { tone({ type: 'square', f0: 330 * Math.pow(2, s / 12), dur: 0.16, vol: 0.11 }); } catch (e) { }
        }, i * 55);
      });
    },
    death: function () {
      tone({ type: 'sawtooth', f0: 300, f1: 40, dur: 1.4, vol: 0.22, filter: 700 });
      noise({ freq: 200, dur: 1.2, vol: 0.14, q: 0.4, type: 'lowpass' });
    },
    win: function () {
      [0, 7, 12, 16, 19, 24].forEach(function (s, i) {
        setTimeout(function () {
          try { tone({ type: 'triangle', f0: 440 * Math.pow(2, s / 12), dur: 0.5, vol: 0.15 }); } catch (e) { }
        }, i * 130);
      });
    },
    ui: function (down) {
      tone({ type: 'square', f0: down ? 520 : 700, f1: down ? 400 : 900, dur: 0.05, vol: 0.08 });
    },
    /**
     * 踏进一个新区域（v11-5）。
     * 和 coin / heal 那种"点状"音效不同：它要听起来像**跨过了一道线**，
     * 所以是一段下滑的音高；危险区/精英区再压一层低频噪声，听起来更沉。
     */
    region: function (rtype) {
      const hard = (rtype === 'hazard' || rtype === 'elite');
      tone({ type: 'sine', f0: hard ? 300 : 460, f1: hard ? 150 : 340, dur: 0.34, vol: 0.13 });
      if (hard) noise({ freq: 180, dur: 0.34, vol: 0.09, q: 0.5, type: 'lowpass' });
    },

    /* ---- 音量 ---- */
    /**
     * 设定音量（0..1），sfx / bgm 分轨。传 undefined 表示"这一路不动"。
     * 上下文还没建起来时也要能记住值 —— 玩家可能在第一次发声之前就拖了滑块。
     */
    setVolume: function (sfx, bgm) {
      if (sfx !== undefined && sfx !== null) VOL.sfx = Math.max(0, Math.min(1, Number(sfx) || 0));
      if (bgm !== undefined && bgm !== null) VOL.bgm = Math.max(0, Math.min(1, Number(bgm) || 0));
      try { if (sfxBus) sfxBus.gain.value = VOL.sfx; } catch (e) { }
      try { if (musicBus) musicBus.gain.value = VOL.bgm; } catch (e) { }
      return { sfx: VOL.sfx, bgm: VOL.bgm };
    },
    getVolume: function () { return { sfx: VOL.sfx, bgm: VOL.bgm }; },

    /* ---- 背景音乐 ---- */
    music: function (scene, level) { bgmApply(scene, level); },
    musicStop: function () { bgmApply('off', 0); },
    /** 页面失焦时叫停（别在后台空转），回来再接上 */
    musicPause: function () { bgmStop(); },
    musicResume: function () { bgmStart(); },
    /** 供测试断言用：音序器到底在不在跑、跑的是哪一段 */
    musicState: function () {
      return {
        scene: BGM.scene, level: BGM.level, tempo: BGM.tempo,
        running: !!BGM.timer, step: BGM.step
      };
    }
  };

  const API = {};
  const NO_GUARD = { init: 1, toggle: 1, isOn: 1, ambient: 1, musicState: 1, getVolume: 1, setVolume: 1 };
  Object.keys(RAW).forEach(function (k) {
    API[k] = NO_GUARD[k] ? function () {
      try { return RAW[k].apply(null, arguments); } catch (e) { return undefined; }
    } : guard(RAW[k]);
  });

  /** 按事件类型分发，调用方只需一个入口 */
  API.play = function (kind, arg) {
    try {
      const fn = RAW[kind];
      if (typeof fn === 'function') return fn(arg);
    } catch (e) { }
    return undefined;
  };

  global.TideAudio = API;
})(window);
