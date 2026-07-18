import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRaceRoster,
  buildStartGrid,
  FixedStepAccumulator,
  MultiplayerRaceController,
  reconcilePredictedBoat,
  resolveRaceStartClock,
  restartModePolicy,
} from '../src/game/multiplayerRace.js';

const EMPTY_INTENT = Object.freeze({
  steerLeft: false,
  steerRight: false,
  sheetIn: false,
  sheetOut: false,
  hikeOut: false,
  hikeIn: false,
  boardDown: false,
  boardUp: false,
  righting: false,
});

class FakeSession extends EventTarget {
  constructor(role = 'host') {
    super();
    this.role = role;
    this.state = {
      role,
      playerId: role === 'host' ? 'player-a' : 'player-b',
      hostEpoch: 1,
      migrating: false,
      invalidated: false,
      members: [
        { playerId: 'player-a', connected: true, ready: true },
        { playerId: 'player-b', connected: true, ready: true },
      ],
    };
    this.configurations = [];
    this.updates = [];
  }

  configure(configuration) {
    this.configurations.push(configuration);
    this.configuration = configuration;
    return this;
  }

  update(value) {
    this.updates.push(value);
    return true;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setRole(role, migrating = false) {
    const previousRole = this.role;
    this.role = role;
    this.state = { ...this.state, role, migrating };
    this.emit('rolechange', { role, previousRole });
  }
}

function makeBoat(boatId, playerId = boatId) {
  return {
    boatId,
    playerId,
    isLocal: playerId === 'player-b',
    rudderCmd: 0,
    hikeLevel: 0,
    manualSheetAt: -99,
    phys: {
      x: 0,
      z: 0,
      psi: 0,
      u: 0,
      v: 0,
      yawRate: 0,
      phi: 0,
      phiRate: 0,
      boom: 0,
      rudder: 0,
      sheet: 1,
      board: 1,
      crewY: 0,
      rightProgress: 0,
      capsized: false,
      ctl: {
        rudder: 0,
        sheet: 1,
        board: 1,
        hike: 0,
        autoHike: true,
        righting: false,
        autoTrim: false,
      },
    },
  };
}

function makeRace(boats) {
  const entries = new Map(boats.map((boat) => [boat, {
    leg: 0,
    ocs: false,
    splits: [],
    finished: false,
    finishT: 0,
    prevX: 0,
    prevZ: 0,
  }]));
  return {
    state: 'prestart',
    t: -30,
    entries,
    results: [],
    captureState() {
      return {
        state: this.state,
        t: this.t,
        entries: boats.map((boat) => ({ boatId: boat.boatId, ...this.entries.get(boat), splits: [...this.entries.get(boat).splits] })),
        results: this.results.map(({ boat, time }) => ({ boatId: boat.boatId, time })),
      };
    },
    applyState(state) {
      this.state = state.state;
      this.t = state.t;
      for (const boat of boats) {
        const entry = state.entries.find((candidate) => candidate.boatId === boat.boatId);
        Object.assign(this.entries.get(boat), entry, { splits: [...entry.splits] });
        delete this.entries.get(boat).boatId;
      }
      this.results = state.results.map((result) => ({
        boat: boats.find((boat) => boat.boatId === result.boatId),
        time: result.time,
      }));
    },
  };
}

function makeCheckpoint(boats, race, overrides = {}) {
  return {
    tick: 120,
    worldTime: 2,
    seed: 'private-race',
    hostEpoch: 2,
    boats: boats.map((boat, index) => ({
      boatId: boat.boatId,
      phys: {
        ...boat.phys,
        x: 20 + index,
        ctl: { ...boat.phys.ctl },
      },
      control: {
        rudderCmd: boat.rudderCmd,
        hikeLevel: boat.hikeLevel,
        manualSheetAt: boat.manualSheetAt,
      },
    })),
    race: race.captureState(),
    ...overrides,
  };
}

test('FixedStepAccumulator advances a 60 Hz world independently of render cadence', () => {
  const clock = new FixedStepAccumulator({ hz: 60, tick: 10 });
  const steps = [];

  assert.equal(clock.advance(1 / 120, (dt, tick) => steps.push([dt, tick])), 0);
  assert.equal(clock.advance(1 / 120, (dt, tick) => steps.push([dt, tick])), 1);
  assert.equal(clock.advance(1 / 30, (dt, tick) => steps.push([dt, tick])), 2);
  assert.equal(clock.tick, 13);
  assert.deepEqual(steps.map(([, tick]) => tick), [11, 12, 13]);
  assert.ok(steps.every(([dt]) => Math.abs(dt - 1 / 60) < 1e-12));
});

test('buildRaceRoster keeps human ids stable and fills no more than eight boats', () => {
  const roster = buildRaceRoster({
    roster: [
      { playerId: 'player-a', nickname: '甲' },
      { playerId: 'player-b', nickname: '乙' },
    ],
    aiFill: 3,
    localPlayerId: 'player-b',
  });

  assert.deepEqual(roster.map(({ boatId }) => boatId), [
    'player-a', 'player-b', 'ai:0', 'ai:1', 'ai:2',
  ]);
  assert.equal(roster[1].isLocal, true);
  assert.equal(roster[0].isHuman, true);
  assert.equal(roster[2].isHuman, false);
  assert.throws(() => buildRaceRoster({
    roster: Array.from({ length: 8 }, (_, index) => ({
      playerId: `p-${index}`,
      nickname: `P${index}`,
    })),
    aiFill: 1,
  }), /eight|8/i);
});

test('buildStartGrid keeps all eight starting boats inside the 84 metre line', () => {
  const slots = buildStartGrid(8);

  assert.equal(slots.length, 8);
  assert.ok(slots.every(({ lateral }) => Math.abs(lateral) <= 37));
  assert.equal(new Set(slots.map(({ lateral }) => lateral)).size, 8);
  assert.deepEqual(new Set(slots.map(({ downwind }) => downwind)), new Set([46, 55]));
  assert.throws(() => buildStartGrid(1), /two|eight/i);
  assert.throws(() => buildStartGrid(9), /two|eight/i);
});

test('resolveRaceStartClock derives countdown state from authoritative startTick', () => {
  assert.deepEqual(resolveRaceStartClock({ tick: 120, startTick: 1_920 }), {
    tick: 120,
    startTick: 1_920,
    worldTime: 0,
    raceTime: -30,
    countdown: 30,
  });
  assert.throws(
    () => resolveRaceStartClock({ tick: 121, startTick: 120 }),
    /startTick/i,
  );
});

test('multiplayer restart policy preserves pause and menu state instead of resuming locally', () => {
  assert.deepEqual(restartModePolicy('multiplayer-race', true), {
    restart: false,
    paused: true,
  });
  assert.deepEqual(restartModePolicy('race', true), {
    restart: true,
    paused: false,
  });
});

test('disconnected humans use temporary AI control and restore human control on reconnect', () => {
  const session = new FakeSession('host');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race: makeRace(boats),
    seed: 'private-race',
    localPlayerId: 'player-a',
    controlProvider: () => EMPTY_INTENT,
  });

  controller.syncRoom({
    members: [
      { playerId: 'player-a', connected: true },
      { playerId: 'player-b', connected: false },
    ],
  });
  assert.deepEqual([...controller.takeoverPlayerIds], ['player-b']);
  assert.equal(controller.controlModeFor('player-b'), 'ai-takeover');

  controller.syncRoom({
    members: [
      { playerId: 'player-a', connected: true },
      { playerId: 'player-b', connected: true },
    ],
  });
  assert.equal(controller.takeoverPlayerIds.size, 0);
  assert.equal(controller.controlModeFor('player-b'), 'human');
});

test('AI takeover and reconnect discard stale remote controls', () => {
  const session = new FakeSession('host');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race: makeRace(boats),
    seed: 'private-race',
    localPlayerId: 'player-a',
  });
  session.emit('remote-input', {
    playerId: 'player-b',
    seq: 4,
    tick: 20,
    intent: { ...EMPTY_INTENT, steerRight: true },
  });
  assert.equal(controller.controlFor('player-b').steerRight, true);

  controller.syncRoom({
    members: [
      { playerId: 'player-a', connected: true },
      { playerId: 'player-b', connected: false },
    ],
  });
  controller.syncRoom({
    members: [
      { playerId: 'player-a', connected: true },
      { playerId: 'player-b', connected: true },
    ],
  });

  assert.deepEqual(controller.controlFor('player-b'), EMPTY_INTENT);
});

test('detach clears inputs, connectivity, takeover, snapshots, and fixed-step cadence', () => {
  const session = new FakeSession('host');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-a',
  });
  controller.advanceFrame(1 / 120, { now: 1_000 });
  session.emit('remote-input', {
    playerId: 'player-b',
    seq: 4,
    tick: 1,
    intent: { ...EMPTY_INTENT, steerRight: true },
  });
  controller.syncRoom({
    members: [
      { playerId: 'player-a', connected: true },
      { playerId: 'player-b', connected: false },
    ],
  });
  controller.snapshotBuffer.add(makeCheckpoint(boats, race, {
    hostEpoch: 1,
    tick: 1,
    worldTime: 1 / 60,
  }));

  controller.detach();

  assert.equal(controller.takeoverPlayerIds.size, 0);
  assert.equal(controller.snapshotBuffer.size, 0);
  assert.deepEqual(controller.controlFor('player-b'), EMPTY_INTENT);
  assert.equal(controller.controlModeFor('player-b'), 'human');

  const replacement = new FakeSession('host');
  controller.attach(replacement);
  assert.equal(controller.advanceFrame(1 / 120, { now: 1_100 }), 0);
});

test('online local pause does not stop authoritative fixed-step simulation', () => {
  const session = new FakeSession('host');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const authoritySteps = [];
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race: makeRace(boats),
    seed: 'private-race',
    localPlayerId: 'player-a',
    controlProvider: () => EMPTY_INTENT,
    authorityStep: (context) => authoritySteps.push(context),
  });

  controller.setLocalPaused(true);
  assert.equal(controller.advanceFrame(1 / 30, { now: 1_000 }), 2);
  assert.equal(authoritySteps.length, 2);
  assert.equal(authoritySteps[0].localPaused, true);
  assert.equal(session.updates.at(-1).tick, 2);
});

test('guest prediction never invokes authority collision or race adjudication', () => {
  const session = new FakeSession('guest');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  let authorityCalls = 0;
  let predictionCalls = 0;
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race: makeRace(boats),
    seed: 'private-race',
    localPlayerId: 'player-b',
    controlProvider: () => EMPTY_INTENT,
    authorityStep: () => { authorityCalls += 1; },
    predictionStep: () => { predictionCalls += 1; },
  });
  session.emit('snapshot', {
    snapshot: makeCheckpoint(boats, controller.race, {
      tick: 0,
      worldTime: 0,
      hostEpoch: 1,
    }),
  });

  controller.advanceFrame(1 / 30, { now: 1_000 });

  assert.equal(predictionCalls, 2);
  assert.equal(authorityCalls, 0);
});

test('a delayed guest start waits and fully rebases to the first authority tick and world time', () => {
  let now = 1_000;
  const session = new FakeSession('guest');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  let predictionCalls = 0;
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-b',
    tick: 120,
    startTick: 1_920,
    now: () => now,
    predictionStep: () => { predictionCalls += 1; },
  });

  assert.equal(controller.migrating, true);
  assert.equal(controller.advanceFrame(1 / 30, { now }), 0);
  assert.equal(predictionCalls, 0);
  assert.equal(session.updates.length, 0);

  const authority = makeCheckpoint(boats, race, {
    tick: 150,
    worldTime: 0.5,
    hostEpoch: 1,
  });
  authority.race.t = -29.5;
  authority.boats[0].phys.x = 30;
  authority.boats[1].phys.x = 31;
  now = 1_050;
  session.emit('snapshot', { snapshot: authority });

  assert.equal(controller.migrating, false);
  assert.equal(controller.tick, 150);
  assert.equal(controller.worldTime, 0.5);
  assert.equal(controller.startTick, 1_920);
  assert.equal(race.t, -29.5);
  assert.equal(boats[0].phys.x, 30);
  assert.equal(boats[1].phys.x, 31);
});

test('guest host-clock estimate catches up safely after a five second background stall', () => {
  let now = 1_000;
  const session = new FakeSession('guest');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  const environments = [];
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-b',
    tick: 120,
    startTick: 1_920,
    worldTime: 2,
    now: () => now,
    onApplyEnvironment: (state) => environments.push(state),
  });
  session.emit('snapshot', {
    snapshot: makeCheckpoint(boats, race, {
      hostEpoch: 1,
      tick: 120,
      worldTime: 2,
    }),
  });

  now = 6_000;
  assert.equal(controller.advanceFrame(0.09), 5);

  assert.equal(controller.tick, 420);
  assert.ok(Math.abs(controller.worldTime - 7) < 1e-9);
  assert.ok(Math.abs(controller.estimatedHostWorldTime(now) - 7) < 1e-9);
  assert.equal(environments.at(-1).tick, 420);
  assert.ok(Math.abs(environments.at(-1).worldTime - 7) < 1e-9);
});

test('a reliable checkpoint also rebases the guest authoritative clock', () => {
  let now = 1_000;
  const session = new FakeSession('guest');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-b',
    tick: 120,
    startTick: 1_920,
    worldTime: 2,
    now: () => now,
  });
  session.emit('snapshot', {
    snapshot: makeCheckpoint(boats, race, {
      hostEpoch: 1,
      tick: 120,
      worldTime: 2,
    }),
  });

  now = 1_100;
  session.emit('checkpoint', {
    checkpoint: makeCheckpoint(boats, race, {
      hostEpoch: 1,
      tick: 126,
      worldTime: 2.1,
    }),
  });

  assert.equal(controller.tick, 126);
  assert.ok(Math.abs(controller.worldTime - 2.1) < 1e-9);
  assert.ok(Math.abs(controller.estimatedHostWorldTime(now) - 2.1) < 1e-9);
});

test('clock rebasing is the final environment update for a delayed authority snapshot', () => {
  let now = 1_000;
  const session = new FakeSession('guest');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  const environmentUpdates = [];
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-b',
    tick: 120,
    startTick: 1_920,
    worldTime: 2,
    now: () => now,
    onAuthoritySnapshot: (state) => environmentUpdates.push(['authority', state.worldTime]),
    onApplyEnvironment: (state) => environmentUpdates.push(['clock', state.worldTime]),
  });
  session.emit('snapshot', {
    snapshot: makeCheckpoint(boats, race, {
      hostEpoch: 1,
      tick: 120,
      worldTime: 2,
    }),
  });

  now = 1_100;
  session.emit('snapshot', {
    snapshot: makeCheckpoint(boats, race, {
      hostEpoch: 1,
      tick: 123,
      worldTime: 2.05,
    }),
  });

  assert.deepEqual(environmentUpdates.at(-1), ['clock', 2.1]);
});

test('remote interpolation samples 125ms behind estimated host world time', () => {
  let now = 1_000;
  const session = new FakeSession('guest');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-b',
    tick: 600,
    startTick: 2_400,
    worldTime: 10,
    now: () => now,
  });
  const first = makeCheckpoint(boats, race, {
    hostEpoch: 1,
    tick: 600,
    worldTime: 10,
  });
  first.boats[0].phys.x = 0;
  session.emit('snapshot', { snapshot: first });

  now = 1_050;
  const second = makeCheckpoint(boats, race, {
    hostEpoch: 1,
    tick: 603,
    worldTime: 10.05,
  });
  second.boats[0].phys.x = 10;
  session.emit('snapshot', { snapshot: second });

  now = 1_175;
  const rendered = controller.sampleRemoteBoats({ now });

  assert.ok(Math.abs(controller.estimatedHostWorldTime(now) - 10.175) < 1e-9);
  assert.equal(rendered.renderOnly, true);
  assert.ok(Math.abs(boats[0].phys.x - 10) < 1e-9);
});

test('guest applies authoritative race and environment while rendering only remote buffered boats', () => {
  let now = 1_000;
  const session = new FakeSession('guest');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  const environments = [];
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-b',
    now: () => now,
    onAuthoritySnapshot: (state) => environments.push(state.worldTime),
  });
  const baseline = makeCheckpoint(boats, race, {
    hostEpoch: 1,
    tick: 120,
    worldTime: 2,
  });
  baseline.boats[0].phys.x = 0;
  baseline.boats[1].phys.x = 0;
  controller.receiveAuthoritySnapshot(baseline);
  now = 1_050;
  const snapshot = makeCheckpoint(boats, race, {
    hostEpoch: 1,
    tick: 123,
    worldTime: 2.05,
  });
  snapshot.race.state = 'racing';
  snapshot.race.t = 1.55;
  snapshot.boats[0].phys.x = 20;
  snapshot.boats[1].phys.x = 0.5;

  assert.equal(controller.receiveAuthoritySnapshot(snapshot), true);
  const localAfterCorrection = boats[1].phys.x;
  now = 1_175;
  const rendered = controller.sampleRemoteBoats({ now });

  assert.equal(rendered.renderOnly, true);
  assert.equal(boats[0].phys.x, 20);
  assert.equal(boats[1].phys.x, localAfterCorrection);
  assert.ok(localAfterCorrection > 0 && localAfterCorrection < 0.5);
  assert.equal(race.state, 'racing');
  assert.equal(race.t, 1.55);
  assert.deepEqual(environments, [2.05]);
});

test('non-finite local prediction state forces a complete hard authority snap', () => {
  const boat = makeBoat('player-b');
  const authority = makeCheckpoint([boat], makeRace([boat])).boats[0];
  authority.phys.x = 12;
  authority.phys.u = 3;
  authority.control.rudderCmd = 0.4;
  boat.phys.x = Number.NaN;
  boat.phys.u = Number.POSITIVE_INFINITY;
  boat.rudderCmd = Number.NaN;

  assert.equal(reconcilePredictedBoat(boat, authority), 'hard');
  assert.equal(boat.phys.x, 12);
  assert.equal(boat.phys.u, 3);
  assert.equal(boat.rudderCmd, 0.4);
  assert.ok(Object.values(boat.phys).filter((value) => typeof value === 'number').every(Number.isFinite));
});

test('promotion applies the latest checkpoint before host fixed-step simulation resumes', () => {
  const session = new FakeSession('guest');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  let authorityCalls = 0;
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-b',
    controlProvider: () => EMPTY_INTENT,
    authorityStep: () => { authorityCalls += 1; },
  });
  const checkpoint = makeCheckpoint(boats, race);

  session.setRole('host', true);
  session.emit('promote', { checkpoint });

  assert.equal(controller.tick, 120);
  assert.equal(controller.worldTime, 2);
  assert.equal(controller.seed, 'private-race');
  assert.equal(boats[0].phys.x, 20);
  assert.equal(controller.advanceFrame(1 / 30, { now: 2_000 }), 0);

  session.state = { ...session.state, migrating: false };
  session.emit('migration-ready', { hostEpoch: 2, tick: 120 });
  assert.equal(controller.advanceFrame(1 / 30, { now: 2_034 }), 2);
  assert.equal(authorityCalls, 2);
});

test('host demotion pauses and accepts a complete new-epoch checkpoint with 0.5s rollback', () => {
  const session = new FakeSession('host');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-a',
    tick: 630,
    startTick: 1_800,
    worldTime: 10.5,
  });
  session.emit('remote-input', {
    playerId: 'player-b',
    seq: 9,
    tick: 629,
    intent: { ...EMPTY_INTENT, steerRight: true },
  });

  session.role = 'guest';
  session.state = {
    ...session.state,
    role: 'guest',
    hostEpoch: 2,
    migrating: false,
  };
  session.emit('rolechange', { role: 'guest', previousRole: 'host' });

  assert.equal(controller.migrating, true);
  assert.equal(controller.snapshotBuffer.size, 0);
  assert.deepEqual(controller.controlFor('player-b'), EMPTY_INTENT);
  assert.equal(controller.advanceFrame(1 / 30, { now: 2_000 }), 0);

  const checkpoint = makeCheckpoint(boats, race, {
    hostEpoch: 2,
    tick: 600,
    worldTime: 10,
  });
  checkpoint.boats[0].phys.x = 40;
  checkpoint.race.t = -20;
  session.emit('checkpoint', { checkpoint });

  assert.equal(controller.migrating, false);
  assert.equal(controller.tick, 600);
  assert.equal(controller.worldTime, 10);
  assert.equal(boats[0].phys.x, 40);
  assert.equal(race.t, -20);
});

test('a guest staying guest across a new epoch waits for first accepted authority', () => {
  const session = new FakeSession('guest');
  const boats = [makeBoat('player-a'), makeBoat('player-b')];
  const race = makeRace(boats);
  const controller = new MultiplayerRaceController({
    session,
    boats,
    race,
    seed: 'private-race',
    localPlayerId: 'player-b',
    tick: 100,
    startTick: 1_900,
    worldTime: 1,
  });
  session.emit('snapshot', {
    snapshot: makeCheckpoint(boats, race, {
      hostEpoch: 1,
      tick: 100,
      worldTime: 1,
    }),
  });
  assert.equal(controller.migrating, false);

  session.state = {
    ...session.state,
    role: 'guest',
    hostEpoch: 2,
    migrating: false,
  };
  session.emit('statechange', session.state);

  assert.equal(controller.migrating, true);
  assert.equal(controller.snapshotBuffer.size, 0);
  assert.equal(controller.advanceFrame(1 / 30, { now: 3_000 }), 0);

  const authority = makeCheckpoint(boats, race, {
    hostEpoch: 2,
    tick: 98,
    worldTime: 0.9666666666666667,
  });
  authority.boats[1].phys.x = 77;
  session.emit('snapshot', { snapshot: authority });

  assert.equal(controller.migrating, false);
  assert.equal(controller.tick, 98);
  assert.equal(controller.worldTime, authority.worldTime);
  assert.equal(boats[1].phys.x, 77);
});
