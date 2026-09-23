/* ============================================================
   数值潮汐 · 特效层
   粒子 + 飘字 + 震屏。
   刻意做成"事件驱动"：核心逻辑 push 事件，这里只负责把事件翻译成画面，
   逻辑层依旧完全不认识 canvas。
   ============================================================ */
(function (global) {
  'use strict';

  const parts = [];
  const texts = [];
  let shakeX = 0, shakeY = 0, shakeMag = 0;

  function spawn(x, y, n, color, opts) {
    opts = opts || {};
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (opts.speed || 2.2) * (0.4 + Math.random());
      parts.push({
        x: x, y: y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - (opts.lift || 0.6),
        life: 1, decay: 0.022 + Math.random() * 0.03,
        size: opts.size || (1 + Math.random() * 2.2),
        color: Array.isArray(color) ? color[(Math.random() * color.length) | 0] : color,
        grav: opts.grav === undefined ? 0.045 : opts.grav
      });
    }
  }

  function popText(x, y, str, color, size, vy) {
    texts.push({
      x: x, y: y, str: str, color: color || '#fff',
      size: size || 14, life: 1, vy: vy === undefined ? -1.15 : vy
    });
  }

  function shake(mag) { shakeMag = Math.max(shakeMag, mag || 3); }

  /* ============================================================
     两种"形状型"特效

     粒子能表达"碎屑"，但表达不了"一圈扩散的冲击"和"一条打过去的能量"，
     而这两个恰好是技能最需要的形状。所以单独补两种：
       ring   —— 地面平面上的椭圆环（用地裂、护盾、落地都合适）
       streak —— 两点之间的能量束（法术射线、残影拖尾）
     都用和粒子同一套生命周期（life 递减），免得多一套回收逻辑。
     ============================================================ */
  const rings = [];
  const streaks = [];

  function ring(x, y, color, maxR, life, width) {
    rings.push({
      x: x, y: y, color: color || '#ffffff', r: 5,
      maxR: maxR || 60, life: 1, decay: 1 / (life || 26), w: width || 3
    });
  }

  function streak(x1, y1, x2, y2, color, life) {
    streaks.push({
      x1: x1, y1: y1, x2: x2, y2: y2,
      color: color || 'rgba(255,255,255,0.8)', life: 1, decay: 1 / (life || 16)
    });
  }

  function update() {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx; p.y += p.vy;
      p.vy += p.grav;
      p.vx *= 0.985;
      p.life -= p.decay;
      if (p.life <= 0) parts.splice(i, 1);
    }
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      t.y += t.vy;
      t.vy *= 0.955;
      t.life -= 0.021;
      if (t.life <= 0) texts.splice(i, 1);
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.r += (r.maxR - r.r) * 0.20;      // 向外扩张，先快后慢
      r.life -= r.decay;
      if (r.life <= 0) rings.splice(i, 1);
    }
    for (let i = streaks.length - 1; i >= 0; i--) {
      const s = streaks[i];
      s.life -= s.decay;
      if (s.life <= 0) streaks.splice(i, 1);
    }
    if (shakeMag > 0.05) {
      shakeX = (Math.random() - 0.5) * shakeMag * 2;
      shakeY = (Math.random() - 0.5) * shakeMag * 2;
      shakeMag *= 0.86;
    } else { shakeMag = 0; shakeX = 0; shakeY = 0; }
  }

  function offset() { return { x: shakeX, y: shakeY }; }

  function draw(ctx) {
    // 形状型特效先画（它们贴地/贴面，粒子要压在它们上面）
    ctx.save();
    for (const s of streaks) {
      ctx.globalAlpha = Math.max(0, Math.min(1, s.life));
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1 + 5 * s.life;
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    }
    for (const r of rings) {
      ctx.globalAlpha = Math.max(0, Math.min(1, r.life * 0.9));
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, r.w * (0.35 + r.life));
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, r.r, r.r * 0.44, 0, 0, Math.PI * 2);   // 压扁 = 贴地
      ctx.stroke();
    }
    ctx.restore();
    for (const p of parts) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    for (const t of texts) {
      const a = Math.max(0, Math.min(1, t.life * 1.4));
      ctx.globalAlpha = a;
      ctx.font = 'bold ' + t.size + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(6,8,14,0.9)';
      ctx.strokeText(t.str, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.str, t.x, t.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  function clear() { parts.length = 0; texts.length = 0; rings.length = 0; streaks.length = 0; }

  /**
   * 把核心逻辑产生的事件翻译成画面。
   * @param {Array} events
   * @param {object} view  {sx, sy} 世界→屏幕的转换函数
   */
  function consume(events, view) {
    for (const ev of events) {
      switch (ev.kind) {
        /* ---- 魂技：四个技能各有自己的招牌形状 ----
           为什么每个都要不一样：如果四个技能都只放一圈粒子，
           玩家的记忆里就只有"放了技能"，而不是"放了裂地斩"。
           形状是最好记的语言 —— 地裂是贴着地面的环、水束是打出去的线、
           疾影是身后的残影、护盾是包住人的罩。 */
        case 'skill': {
          const px = view.cx(view.game.px), py = view.cy(view.game.py);
          const tint = ev.tint || '#9fe6f2';
          const targets = ev.targets || [];
          // 先把技能名喊出来。没有这行字，玩家看到的就是"好像闪了一下"
          popText(px, py - 34, ev.name, tint, 20, -0.8);
          if (ev.key === 'quake') {
            ring(px, py + 10, '#e0a860', 76, 30, 4);
            ring(px, py + 10, '#f0d060', 52, 22, 2);
            spawn(px, py + 12, 26, ['#c08a4a', '#8a6a3a', '#e0c080'],
              { speed: 3.0, grav: 0.12, lift: 1.0, size: 2.4 });
            shake(7);
          } else if (ev.key === 'torrent') {
            for (const t of targets) {
              streak(px, py, view.cx(t.x), view.cy(t.y), 'rgba(143,223,240,0.9)', 18);
              spawn(view.cx(t.x), view.cy(t.y) + 4, 14, ['#2b7ea0', '#8fdff0', '#ffffff'],
                { speed: 3.2, grav: 0.02, lift: 1.2, size: 2.6 });
            }
            if (!targets.length) ring(px, py + 10, '#2b7ea0', 60, 26, 3);
            shake(4);
          } else if (ev.key === 'blitz') {
            for (let i = 0; i < 5; i++) {
              streak(px - 26 + i * 5, py - 12 + i * 4, px + 26 - i * 5, py + 12 - i * 4,
                'rgba(126,224,214,0.5)', 12);
            }
            ring(px, py + 10, '#7ee0d6', 46, 18, 2);
            spawn(px, py + 8, 18, ['#7ee0d6', '#ffffff', '#8fdff0'],
              { speed: 3.4, grav: 0.0, lift: 0.2 });
            shake(2.5);
          } else if (ev.key === 'bulwark') {
            ring(px, py + 10, '#f0d060', 64, 34, 4);
            ring(px, py + 10, '#fff0b0', 40, 24, 2);
            spawn(px, py + 10, 24, ['#f0d060', '#ffffff', '#7ee08a'],
              { speed: 2.0, grav: -0.03, lift: 1.6, size: 2.4 });
            if (ev.heal) popText(px, py - 16, '+' + Math.round(ev.heal), '#7ee08a', 16, -1.3);
            shake(4);
          } else {
            ring(px, py + 10, tint, 56, 24, 3);
            spawn(px, py + 8, 16, [tint, '#ffffff'], { speed: 2.6 });
            shake(3);
          }
          break;
        }
        case 'stun':
          // 撞晕：头顶炸一下 + 一圈小环，配合渲染层那三颗转圈的星
          spawn(view.cx(ev.enemy.x), view.cy(ev.enemy.y) - 4, 12,
            ['#ffe08a', '#ffffff', '#f0d060'], { speed: 1.8, grav: -0.02, lift: 1.2, size: 2.2 });
          popText(view.cx(ev.enemy.x), view.cy(ev.enemy.y) - 20, '震晕', '#ffe08a', 14, -1.2);
          ring(view.cx(ev.enemy.x), view.cy(ev.enemy.y) + 8, '#f0d060', 30, 16, 2);
          shake(2.5);
          break;
        case 'knock':
          // 被掀开：落点扬尘，让"位移"这件事有重量
          spawn(view.cx(ev.enemy.x), view.cy(ev.enemy.y) + 10, 10,
            ['#c08a4a', '#8a6a3a', '#e0c080'], { speed: 1.8, grav: 0.10, lift: 0.5, size: 2.0 });
          break;
        case 'stunned':
          // 被震晕的敌人这一轮跳过：只吐一个很小的提示，不要抢戏
          popText(view.cx(ev.enemy.x), view.cy(ev.enemy.y) - 14, '…', '#8d99ac', 13, -0.8);
          break;
        case 'step':
          spawn(view.cx(ev.x), view.cy(ev.y) + 10, 4, ['#5c6478', '#7a84a0'], { speed: 1.1, grav: 0.06, size: 1.6 });
          break;
        case 'hit':
        case 'fight': {
          const r = ev.rounds || [];
          const e = ev.enemy;
          const ex = view.cx(e.x), ey = view.cy(e.y);
          const px = view.cx(view.game.px), py = view.cy(view.game.py);
          let idx = 0;
          for (const h of r) {
            if (h.dodge) { popText(ex, ey - 6, '闪避', '#9ecbff', 13, -1.4); continue; }
            const toEnemy = (h.from !== view.game.cls.name) || h.to === e.name;
            // 玩家打怪：数字出现在怪物头上；怪打玩家：出现在玩家头上
            const onEnemy = (h.to === e.name);
            const tx = onEnemy ? ex : px;
            const ty = onEnemy ? ey : py;
            const crit = h.crit;
            const col = h.type === 'm' ? (crit ? '#e8c0ff' : '#b98cff')
              : (crit ? '#ffd86a' : '#ffb060');
            popText(tx + (Math.random() * 14 - 7), ty - 8 - (idx % 3) * 10,
              (crit ? '' : '') + h.dmg, col, crit ? 20 : 15, crit ? -1.9 : -1.4);
            if (h.heal) popText(px, py - 26, '+' + h.heal, '#7ee08a', 13, -1.2);
            spawn(onEnemy ? ex : px, (onEnemy ? ey : py) + 4,
              crit ? 12 : 6,
              h.type === 'm' ? ['#b98cff', '#7ee0d6', '#ffffff'] : ['#ffb060', '#ffe08a', '#ffffff'],
              { speed: crit ? 3.4 : 2.2 });
            idx++;
          }
          if (crit_big(r)) shake(2.6);
          break;
        }
        case 'kill':
          spawn(view.cx(ev.enemy.x), view.cy(ev.enemy.y) + 6, 18,
            ['#e0525a', '#ffb060', '#f0d060', '#ffffff'], { speed: 3.2, size: 2.4 });
          shake(2.2);
          break;
        case 'loot':
          spawn(view.cx(view.game.px), view.cy(view.game.py) + 4, 14,
            [ev.item.color, '#ffffff', '#f0d060'], { speed: 2.4, grav: 0.02, lift: 1.2 });
          popText(view.cx(view.game.px), view.cy(view.game.py) - 22,
            ev.item.name, ev.item.color, 14, -1.6);
          break;
        case 'chest':
          spawn(view.cx(ev.x), view.cy(ev.y) + 4, 20,
            ['#f0d060', '#ffffff', '#c9a04a'], { speed: 2.8, grav: 0.03 });
          break;
        case 'heal':
          spawn(view.cx(view.game.px), view.cy(view.game.py) + 6, 16,
            ['#7ee08a', '#a8f0b8', '#ffffff'], { speed: 1.8, grav: -0.02, lift: 1.4 });
          break;
        case 'corrode':
          spawn(view.cx(view.game.px), view.cy(view.game.py) + 6, 10,
            ['#2b7ea0', '#8fdff0'], { speed: 1.6 });
          popText(view.cx(view.game.px), view.cy(view.game.py) - 18, '-' + ev.dmg, '#8fdff0', 14);
          break;
        case 'tide':
          if (ev.rising) {
            for (let i = 0; i < 40; i++) {
              spawn(Math.random() * view.w, view.h + 10, 1,
                ['#2b7ea0', '#8fdff0', '#1b4a68'], { speed: 0.4, grav: -0.5, lift: 0.2, size: 2.4 });
            }
          }
          break;
        case 'descend':
          spawn(view.w / 2, view.h / 2, 40, ['#7ee0d6', '#ffffff', '#2b7ea0'], { speed: 4 });
          shake(3);
          break;
        case 'levelup':
          spawn(view.cx(view.game.px), view.cy(view.game.py), 22, ['#f0d060', '#ffffff'], { speed: 2.6, lift: 1 });
          popText(view.cx(view.game.px), view.cy(view.game.py) - 30, '升级！', '#f0d060', 17, -1.5);
          break;
        case 'death':
          spawn(view.cx(view.game.px), view.cy(view.game.py), 40,
            ['#e0525a', '#8a2b30', '#ffffff'], { speed: 4, size: 3 });
          shake(6);
          break;
        case 'win':
          for (let i = 0; i < 90; i++) {
            spawn(Math.random() * view.w, view.h * (0.2 + Math.random() * 0.5), 1,
              ['#7ee0d6', '#f0d060', '#ffffff', '#8fdff0'], { speed: 2.4, grav: 0.02, lift: 1.6 });
          }
          break;
      }
    }
  }

  function crit_big(rounds) {
    for (const r of rounds) if (r.crit) return true;
    return false;
  }

  global.TideFX = {
    spawn: spawn, popText: popText, shake: shake,
    update: update, draw: draw, clear: clear, consume: consume, offset: offset,
    /* 给测试用的观测量：特效有没有真的产生，"有感觉"这件事不能靠肉眼说了算。
       粒子数 / 飘字数 / 当前震屏强度，三个都能量。 */
    counts: function () {
      return {
        parts: parts.length, texts: texts.length, shake: shakeMag,
        rings: rings.length, streaks: streaks.length
      };
    }
  };
})(window);
