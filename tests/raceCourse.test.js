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
