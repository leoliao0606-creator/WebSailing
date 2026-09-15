import assert from 'node:assert/strict';
import test from 'node:test';
import { BoatPhysics } from '../src/sim/boatPhysics.js';
import { autoSheet, steerTowards } from '../src/sim/helm.js';
import { DEG, KN } from '../src/util/math.js';

const dt = 1 / 120;
const northWind = kn => ({ sample: () => ({ vx: 0, vz: kn * KN, speed: kn * KN, fromPsi: 0 }) });

for (const kn of [8, 12]) for (const side of [-1, 1]) {
  test(`${kn} 节正常航速换舷：保持原缭绳，手动连续打舵能带着前进速度越过顶风区（${side}）`, () => {
    const b = new BoatPhysics(), wind = northWind(kn);
    b.psi = -side * 50 * DEG;
    b.u = 2;
    for (let i = 0; i < 50 / dt; i++) {
      steerTowards(b, -side * 50 * DEG); autoSheet(b); b.step(wind, dt);
    }
    const entry = b.u, sheet = b.sheet;
    let done = null, minimum = entry;
    for (let i = 0; i < 10 / dt; i++) {
      b.ctl.rudder = side; b.ctl.sheet = sheet;
      b.step(wind, dt);
      minimum = Math.min(minimum, b.u);
      if (side * b.psi >= 40 * DEG) { done = (i + 1) * dt; break; }
    }
    assert.ok(done !== null, `进入 ${entry.toFixed(2)} m/s 后仍卡在 ${(b.psi / DEG).toFixed(1)}°`);
    assert.ok(minimum > 0.4, `换舷不能依赖停船倒漂，最低速度 ${minimum.toFixed(2)} m/s`);
    assert.ok(minimum < entry * 0.8, '换舷仍应产生实际动能损失');
  });
}

test('帆偏左产生右转力矩，帆偏右产生左转力矩；无动力时不凭空转向', () => {
  const moments = [];
  for (const side of [-1, 1]) {
    const b = new BoatPhysics();
    b.psi = Math.PI; b.u = 2; b.boom = side * 80 * DEG;
    b.sheet = b.ctl.sheet = 1; b._boomSettled = true;
    b.step(northWind(12), dt);
    moments.push(b.out.sailYawNm);
    assert.ok(side * b.out.sailYawNm < -20, `顺风偏舷驱动力矩应朝帆的反侧，实际 ${b.out.sailYawNm}`);
  }
  assert.ok(Math.abs(moments[0] + moments[1]) < 0.1);
  const stopped = new BoatPhysics(); stopped.powerScale = 0; stopped.p.windageArea = 0;
  stopped.step(northWind(0), dt);
  assert.equal(stopped.yawRate, 0);
});

test('横倾力矩与帆力矩独立：左右倾镜像，静止无横倾转向', () => {
  for (const side of [-1, 1]) {
    const b = new BoatPhysics(); b.powerScale = 0; b.p.windageArea = 0;
    b.phi = side * 15 * DEG; b.u = 2; b.ctl.autoHike = false;
    b.step(northWind(0), dt);
    assert.equal(b.out.sailYawNm, 0);
    assert.ok(side * b.out.heelYawNm < -20);
  }
  const b = new BoatPhysics(); b.powerScale = 0; b.p.windageArea = 0; b.phi = 15 * DEG;
  b.step(northWind(0), dt);
  assert.ok(Math.abs(b.out.heelYawNm) === 0);
});

test('横倾也会把帆压力中心移向低舷，顺风驱动力产生相反方向的附加力矩', () => {
  for (const side of [-1, 1]) {
    const b = new BoatPhysics(); b.psi = Math.PI; b.u = 2;
    b.boom = 80 * DEG; b._boomSettled = true; b.phi = side * 15 * DEG;
    b.p.cHeelYaw = 0; // 隔离桅杆倾斜造成的压力中心横移，不借用船壳横倾系数。
    b.step(northWind(12), dt);
    assert.ok(side * b.out.heelYawNm < -10, `压力中心横移没有进入力矩：${b.out.heelYawNm}`);
  }
});
