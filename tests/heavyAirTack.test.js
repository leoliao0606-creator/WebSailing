// 大风抢风调向回归。玩家的真实操作路径是「按住 A/D」，走 Boat.applyControlIntent；
// tests/tackingSternway.test.js 用的是 helm.js 的 steerTowards，那是 AI 舵手，
// 它本来就会在倒航时反打舵，所以那条路径从来测不出玩家会遇到的卡死。
import assert from 'node:assert/strict';
import test from 'node:test';

import { BoatPhysics } from '../src/sim/boatPhysics.js';
import { WaveField } from '../src/sim/waves.js';
import { Boat } from '../src/game/boat.js';
import { autoSheet } from '../src/sim/helm.js';
import { DEG, KN, clamp, wrapPi } from '../src/util/math.js';

const SETTINGS = Object.freeze({ autoTrim: false, autoHike: true });
const northWind = (kn) => ({
  sample(x, z, out = {}) { out.vx = 0; out.vz = kn * KN; out.speed = kn * KN; out.fromPsi = 0; return out; },
});

// 只借 Boat 的控制映射，不构造它的 Three.js 视觉体（Node 里跑不了）。
function helmFor(phys) {
  const b = Object.create(Boat.prototype);
  b.phys = phys; b.rudderCmd = 0; b.hikeLevel = 0; b.manualSheetAt = -99;
  return b;
}
function hold(helm, dt, t, steerRight) {
  helm.applyControlIntent({
    steerRight, steerLeft: false, sheetIn: false, sheetOut: false,
    hikeOut: false, hikeIn: false, boardDown: false, boardUp: false, righting: false,
  }, SETTINGS, dt, t);
}
function autoTrim(b) {
  const over = Math.abs(b.out.heelDeg) - 24;
  autoSheet(b, over > 0 ? Math.max(4, 16 - over * 1.1) : 16);
}

// settle 用来错开起始浪相位：单次采样受相位影响极大，必须扫几个相位才有意义。
function playerTack(windKn, settleSec) {
  const b = new BoatPhysics();
  const waves = new WaveField(); waves.setConditions(0, windKn);
  const wind = northWind(windKn), dt = 1 / 60;
  b.psi = -45 * DEG; b.u = 1.5; b.ctl.autoHike = true;
  for (let i = 0; i < settleSec * 60; i++) {
    const err = wrapPi(-45 * DEG - b.psi);
    b.ctl.rudder = clamp(err * 3 - b.yawRate * 0.8, -1, 1);
    autoTrim(b); waves.update(dt); b.step(wind, dt, waves);
  }
  const helm = helmFor(b);
  for (let t = 0; t < 20; t += dt) {
    hold(helm, dt, t, wrapPi(b.psi - 45 * DEG) <= -3 * DEG);
    autoTrim(b); waves.update(dt); b.step(wind, dt, waves);
    if (Math.abs(wrapPi(b.psi - 45 * DEG)) < 5 * DEG) return t;
  }
  return null;
}

for (const windKn of [22, 28]) {
  test(`${windKn} 节有浪：玩家按住满舵能把船转过顶风区`, () => {
    const times = [];
    for (let i = 0; i < 4; i++) {
      const t = playerTack(windKn, 30 + i * 1.7);
      assert.ok(t !== null, `第 ${i + 1} 个浪相位下调向没完成（20 秒超时）`);
      times.push(t);
    }
    const worst = Math.max(...times);
    assert.ok(worst < 16, `最慢一次用了 ${worst.toFixed(1)} 秒，玩家会当成转不过去`);
  });
}

test('倒航时舵按水流方向反向：A/D 是转向意图，不是舵柄位置', () => {
  const phys = new BoatPhysics();
  const helm = helmFor(phys);
  // 先把舵指令推满（前进中）
  phys.u = 2;
  for (let i = 0; i < 60; i++) hold(helm, 1 / 60, i / 60, true);
  const ahead = phys.ctl.rudder;
  assert.ok(ahead > 0.9, `前进时满舵应接近 +1，实际 ${ahead}`);
  // 同样按住右舵，改成倒航：舵必须翻向，否则满舵会把船推回原来那一舷
  phys.u = -1;
  hold(helm, 1 / 60, 2, true);
  assert.ok(phys.ctl.rudder < -0.9, `倒航时舵应反向，实际 ${phys.ctl.rudder}`);
  // 速度过零附近平滑回中，不在阈值上高频翻转
  phys.u = 0;
  hold(helm, 1 / 60, 3, true);
  assert.equal(phys.ctl.rudder, 0);
  phys.u = 0.125;
  hold(helm, 1 / 60, 4, true);
  assert.ok(phys.ctl.rudder > 0.4 && phys.ctl.rudder < 0.6,
    `零速附近应线性过渡，实际 ${phys.ctl.rudder}`);
});
