import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HULL_HALF_LEN,
  HULL_RADIUS,
  segSegClosest,
  resolveBoatCollisions,
} from '../src/sim/collision.js';

function mkBoat(x, z, psi, u = 0, v = 0) {
  return { phys: { x, z, psi, u, v, yawRate: 0 } };
}

test('segSegClosest: 平行线段最近距离', () => {
  const r = segSegClosest(0, 0, 10, 0, 0, 3, 10, 3);
  assert.ok(Math.abs(r.d - 3) < 1e-9);
});

test('segSegClosest: 相交线段距离为 0', () => {
  const r = segSegClosest(-5, 0, 5, 0, 0, -5, 0, 5);
  assert.ok(r.d < 1e-9);
});

test('远处的船不产生接触', () => {
  const a = mkBoat(0, 0, 0);
  const b = mkBoat(30, 0, 0);
  const contacts = resolveBoatCollisions([a, b]);
  assert.equal(contacts.length, 0);
  assert.equal(a.phys.x, 0);
});

test('并排近距平行航行(横距 1.6m)不算碰撞 — 圆形碰撞箱会误判', () => {
  // 两船同向,横向间距 1.6m:胶囊半径 0.72*2=1.44 < 1.6,应无接触
  const a = mkBoat(0, 0, 0, 3);
  const b = mkBoat(1.6, 0, 0, 3);
  const contacts = resolveBoatCollisions([a, b]);
  assert.equal(contacts.length, 0);
});

test('横向重叠的并排船被推开并报告接触', () => {
  const a = mkBoat(0, 0, 0, 3);
  const b = mkBoat(1.0, 0, 0, 3);
  const contacts = resolveBoatCollisions([a, b]);
  assert.equal(contacts.length, 1);
  // 沿 +x 分离
  assert.ok(a.phys.x < 0);
  assert.ok(b.phys.x > 1.0);
  const gap = b.phys.x - a.phys.x;
  assert.ok(Math.abs(gap - 2 * HULL_RADIUS) < 1e-6);
});

test('艏艉纵向相接(同一直线)比横向允许更近 — 胶囊几何生效', () => {
  // 同向首尾排列,中心距 4.0m:线段端点间距 4.0-2*1.7=0.6 < 1.44 → 接触
  const a = mkBoat(0, 0, 0);
  const b = mkBoat(0, -4.0, 0); // psi=0 朝 -z,b 在 a 正前方
  const contacts = resolveBoatCollisions([a, b]);
  assert.equal(contacts.length, 1);
  // 中心距 5m(> 2*(1.7+0.72)=4.84)则不接触
  const c = mkBoat(0, 0, 0);
  const d = mkBoat(0, -5.0, 0);
  assert.equal(resolveBoatCollisions([c, d]).length, 0);
});

test('迎头相撞消除闭合速度并附带减速', () => {
  // a 朝 -z 前进,b 在其前方朝 +z(psi=π)对头驶来
  const a = mkBoat(0, 0, 0, 3);
  const b = mkBoat(0.5, -4.0, Math.PI, 3);
  const contacts = resolveBoatCollisions([a, b]);
  assert.equal(contacts.length, 1);
  assert.ok(contacts[0].closing > 0, '应报告闭合速度');
  // 碰后两船前进速度应下降
  assert.ok(a.phys.u < 3);
  assert.ok(b.phys.u < 3);
});

test('接触信息包含判责所需的双方引用', () => {
  const a = mkBoat(0, 0, 0);
  const b = mkBoat(1.0, 0, 0);
  const [c] = resolveBoatCollisions([a, b]);
  assert.equal(c.a, a);
  assert.equal(c.b, b);
  assert.ok(Number.isFinite(c.nx) && Number.isFinite(c.nz));
  assert.ok(c.overlap > 0);
});

test('胶囊参数覆盖整船', () => {
  assert.ok(2 * (HULL_HALF_LEN + HULL_RADIUS) > 4.2, '胶囊总长应不小于船长');
});
