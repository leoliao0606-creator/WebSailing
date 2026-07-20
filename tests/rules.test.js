import assert from 'node:assert/strict';
import test from 'node:test';

import {
  tackOf,
  isOverlapped,
  giveWay,
  RulesEngine,
  PENALTY_SECONDS,
  PENALTY_POWER,
  PENALTY_TURNS_CONTACT,
  PENALTY_TURNS_MARK,
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

const WIND = { currentFromPsi: () => 0 };

function turnsEngine() {
  return new RulesEngine(WIND, { mode: 'turns' });
}

// 以恒定转率把船转过给定角度(默认 0.8 rad/s ≈ 一个回转 8 秒)
function spin(engine, boats, target, radians, rate = 0.8) {
  const dt = 1 / 60;
  const steps = Math.ceil(Math.abs(radians) / (rate * dt));
  const step = radians / steps;
  for (let i = 0; i < steps; i++) {
    target.phys.psi += step;
    engine.update(boats, [], dt);
  }
}

test('turns 模式:碰撞记 2 回转、触标记 1 回转,不压帆效率', () => {
  const engine = turnsEngine();
  const stb = boat(0, 0, -45 * DEG, 45);
  const port = boat(2, 0, 45 * DEG, -45);
  engine.update([stb, port], [{ a: port, b: stb, closing: 1 }], 1 / 60);
  assert.equal(port.penaltyTurns, PENALTY_TURNS_CONTACT);
  assert.equal(stb.penaltyTurns ?? 0, 0);
  assert.equal(port.penaltyT ?? 0, 0, 'turns 模式不应设减速处罚');
  engine.update([stb, port], [], 1 / 60);
  assert.equal(port.phys.powerScale, 1, 'turns 模式帆效率不受限');

  const toucher = boat(0, 50, 0, 45);
  engine.update([toucher], [], 1 / 60, [{ boat: toucher, obstacle: { kind: 'mark' } }]);
  assert.equal(toucher.penaltyTurns, PENALTY_TURNS_MARK);
  const kinds = engine.takeEvents().map((e) => e.kind);
  assert.deepEqual(kinds, ['contact', 'mark']);
});

test('turns 模式:连续转满 360° 清一个回转并发事件', () => {
  const engine = turnsEngine();
  const b = boat(0, 0, 0, 45);
  b.penaltyTurns = 2;
  spin(engine, [b], b, Math.PI * 2);
  assert.equal(b.penaltyTurns, 1, '转满一圈应清一个');
  const ev = engine.takeEvents().find((e) => e.kind === 'turnDone');
  assert.ok(ev && ev.turns === 1);
  spin(engine, [b], b, Math.PI * 2);
  assert.equal(b.penaltyTurns, 0);
});

test('turns 模式:反向转抵消,来回摆不清回转', () => {
  const engine = turnsEngine();
  const b = boat(0, 0, 0, 45);
  b.penaltyTurns = 1;
  for (let i = 0; i < 4; i++) {
    spin(engine, [b], b, Math.PI);
    spin(engine, [b], b, -Math.PI);
  }
  assert.equal(b.penaltyTurns, 1, '来回摆动不应清罚');
});

test('turns 模式:慢速转向(正常航行)不计入回转', () => {
  const engine = turnsEngine();
  const b = boat(0, 0, 0, 45);
  b.penaltyTurns = 1;
  spin(engine, [b], b, Math.PI * 2, 0.1); // 低于转率门槛
  assert.equal(b.penaltyTurns, 1, '慢速转不应计入');
});

test('turns 模式:翻船期间不累计回转', () => {
  const engine = turnsEngine();
  const b = boat(0, 0, 0, 45);
  b.penaltyTurns = 1;
  b.phys.capsized = true;
  spin(engine, [b], b, Math.PI * 2);
  assert.equal(b.penaltyTurns, 1);
  // 扶正后从当前艏向重新累计,不因翻船期的角度跳变误清
  b.phys.capsized = false;
  spin(engine, [b], b, Math.PI * 2);
  assert.equal(b.penaltyTurns, 0);
});

test('slow 模式(默认)行为不变:触标也走减速处罚', () => {
  const engine = new RulesEngine(WIND);
  const b = boat(0, 0, 0, 45);
  engine.update([b], [], 1 / 60, [{ boat: b, obstacle: { kind: 'mark' } }]);
  assert.equal(b.penaltyT, PENALTY_SECONDS);
  assert.equal(b.penaltyTurns ?? 0, 0);
  const events = engine.takeEvents();
  assert.equal(events[0].kind, 'mark');
  assert.equal(events[0].rule, 'rules.markTouch');
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
