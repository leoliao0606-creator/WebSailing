// 新增操纵/环境物理回归:
//  - 倒航反舵(死区脱困):前进与倒航同一舵输入,艏摇方向相反
//  - 正顺风上风侧微倾:自动压舷把船摆向上风(帆的反侧)
//  - 横倾诱导艏摇:右倾→左转、左倾→右转(有速度)
//  - 环境水流:无动力船漂向水流速度、艏向沿岸时被横流带偏

import assert from 'node:assert/strict';
import test from 'node:test';

import { BoatPhysics } from '../src/sim/boatPhysics.js';
import { steerTowards, autoSheet } from '../src/sim/helm.js';

const DEG = Math.PI / 180;
const KN = 0.514444;
const dt = 1 / 120;
const calmWind = { sample: (x, z, o = {}) => { o.vx = 0; o.vz = 0; o.speed = 0; o.fromPsi = 0; return o; } };
const northWind = (kn) => ({ sample: (x, z, o = {}) => { o.vx = 0; o.vz = kn * KN; o.speed = kn * KN; o.fromPsi = 0; return o; } });

// 舵单独:清零帆力/风阻,锁定给定纵向速度,施加右舵,返回净艏摇角(°)
function rudderYaw(u, seconds = 1) {
  const b = new BoatPhysics();
  b.p.windageArea = 0; b.powerScale = 0;
  b.psi = 0; b.v = 0; b.yawRate = 0; b.phi = 0; b.phiRate = 0;
  b.ctl.autoHike = false; b.ctl.hike = 0; b.ctl.sheet = 0; b.ctl.board = 1; b.ctl.rudder = 0.7;
  const psi0 = b.psi;
  for (let t = 0; t < seconds; t += dt) { b.u = u; b.step(calmWind, dt); }
  return (b.psi - psi0) / DEG;
}

test('倒航反舵:前进右转、倒航同舵反向左转(死区脱困要领)', () => {
  const fwd = rudderYaw(2);
  const astern = rudderYaw(-1.2);
  assert.ok(fwd > 3, `前进 +舵应右转,实测 Δψ=${fwd.toFixed(1)}°`);
  assert.ok(astern < -1, `倒航 +舵应反向(左转),实测 Δψ=${astern.toFixed(1)}°`);
});

test('倒航反舵随倒航速度增强', () => {
  const slow = rudderYaw(-0.6);
  const fast = rudderYaw(-1.6);
  assert.ok(fast < slow, `倒得越快反舵越强:慢 ${slow.toFixed(1)}° vs 快 ${fast.toFixed(1)}°`);
});

test('横倾诱导艏摇:右倾→左转力矩、左倾→右转(镜像对称)', () => {
  const heelYaw = (heelDeg) => {
    const b = new BoatPhysics();
    b.psi = 0; b.u = 4; b.ctl.autoHike = false; b.ctl.hike = 0; b.ctl.sheet = 1; b.ctl.rudder = 0;
    const psi0 = b.psi;
    for (let t = 0; t < 2; t += dt) { b.phi = heelDeg * DEG; b.phiRate = 0; b.u = Math.max(b.u, 3); b.step(calmWind, dt); }
    return (b.psi - psi0) / DEG;
  };
  const right = heelYaw(15), left = heelYaw(-15), hard = heelYaw(30);
  assert.ok(right < -0.5, `右倾应有左转力矩,实测 Δψ=${right.toFixed(2)}°`);
  assert.ok(left > 0.5, `左倾应有右转力矩,实测 Δψ=${left.toFixed(2)}°`);
  assert.ok(Math.abs(right + left) < 0.2, '左右倾应镜像对称');
  assert.ok(Math.abs(hard) > Math.abs(right), '倾角越大力矩越强');
});

test('正顺风上风侧微倾:自动压舷把船摆向帆的反侧(上风),横风时保持近水平', () => {
  const heelOnHeading = (twaDeg) => {
    const b = new BoatPhysics();
    b.psi = -twaDeg * DEG; b.u = 3; b.ctl.autoHike = true;
    for (let t = 0; t < 60; t += dt) { steerTowards(b, -twaDeg * DEG); autoSheet(b, twaDeg < 100 ? 16 : 15); b.step(northWind(12), dt); }
    return b;
  };
  const beam = heelOnHeading(90);
  assert.ok(Math.abs(beam.out.heelDeg) < 4, `横风应近水平,实测 ${beam.out.heelDeg.toFixed(1)}°`);
  const run = heelOnHeading(176);
  const windwardSign = -(Math.sign(run.boom) || 1); // 上风倾的 phi 符号(帆反侧)
  assert.ok(Math.abs(run.out.heelDeg) > 4, `正顺风应有可感横倾,实测 ${run.out.heelDeg.toFixed(1)}°`);
  assert.ok(Math.sign(run.phi) === windwardSign,
    `正顺风应向上风侧(帆反侧)倾:phi=${run.out.heelDeg.toFixed(1)}° boom=${run.out.boomDeg.toFixed(0)}°`);
});

test('环境水流:无动力船稳态漂速趋近水流速度', () => {
  const b = new BoatPhysics();
  b.powerScale = 0; b.p.windageArea = 0; b.ctl.autoHike = false; b.ctl.hike = 0; b.ctl.sheet = 1;
  b.current = { vx: 0.4, vz: 0 };
  for (let t = 0; t < 120; t += dt) b.step(calmWind, dt, null);
  const vwx = b.u * Math.sin(b.psi) + b.v * Math.cos(b.psi);
  const vwz = -b.u * Math.cos(b.psi) + b.v * Math.sin(b.psi);
  assert.ok(Math.abs(vwx - 0.4) < 0.05, `应漂向水流速度 +x,实测 vx=${vwx.toFixed(3)}`);
  assert.ok(Math.abs(vwz) < 0.05, `不应有横向漂移,实测 vz=${vwz.toFixed(3)}`);
  assert.ok(b.x > 30, `应随水流漂到下游,实测 x=${b.x.toFixed(0)}`);
});

test('静水(默认)不影响物理:current 为零时行为与不设一致', () => {
  const runOnce = () => {
    const b = new BoatPhysics();
    b.psi = -45 * DEG; b.u = 2; b.ctl.autoHike = true;
    for (let t = 0; t < 20; t += dt) { steerTowards(b, -45 * DEG); autoSheet(b, 17); b.step(northWind(12), dt); }
    return b.speed;
  };
  const a = runOnce();
  const c = runOnce();
  assert.ok(Math.abs(a - c) < 1e-9, '默认静水应完全确定、可复现');
  assert.ok(a > 1, '应正常起速');
});
