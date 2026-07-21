import assert from 'node:assert/strict';
import test from 'node:test';

import { RaceManager } from '../src/game/race.js';

function makeBoat(boatId, x) {
  return {
    boatId,
    isPlayer: boatId === 'player-a',
    nameKey: 'name.you',
    phys: { x, z: 0 },
  };
}

function makeCourse() {
  return {
    lineMid: { x: 0, z: 0 },
    marks: [{ x: 100, z: 0, nameKey: 'race.mark.wind' }],
    legs: [
      { type: 'start', key: 'race.leg.start' },
      { type: 'mark', mark: 0, key: 'race.leg.up', lap: 1 },
      { type: 'finish', key: 'race.leg.finish' },
    ],
    crossesLine: () => false,
    isUpwindOfLine: () => false,
    legLabel: () => 'upwind mark',
  };
}

test('RaceManager captures JSON-only state keyed by stable boatId', () => {
  const boats = [makeBoat('player-a', 5), makeBoat('player-b', 15)];
  const race = new RaceManager(makeCourse(), boats, 30);
  race.state = 'racing';
  race.t = 12.5;
  Object.assign(race.entries.get(boats[0]), {
    leg: 1,
    splits: [4.5],
    prevX: 4,
  });
  Object.assign(race.entries.get(boats[1]), {
    leg: 2,
    finished: true,
    finishT: 12.25,
  });
  race.results.push({ boat: boats[1], time: 12.25 });

  const snapshot = race.captureState();

  assert.deepEqual(snapshot, {
    state: 'racing',
    t: 12.5,
    entries: [
      {
        boatId: 'player-a',
        leg: 1,
        ocs: false,
        splits: [4.5],
        finished: false,
        finishT: 0,
        prevX: 4,
        prevZ: 0,
        roundAcc: 0,
        nearMark: false,
      },
      {
        boatId: 'player-b',
        leg: 2,
        ocs: false,
        splits: [],
        finished: true,
        finishT: 12.25,
        prevX: 15,
        prevZ: 0,
        roundAcc: 0,
        nearMark: false,
      },
    ],
    results: [{ boatId: 'player-b', time: 12.25 }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);

  race.entries.get(boats[0]).splits.push(99);
  race.results[0].time = 99;
  assert.deepEqual(snapshot.entries[0].splits, [4.5]);
  assert.equal(snapshot.results[0].time, 12.25);
});

test('RaceManager restores by boatId while preserving its Map and boat identities', () => {
  const localB = makeBoat('player-b', 250);
  const localA = makeBoat('player-a', 150);
  const race = new RaceManager(makeCourse(), [localB, localA], 10);
  const entriesIdentity = race.entries;
  const localAEntryIdentity = race.entries.get(localA);
  const snapshot = {
    state: 'racing',
    t: 18.75,
    entries: [
      {
        boatId: 'player-a', leg: 1, ocs: true, splits: [9.25], finished: false,
        finishT: 0, prevX: 9, prevZ: -1, roundAcc: 0.5, nearMark: true,
      },
      {
        boatId: 'player-b', leg: 2, ocs: false, splits: [8, 17], finished: true,
        finishT: 18.5, prevX: 19, prevZ: 2, roundAcc: 0, nearMark: false,
      },
    ],
    results: [{ boatId: 'player-b', time: 18.5 }],
  };

  race.applyState(snapshot);

  assert.equal(race.entries, entriesIdentity);
  assert.equal(race.entries.get(localA), localAEntryIdentity);
  assert.equal(race.entries.get(localA).leg, 1);
  assert.deepEqual(race.entries.get(localB).splits, [8, 17]);
  assert.deepEqual(race.results, [{ boat: localB, time: 18.5 }]);
  assert.deepEqual(race.standings(), [localB, localA]);
  assert.equal(race.targetFor(localA), race.course.marks[0]);
  assert.doesNotThrow(() => race.playerStatus(localA));

  snapshot.entries[0].splits.push(100);
  snapshot.results[0].time = 100;
  assert.deepEqual(race.entries.get(localA).splits, [9.25]);
  assert.equal(race.results[0].time, 18.5);
});

test('RaceManager rejects incomplete or mismatched boatId snapshots before mutation', () => {
  const boats = [makeBoat('player-a', 5), makeBoat('player-b', 15)];
  const race = new RaceManager(makeCourse(), boats, 30);
  const before = race.captureState();

  assert.throws(() => race.applyState({
    ...before,
    entries: before.entries.slice(0, 1),
  }), /every boat|missing/i);
  assert.deepEqual(race.captureState(), before);

  assert.throws(() => race.applyState({
    ...before,
    results: [{ boatId: 'intruder', time: 1 }],
  }), /intruder|unknown/i);
  assert.deepEqual(race.captureState(), before);
});

test('race finish messages use the temporary multiplayer nickname', () => {
  const boat = makeBoat('player-a', 5);
  boat.displayName = 'Skipper 七';
  const course = makeCourse();
  course.crossesLine = () => true;
  course.isUpwindOfLine = () => true; // 终点要求正向(向上风)穿越
  const race = new RaceManager(course, [boat], 0);
  race.state = 'racing';
  race.t = 4;
  race.entries.get(boat).leg = 2;

  race.update(0.1);

  assert.equal(race.entries.get(boat).finished, true);
  assert.ok(race.takeEvents().some((message) => message.includes('Skipper 七')));
});
