// 大风抢风调向与倒航舵效的回归。
//
// 守的是两件事：
//  1. steerTowards 知道倒航时舵效是反的。不知道的话，大风调向一掉速到倒航，
//     满舵就会把船推回原来那一舷，船永远卡在顶风点转不过去（25 节必现）。
//  2. 倒航的船体阻力用的是钝体形状阻力，不是正向航行那套流线型系数。否则
//     顶风停住的船会被区区 20 N 的风推到近 3 节的倒退速度。

import assert from 'node:assert/strict';
import test from 'node:test';

import { BoatPhysics } from '../src/sim/boatPhysics.js';
import { steerTowards, autoSheet } from '../src/sim/helm.js';
import { DEG, KN, wrapPi } from '../src/util/math.js';

// 恒定风从北（fromPsi=0），无阵风无摆动：把导航行为从风的随机性里隔离出来
function northWind(kn) {
  return {
    sample(x, z, out = {}) {
      out.vx = 0;
      out.vz = kn * KN;
      out.speed = kn * KN;
      out.fromPsi = 0;
      return out;
    },
  };
}

// 与游戏内 autoTrim 一致：横倾过载就松帆，大风下才能持续航行
function trimAssist(b, alpha = 18) {
  const over = Math.abs(b.out.heelDeg) - 24;
  autoSheet(b, over > 0 ? Math.max(4, alpha - over * 1.1) : alpha);
}

// 从 -45° 抢风调向到 +45°，返回耗时与速度恢复情况
function tack(windKn) {
  const wind = northWind(windKn);
  const b = new BoatPhysics();
  b.psi = -45 * DEG;
  b.u = 1.5;
  b.ctl.autoHike = true;
  const dt = 1 / 60;
  for (let i = 0; i < 40 * 60; i++) { steerTowards(b, -45 * DEG); trimAssist(b); b.step(wind, dt); }
  const v0 = b.out.speedKn;
  let tDone = -1, minV = v0;
  for (let t = 0; t < 20; t += dt) {
    steerTowards(b, 45 * DEG);
    trimAssist(b);
    b.step(wind, dt);
    minV = Math.min(minV, b.out.speedKn);
    if (tDone < 0 && Math.abs(wrapPi(b.psi - 45 * DEG)) < 5 * DEG) tDone = t;
  }
  for (let i = 0; i < 25 * 60; i++) { steerTowards(b, 45 * DEG); trimAssist(b); b.step(wind, dt); }
  return { tDone, v0, minV, recovered: b.out.speedKn };
}

test('25 节大风能完成抢风调向', () => {
  // 修复前：船转到顶风点掉速到倒航，满舵被反向的舵效推回原舷，反复来回转不过去
  const r = tack(25);
  assert.ok(r.tDone > 0 && r.tDone < 15,
    `调向应在 15 秒内完成，实测 ${r.tDone < 0 ? '未完成' : r.tDone.toFixed(1) + 's'}`);
  assert.ok(r.recovered > r.v0 * 0.9,
    `调向后应恢复速度，实测 ${r.recovered.toFixed(2)} vs 进入 ${r.v0.toFixed(2)}kn`);
});

test('30 节调向也能完成（倒航反打是脱困的关键）', () => {
  const r = tack(30);
  assert.ok(r.tDone > 0 && r.tDone < 15,
    `实测 ${r.tDone < 0 ? '未完成' : r.tDone.toFixed(1) + 's'}`);
});

test('中低风调向不受影响：仍有真实掉速、耗时相当', () => {
  const r = tack(12);
  assert.ok(r.tDone > 0 && r.tDone < 15, `实测 ${r.tDone.toFixed(1)}s`);
  assert.ok(r.minV < r.v0 * 0.85, `调向要有真实掉速，实测谷值 ${(r.minV / r.v0 * 100).toFixed(0)}%`);
  assert.ok(r.minV > r.v0 * 0.2, `中低风不该掉到近乎停住，实测 ${(r.minV / r.v0 * 100).toFixed(0)}%`);
});

test('steerTowards 在倒航时反打，前进时不变', () => {
  const b = new BoatPhysics();
  b.psi = 0;
  // 目标在右舷 60°，前进中：应给出右转（正）舵令
  b.u = 3;
  steerTowards(b, 60 * DEG);
  const ahead = b.ctl.rudder;
  assert.ok(ahead > 0.5, `前进时应打右舵，实测 ${ahead.toFixed(2)}`);
  // 同样的目标，倒航中：舵效整个反向，舵令应当跟着反号
  b.u = -3;
  steerTowards(b, 60 * DEG);
  assert.ok(b.ctl.rudder < -0.5, `倒航时应反打，实测 ${b.ctl.rudder.toFixed(2)}`);
  assert.ok(Math.abs(b.ctl.rudder + ahead) < 1e-9, '大小应相同、方向相反');
});

test('速度过零附近舵令平滑回中，不会高频翻转', () => {
  const b = new BoatPhysics();
  b.psi = 0;
  const at = (u) => { b.u = u; b.yawRate = 0; steerTowards(b, 60 * DEG); return b.ctl.rudder; };
  // 硬用 out.sternway 切换的话，u 在零附近反复跨阈值会让舵令在 ±1 之间跳
  assert.ok(Math.abs(at(0)) < 1e-9, 'u=0 时舵回中（那里舵本来就没效力）');
  const seq = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map(at);
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] >= seq[i - 1], '舵令应随 u 单调变化，不出现跳变');
    assert.ok(Math.abs(seq[i] - seq[i - 1]) < 0.5, `相邻步长过大：${seq[i - 1]} -> ${seq[i]}`);
  }
});

test('顶风放帆停住时倒退速度在真实范围（约 1 节）', () => {
  const wind = northWind(12);
  const b = new BoatPhysics();
  b.psi = 0;
  b.u = 0;
  b.ctl.autoHike = true;
  b.ctl.sheet = 1;
  b.ctl.rudder = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 60; i++) { b.psi = 0; b.yawRate = 0; b.step(wind, dt); }
  const kn = -b.u / KN;
  assert.ok(b.u < 0, '正顶风、帆放尽的船应当被风推着倒退（这正是 in irons）');
  assert.ok(kn > 0.5 && kn < 2.0,
    `倒退速度应在 0.5~2 节，实测 ${kn.toFixed(2)}kn。偏快通常意味着倒航阻力又退回了正向那套流线型系数`);
});

test('倒航阻力显著大于同速前进（钝体 vs 流线型）', () => {
  const wind = northWind(0.001); // 几乎无风：只看水动力
  const decel = (u0) => {
    const b = new BoatPhysics();
    b.psi = 0;
    b.u = u0;
    b.powerScale = 0;
    b.p.windageArea = 0;
    b.ctl.rudder = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) { b.psi = 0; b.yawRate = 0; b.step(wind, dt); }
    return Math.abs(b.u - u0); // 1 秒内的速度损失
  };
  const fwd = decel(1.5);
  const aft = decel(-1.5);
  assert.ok(aft > fwd * 2.5,
    `同速倒航的减速应远快于前进，实测 后退 ${aft.toFixed(3)} vs 前进 ${fwd.toFixed(3)} m/s`);
});
