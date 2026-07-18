import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyWorldState,
  captureWorldState,
  cloneWorldState,
  decodeWorldStateJson,
  MAX_RACE_LEG,
  MAX_WORLD_STATE_BYTES,
} from '../src/net/worldState.js';

function makeBoat(boatId, offset = 0) {
  return {
    boatId,
    phys: {
      x: 10 + offset,
      z: -20 - offset,
      psi: 0.1 + offset * 0.01,
      u: 3 + offset,
      v: -0.2 - offset * 0.01,
      yawRate: 0.03 + offset * 0.001,
      phi: -0.1 + offset * 0.001,
      phiRate: 0.02 + offset * 0.001,
      boom: 0.4 + offset * 0.001,
      rudder: -0.2 + offset * 0.001,
      sheet: 0.6,
      board: 0.8,
      crewY: -0.35,
      capsized: false,
      rightProgress: 0.25,
      ctl: {
        rudder: 0.5,
        sheet: 0.55,
        board: 0.75,
        hike: -0.4,
        autoHike: true,
        righting: false,
        autoTrim: true,
      },
    },
    rudderCmd: 0.45,
    hikeLevel: -0.3,
    manualSheetAt: 12.5 + offset,
  };
}

function makeRace(boats) {
  return {
    state: 'racing',
    t: 18.75,
    entries: new Map(boats.map((boat, index) => [boat, {
      leg: index + 1,
      ocs: index === 1,
      splits: [4.25 + index, 9.5 + index],
      finished: index === 1,
      finishT: index === 1 ? 18.5 : 0,
      prevX: boat.phys.x - 0.5,
      prevZ: boat.phys.z + 0.25,
    }])),
    results: [{ boat: boats[1], time: 18.5 }],
  };
}

function captureFixture() {
  const boats = [makeBoat('boat-a'), makeBoat('boat-b', 1)];
  const race = makeRace(boats);
  const snapshot = captureWorldState({
    tick: 720,
    worldTime: 12,
    seed: 'private-race-42',
    hostEpoch: 3,
    boats,
    race,
  });
  return { boats, race, snapshot };
}

function makeApplyTarget() {
  const boats = [makeBoat('boat-a', 10), makeBoat('boat-b', 20)];
  return {
    tick: 1,
    worldTime: 1,
    seed: 'old-seed',
    hostEpoch: 1,
    boats,
    race: makeRace(boats),
  };
}

test('captureWorldState captures every authoritative boat and control field as JSON data', () => {
  const { boats, snapshot } = captureFixture();

  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['boats', 'hostEpoch', 'race', 'seed', 'tick', 'worldTime'],
  );
  assert.deepEqual(snapshot.boats[0], {
    boatId: 'boat-a',
    phys: {
      x: 10,
      z: -20,
      psi: 0.1,
      u: 3,
      v: -0.2,
      yawRate: 0.03,
      phi: -0.1,
      phiRate: 0.02,
      boom: 0.4,
      rudder: -0.2,
      sheet: 0.6,
      board: 0.8,
      crewY: -0.35,
      capsized: false,
      rightProgress: 0.25,
      ctl: {
        rudder: 0.5,
        sheet: 0.55,
        board: 0.75,
        hike: -0.4,
        autoHike: true,
        righting: false,
        autoTrim: true,
      },
    },
    control: {
      rudderCmd: 0.45,
      hikeLevel: -0.3,
      manualSheetAt: 12.5,
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  assert.equal(snapshot.race.entries[0].boatId, boats[0].boatId);
  assert.equal(snapshot.race.entries[1].boatId, boats[1].boatId);
  assert.deepEqual(snapshot.race.results, [{ boatId: 'boat-b', time: 18.5 }]);
  assert.equal(snapshot.race.entries.some((entry) => 'boat' in entry), false);
});

test('captured state shares no nested references with boats or race state', () => {
  const { boats, race, snapshot } = captureFixture();

  boats[0].phys.ctl.sheet = 0.1;
  race.entries.get(boats[0]).splits.push(99);
  race.results[0].time = 99;
  snapshot.boats[1].phys.ctl.board = 0.2;
  snapshot.race.entries[1].splits.push(77);

  assert.equal(snapshot.boats[0].phys.ctl.sheet, 0.55);
  assert.deepEqual(snapshot.race.entries[0].splits, [4.25, 9.5]);
  assert.deepEqual(snapshot.race.results, [{ boatId: 'boat-b', time: 18.5 }]);
  assert.equal(boats[1].phys.ctl.board, 0.75);
  assert.deepEqual(race.entries.get(boats[1]).splits, [5.25, 10.5]);
});

test('applyWorldState restores by boatId rather than source object identity', () => {
  const { snapshot } = captureFixture();
  const localBoats = [makeBoat('boat-b', 50), makeBoat('boat-a', 60)];
  const localRace = makeRace(localBoats);
  const target = {
    tick: 0,
    worldTime: 0,
    seed: 'old-seed',
    hostEpoch: 0,
    boats: localBoats,
    race: localRace,
  };

  const applied = applyWorldState(snapshot, target);

  const localA = localBoats.find((boat) => boat.boatId === 'boat-a');
  const localB = localBoats.find((boat) => boat.boatId === 'boat-b');
  assert.equal(localA.phys.x, 10);
  assert.equal(localA.rudderCmd, 0.45);
  assert.deepEqual(localA.phys.ctl, snapshot.boats[0].phys.ctl);
  assert.equal(localRace.state, 'racing');
  assert.equal(localRace.t, 18.75);
  assert.equal(localRace.entries.get(localA).leg, 1);
  assert.equal(localRace.entries.get(localB).leg, 2);
  assert.deepEqual(localRace.results, [{ boat: localB, time: 18.5 }]);
  assert.deepEqual(
    {
      tick: target.tick,
      worldTime: target.worldTime,
      seed: target.seed,
      hostEpoch: target.hostEpoch,
    },
    { tick: 720, worldTime: 12, seed: 'private-race-42', hostEpoch: 3 },
  );
  assert.deepEqual(applied, snapshot);
  assert.notEqual(applied, snapshot);
});

test('applyWorldState does not retain nested references from its snapshot input', () => {
  const { snapshot } = captureFixture();
  const localBoats = [makeBoat('boat-a', 10), makeBoat('boat-b', 20)];
  const localRace = makeRace(localBoats);

  applyWorldState(snapshot, { boats: localBoats, race: localRace });
  snapshot.boats[0].phys.ctl.sheet = 0;
  snapshot.race.entries[0].splits.push(100);
  snapshot.race.results[0].time = 100;

  assert.equal(localBoats[0].phys.ctl.sheet, 0.55);
  assert.deepEqual(localRace.entries.get(localBoats[0]).splits, [4.25, 9.5]);
  assert.equal(localRace.results[0].time, 18.5);
});

test('cloneWorldState rejects non-finite, missing, duplicate, and unknown schema data', () => {
  const { snapshot } = captureFixture();

  const nonFinite = structuredClone(snapshot);
  nonFinite.boats[0].phys.x = Number.NaN;
  assert.throws(() => cloneWorldState(nonFinite), /finite/i);

  const missing = structuredClone(snapshot);
  delete missing.boats[0].control.manualSheetAt;
  assert.throws(() => cloneWorldState(missing), /manualSheetAt/);

  const duplicate = structuredClone(snapshot);
  duplicate.boats[1].boatId = duplicate.boats[0].boatId;
  assert.throws(() => cloneWorldState(duplicate), /duplicate/i);

  const unknown = structuredClone(snapshot);
  unknown.boats[0].phys.teleport = true;
  assert.throws(() => cloneWorldState(unknown), /unknown/i);
});

test('applyWorldState validates the full snapshot before mutating any target', () => {
  const { snapshot } = captureFixture();
  const localBoats = [makeBoat('boat-a', 10), makeBoat('boat-b', 20)];
  const localRace = makeRace(localBoats);
  const before = localBoats[0].phys.x;
  const invalid = structuredClone(snapshot);
  invalid.race.results[0].boatId = 'missing-boat';

  assert.throws(
    () => applyWorldState(invalid, { boats: localBoats, race: localRace }),
    /missing-boat/,
  );
  assert.equal(localBoats[0].phys.x, before);
});

test('applyWorldState leaves every target field unchanged when a later boat is frozen', () => {
  const { snapshot } = captureFixture();
  const target = makeApplyTarget();
  const before = captureWorldState(target);
  Object.freeze(target.boats[1].phys);

  assert.throws(() => applyWorldState(snapshot, target), /writable|plain|frozen|read only/i);
  assert.deepEqual(captureWorldState(target), before);
});

test('applyWorldState rejects accessor targets before changing boats or race state', () => {
  const { snapshot } = captureFixture();
  const target = makeApplyTarget();
  const before = captureWorldState(target);
  Object.defineProperty(target, 'tick', {
    configurable: true,
    enumerable: true,
    get: () => 1,
    set: () => { throw new Error('tick setter ran'); },
  });

  assert.throws(() => applyWorldState(snapshot, target), /data property|accessor/i);
  assert.deepEqual(captureWorldState(target), before);
});

test('applyWorldState rejects Map subclasses before changing any target field', () => {
  class ThrowingMap extends Map {
    clear() {
      throw new Error('clear must never run');
    }
  }

  const { snapshot } = captureFixture();
  const target = makeApplyTarget();
  target.race.entries = new ThrowingMap(target.race.entries);
  const before = captureWorldState(target);

  assert.throws(() => applyWorldState(snapshot, target), /native Map/i);
  assert.deepEqual(captureWorldState(target), before);
});

test('world-state schema bounds boats, identifiers, seed, splits, and results', () => {
  const { snapshot } = captureFixture();

  const tooManyBoats = structuredClone(snapshot);
  for (let index = 2; index < 9; index += 1) {
    const boat = structuredClone(snapshot.boats[0]);
    boat.boatId = `boat-${index}`;
    tooManyBoats.boats.push(boat);
    tooManyBoats.race.entries.push({
      ...structuredClone(snapshot.race.entries[0]),
      boatId: boat.boatId,
    });
  }
  assert.throws(() => cloneWorldState(tooManyBoats), /one to eight boats/i);

  const longId = structuredClone(snapshot);
  longId.boats[0].boatId = 'b'.repeat(129);
  longId.race.entries[0].boatId = longId.boats[0].boatId;
  assert.throws(() => cloneWorldState(longId), /boatId.*128/i);

  const longSeed = structuredClone(snapshot);
  longSeed.seed = 's'.repeat(257);
  assert.throws(() => cloneWorldState(longSeed), /seed.*256/i);

  const tooManySplits = structuredClone(snapshot);
  tooManySplits.race.entries[0].splits = Array.from({ length: 17 }, (_, index) => index);
  assert.throws(() => cloneWorldState(tooManySplits), /splits.*16/i);

  const tooManyEntries = structuredClone(snapshot);
  tooManyEntries.race.entries = Array.from({ length: 9 }, () => (
    structuredClone(snapshot.race.entries[0])
  ));
  assert.throws(() => cloneWorldState(tooManyEntries), /entries.*8/i);

  const tooManyResults = structuredClone(snapshot);
  tooManyResults.race.results = Array.from({ length: 9 }, () => ({
    boatId: 'boat-b',
    time: 18.5,
  }));
  assert.throws(() => cloneWorldState(tooManyResults), /results.*8/i);
});

test('world-state schema accepts only explicit race-state enum values', () => {
  const { snapshot } = captureFixture();
  snapshot.race.state = 'teleporting';

  assert.throws(() => cloneWorldState(snapshot), /prestart.*racing.*finished/i);
});

test('world-state schema rejects race legs beyond the canonical course', () => {
  const { snapshot } = captureFixture();
  snapshot.race.entries[0].leg = MAX_RACE_LEG + 1;

  assert.throws(() => cloneWorldState(snapshot), /leg.*between 0 and 5/i);
});

test('decodeWorldStateJson enforces the 64 KiB encoded payload limit before parsing', () => {
  const { snapshot } = captureFixture();
  assert.deepEqual(decodeWorldStateJson(JSON.stringify(snapshot)), snapshot);

  const oversized = `${' '.repeat(MAX_WORLD_STATE_BYTES)}{}`;
  assert.throws(() => decodeWorldStateJson(oversized), /65536|64 KiB/i);
  assert.throws(
    () => decodeWorldStateJson(new TextEncoder().encode(oversized)),
    /65536|64 KiB/i,
  );
});
