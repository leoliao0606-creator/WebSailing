import assert from 'node:assert/strict';
import test from 'node:test';

import { IntegrityMonitor } from '../src/net/integrityMonitor.js';
import { SnapshotBuffer } from '../src/net/snapshotBuffer.js';

function makeSnapshot({
  tick = 60,
  worldTime = 1,
  hostEpoch = 1,
  raceTime = 1,
  x = 0,
  z = 0,
  u = 3,
  v = 0,
} = {}) {
  return {
    tick,
    worldTime,
    seed: 'integrity-seed',
    hostEpoch,
    boats: [{
      boatId: 'boat-a',
      phys: {
        x,
        z,
        psi: 0,
        u,
        v,
        yawRate: 0,
        phi: 0,
        phiRate: 0,
        boom: 0,
        rudder: 0,
        sheet: 0.5,
        board: 1,
        crewY: 0,
        capsized: false,
        rightProgress: 0,
        powerScale: 1,
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
      rules: { penaltyT: 0, ruleCooldown: 0, penaltyTurns: 0, turnAcc: 0 },
    }],
    race: {
      state: 'racing',
      t: raceTime,
      entries: [{
        boatId: 'boat-a',
        leg: 1,
        ocs: false,
        splits: [],
        finished: false,
        finishT: 0,
        prevX: x,
        prevZ: z,
        roundAcc: 0,
        nearMark: false,
      }],
      results: [],
    },
  };
}

function inspect(monitor, snapshot, expectedEpoch = snapshot?.hostEpoch ?? 1) {
  return monitor.inspect(snapshot, { expectedEpoch });
}

function advance(snapshot, { ticks = 6, seconds = 0.1 } = {}) {
  const next = structuredClone(snapshot);
  next.tick += ticks;
  next.worldTime += seconds;
  next.race.t += seconds;
  return next;
}

test('IntegrityMonitor accepts a valid baseline and returns an isolated clone', () => {
  const monitor = new IntegrityMonitor();
  const snapshot = makeSnapshot();

  const result = inspect(monitor, snapshot);
  snapshot.boats[0].phys.x = 999;

  assert.equal(result.invalidated, false);
  assert.equal(result.ignored, false);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.snapshot.boats[0].phys.x, 0);
});

test('IntegrityMonitor ignores duplicate or older tick and world time without moving its baseline', () => {
  const monitor = new IntegrityMonitor();
  assert.equal(inspect(monitor, makeSnapshot()).invalidated, false);

  const sameTick = inspect(monitor, makeSnapshot({ tick: 60, worldTime: 1.1, raceTime: 1.1 }));
  const lowerTime = inspect(monitor, makeSnapshot({ tick: 66, worldTime: 0.9, raceTime: 1.1 }));
  const recovered = inspect(monitor, makeSnapshot({ tick: 66, worldTime: 1.1, raceTime: 1.1 }));

  assert.deepEqual(
    { status: sameTick.status, ignored: sameTick.ignored, invalidated: sameTick.invalidated },
    { status: 'ignored', ignored: true, invalidated: false },
  );
  assert.equal(lowerTime.status, 'ignored');
  assert.equal(recovered.status, 'accepted');
});

test('IntegrityMonitor resets continuity only for the session-authorized next epoch', () => {
  const monitor = new IntegrityMonitor({ maxDisplacementPerSecond: 5, positionTolerance: 0 });
  inspect(monitor, makeSnapshot({ tick: 600, worldTime: 10, hostEpoch: 2, raceTime: 10, x: 100 }), 2);

  const migrated = inspect(monitor, makeSnapshot({
    tick: 1,
    worldTime: 0.1,
    hostEpoch: 3,
    raceTime: -30,
    x: -100,
  }), 3);
  const stale = inspect(monitor, makeSnapshot({
    tick: 700,
    worldTime: 11,
    hostEpoch: 2,
    raceTime: 11,
    x: 100,
  }), 3);

  assert.equal(migrated.invalidated, false);
  assert.equal(migrated.status, 'accepted');
  assert.equal(stale.status, 'ignored');
});

test('IntegrityMonitor returns invalidated instead of throwing for malformed and non-finite data', () => {
  const monitor = new IntegrityMonitor();
  const nonFinite = makeSnapshot();
  nonFinite.boats[0].phys.u = Number.POSITIVE_INFINITY;
  const cyclic = makeSnapshot();
  cyclic.loop = cyclic;

  assert.doesNotThrow(() => monitor.inspect(null, { expectedEpoch: 1 }));
  assert.equal(inspect(monitor, null).invalidated, true);
  assert.equal(inspect(monitor, nonFinite).invalidated, true);
  assert.equal(inspect(monitor, cyclic).invalidated, true);
});

test('IntegrityMonitor enforces configured maximum speed without advancing its baseline', () => {
  const monitor = new IntegrityMonitor({ maxSpeed: 8 });
  inspect(monitor, makeSnapshot());

  const tooFast = inspect(monitor, makeSnapshot({ tick: 66, worldTime: 1.1, raceTime: 1.1, u: 9 }));
  const recovered = inspect(monitor, makeSnapshot({ tick: 66, worldTime: 1.1, raceTime: 1.1, u: 4 }));

  assert.equal(tooFast.invalidated, true);
  assert.ok(tooFast.reasons.some((reason) => reason.includes('speed')));
  assert.equal(recovered.invalidated, false);
});

test('IntegrityMonitor invalidates displacement beyond the elapsed-time allowance', () => {
  const monitor = new IntegrityMonitor({
    maxSpeed: 20,
    maxDisplacementPerSecond: 10,
    positionTolerance: 0.25,
  });
  inspect(monitor, makeSnapshot({ x: 0 }));

  const teleported = inspect(monitor, makeSnapshot({
    tick: 66,
    worldTime: 1.1,
    raceTime: 1.1,
    x: 2,
  }));

  assert.equal(teleported.invalidated, true);
  assert.ok(teleported.reasons.some((reason) => reason.includes('displacement')));
});

test('IntegrityMonitor enforces physical, control, coordinate, and race-time ranges', () => {
  const monitor = new IntegrityMonitor({ maxRaceTime: 100, maxCoordinate: 1_000 });
  const invalid = makeSnapshot({ raceTime: 101, x: 1_001 });
  invalid.boats[0].phys.sheet = 1.1;
  invalid.boats[0].control.rudderCmd = 1.1;

  const result = inspect(monitor, invalid);

  assert.equal(result.invalidated, true);
  assert.ok(result.reasons.some((reason) => reason.includes('race.t')));
  assert.ok(result.reasons.some((reason) => reason.includes('coordinate')));
  assert.ok(result.reasons.some((reason) => reason.includes('sheet')));
  assert.ok(result.reasons.some((reason) => reason.includes('rudderCmd')));
});

test('IntegrityMonitor reset explicitly discards the previous baseline', () => {
  const monitor = new IntegrityMonitor();
  inspect(monitor, makeSnapshot({ tick: 600, worldTime: 10, raceTime: 10 }));
  monitor.reset();

  const restarted = inspect(monitor, makeSnapshot({ tick: 1, worldTime: 0.1, raceTime: -20 }));

  assert.equal(restarted.invalidated, false);
});

test('unordered state integration ignores old physics while SnapshotBuffer still sorts it', () => {
  const monitor = new IntegrityMonitor();
  const buffer = new SnapshotBuffer({ capacity: 4 });
  const current = makeSnapshot({ tick: 72, worldTime: 1.2, raceTime: 1.2, x: 2 });
  const old = makeSnapshot({ tick: 66, worldTime: 1.1, raceTime: 1.1, x: 99_999, u: 999 });
  const next = makeSnapshot({ tick: 78, worldTime: 1.3, raceTime: 1.3, x: 3 });

  assert.equal(inspect(monitor, current).status, 'accepted');
  const ignored = inspect(monitor, old);
  assert.deepEqual(
    { status: ignored.status, ignored: ignored.ignored, invalidated: ignored.invalidated },
    { status: 'ignored', ignored: true, invalidated: false },
  );
  assert.equal(inspect(monitor, next).status, 'accepted');

  buffer.add(current);
  buffer.add(old);
  assert.deepEqual(buffer.getSnapshots().map((snapshot) => snapshot.tick), [66, 72]);
});

test('IntegrityMonitor invalidates new physics only after classifying snapshot order', () => {
  const monitor = new IntegrityMonitor({ maxSpeed: 8 });
  inspect(monitor, makeSnapshot());

  const tooFast = inspect(monitor, makeSnapshot({
    tick: 66,
    worldTime: 1.1,
    raceTime: 1.1,
    u: 999,
  }));

  assert.equal(tooFast.status, 'invalidated');
  assert.equal(tooFast.invalidated, true);
  assert.ok(tooFast.reasons.some((reason) => reason.includes('speed')));
});

test('IntegrityMonitor rejects missing authorization, future epochs, and epoch jumps', () => {
  const monitor = new IntegrityMonitor();
  const baseline = makeSnapshot({ hostEpoch: 3 });

  assert.equal(monitor.inspect(baseline).status, 'invalidated');
  assert.equal(inspect(monitor, baseline, 3).status, 'accepted');

  const unauthorized = makeSnapshot({ tick: 1, worldTime: 0.1, raceTime: -30, hostEpoch: 4 });
  const jumped = makeSnapshot({ tick: 1, worldTime: 0.1, raceTime: -30, hostEpoch: 5 });
  assert.equal(inspect(monitor, unauthorized, 3).status, 'invalidated');
  const jumpResult = inspect(monitor, jumped, 5);
  assert.equal(jumpResult.status, 'invalidated');
  assert.ok(jumpResult.reasons.some((reason) => reason.includes('jump')));

  assert.equal(inspect(monitor, unauthorized, 4).status, 'accepted');
});

test('IntegrityMonitor audits tick rate against elapsed world time', () => {
  const monitor = new IntegrityMonitor({ tickRate: 60, maxTickTimeDrift: 0.01 });
  inspect(monitor, makeSnapshot());
  const inconsistent = makeSnapshot({ tick: 120, worldTime: 1.1, raceTime: 1.1 });

  const result = inspect(monitor, inconsistent);

  assert.equal(result.invalidated, true);
  assert.ok(result.reasons.some((reason) => reason.includes('tickDelta')));
});

test('IntegrityMonitor invalidates race time rollback on a newer snapshot', () => {
  const monitor = new IntegrityMonitor();
  inspect(monitor, makeSnapshot());

  const result = inspect(monitor, makeSnapshot({
    tick: 66,
    worldTime: 1.1,
    raceTime: 0.9,
  }));

  assert.equal(result.invalidated, true);
  assert.ok(result.reasons.some((reason) => reason.includes('race.t')));
});

test('IntegrityMonitor rejects boat roster replacement and seed changes within an epoch', () => {
  const rosterMonitor = new IntegrityMonitor();
  const baseline = makeSnapshot();
  inspect(rosterMonitor, baseline);
  const replaced = advance(baseline);
  replaced.boats[0].boatId = 'boat-b';
  replaced.race.entries[0].boatId = 'boat-b';

  const rosterResult = inspect(rosterMonitor, replaced);
  assert.equal(rosterResult.invalidated, true);
  assert.ok(rosterResult.reasons.some((reason) => reason.includes('boatId')));

  const seedMonitor = new IntegrityMonitor();
  inspect(seedMonitor, baseline);
  const changedSeed = advance(baseline);
  changedSeed.seed = 'different-seed';
  const seedResult = inspect(seedMonitor, changedSeed);
  assert.equal(seedResult.invalidated, true);
  assert.ok(seedResult.reasons.some((reason) => reason.includes('seed')));
});

test('IntegrityMonitor checks the first authority state against the authorized race identity', () => {
  const snapshot = makeSnapshot();

  const foreignRoster = new IntegrityMonitor().inspect(snapshot, {
    expectedEpoch: 1,
    expectedBoatIds: ['boat-a', 'boat-b'],
    expectedSeed: 'integrity-seed',
  });
  const foreignSeed = new IntegrityMonitor().inspect(snapshot, {
    expectedEpoch: 1,
    expectedBoatIds: ['boat-a'],
    expectedSeed: 'different-seed',
  });
  const authorized = new IntegrityMonitor().inspect(snapshot, {
    expectedEpoch: 1,
    expectedBoatIds: ['boat-a'],
    expectedSeed: 'integrity-seed',
  });

  assert.equal(foreignRoster.status, 'invalidated');
  assert.ok(foreignRoster.reasons.some((reason) => reason.includes('authorized roster')));
  assert.equal(foreignSeed.status, 'invalidated');
  assert.ok(foreignSeed.reasons.some((reason) => reason.includes('authorized seed')));
  assert.equal(authorized.status, 'accepted');
});

test('IntegrityMonitor rejects a first authority state that lies about the 60 Hz start timeline', () => {
  const result = new IntegrityMonitor().inspect(
    makeSnapshot({ tick: 600, worldTime: 0.1, raceTime: 0.1 }),
    {
      expectedEpoch: 1,
      expectedBoatIds: ['boat-a'],
      expectedSeed: 'integrity-seed',
      expectedStartTick: 0,
    },
  );

  assert.equal(result.status, 'invalidated');
  assert.match(result.reasons.join(' '), /tick|worldTime|60 Hz|timeline/i);
});

test('IntegrityMonitor accepts legal first states on the original and migrated epochs', () => {
  const monitor = new IntegrityMonitor();
  const authorization = {
    expectedBoatIds: ['boat-a'],
    expectedSeed: 'integrity-seed',
    expectedStartTick: 540,
  };

  const original = monitor.inspect(makeSnapshot({ tick: 600, worldTime: 1 }), {
    ...authorization,
    expectedEpoch: 1,
  });
  monitor.reset();
  const migrated = monitor.inspect(makeSnapshot({ tick: 606, worldTime: 1.1, hostEpoch: 2 }), {
    ...authorization,
    expectedEpoch: 2,
  });

  assert.equal(original.status, 'accepted');
  assert.equal(migrated.status, 'accepted');
});

test('IntegrityMonitor allows only adjacent race-state transitions without rollback', () => {
  const skipMonitor = new IntegrityMonitor();
  const prestart = makeSnapshot({ raceTime: 0 });
  prestart.race.state = 'prestart';
  inspect(skipMonitor, prestart);
  const skipped = advance(prestart);
  skipped.race.state = 'finished';
  skipped.race.entries[0].finished = true;
  skipped.race.entries[0].finishT = skipped.race.t;
  skipped.race.results = [{ boatId: 'boat-a', time: skipped.race.t }];
  const skippedResult = inspect(skipMonitor, skipped);
  assert.equal(skippedResult.invalidated, true);
  assert.ok(skippedResult.reasons.some((reason) => reason.includes('race.state')));

  const rollbackMonitor = new IntegrityMonitor();
  const racing = makeSnapshot();
  inspect(rollbackMonitor, racing);
  const rolledBack = advance(racing);
  rolledBack.race.state = 'prestart';
  const rollbackResult = inspect(rollbackMonitor, rolledBack);
  assert.equal(rollbackResult.invalidated, true);
  assert.ok(rollbackResult.reasons.some((reason) => reason.includes('race.state')));
});

test('IntegrityMonitor rejects leg rollback, leg jumps, and finished rollback', () => {
  for (const nextLeg of [0, 3]) {
    const monitor = new IntegrityMonitor();
    const baseline = makeSnapshot();
    inspect(monitor, baseline);
    const changed = advance(baseline);
    changed.race.entries[0].leg = nextLeg;
    const result = inspect(monitor, changed);
    assert.equal(result.invalidated, true);
    assert.ok(result.reasons.some((reason) => reason.includes('leg')));
  }

  const finishedMonitor = new IntegrityMonitor();
  const finished = makeSnapshot();
  finished.race.state = 'finished';
  finished.race.entries[0].finished = true;
  finished.race.entries[0].finishT = 1;
  finished.race.results = [{ boatId: 'boat-a', time: 1 }];
  inspect(finishedMonitor, finished);
  const rollback = advance(finished);
  rollback.race.entries[0].finished = false;
  rollback.race.entries[0].finishT = 0;
  rollback.race.results = [];
  const rollbackResult = inspect(finishedMonitor, rollback);
  assert.equal(rollbackResult.invalidated, true);
  assert.ok(rollbackResult.reasons.some((reason) => reason.includes('finished')));
});

test('IntegrityMonitor requires splits to be ordered and preserve the previous prefix', () => {
  const prefixMonitor = new IntegrityMonitor();
  const baseline = makeSnapshot();
  baseline.race.entries[0].splits = [0.4, 0.8];
  inspect(prefixMonitor, baseline);
  const changed = advance(baseline);
  changed.race.entries[0].splits = [0.4, 0.9];
  const prefixResult = inspect(prefixMonitor, changed);
  assert.equal(prefixResult.invalidated, true);
  assert.ok(prefixResult.reasons.some((reason) => reason.includes('prefix')));

  const reversed = makeSnapshot();
  reversed.race.entries[0].splits = [0.8, 0.4];
  const reversedResult = inspect(new IntegrityMonitor(), reversed);
  assert.equal(reversedResult.invalidated, true);
  assert.ok(reversedResult.reasons.some((reason) => reason.includes('order')));
});

test('IntegrityMonitor requires results to match finished entries and finishT', () => {
  const unfinished = makeSnapshot();
  unfinished.race.results = [{ boatId: 'boat-a', time: 1 }];
  const unfinishedResult = inspect(new IntegrityMonitor(), unfinished);
  assert.equal(unfinishedResult.invalidated, true);

  const mismatched = makeSnapshot();
  mismatched.race.state = 'finished';
  mismatched.race.entries[0].finished = true;
  mismatched.race.entries[0].finishT = 1;
  mismatched.race.results = [{ boatId: 'boat-a', time: 1.1 }];
  const mismatchResult = inspect(new IntegrityMonitor(), mismatched);
  assert.equal(mismatchResult.invalidated, true);
  assert.ok(mismatchResult.reasons.some((reason) => reason.includes('finishT')));

  const missing = structuredClone(mismatched);
  missing.race.results = [];
  const missingResult = inspect(new IntegrityMonitor(), missing);
  assert.equal(missingResult.invalidated, true);
  assert.ok(missingResult.reasons.some((reason) => reason.includes('result')));
});
