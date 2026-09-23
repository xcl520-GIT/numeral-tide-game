# -*- coding: utf-8 -*-
"""数值潮汐 · 平衡性模拟器 / 参数调优台

与 index.html 共用同一套规则与随机数算法（mulberry32）。

设计迭代记录（这份记录本身就是项目的一部分）
------------------------------------------------
v1  敌人每回合 +1，玩家吃敌人得 E
    ✗ 失败：玩家吃不到东西时数值停滞，敌人却继续涨，形成**活锁**。
            通关率 1%，跑满回合上限（4000），平均只吃到 1.5 个。

v2  敌人不随时间变强，压力交给"新敌人涌入淹没棋盘"
    ✗ 失败：通关率 100%、"撞死"0 次。静态敌人可以被完全规划绕过，
            玩家只要扫地就行，没有任何风险决策。

v3  引入"礁石"（吃不下、只占格的障碍），先把压力从时间换成空间
    △ 部分成功：通关率首次降到 68%，死因分裂成"淹没 / 困死"两类。
              但礁石按玩家数值比例生成，永远追不上，空间只减不增。

v4  礁石改用**绝对数值**（wall_base + 回合 x wall_scale）
    → 前期它是一堵墙，后期你成长起来就能砸开它。
      形成「被压迫 → 突破 → 反打」的成长曲线，而不是单向挤压。

用法：
    py -3 tools/sim.py              基准 2000 局
    py -3 tools/sim.py 5000 sweep   一维敏感度扫描
    py -3 tools/sim.py 800 tune     参数网格搜索
"""

import itertools
import math
import sys
from statistics import mean

MASK = 0xFFFFFFFF


# ---------------------------------------------------------------- 随机数
def mulberry32(seed):
    """与 JS 版逐位等价的实现：用 & MASK 模拟 Math.imul 的 32 位截断。"""
    a = seed & MASK

    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) & MASK
        t = a
        t = ((t ^ (t >> 15)) * (1 | t)) & MASK
        t0 = t
        t = ((t0 ^ (t0 >> 7)) * (61 | t0)) & MASK
        t = ((t0 + t) & MASK) ^ t0
        return ((t ^ (t >> 14)) & MASK) / 4294967296.0

    return nxt


# ---------------------------------------------------------------- 参数
DEFAULTS = dict(
    W=9,
    H=9,
    player_start=1,
    initial_enemies=6,      # 开局敌人数
    initial_enemy_max=2,    # 开局敌人最大数值

    spawn_every=3,          # 每 N 回合涌入一个普通敌人
    spawn_lo=0.30,          # 普通敌人数值 = 玩家数值 x [lo, hi]
    spawn_hi=1.10,

    wall_every=1,           # 每 N 回合沉积一块礁石
    wall_base=6,            # 礁石数值 = wall_base + 回合数 x wall_scale
    wall_scale=1.0,         # 定稿值：通关 85.8% / 回合 96.7 / 死因最分散（淹没38 困死47）

    goal=25,                # 吞噬够这么多普通敌人 => 通关
)

DIRS = ((1, 0), (-1, 0), (0, 1), (0, -1))


# ---------------------------------------------------------------- 核心逻辑
class Game:
    def __init__(self, seed, cfg=None):
        self.cfg = dict(DEFAULTS)
        if cfg:
            self.cfg.update(cfg)
        self.seed = seed & MASK
        self.rng = mulberry32(self.seed)
        self.reset()

    @property
    def capacity(self):
        return self.cfg["W"] * self.cfg["H"] - 1

    def reset(self):
        c = self.cfg
        self.turn = 0
        self.status = "playing"      # playing | dead | win
        self.reason = ""             # eaten | drowned | trapped | timeout
        self.value = c["player_start"]
        self.kills = 0
        self.enemies = []
        self.px = (c["W"] - 1) // 2
        self.py = (c["H"] - 1) // 2

        occ = {(self.px, self.py)}
        vals = [1]
        for _ in range(1, c["initial_enemies"]):
            vals.append(self._int(1, c["initial_enemy_max"]))
        for v in vals:
            s = self._random_empty(occ)
            if s is None:
                break
            occ.add(s)
            self.enemies.append({"x": s[0], "y": s[1], "v": v, "wall": False})

    def _int(self, lo, hi):
        return lo + int(self.rng() * (hi - lo + 1))

    def _random_empty(self, occ):
        c = self.cfg
        for _ in range(200):
            x = self._int(0, c["W"] - 1)
            y = self._int(0, c["H"] - 1)
            if (x, y) not in occ:
                return (x, y)
        for y in range(c["H"]):
            for x in range(c["W"]):
                if (x, y) not in occ:
                    return (x, y)
        return None

    def enemy_at(self, x, y):
        for e in self.enemies:
            if e["x"] == x and e["y"] == y:
                return e
        return None

    def in_bounds(self, x, y):
        c = self.cfg
        return 0 <= x < c["W"] and 0 <= y < c["H"]

    def can_move(self, dx, dy):
        return self.status == "playing" and self.in_bounds(self.px + dx, self.py + dy)

    def move(self, dx, dy):
        if not self.can_move(dx, dy):
            return None
        nx, ny = self.px + dx, self.py + dy
        target = self.enemy_at(nx, ny)
        self.px, self.py = nx, ny

        if target is not None and self.value < target["v"]:
            self.turn += 1
            self.status = "dead"
            self.reason = "eaten"
            return {"died": True}

        if target is not None:
            self.value += target["v"]
            if not target["wall"]:
                self.kills += 1
            self.enemies = [e for e in self.enemies if e is not target]

        self.turn += 1
        self._world_tick()
        self._check_end()
        return {"died": False}

    def _place(self, v, is_wall):
        if len(self.enemies) >= self.capacity:
            return False
        occ = {(e["x"], e["y"]) for e in self.enemies}
        occ.add((self.px, self.py))
        s = self._random_empty(occ)
        if s is None:
            return False
        self.enemies.append({"x": s[0], "y": s[1], "v": v, "wall": is_wall})
        return True

    def _spawn_common(self):
        c = self.cfg
        lo = max(1, math.floor(self.value * c["spawn_lo"]))
        hi = max(lo, math.ceil(self.value * c["spawn_hi"]))
        return self._place(self._int(lo, hi), False)

    def _spawn_wall(self):
        c = self.cfg
        v = int(c["wall_base"] + self.turn * c["wall_scale"])
        return self._place(max(2, v), True)

    def _world_tick(self):
        c = self.cfg
        if c["spawn_every"] and self.turn % c["spawn_every"] == 0:
            self._spawn_common()
        if c["wall_every"] and self.turn % c["wall_every"] == 0:
            self._spawn_wall()

    def _check_end(self):
        c = self.cfg
        if self.status != "playing":
            return
        if self.kills >= c["goal"]:
            self.status = "win"
            return
        if len(self.enemies) >= self.capacity:
            self.status = "dead"
            self.reason = "drowned"
            return
        for dx, dy in DIRS:
            if not self.in_bounds(self.px + dx, self.py + dy):
                continue
            e = self.enemy_at(self.px + dx, self.py + dy)
            if e is None or self.value >= e["v"]:
                return
        self.status = "dead"
        self.reason = "trapped"


# ---------------------------------------------------------------- 策略
def greedy_move(g):
    """贪心：① 相邻可吃里挑最大的；② 否则朝最近的可吃目标走；③ 再不行朝最近敌人靠。"""
    moves = []
    for dx, dy in DIRS:
        if not g.can_move(dx, dy):
            continue
        moves.append((dx, dy, g.enemy_at(g.px + dx, g.py + dy)))
    if not moves:
        return None

    eatable = [m for m in moves if m[2] is not None and g.value >= m[2]["v"]]
    if eatable:
        eatable.sort(key=lambda m: -m[2]["v"])
        return eatable[0]

    def step_toward(pred):
        pick, pick_d = None, float("inf")
        for m in moves:
            dx, dy, e = m
            if e is not None and g.value < e["v"]:
                continue
            nx, ny = g.px + dx, g.py + dy
            for t in g.enemies:
                if not pred(t):
                    continue
                d = abs(nx - t["x"]) + abs(ny - t["y"])
                if d < pick_d:
                    pick_d, pick = d, m
        return pick

    pick = step_toward(lambda t: g.value >= t["v"])
    if pick is not None:
        return pick
    pick = step_toward(lambda t: True)
    if pick is not None:
        return pick
    safe = [m for m in moves if m[2] is None]
    return safe[0] if safe else None


def auto_play(seed, cfg=None, max_turns=2000):
    g = Game(seed, cfg)
    guard = 0
    while g.status == "playing" and guard < max_turns:
        guard += 1
        m = greedy_move(g)
        if m is None:
            break
        g.move(m[0], m[1])
    if g.status == "playing":
        g.status = "dead"
        g.reason = "timeout"
    return g


# ---------------------------------------------------------------- 统计
def simulate(n, cfg=None, seed0=1):
    wins = 0
    turns, kills = [], []
    reasons = {"eaten": 0, "drowned": 0, "trapped": 0, "timeout": 0}
    for i in range(n):
        g = auto_play(seed0 + i, cfg)
        if g.status == "win":
            wins += 1
        else:
            reasons[g.reason] = reasons.get(g.reason, 0) + 1
        turns.append(g.turn)
        kills.append(g.kills)
    return dict(n=n, win_rate=wins / n, avg_turn=mean(turns),
                avg_kills=mean(kills), reasons=reasons)


def show(r, label="", width=38):
    tag = label.ljust(width)
    rs = r["reasons"]
    print(f"  {tag} 通关 {r['win_rate'] * 100:5.1f}%  回合 {r['avg_turn']:6.1f}  吞噬 {r['avg_kills']:5.2f}  "
          f"死因[撞死{rs['eaten']:>3} 淹没{rs['drowned']:>3} 困死{rs['trapped']:>3} 超时{rs['timeout']:>3}]")


def main():
    args = sys.argv[1:]
    nums = [a for a in args if a.isdigit()]
    n = int(nums[0]) if nums else 2000
    mode = args[-1] if args and not args[-1].isdigit() else "base"

    print()
    print("数值潮汐 · 平衡性模拟 (greedy policy)")
    print("=" * 122)
    print("  设计目标：通关率 45%~70%，平均回合 60~140，死因分散")
    print("-" * 122)

    if mode == "sweep":
        show(simulate(n), "baseline v4")
        print("-" * 122)
        print("  礁石沉积间隔 wall_every（0 = 关闭礁石）")
        for v in (0, 1, 2, 3, 5):
            show(simulate(n, {"wall_every": v}), f"wall_every={v}")
        print("-" * 122)
        print("  礁石绝对强度 wall_base（另有 + 回合 x 0.5）")
        for v in (2, 4, 6, 10, 16):
            show(simulate(n, {"wall_base": v}), f"wall_base={v}")
        print("-" * 122)
        print("  礁石成长速度 wall_scale")
        for v in (0.0, 0.3, 0.5, 1.0, 2.0):
            show(simulate(n, {"wall_scale": v}), f"wall_scale={v}")
        print("-" * 122)
        print("  普通敌人区间 spawn_lo ~ spawn_hi")
        for lo, hi in ((0.3, 1.0), (0.3, 1.1), (0.45, 1.1), (0.6, 1.3)):
            show(simulate(n, {"spawn_lo": lo, "spawn_hi": hi}), f"spawn=[{lo},{hi}]")
        print("-" * 122)
        print("  通关目标 goal")
        for v in (15, 20, 25, 30, 40):
            show(simulate(n, {"goal": v}), f"goal={v}")
        print("-" * 122)
        print("  棋盘尺寸")
        for v in (7, 8, 9, 11):
            show(simulate(n, {"W": v, "H": v}), f"board={v}x{v}")

    elif mode == "tune":
        results = []
        for se, wb, ws in itertools.product([2, 3], [3, 4, 6], [0.3, 0.6, 1.0]):
            cfg = dict(spawn_every=se, wall_base=wb, wall_scale=ws)
            r = simulate(n, cfg)
            results.append((cfg, r))
            show(r, f"spawn={se} base={wb} scale={ws}")
        print("-" * 122)
        good = [x for x in results if 0.40 <= x[1]["win_rate"] <= 0.70 and 55 <= x[1]["avg_turn"] <= 150]
        print(f"  达标组合 {len(good)} / {len(results)}")
        for cfg, r in sorted(good, key=lambda x: abs(x[1]["win_rate"] - 0.55))[:8]:
            show(r, f"  ★ spawn={cfg['spawn_every']} base={cfg['wall_base']} scale={cfg['wall_scale']}", 44)
        if not good:
            best = min(results, key=lambda x: abs(x[1]["win_rate"] - 0.55))
            print("  无达标组合，最接近：")
            show(best[1], f"  spawn={best[0]['spawn_every']} base={best[0]['wall_base']} "
                          f"scale={best[0]['wall_scale']}", 44)

    else:
        show(simulate(n), "baseline v4")

    print("=" * 122)
    print()


if __name__ == "__main__":
    main()
