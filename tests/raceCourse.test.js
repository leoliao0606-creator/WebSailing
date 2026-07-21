// RaceCourse 几何与 RaceManager 判定回归:终点穿越方向、起航线几何。
// (绕标方向校验的用例在 1.3 落地时补充于此。)

import assert from 'node:assert/strict';
import test from 'node:test';

import { RaceCourse, RaceManager } from '../src/game/race.js';

const fakeScene = { add() {}, remove() {} };
const fakeWaves = { sample: () => ({ y: 0, nx: 0, nz: 0 }) };

// windFromPsi=0 → 上风为 -z,起航线沿 x 轴,pin 在 -x、委员会船在 +x
function makeCourse() {
  return new RaceCourse(fakeScene, fakeWaves, 0, { x: 0, z: 0 });
}

function makeBoat(x, z) {
  return { isPlayer: false, nameKey: 'name.you', displayName: 'T', phys: { x, z } };
}

test('赛道几何:上风标在上风侧,起航线两端与障碍就位', () => {
  const course = makeCourse();
  assert.ok(course.marks[0].z < 0, '上风标应在 -z');
  assert.ok(course.isUpwindOfLine(0, -1));
  assert.ok(!course.isUpwindOfLine(0, 1));
  assert.ok(course.crossesLine(0, 1, 0, -1), '穿越线段应被检测');
  assert.ok(!course.crossesLine(60, 1, 60, -1), '线段外不算穿越');
  const kinds = course.obstacles.map((o) => o.kind);
  assert.deepEqual(kinds, ['pin', 'committee', 'mark', 'mark']);
});

test('终点仅接受自下风向上风的穿越;反向穿线不算完赛', () => {
  const course = makeCourse();
  const boat = makeBoat(0, -1); // 从上风侧(错误方向)开始
  const race = new RaceManager(course, [boat], 0);
  race.state = 'racing';
  race.t = 100;
  race.entries.get(boat).leg = course.legs.length - 1;

  boat.phys.z = 1; // 上风 -> 下风:反向穿线
  race.update(0.1);
  assert.equal(race.entries.get(boat).finished, false, '反向穿线不应完赛');

  boat.phys.z = -1; // 下风 -> 上风:正确方向
  race.update(0.1);
  assert.equal(race.entries.get(boat).finished, true, '正向穿线应完赛');
  assert.equal(race.results.length, 1);
});

// 沿"标->船"方位角圆弧驱动船位:fromDeg -> toDeg(罗盘角),半径序列线性过渡
function sweepAround(race, boat, mark, fromDeg, toDeg, rFrom, rTo, steps = 60) {
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    const th = (fromDeg + (toDeg - fromDeg) * f) * Math.PI / 180;
    const r = rFrom + (rTo - rFrom) * f;
    boat.phys.x = mark.x + r * Math.sin(th);
    boat.phys.z = mark.z - r * Math.cos(th);
    race.update(1 / 30);
  }
}

test('绕标:正确侧(左舷)扫掠过标判过,错边穿圈不判', () => {
  const course = makeCourse();
  const m = course.marks[0];
  // 正确侧:方位角自 170° 递减扫到 -30°(左舷绕标),半径 40 -> 12 -> 恢复 30
  const good = makeBoat(m.x + 40 * Math.sin(170 * Math.PI / 180), m.z - 40 * Math.cos(170 * Math.PI / 180));
  const race = new RaceManager(course, [good], 0);
  race.state = 'racing';
  race.t = 10;
  race.entries.get(good).leg = 1;
  sweepAround(race, good, m, 170, 60, 40, 12);
  sweepAround(race, good, m, 60, -30, 12, 30);
  assert.equal(race.entries.get(good).leg, 2, '正确侧绕标应判过');
  assert.equal(race.entries.get(good).roundAcc, 0, '判过后扫掠清零');

  // 错边:方位角正向递增扫过判定圈(标在右舷)
  const bad = makeBoat(m.x - 40 * Math.sin(170 * Math.PI / 180), m.z - 40 * Math.cos(170 * Math.PI / 180));
  const race2 = new RaceManager(course, [bad], 0);
  race2.state = 'racing';
  race2.t = 10;
  race2.entries.get(bad).leg = 1;
  sweepAround(race2, bad, m, -170, -60, 40, 12);
  sweepAround(race2, bad, m, -60, 30, 12, 30);
  assert.equal(race2.entries.get(bad).leg, 1, '错边通过不应判过');
});

test('绕标:离开捕获区清零,回头按正确侧重绕后判过', () => {
  const course = makeCourse();
  const m = course.marks[0];
  const boat = makeBoat(m.x, m.z + 40);
  const race = new RaceManager(course, [boat], 0);
  race.state = 'racing';
  race.t = 10;
  const e = race.entries.get(boat);
  e.leg = 1;

  // 错边进近到圈内再退出捕获区
  sweepAround(race, boat, m, -170, -90, 40, 12);
  assert.equal(e.nearMark, true, '进过判定圈');
  boat.phys.x = m.x - 80;
  boat.phys.z = m.z;
  race.update(1 / 30);
  assert.equal(e.nearMark, false, '离开捕获区应清零进近状态');
  assert.equal(e.roundAcc, 0);

  // 回头正确侧重绕
  boat.phys.x = m.x + 40 * Math.sin(170 * Math.PI / 180);
  boat.phys.z = m.z - 40 * Math.cos(170 * Math.PI / 180);
  race.update(1 / 30);
  sweepAround(race, boat, m, 170, 40, 40, 12);
  sweepAround(race, boat, m, 40, -40, 12, 30);
  assert.equal(e.leg, 2, '重绕后应判过');
});

test('未完成的回转处罚拦截完赛,清罚后可完赛', () => {
  const course = makeCourse();
  const boat = makeBoat(0, 1);
  boat.penaltyTurns = 1;
  const race = new RaceManager(course, [boat], 0);
  race.state = 'racing';
  race.t = 100;
  race.entries.get(boat).leg = course.legs.length - 1;

  boat.phys.z = -1;
  race.update(0.1);
  assert.equal(race.entries.get(boat).finished, false, '带罚转不应完赛');

  boat.phys.z = 1;
  race.update(0.1); // 回到线下
  boat.penaltyTurns = 0;
  boat.phys.z = -1;
  race.update(0.1);
  assert.equal(race.entries.get(boat).finished, true, '清罚后应完赛');
});
