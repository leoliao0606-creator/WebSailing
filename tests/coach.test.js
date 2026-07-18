import assert from 'node:assert/strict';
import test from 'node:test';

import { optimalSheet, optimalBoard, coachAdvice } from '../src/game/coach.js';

const P = { boomMinDeg: 4, boomMaxDeg: 88 };

function phys({
  awaDeg = 90, twaDeg = 90, heelDeg = 5, sheet = 0.5, board = 1,
  luff = 0, speedKn = 4, inIrons = false, capsized = false,
  x = 0, z = 0, psi = 0,
} = {}) {
  return {
    p: P, x, z, psi, sheet, board, capsized,
    out: { awaDeg, twaDeg, heelDeg, luff, speedKn, inIrons },
  };
}

test('最佳稳向板:迎风全放,顺风收起', () => {
  assert.equal(optimalBoard(45), 1);
  assert.equal(optimalBoard(-60), 1);
  assert.equal(optimalBoard(160), 0.35);
  const reach = optimalBoard(115);
  assert.ok(reach > 0.35 && reach < 1, '横风应在两者之间');
});

test('最佳缭绳随视风角增大而放出', () => {
  const close = optimalSheet(phys({ awaDeg: 30 }));
  const beam = optimalSheet(phys({ awaDeg: 90 }));
  const run = optimalSheet(phys({ awaDeg: 170 }));
  assert.ok(close < beam && beam < run);
  assert.ok(close >= 0 && run <= 1);
});

test('过载(大横倾)时最佳缭绳比正常更松', () => {
  const normal = optimalSheet(phys({ awaDeg: 60, heelDeg: 10 }));
  const over = optimalSheet(phys({ awaDeg: 60, heelDeg: 40 }));
  assert.ok(over > normal, '大横倾应建议放更多帆');
});

test('提示:帆放太开 -> 收帆;收太死 -> 放帆', () => {
  const eased = coachAdvice(phys({ awaDeg: 40, twaDeg: 45, sheet: 1 }));
  assert.equal(eased.hint, 'coach.sheetIn');
  const tight = coachAdvice(phys({ awaDeg: 170, twaDeg: 170, sheet: 0, board: 0.35 }));
  assert.equal(tight.hint, 'coach.sheetOut');
});

test('提示:顺风未收板 -> 建议收板;迎风板收着 -> 建议放板', () => {
  // 顺风:缭绳已在最佳附近,板还全放着
  const p1 = phys({ awaDeg: 160, twaDeg: 160, board: 1 });
  p1.sheet = optimalSheet(p1);
  assert.equal(coachAdvice(p1).hint, 'coach.boardUp');
  // 迎风:板收着
  const p2 = phys({ awaDeg: 30, twaDeg: 45, board: 0.3 });
  p2.sheet = optimalSheet(p2);
  assert.equal(coachAdvice(p2).hint, 'coach.boardDown');
});

test('提示:死区与过载优先级最高', () => {
  const irons = coachAdvice(phys({ awaDeg: 5, twaDeg: 5, inIrons: true, sheet: 1 }));
  assert.equal(irons.hint, 'coach.irons');
  const over = coachAdvice(phys({ awaDeg: 40, twaDeg: 45, heelDeg: 40, sheet: 1 }));
  assert.equal(over.hint, 'coach.overpower');
});

test('提示:目标在上风时给 VMG 角建议', () => {
  // 朝东横风航行(twa=90),目标在正北 = 正上风(风从北来,psi=90°,twa=+90 → 风向 psi+twa=180?)
  // 构造:psi=90°E,twa=-90 → 风来自 psi-90=0(北)。目标在北。
  const DEG = Math.PI / 180;
  const p = phys({ awaDeg: -80, twaDeg: -90, psi: 90 * DEG });
  p.sheet = optimalSheet(p);
  const advice = coachAdvice(p, { x: 0, z: -300 }); // 北方目标
  assert.equal(advice.hint, 'coach.vmgUp');
});

test('一切正常时给出正向反馈', () => {
  const p = phys({ awaDeg: 40, twaDeg: 45, heelDeg: 8, luff: 0, speedKn: 5 });
  p.sheet = optimalSheet(p);
  p.board = optimalBoard(45);
  const advice = coachAdvice(p);
  assert.equal(advice.hint, 'coach.good');
  assert.ok(advice.good);
});

test('翻船时不给调帆提示', () => {
  const advice = coachAdvice(phys({ capsized: true }));
  assert.equal(advice.hint, null);
});
