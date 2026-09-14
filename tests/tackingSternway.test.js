// 大风下的操舵与起步行为回归。
//
// 守的是三件事：
//  1. steerTowards 知道倒航时舵效是反的。不知道的话，大风调向一掉速到倒航，
//     满舵就会把船推回原来那一舷，船永远卡在顶风点转不过去（25 节必现）。
//  2. 倒航的船体阻力用的是钝体形状阻力，不是正向航行那套流线型系数。否则
//     顶风停住的船会被区区 20 N 的风推到近 3 节的倒退速度。
//  3. 新建/重置的船，帆杠首帧就落到当前风况下的位置。缭绳放尽而帆杠还留在
//     中线是不自洽的状态，让它按 150°/s 慢慢摆出去的话，横风起步的头半秒
//     帆面几乎正对风，侧力足以把船直接掀翻。

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

// 从 -45° 抢风调向到 +45°，返回耗时与速度恢复情况。
// preSpeed：调向前先落下风加速到这个船速（真实船手在大风调向前的标准动作）
function tack(windKn, preSpeed = 0) {
  const wind = northWind(windKn);
  const b = new BoatPhysics();
  b.psi = -45 * DEG;
  b.u = 1.5;
  b.ctl.autoHike = true;
  const dt = 1 / 60;
  for (let i = 0; i < 40 * 60; i++) { steerTowards(b, -45 * DEG); trimAssist(b); b.step(wind, dt); }
  if (preSpeed) {
    for (let t = 0; t < 25 && b.out.speedKn < preSpeed; t += dt) {
      steerTowards(b, -62 * DEG); trimAssist(b, 17); b.step(wind, dt);
    }
  }
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

test('28 节调向也能完成', () => {
  const r = tack(28);
  assert.ok(r.tDone > 0 && r.tDone < 15,
    `实测 ${r.tDone < 0 ? '未完成' : r.tDone.toFixed(1) + 's'}`);
});

test('30 节直接调向会失败，但给够进入速度就能转过来', () => {
  // 守的是「倒航反打这套机制有效」，而不是「某个边缘风速下恰好能过」。
  // 30 节迎风段的帆已被压到几乎无动力，进入速度只有 4 节出头，冲不过顶风点
  // —— 这是真实的。真实船手在大风里会先落下风加速再调向。
  const direct = tack(30);
  const prepped = tack(30, 5.2);
  assert.ok(prepped.tDone > 0 && prepped.tDone < 15,
    `先加速到 ${prepped.v0.toFixed(2)}kn 后应能调向，实测 ${prepped.tDone < 0 ? '未完成' : prepped.tDone.toFixed(1) + 's'}`);
  assert.ok(prepped.v0 > direct.v0,
    `落下风加速应当真的提高了进入速度：${direct.v0.toFixed(2)} -> ${prepped.v0.toFixed(2)}kn`);
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

// —— 起步时的帆杠落位 ——

// 复现 Boat.place 的出生状态：缭绳放尽、稳向板放下、开自动压舷
function spawn(headingDeg) {
  const b = new BoatPhysics();
  b.psi = headingDeg * DEG;
  b.u = 1.5;
  b.v = 0;
  b.sheet = b.ctl.sheet = 1;
  b.board = b.ctl.board = 1;
  b.ctl.autoHike = true;
  return b;
}

test('帆杠首帧就落到下风侧，不是从中线慢慢摆出去', () => {
  const b = spawn(90); // 正横风，风从北
  assert.equal(b.boom, 0, '出生瞬间帆杠还在中线');
  b.step(northWind(20), 1 / 60);
  // 一帧只有 1/60 秒，按 150°/s 的摆动速率最多走 2.5°；能到下风侧说明是瞬间落位的
  assert.ok(Math.abs(b.out.boomDeg) > 30,
    `首帧后帆杠应已在下风侧，实测 ${b.out.boomDeg.toFixed(1)}°`);
});

test('大风横风出生不会自己翻船', () => {
  // 修复前：25 节出生横倾冲到 51°，30 节 1.2 秒内直接翻 —— 玩家什么都没做
  for (const kn of [25, 30, 33]) {
    const b = spawn(90);
    const dt = 1 / 60;
    let maxHeel = 0;
    for (let t = 0; t < 12; t += dt) {
      trimAssist(b, 16);
      b.step(northWind(kn), dt);
      maxHeel = Math.max(maxHeel, Math.abs(b.out.heelDeg));
    }
    assert.ok(!b.capsized, `${kn} 节出生后放手不管不该翻船`);
    assert.ok(maxHeel < 45, `${kn} 节出生最大横倾 ${maxHeel.toFixed(0)}° 过大`);
  }
});

test('横倾随风速平滑增长，不出现悬崖', () => {
  // 帆杠从中线摆出的瞬态会制造一个临界点：28 节还稳在 36°，30 节直接翻过去
  const heelAt = (kn) => {
    const b = spawn(90);
    const dt = 1 / 60;
    let maxHeel = 0;
    for (let t = 0; t < 12; t += dt) {
      trimAssist(b, 16);
      b.step(northWind(kn), dt);
      maxHeel = Math.max(maxHeel, Math.abs(b.out.heelDeg));
    }
    return b.capsized ? 999 : maxHeel;
  };
  const series = [18, 22, 25, 28, 30, 33].map(heelAt);
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i] < 45, `第 ${i} 档横倾 ${series[i].toFixed(0)}° 失控`);
    assert.ok(series[i] - series[i - 1] < 12,
      `相邻风速档的横倾跳变过大：${series[i - 1].toFixed(0)}° -> ${series[i].toFixed(0)}°`);
  }
});
