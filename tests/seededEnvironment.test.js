import assert from 'node:assert/strict';
import test from 'node:test';

import { AIHelm } from '../src/game/ai.js';
import { createSeededRandom } from '../src/sim/random.js';
import { WindField } from '../src/sim/wind.js';

test('createSeededRandom repeats a sequence for the same seed', () => {
  const a = createSeededRandom('private-race-42');
  const b = createSeededRandom('private-race-42');
  const c = createSeededRandom('private-race-43');
  const sequenceA = Array.from({ length: 6 }, () => a());

  assert.deepEqual(sequenceA, Array.from({ length: 6 }, () => b()));
  assert.notDeepEqual(sequenceA, Array.from({ length: 6 }, () => c()));
  assert.ok(sequenceA.every((value) => value >= 0 && value < 1));
});

test('WindField samples match for the same explicit seed and time', () => {
  const a = new WindField('race-seed');
  const b = new WindField('race-seed');
  a.setBase(0.37, 15);
  b.setBase(0.37, 15);
  a.update(27.25);
  b.update(27.25);

  assert.deepEqual(a.sample(123.5, -88.25), b.sample(123.5, -88.25));
});

test('WindField samples differ for different explicit seeds', () => {
  const a = new WindField('race-seed-a');
  const b = new WindField('race-seed-b');
  a.update(11.5);
  b.update(11.5);

  assert.notDeepEqual(a.sample(41, -17), b.sample(41, -17));
});

test('WindField.setSeed restores an explicitly seeded environment', () => {
  const wind = new WindField();
  wind.time = 9.75;
  wind.setSeed(8675309);
  const first = wind.sample(-12, 34);
  wind.setSeed(123);
  wind.setSeed(8675309);

  assert.deepEqual(wind.sample(-12, 34), first);
});

test('AIHelm initializes identically for the same explicit seed', () => {
  const a = new AIHelm({ phys: {} }, 0.76, 'fleet-seed');
  const b = new AIHelm({ phys: {} }, 0.76, 'fleet-seed');

  assert.deepEqual(
    { tackSide: a.tackSide, noiseT: a.noiseT, alphaStar: a.alphaStar },
    { tackSide: b.tackSide, noiseT: b.noiseT, alphaStar: b.alphaStar },
  );
});

test('AIHelm.setSeed repeats its seeded initialization', () => {
  const helm = new AIHelm({ phys: {} });
  helm.setSeed('replacement-host');
  const first = { tackSide: helm.tackSide, noiseT: helm.noiseT };
  helm.setSeed('some-other-seed');
  helm.setSeed('replacement-host');

  assert.deepEqual({ tackSide: helm.tackSide, noiseT: helm.noiseT }, first);
});

test('unseeded wind and AI retain Math.random defaults', () => {
  const originalRandom = Math.random;
  const values = [0.25, 0.75, 0.125];
  Math.random = () => values.shift();
  try {
    const wind = new WindField();
    const helm = new AIHelm({ phys: {} });
    assert.equal(wind._seed, 25);
    assert.equal(helm.tackSide, 1);
    assert.equal(helm.noiseT, 12.5);
  } finally {
    Math.random = originalRandom;
  }
});
