import assert from 'node:assert/strict';
import test from 'node:test';

import {
  tackOf,
  isOverlapped,
  giveWay,
  RulesEngine,
  PENALTY_SECONDS,
  PENALTY_POWER,
} from '../src/game/rules.js';

const DEG = Math.PI / 180;

function phys(x, z, psi, twaDeg, u = 3) {
  return { x, z, psi, u, v: 0, out: { twaDeg }, capsized: false };
}

function boat(x, z, psi, twaDeg, opts = {}) {
  return { phys: phys(x, z, psi, twaDeg), penaltyT: 0, ruleCooldown: 0, ...opts };
}

test('受风舷判定:twa>0 为右舷受风', () => {
  assert.equal(tackOf({ out: { twaDeg: 40 } }), 'starboard');
  assert.equal(tackOf({ out: { twaDeg: -40 } }), 'port');
});

test('规则10:左舷受风让右舷受风', () => {
  const stb = phys(0, 0, -45 * DEG, 45);
  const port = phys(5, 0, 45 * DEG, -45);
  const r1 = giveWay(port, stb, 0);
  assert.equal(r1.give, 'a');
  assert.equal(r1.rule, 'rules.portStb');
  const r2 = giveWay(stb, port, 0);
  assert.equal(r2.give, 'b');
});

test('规则11:同舷并列时上风船让行', () => {
  // 风从北(psi=0)来;两船并列同为右舷受风,b 在北侧(上风)
  const a = phys(0, 0, 90 * DEG, 45);
  const b = phys(0, -3, 90 * DEG, 45); // -z = 北 = 上风侧
  assert.ok(isOverlapped(a, b));
  const r = giveWay(a, b, 0);
  assert.equal(r.give, 'b');
  assert.equal(r.rule, 'rules.windward');
});

test('规则12:后船让前船(未并列)', () => {
  // 同向(朝东),b 在 a 正后方 8m(> 一船长)
  const a = phys(0, 0, 90 * DEG, 45);
  const b = phys(-8, 0, 90 * DEG, 45);
  assert.ok(!isOverlapped(a, b));
  const r = giveWay(a, b, 0);
  assert.equal(r.give, 'b');
  assert.equal(r.rule, 'rules.astern');
});

test('引擎:碰撞后让行方受罚,帆效率下降并计时恢复', () => {
  const wind = { currentFromPsi: () => 0 };
  const engine = new RulesEngine(wind);
  const stb = boat(0, 0, -45 * DEG, 45, { isPlayer: true });
  const port = boat(2, 0, 45 * DEG, -45);
  const boats = [stb, port];

  engine.update(boats, [{ a: port, b: stb, closing: 1 }], 1 / 60);
  assert.equal(port.penaltyT, PENALTY_SECONDS);
  assert.equal(stb.penaltyT, 0);
  const events = engine.takeEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].boat, port);
  assert.equal(events[0].rule, 'rules.portStb');

  // 处罚期内帆效率受限
  engine.update(boats, [], 1 / 60);
  assert.equal(port.phys.powerScale, PENALTY_POWER);
  assert.equal(stb.phys.powerScale, 1);

  // 处罚结束后恢复
  engine.update(boats, [], PENALTY_SECONDS + 1);
  engine.update(boats, [], 1 / 60);
  assert.equal(port.penaltyT, 0);
  assert.equal(port.phys.powerScale, 1);
});

test('引擎:同一对船碰撞冷却期内不重复处罚', () => {
  const wind = { currentFromPsi: () => 0 };
  const engine = new RulesEngine(wind);
  const stb = boat(0, 0, -45 * DEG, 45);
  const port = boat(2, 0, 45 * DEG, -45);
  engine.update([stb, port], [{ a: port, b: stb, closing: 1 }], 1 / 60);
  engine.takeEvents();
  engine.update([stb, port], [{ a: port, b: stb, closing: 1 }], 1 / 60);
  assert.equal(engine.takeEvents().length, 0, '冷却期内不应再次判罚');
});

test('预警:玩家为让行方且正在接近时给出规则提示', () => {
  const wind = { currentFromPsi: () => 0 };
  const engine = new RulesEngine(wind);
  // 玩家左舷受风朝东,对手右舷受风在 10m 外相向
  const player = boat(0, 0, 45 * DEG, -45);
  player.phys.u = 3;
  const other = boat(10, 0, -45 * DEG, 45);
  other.phys.u = 3; // 朝西北方向?psi=-45°,朝 -x/-z → 靠近玩家
  const warn = engine.warningFor(player, [player, other]);
  assert.ok(warn, '应产生让行预警');
  assert.equal(warn.rule, 'rules.portStb');

  // 玩家是右舷受风(有路权)时无预警
  const holder = boat(0, 0, -45 * DEG, 45);
  holder.phys.u = 3;
  const portBoat = boat(10, 0, 45 * DEG, -45);
  portBoat.phys.u = 3;
  assert.equal(engine.warningFor(holder, [holder, portBoat]), null);
});
