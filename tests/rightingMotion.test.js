import assert from 'node:assert/strict';
import test from 'node:test';
import { BoatPhysics, BOAT } from '../src/sim/boatPhysics.js';
import { DEG, KN } from '../src/util/math.js';

const dt = 1 / 120;
const calm = { sample: () => ({ vx: 0, vz: 0, speed: 0, fromPsi: 0 }) };

// 把船按到翻船姿态，然后一直按住扶正，逐帧记录横倾角。
function rightingTrace(side = 1) {
  const b = new BoatPhysics();
  b.powerScale = 0;
  b.p.windageArea = 0;
  b.phi = side * 95 * DEG;
  b.capsized = true;
  b.rightProgress = 0;
  const trace = [];
  for (let i = 0; i < 6 / dt; i++) {
    b.ctl.righting = true;
    b.step(calm, dt);
    trace.push({ phi: b.phi, rate: b.phiRate, capsized: b.capsized, prog: b.rightProgress });
    if (!b.capsized) break;
  }
  return { b, trace };
}

test('扶正过程中横倾角连续变化，没有到点瞬移', () => {
  for (const side of [-1, 1]) {
    const { trace } = rightingTrace(side);
    let maxJump = 0;
    for (let i = 1; i < trace.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(trace[i].phi - trace[i - 1].phi));
    }
    // 旧实现在 rightProgress 到 1 的那一帧直接把 phi 设成 25°，一帧跳近 50°。
    // 连续驱动下单帧变化只可能是角速度 × dt，30°/s 的峰值对应 0.25°。
    assert.ok(maxJump / DEG < 1.5, `单帧最大跳变 ${(maxJump / DEG).toFixed(1)}°，说明中间还有瞬移`);
  }
});

test('扶正结束时已经接近直立且几乎不再转动，交接不产生突变', () => {
  for (const side of [-1, 1]) {
    const { b, trace } = rightingTrace(side);
    assert.equal(b.capsized, false, '按住 6 秒仍未扶正');
    const last = trace[trace.length - 1];
    assert.ok(Math.abs(last.phi / DEG) < BOAT.rightedDeg + 8,
      `结束时横倾 ${(last.phi / DEG).toFixed(1)}°，离目标 ${BOAT.rightedDeg}° 太远`);
    assert.equal(Math.sign(last.phi), side, '扶正不应把船甩到另一舷');
    assert.ok(Math.abs(last.rate / DEG) < 6,
      `结束时还在以 ${(last.rate / DEG).toFixed(1)}°/s 转动，接回常规稳性会抖一下`);
  }
});

test('中途松手会退回平躺，再按住仍能扶起来', () => {
  const b = new BoatPhysics();
  b.powerScale = 0; b.p.windageArea = 0;
  b.phi = 95 * DEG; b.capsized = true;
  for (let i = 0; i < 1.5 / dt; i++) { b.ctl.righting = true; b.step(calm, dt); }
  const mid = b.phi;
  assert.ok(mid / DEG < 70, `按住 1.5 秒只起到 ${(mid / DEG).toFixed(1)}°，中段没有真的在动`);
  for (let i = 0; i < 2.5 / dt; i++) { b.ctl.righting = false; b.step(calm, dt); }
  assert.equal(b.rightProgress, 0);
  assert.ok(b.phi / DEG > 85, `松手后没躺回去，停在 ${(b.phi / DEG).toFixed(1)}°`);
  for (let i = 0; i < 5 / dt && b.capsized; i++) { b.ctl.righting = true; b.step(calm, dt); }
  assert.equal(b.capsized, false, '松手一次之后就再也扶不起来了');
});

test('扶正耗时仍由 rightingTime 决定，不因为改了动画而变快', () => {
  const b = new BoatPhysics();
  b.powerScale = 0; b.p.windageArea = 0;
  b.phi = 95 * DEG; b.capsized = true;
  let t = 0;
  while (b.capsized && t < 8) { b.ctl.righting = true; b.step(calm, dt); t += dt; }
  assert.ok(Math.abs(t - BOAT.rightingTime) < 0.1, `用了 ${t.toFixed(2)} 秒，应为 ${BOAT.rightingTime} 秒`);
  assert.ok(b.speed < 1.5 * KN, '扶正后应基本停住');
});
