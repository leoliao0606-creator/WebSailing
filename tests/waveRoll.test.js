// 浪致横摇回归:横浪明显摇船、顶浪远小于横浪、长时间数值有界。
// 用确定性 WaveField(固定风况,不注入随机),静漂船(帆效清零)隔离波浪响应。

import assert from 'node:assert/strict';
import test from 'node:test';

import { BoatPhysics } from '../src/sim/boatPhysics.js';
import { WaveField } from '../src/sim/waves.js';
import { WindField } from '../src/sim/wind.js';

const DEG = Math.PI / 180;

// 静漂:帆力清零(powerScale=0)、缭绳放空、稳向板放下、不压舷,采样 phi 振荡
function driftRollAmplitude({ windKn, headingDeg, seconds = 60 }) {
  const wind = new WindField();
  wind.setBase(0, windKn);
  if (typeof wind.gustiness === 'number') wind.gustiness = 0;
  const waves = new WaveField();
  waves.setConditions(0, windKn);
  const phys = new BoatPhysics();
  phys.psi = headingDeg * DEG;
  phys.powerScale = 0; // 无帆力,只留风阻/水动力/波浪
  phys.ctl.sheet = 1;
  phys.ctl.board = 1;
  phys.ctl.autoHike = false;
  phys.ctl.hike = 0;

  const dt = 1 / 60;
  let maxAbs = 0;
  let finite = true;
  for (let t = 0; t < seconds; t += dt) {
    waves.update(dt);
    phys.step(wind, dt, waves);
    phys.psi = headingDeg * DEG; // 锁定艏向,隔离横摇响应
    phys.yawRate = 0;
    if (!Number.isFinite(phys.phi) || !Number.isFinite(phys.u)) { finite = false; break; }
    if (t > 10) maxAbs = Math.max(maxAbs, Math.abs(phys.phi)); // 跳过初始瞬态
  }
  return { maxDeg: maxAbs / DEG, finite };
}

test('15kn 横浪静漂:横摇明显(>3°)且 60 秒内有界(<45°)', () => {
  // 风从北来,波浪向南传播;艏向东(90°)= 横浪
  const r = driftRollAmplitude({ windKn: 15, headingDeg: 90 });
  assert.ok(r.finite, '数值应有界');
  assert.ok(r.maxDeg > 3, `横浪摇幅应可感,实测 ${r.maxDeg.toFixed(1)}°`);
  assert.ok(r.maxDeg < 45, `横浪摇幅不应失控,实测 ${r.maxDeg.toFixed(1)}°`);
});

test('顶浪横摇小于横浪(波组围绕风向散布,顶浪仍有侧向分量)', () => {
  const beam = driftRollAmplitude({ windKn: 15, headingDeg: 90 });
  const head = driftRollAmplitude({ windKn: 15, headingDeg: 0 });
  assert.ok(head.finite && beam.finite);
  assert.ok(head.maxDeg < beam.maxDeg * 0.85,
    `顶浪 ${head.maxDeg.toFixed(1)}° 应小于横浪 ${beam.maxDeg.toFixed(1)}°`);
});

test('25kn 大浪横摇增强但仍有界', () => {
  const r = driftRollAmplitude({ windKn: 25, headingDeg: 90 });
  const mild = driftRollAmplitude({ windKn: 12, headingDeg: 90 });
  assert.ok(r.finite);
  assert.ok(r.maxDeg > mild.maxDeg, '大风浪应摇得更凶');
  assert.ok(r.maxDeg < 80, `不应仅因波浪翻船,实测 ${r.maxDeg.toFixed(1)}°`);
});
