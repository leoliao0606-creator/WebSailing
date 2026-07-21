// AI 迎风走廊回归:长迎风腿应沿中线短抢风到达上风标,而非一路冲到远处 layline“跑飞”。
// 复现真实赛道尺度(上风标 380m 正上风),用恒定风隔离导航策略。

import assert from 'node:assert/strict';
import test from 'node:test';

import { BoatPhysics } from '../src/sim/boatPhysics.js';
import { AIHelm } from '../src/game/ai.js';

const DEG = Math.PI / 180;
const KN = 0.514444;
// 恒定风从北(fromPsi=0):上风 = -z
const wind = { sample: (x, z, o = {}) => { o.vx = 0; o.vz = 12 * KN; o.speed = 12 * KN; o.fromPsi = 0; return o; } };

function beatToMark(mark, { seconds = 900, seed = 'beat:1' } = {}) {
  const phys = new BoatPhysics();
  phys.psi = -45 * DEG; phys.u = 1.5; phys.ctl.autoHike = true;
  const boat = { phys, shadowF: 1, penaltyTurns: 0 };
  const helm = new AIHelm(boat, 0.86, seed);
  const dt = 1 / 60;
  let maxLateral = 0, reached = false, reachT = -1;
  for (let t = 0; t < seconds; t += dt) {
    helm.update(wind, mark, t, dt);
    phys.step(wind, dt);
    maxLateral = Math.max(maxLateral, Math.abs(phys.x - mark.x)); // 迎风轴(x=mark.x)横向偏离
    if (!reached && Math.hypot(phys.x - mark.x, phys.z - mark.z) < 16) { reached = true; reachT = t; }
    if (reached) break;
  }
  const finite = Number.isFinite(phys.x + phys.z + phys.u + phys.psi);
  return { maxLateral, reached, reachT, finite, x: phys.x, z: phys.z };
}

test('AI 迎风:短抢风到达 380m 上风标,横向不跑飞', () => {
  const r = beatToMark({ x: 0, z: -380 });
  assert.ok(r.finite, '数值应有界');
  assert.ok(r.reached, `应绕到上风标,终点(${r.x.toFixed(0)},${r.z.toFixed(0)})`);
  // layline 在 ~190m 外;走廊短抢风应把横向偏离压到远小于此
  assert.ok(r.maxLateral < 120, `横向偏离应受走廊约束,实测 ${r.maxLateral.toFixed(0)}m`);
});

test('AI 迎风:偏置起点也能收敛回中线并到标', () => {
  const phys = new BoatPhysics();
  phys.x = 90; phys.z = 20; phys.psi = 30 * DEG; phys.u = 2; phys.ctl.autoHike = true;
  const boat = { phys, shadowF: 1, penaltyTurns: 0 };
  const helm = new AIHelm(boat, 0.9, 'beat:2');
  const mark = { x: 0, z: -300 };
  const dt = 1 / 60;
  let reached = false, maxLateral = 0;
  for (let t = 0; t < 900; t += dt) {
    helm.update(wind, mark, t, dt);
    phys.step(wind, dt);
    if (t > 60) maxLateral = Math.max(maxLateral, Math.abs(phys.x)); // 越过起点瞬态后不应再冲远
    if (Math.hypot(phys.x - mark.x, phys.z - mark.z) < 16) { reached = true; break; }
  }
  assert.ok(reached, '偏置起点也应到标');
  assert.ok(maxLateral < 130, `收敛后横向应受控,实测 ${maxLateral.toFixed(0)}m`);
});

test('AI 无目标:顶风放帆停住,不横漂到天边', () => {
  const phys = new BoatPhysics();
  phys.psi = 90 * DEG; phys.u = 4; phys.ctl.autoHike = true;
  const boat = { phys, shadowF: 1, penaltyTurns: 0 };
  const helm = new AIHelm(boat, 0.9, 'idle:1');
  const dt = 1 / 60;
  for (let t = 0; t < 120; t += dt) { helm.update(wind, null, t, dt); phys.step(wind, dt); }
  assert.ok(phys.speed < 1.2, `无目标应基本停住,实测 ${(phys.speed / KN).toFixed(2)}kn`);
  assert.ok(Math.hypot(phys.x, phys.z) < 260, `不应漂离太远,实测 ${Math.hypot(phys.x, phys.z).toFixed(0)}m`);
});
