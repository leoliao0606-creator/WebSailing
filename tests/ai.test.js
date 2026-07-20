// AI 战术纯函数回归:起航有利端、脏风逃逸门控、追浪偏置。

import assert from 'node:assert/strict';
import test from 'node:test';

import { favoredLineEnd, shouldEscapeShadow, surfSteerBias } from '../src/game/ai.js';

const DEG = Math.PI / 180;

test('favoredLineEnd:风向偏向哪端哪端有利,符号正确', () => {
  // 起航线沿 x 轴:pin 在 -x,committee 在 +x
  const course = { pin: { x: -42, z: 0 }, committee: { x: 42, z: 0 } };
  // 风从正北(-z,windFromPsi=0):线与风垂直,两端等价
  assert.ok(Math.abs(favoredLineEnd(0, course)) < 1e-9);
  // 风偏向 pin 侧(从西北来):pin 端更上风 → favored > 0
  assert.ok(favoredLineEnd(-45 * DEG, course) > 0.5);
  // 风偏向委员会侧(从东北来):favored < 0
  assert.ok(favoredLineEnd(45 * DEG, course) < -0.5);
  // 数值范围
  assert.ok(Math.abs(favoredLineEnd(-90 * DEG, course)) <= 1);
});

test('shouldEscapeShadow:仅在持续脏风且冷却/距离允许时触发', () => {
  assert.equal(shouldEscapeShadow(0.8, 3, 10, 100), true);
  assert.equal(shouldEscapeShadow(0.95, 3, 10, 100), false, '清风不逃');
  assert.equal(shouldEscapeShadow(0.8, 1, 10, 100), false, '短暂脏风不逃');
  assert.equal(shouldEscapeShadow(0.8, 3, 4, 100), false, '换舷冷却未过不逃');
  assert.equal(shouldEscapeShadow(0.8, 3, 10, 40), false, '绕标进近段不逃');
});

test('surfSteerBias:上浪背压低、减速面抬头、新手不启用、有上限', () => {
  assert.equal(surfSteerBias(0.4, 0.7), 0, '低技能不追浪');
  assert.ok(surfSteerBias(0.4, 1) > 0, '被浪推时应压低');
  assert.ok(surfSteerBias(-0.3, 1) < 0, '顶浪面应抬头');
  assert.equal(surfSteerBias(0.05, 1), 0, '弱信号不动作');
  assert.ok(surfSteerBias(10, 1) <= 10 * DEG + 1e-9, '压低偏置有上限');
  assert.ok(surfSteerBias(-10, 1) >= -8 * DEG - 1e-9, '抬头偏置有上限');
});
