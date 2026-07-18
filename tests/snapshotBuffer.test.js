import assert from 'node:assert/strict';
import test from 'node:test';

import { SnapshotBuffer } from '../src/net/snapshotBuffer.js';
import { cloneWorldState } from '../src/net/worldState.js';

function makeSnapshot({
  tick = 0,
  worldTime = 0,
  hostEpoch = 1,
  x = 0,
  z = 0,
  psi = 0,
  u = 0,
  v = 0,
  yawRate = 0,
} = {}) {
  return {
    tick,
    worldTime,
    seed: 'buffer-seed',
    hostEpoch,
    boats: [{
      boatId: 'boat-a',
      phys: {
        x,
        z,
        psi,
        u,
        v,
        yawRate,
        phi: 0,
        phiRate: 0,
        boom: 0.2,
        rudder: 0.1,
        sheet: 0.5,
        board: 1,
        crewY: 0,
        capsized: false,
        rightProgress: 0,
        ctl: {
          rudder: 0,
          sheet: 0.5,
          board: 1,
          hike: 0,
          autoHike: true,
          righting: false,
          autoTrim: false,
        },
      },
      control: { rudderCmd: 0, hikeLevel: 0, manualSheetAt: -99 },
    }],
    race: {
      state: 'racing',
      t: worldTime,
      entries: [{
        boatId: 'boat-a',
        leg: 1,
        ocs: false,
        splits: [],
        finished: false,
        finishT: 0,
        prevX: x,
        prevZ: z,
      }],
      results: [],
    },
  };
}

function sampleState(buffer, renderWorldTime) {
  return buffer.sample(renderWorldTime).state;
}

test('SnapshotBuffer enforces a 100 to 150 millisecond interpolation delay', () => {
  assert.throws(() => new SnapshotBuffer({ interpolationDelayMs: 99 }), /100/);
  assert.throws(() => new SnapshotBuffer({ interpolationDelayMs: 151 }), /150/);

  const minimum = new SnapshotBuffer({ interpolationDelayMs: 100 });
  const maximum = new SnapshotBuffer({ interpolationDelayMs: 150 });
  assert.equal(minimum.interpolationDelayMs, 100);
  assert.equal(maximum.interpolationDelayMs, 150);
});

test('SnapshotBuffer sorts out-of-order arrivals and keeps only its newest capacity', () => {
  const buffer = new SnapshotBuffer({ capacity: 2, interpolationDelayMs: 125 });
  buffer.add(makeSnapshot({ tick: 3, worldTime: 0.3, x: 30 }));
  buffer.add(makeSnapshot({ tick: 1, worldTime: 0.1, x: 10 }));
  buffer.add(makeSnapshot({ tick: 2, worldTime: 0.2, x: 20 }));

  assert.equal(buffer.size, 2);
  assert.deepEqual(buffer.getSnapshots().map((snapshot) => snapshot.tick), [2, 3]);
  assert.equal(sampleState(buffer, 0.325).boats[0].phys.x, 20);
});

test('SnapshotBuffer replaces a duplicate epoch and tick without growing', () => {
  const buffer = new SnapshotBuffer();
  buffer.add(makeSnapshot({ tick: 4, worldTime: 0.4, x: 4 }));
  buffer.add(makeSnapshot({ tick: 4, worldTime: 0.45, x: 9 }));

  assert.equal(buffer.size, 1);
  assert.equal(buffer.getSnapshots()[0].boats[0].phys.x, 9);
});

test('SnapshotBuffer interpolates position at its delayed render time', () => {
  const buffer = new SnapshotBuffer({ interpolationDelayMs: 125 });
  buffer.add(makeSnapshot({ tick: 60, worldTime: 1, x: 0 }));
  buffer.add(makeSnapshot({ tick: 72, worldTime: 1.2, x: 20 }));

  const rendered = sampleState(buffer, 1.225);

  assert.ok(Math.abs(rendered.worldTime - 1.1) < 1e-12);
  assert.ok(Math.abs(rendered.boats[0].phys.x - 10) < 1e-9);
});

test('SnapshotBuffer interpolates headings through the short arc across plus and minus pi', () => {
  const buffer = new SnapshotBuffer({ interpolationDelayMs: 125 });
  const almostPi = 179 * Math.PI / 180;
  buffer.add(makeSnapshot({ tick: 60, worldTime: 1, psi: almostPi }));
  buffer.add(makeSnapshot({ tick: 72, worldTime: 1.2, psi: -almostPi }));

  const heading = sampleState(buffer, 1.225).boats[0].phys.psi;

  assert.ok(Math.abs(Math.abs(heading) - Math.PI) < 1e-9);
});

test('SnapshotBuffer keeps race completion events discrete while interpolating motion', () => {
  const buffer = new SnapshotBuffer({ interpolationDelayMs: 125 });
  const beforeFinish = makeSnapshot({ tick: 60, worldTime: 1, x: 0 });
  const afterFinish = makeSnapshot({ tick: 72, worldTime: 1.2, x: 20 });
  afterFinish.race.state = 'finished';
  afterFinish.race.entries[0].finished = true;
  afterFinish.race.entries[0].finishT = 1.15;
  afterFinish.race.results = [{ boatId: 'boat-a', time: 1.15 }];
  buffer.add(beforeFinish);
  buffer.add(afterFinish);

  const rendered = sampleState(buffer, 1.175);

  assert.equal(rendered.race.state, 'racing');
  assert.equal(rendered.race.entries[0].finished, false);
  assert.equal(rendered.race.entries[0].finishT, 0);
  assert.deepEqual(rendered.race.results, []);
});

test('SnapshotBuffer extrapolates briefly with bounded time and speed', () => {
  const buffer = new SnapshotBuffer({
    interpolationDelayMs: 125,
    maxExtrapolationMs: 50,
    maxExtrapolationSpeed: 4,
  });
  buffer.add(makeSnapshot({
    tick: 60,
    worldTime: 1,
    x: 0,
    psi: Math.PI / 2,
    u: 20,
  }));

  const short = sampleState(buffer, 1.15);
  const muchLater = sampleState(buffer, 20);

  assert.ok(Math.abs(short.boats[0].phys.x - 0.1) < 1e-9);
  assert.ok(Math.abs(muchLater.boats[0].phys.x - 0.2) < 1e-9);
  assert.ok(Math.abs(muchLater.worldTime - 1.05) < 1e-12);
});

test('SnapshotBuffer clones on input and output and rejects invalid snapshots', () => {
  const buffer = new SnapshotBuffer();
  const original = makeSnapshot({ tick: 1, worldTime: 1, x: 5 });
  buffer.add(original);
  original.boats[0].phys.x = 500;

  const exposed = buffer.getSnapshots();
  exposed[0].boats[0].phys.x = 700;

  assert.equal(buffer.getSnapshots()[0].boats[0].phys.x, 5);
  assert.throws(() => buffer.add({ ...makeSnapshot(), boats: [] }), /boat/i);
});

test('SnapshotBuffer starts a fresh timeline for a newer host epoch and ignores stale epochs', () => {
  const buffer = new SnapshotBuffer();
  buffer.add(makeSnapshot({ tick: 100, worldTime: 10, hostEpoch: 2, x: 10 }));
  buffer.add(makeSnapshot({ tick: 1, worldTime: 1, hostEpoch: 3, x: 30 }));
  const accepted = buffer.add(makeSnapshot({ tick: 200, worldTime: 20, hostEpoch: 2, x: 99 }));

  assert.equal(accepted, false);
  assert.equal(buffer.size, 1);
  assert.equal(buffer.getSnapshots()[0].hostEpoch, 3);
});

test('SnapshotBuffer marks sampled states render-only so they cannot be applied as authority', () => {
  const buffer = new SnapshotBuffer();
  buffer.add(makeSnapshot({ tick: 60, worldTime: 1 }));

  const rendered = buffer.sample(1.125);

  assert.deepEqual(Object.keys(rendered).sort(), ['renderOnly', 'state']);
  assert.equal(rendered.renderOnly, true);
  assert.throws(() => cloneWorldState(rendered), /unknown field|world state/i);
});

test('SnapshotBuffer takes manualSheetAt discretely from the newer snapshot', () => {
  const buffer = new SnapshotBuffer({ interpolationDelayMs: 125 });
  const older = makeSnapshot({ tick: 60, worldTime: 1 });
  const newer = makeSnapshot({ tick: 72, worldTime: 1.2 });
  older.boats[0].control.manualSheetAt = -99;
  newer.boats[0].control.manualSheetAt = 12;
  buffer.add(older);
  buffer.add(newer);

  const rendered = sampleState(buffer, 1.175);

  assert.equal(rendered.boats[0].control.manualSheetAt, 12);
});
