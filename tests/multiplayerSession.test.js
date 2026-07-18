import assert from 'node:assert/strict';
import test from 'node:test';

import { IntegrityMonitor } from '../src/net/integrityMonitor.js';
import {
  MultiplayerSession,
  leaveOrCloseMultiplayer,
} from '../src/net/multiplayerSession.js';

function emit(target, type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail });
  target.dispatchEvent(event);
}

class FakeSignaling extends EventTarget {
  constructor(playerId) {
    super();
    this.state = Object.freeze({ playerId, room: null });
    this.leaveCalls = 0;
    this.closeCalls = 0;
    this.leaveResult = true;
  }

  room(room) {
    emit(this, 'room-view', { room });
  }

  hostChanged(detail) {
    emit(this, 'host-changed', detail);
  }

  domain(detail) {
    emit(this, 'domain-event', detail);
  }

  stateChange(patch) {
    this.state = Object.freeze({ ...this.state, ...patch });
    emit(this, 'statechange', this.state);
  }

  leave() {
    this.leaveCalls += 1;
    return this.leaveResult;
  }

  close() { this.closeCalls += 1; }
}

class FakeTransport extends EventTarget {
  constructor() {
    super();
    this.toHost = [];
    this.broadcasts = [];
    this.reliablePreflights = [];
    this.reliableAvailable = true;
    this.broadcastResults = [];
    this.topologies = [];
    this.closed = false;
  }

  sendToHost(message, options) {
    this.toHost.push({ message, options });
  }

  broadcast(message, options) {
    this.broadcasts.push({ message, options });
    return this.broadcastResults.length > 0 ? this.broadcastResults.shift() : true;
  }

  canBroadcastReliable(messageOrMessages, options) {
    this.reliablePreflights.push({ messageOrMessages, options });
    return this.reliableAvailable;
  }

  receive(sourceId, message, { reliable = false } = {}) {
    emit(this, 'message', { sourceId, message, reliable });
  }

  ready(hostEpoch) {
    emit(this, 'ready', { hostEpoch });
  }

  topology(detail) {
    emit(this, 'topology', detail);
  }

  peerOpen(detail) {
    emit(this, 'peer-open', detail);
  }

  peerClose(detail) {
    emit(this, 'peer-close', detail);
  }

  reconcileTopology(room) {
    this.topologies.push(room);
    return true;
  }

  close() {
    this.closed = true;
  }
}

class FakeClock {
  constructor(now = 0) {
    this.time = now;
  }

  now = () => this.time;

  advance(milliseconds) {
    this.time += milliseconds;
  }
}

class FakeTimers {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.tasks = new Map();
    this.callbacks = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.time + delay, callback });
    this.callbacks.set(id, callback);
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  get pendingCount() {
    return this.tasks.size;
  }

  pendingDelays() {
    return [...this.tasks.values()]
      .map(({ at }) => at - this.time)
      .sort((left, right) => left - right);
  }

  callback(id) {
    return this.callbacks.get(id);
  }

  advance(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.time = task.at;
      task.callback();
    }
    this.time = target;
  }
}

class FakeIntegrityMonitor {
  constructor() {
    this.calls = [];
    this.outcomes = [];
    this.resetCalls = 0;
  }

  queue(outcome) {
    this.outcomes.push(outcome);
  }

  inspect(state, authorization) {
    this.calls.push({ state: structuredClone(state), authorization: { ...authorization } });
    const queued = this.outcomes.shift();
    if (queued) return queued;
    return {
      status: 'accepted',
      ignored: false,
      invalidated: false,
      reasons: [],
      snapshot: structuredClone(state),
    };
  }

  reset() {
    this.resetCalls += 1;
  }
}

function makeRoom({
  hostId = 'host',
  hostEpoch = 1,
  localId = 'guest',
  includeGuest = true,
  phase = 'lobby',
  start,
} = {}) {
  const ids = includeGuest ? ['host', 'guest'] : [localId];
  if (!ids.includes(hostId)) ids.push(hostId);
  if (!ids.includes(localId)) ids.push(localId);
  const room = {
    roomCode: 'AB2CD9',
    hostId,
    hostEpoch,
    phase,
    members: ids.map((playerId, index) => ({
      playerId,
      nickname: playerId,
      joinOrder: index + 1,
      connected: true,
      ready: true,
      isHost: playerId === hostId,
    })),
  };
  if (start !== undefined) room.start = start;
  return room;
}

function makeWorldState({ tick = 60, worldTime = 1, hostEpoch = 1, x = 0 } = {}) {
  return {
    tick,
    worldTime,
    seed: 'session-seed',
    hostEpoch,
    boats: [{
      boatId: 'boat-a',
      phys: {
        x,
        z: 0,
        psi: 0,
        u: 2,
        v: 0,
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
        prevZ: 0,
      }],
      results: [],
    },
  };
}

function makeAuthorizedWorldState({
  tick = 60,
  worldTime = 1,
  hostEpoch = 1,
  seed = 'race-seed',
  boatIds = ['host', 'guest', 'ai:0'],
  x = 0,
} = {}) {
  const state = makeWorldState({ tick, worldTime, hostEpoch, x });
  const boatTemplate = state.boats[0];
  const entryTemplate = state.race.entries[0];
  state.seed = seed;
  state.boats = boatIds.map((boatId, index) => ({
    ...structuredClone(boatTemplate),
    boatId,
    phys: {
      ...structuredClone(boatTemplate.phys),
      x: x + index,
    },
  }));
  state.race.entries = boatIds.map((boatId, index) => ({
    ...structuredClone(entryTemplate),
    boatId,
    prevX: x + index,
  }));
  return state;
}

const CONTROL = Object.freeze({
  steerLeft: true,
  steerRight: false,
  sheetIn: false,
  sheetOut: true,
  hikeOut: false,
  hikeIn: false,
  boardDown: false,
  boardUp: false,
  righting: false,
});

const START_CONFIG = Object.freeze({
  windPsi: 0.25,
  windKn: 12,
  gustiness: 0.25,
  countdown: 30,
  startTick: 1_920,
  roster: Object.freeze([
    Object.freeze({ playerId: 'host', nickname: 'host' }),
    Object.freeze({ playerId: 'guest', nickname: 'guest' }),
  ]),
  aiFill: 1,
});

function startConfigForTick(tick, playerIds = ['host', 'guest']) {
  return {
    ...START_CONFIG,
    startTick: tick + START_CONFIG.countdown * 60,
    roster: playerIds.map((playerId) => ({ playerId, nickname: playerId })),
  };
}

function startDescriptorForTick(tick = 120, playerIds = ['host', 'guest']) {
  return {
    tick,
    seed: 'race-seed',
    config: startConfigForTick(tick, playerIds),
  };
}

function receiveStartRace(transport, {
  tick = 0,
  seed = 'race-seed',
  playerIds = ['host', 'guest'],
  aiFill = START_CONFIG.aiFill,
  sourceId = 'host',
  roomCode = 'AB2CD9',
  hostEpoch = 1,
} = {}) {
  transport.receive(sourceId, {
    type: 'start-race',
    roomCode,
    hostEpoch,
    tick,
    seed,
    config: { ...startConfigForTick(tick, playerIds), aiFill },
  }, { reliable: true });
}

function makeHarness({
  playerId = 'guest',
  clock = new FakeClock(),
  timers = new FakeTimers(),
  integrityMonitor = new FakeIntegrityMonitor(),
  ...options
} = {}) {
  const signaling = new FakeSignaling(playerId);
  const transport = new FakeTransport();
  const session = new MultiplayerSession({
    signaling,
    transport,
    integrityMonitor,
    clock,
    timers,
    ...options,
  });
  return { signaling, transport, integrityMonitor, clock, timers, session };
}

function collect(target, type) {
  const details = [];
  target.addEventListener(type, (event) => details.push(event.detail));
  return details;
}

function enterGuestHostGuestEpochs(signaling, transport) {
  const room = makeRoom({ phase: 'racing' });
  room.members.push({
    playerId: 'new-host',
    nickname: 'new-host',
    joinOrder: 3,
    connected: true,
    ready: true,
    isHost: false,
  });
  signaling.room(room);
  receiveStartRace(transport, {
    tick: 0,
    playerIds: ['host', 'guest', 'new-host'],
  });
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({
      tick: 600,
      worldTime: 10,
      boatIds: ['host', 'guest', 'new-host', 'ai:0'],
    }),
  });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 606,
    state: makeAuthorizedWorldState({
      tick: 606,
      worldTime: 10.1,
      boatIds: ['host', 'guest', 'new-host', 'ai:0'],
    }),
  }, { reliable: true });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'guest', hostId: 'new-host', hostEpoch: 3,
  });
}

test('room views expose immutable session state and drive role changes', () => {
  const { signaling, session } = makeHarness();
  const roles = collect(session, 'rolechange');

  signaling.room(makeRoom());

  assert.equal(session.role, 'guest');
  assert.equal(session.state.roomCode, 'AB2CD9');
  assert.equal(session.state.hostEpoch, 1);
  assert.equal(session.state.phase, 'lobby');
  assert.equal(session.state.members[0].nickname, 'host');
  assert.equal(Object.isFrozen(session.state), true);
  assert.equal(roles.at(-1).role, 'guest');
});

test('a racing room promotion requires a checkpoint even when this page missed start-race', () => {
  const { signaling, session } = makeHarness();
  signaling.room(makeRoom({ phase: 'racing' }));

  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  assert.equal(session.state.phase, 'racing');
  assert.equal(session.state.invalidated, true);
  assert.equal(session.state.migrating, false);
});

test('signaling statechange with no room atomically clears the session and topology', () => {
  const integrityMonitor = new FakeIntegrityMonitor();
  const checkpointIntegrityMonitor = new FakeIntegrityMonitor();
  const { signaling, transport, session } = makeHarness({
    integrityMonitor,
    checkpointIntegrityMonitor,
    chatLimit: { maxMessages: 1, windowMs: 10_000 },
  });
  signaling.room(makeRoom());
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  assert.equal(session.state.migrating, true);

  const inputs = collect(session, 'remote-input');
  transport.receive('host', {
    type: 'control', roomCode: 'AB2CD9', hostEpoch: 2, seq: 5, tick: 65, intent: CONTROL,
  });
  transport.receive('host', {
    type: 'chat', roomCode: 'AB2CD9', hostEpoch: 2, text: 'before leave',
  }, { reliable: true });
  const resetsBeforeLeave = integrityMonitor.resetCalls;

  signaling.stateChange({ playerId: null, room: null, connection: 'closed' });

  assert.equal(session.state.roomCode, null);
  assert.equal(session.state.playerId, null);
  assert.equal(session.state.hostId, null);
  assert.equal(session.state.hostEpoch, null);
  assert.equal(session.state.role, 'disconnected');
  assert.equal(session.state.migrating, false);
  assert.equal(session.state.invalidated, false);
  assert.equal(session.state.closed, false);
  assert.equal(transport.topologies.at(-1), null);
  assert.ok(integrityMonitor.resetCalls > resetsBeforeLeave);
  assert.ok(checkpointIntegrityMonitor.resetCalls > resetsBeforeLeave);
  assert.equal(session.update({ tick: 66, now: 1_000 }), false);
  assert.throws(() => session.sendChat('not in room'), /not in a room/i);
  assert.throws(() => session.requestRescue(), /not in a room/i);
  assert.throws(() => session.startRace({ tick: 66, seed: 'race' }), /not in a room/i);

  signaling.stateChange({
    playerId: 'guest',
    connection: 'open',
    room: makeRoom({ hostId: 'guest', hostEpoch: 3, localId: 'guest' }),
  });
  transport.receive('host', {
    type: 'control', roomCode: 'AB2CD9', hostEpoch: 3, seq: 0, tick: 66, intent: CONTROL,
  });
  transport.receive('host', {
    type: 'chat', roomCode: 'AB2CD9', hostEpoch: 3, text: 'after rejoin',
  }, { reliable: true });

  assert.deepEqual(inputs.map(({ seq }) => seq), [5, 0]);
  assert.equal(
    transport.broadcasts.filter(({ message }) => message.type === 'chat-delivery').length,
    2,
  );
});

test('leaveRoom delegates to signaling and the shared fallback closes on send failure', () => {
  const successful = makeHarness();
  successful.signaling.room(makeRoom());
  assert.equal(successful.session.leaveRoom(), true);
  assert.equal(successful.signaling.leaveCalls, 1);

  const failed = makeHarness();
  failed.signaling.room(makeRoom());
  failed.signaling.leaveResult = false;
  assert.equal(leaveOrCloseMultiplayer(failed.session), false);
  assert.equal(failed.signaling.leaveCalls, 1);
  assert.equal(failed.transport.closed, true);
  assert.equal(failed.signaling.closeCalls, 1);
});

test('guest sends canonical control intent to the host at 30 Hz', () => {
  const { signaling, transport, session } = makeHarness({ inputHz: 30 });
  signaling.room(makeRoom());
  session.configure({ controlProvider: () => CONTROL });

  session.update({ tick: 0, now: 0 });
  session.update({ tick: 1, now: 20 });
  session.update({ tick: 2, now: 34 });

  assert.equal(transport.toHost.length, 2);
  assert.deepEqual(transport.toHost.map((entry) => entry.message.seq), [0, 1]);
  assert.deepEqual(transport.toHost.map((entry) => entry.message.tick), [0, 2]);
  assert.deepEqual(transport.toHost[0].message.intent, CONTROL);
  assert.equal(transport.toHost.every((entry) => entry.options.reliable === false), true);
});

test('guest cadence preserves its 30 Hz phase across 20ms updates without bursts', () => {
  const { signaling, transport, session } = makeHarness({ inputHz: 30 });
  signaling.room(makeRoom());
  session.configure({ controlProvider: () => CONTROL });

  for (let now = 0, tick = 0; now < 10_000; now += 20, tick += 1) {
    const before = transport.toHost.length;
    session.update({ tick, now });
    assert.ok(transport.toHost.length - before <= 1);
  }

  assert.ok(Math.abs(transport.toHost.length - 300) <= 1, transport.toHost.length);
});

test('host broadcasts snapshots at 20 Hz and reliable checkpoints every 500ms', () => {
  const { signaling, transport, session } = makeHarness({
    playerId: 'host',
    snapshotHz: 20,
    checkpointHz: 2,
  });
  signaling.room(makeRoom({ localId: 'host' }));
  session.configure({
    snapshotProvider: ({ tick, now, hostEpoch }) => makeWorldState({
      tick,
      worldTime: now / 1_000,
      hostEpoch,
      x: tick,
    }),
  });

  for (const [tick, now] of [[0, 0], [1, 25], [2, 50], [3, 499], [4, 500]]) {
    session.update({ tick, now });
  }

  const snapshots = transport.broadcasts.filter((entry) => entry.message.type === 'snapshot');
  const checkpoints = transport.broadcasts.filter((entry) => entry.message.type === 'checkpoint');
  assert.deepEqual(snapshots.map((entry) => entry.message.tick), [0, 2, 3, 4]);
  assert.deepEqual(checkpoints.map((entry) => entry.message.tick), [0, 4]);
  assert.equal(snapshots.every((entry) => entry.options.reliable === false), true);
  assert.equal(checkpoints.every((entry) => entry.options.reliable === true), true);
  assert.equal(session.latestCheckpoint.tick, 4);
});

test('host snapshot cadence preserves its 20 Hz phase across 20ms updates', () => {
  const { signaling, transport, session } = makeHarness({
    playerId: 'host', snapshotHz: 20, checkpointHz: 2,
  });
  signaling.room(makeRoom({ localId: 'host' }));
  session.configure({
    snapshotProvider: ({ tick, now, hostEpoch }) => makeWorldState({
      tick, worldTime: now / 1_000, hostEpoch,
    }),
  });

  for (let now = 0, tick = 0; now < 10_000; now += 20, tick += 1) {
    const before = transport.broadcasts.filter(({ message }) => message.type === 'snapshot').length;
    session.update({ tick, now });
    const after = transport.broadcasts.filter(({ message }) => message.type === 'snapshot').length;
    assert.ok(after - before <= 1);
  }

  const snapshots = transport.broadcasts.filter(({ message }) => message.type === 'snapshot');
  assert.ok(Math.abs(snapshots.length - 200) <= 1, snapshots.length);
});

test('host checkpoint cadence preserves its 2 Hz phase across late updates', () => {
  const { signaling, transport, session } = makeHarness({
    playerId: 'host', snapshotHz: 20, checkpointHz: 2,
  });
  signaling.room(makeRoom({ localId: 'host' }));
  session.configure({
    snapshotProvider: ({ tick, now, hostEpoch }) => makeWorldState({
      tick, worldTime: now / 1_000, hostEpoch,
    }),
  });

  for (let now = 0, tick = 0; now < 10_000; now += 120, tick += 1) {
    const before = transport.broadcasts.filter(({ message }) => message.type === 'checkpoint').length;
    session.update({ tick, now });
    const after = transport.broadcasts.filter(({ message }) => message.type === 'checkpoint').length;
    assert.ok(after - before <= 1);
  }

  const checkpoints = transport.broadcasts.filter(({ message }) => message.type === 'checkpoint');
  assert.ok(Math.abs(checkpoints.length - 20) <= 1, checkpoints.length);
});

test('host accepts only the newest control sequence owned by a connected sourceId', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host' }));
  const inputs = collect(session, 'remote-input');
  const control = (seq) => ({
    type: 'control',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    seq,
    tick: 60 + seq,
    intent: CONTROL,
  });

  transport.receive('guest', control(2));
  transport.receive('guest', control(1));
  transport.receive('intruder', control(3));

  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], {
    playerId: 'guest',
    seq: 2,
    tick: 62,
    intent: CONTROL,
  });
});

test('same-epoch room disconnect and resume reset every source-owned watermark', () => {
  const { signaling, transport, session } = makeHarness({
    playerId: 'host',
    chatLimit: { maxMessages: 1, windowMs: 10_000 },
  });
  signaling.room(makeRoom({ localId: 'host' }));
  const inputs = collect(session, 'remote-input');
  const rescues = collect(session, 'rescue-request');
  const control = (seq) => ({
    type: 'control', roomCode: 'AB2CD9', hostEpoch: 1, seq, tick: 60 + seq, intent: CONTROL,
  });
  const rescue = (seq) => ({
    type: 'rescue-request', roomCode: 'AB2CD9', hostEpoch: 1, seq, tick: 60 + seq,
  });
  const chat = {
    type: 'chat', roomCode: 'AB2CD9', hostEpoch: 1, text: 'reconnected',
  };

  transport.receive('guest', control(5));
  transport.receive('guest', rescue(5), { reliable: true });
  transport.receive('guest', chat, { reliable: true });

  const disconnected = makeRoom({ localId: 'host' });
  const disconnectedGuest = disconnected.members.find(({ playerId }) => playerId === 'guest');
  disconnectedGuest.connected = false;
  disconnectedGuest.ready = false;
  signaling.room(disconnected);
  signaling.room(makeRoom({ localId: 'host' }));

  transport.receive('guest', control(0));
  transport.receive('guest', rescue(0), { reliable: true });
  transport.receive('guest', chat, { reliable: true });

  assert.deepEqual(inputs.map(({ seq }) => seq), [5, 0]);
  assert.deepEqual(rescues.map(({ seq }) => seq), [5, 0]);
  assert.equal(transport.broadcasts.filter(({ message }) => message.type === 'chat-delivery').length, 2);
});

test('member lifecycle domain events reset the source control sequence', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host' }));
  const inputs = collect(session, 'remote-input');
  const control = (seq) => ({
    type: 'control', roomCode: 'AB2CD9', hostEpoch: 1, seq, tick: 60 + seq, intent: CONTROL,
  });

  transport.receive('guest', control(5));
  signaling.domain({ type: 'member-left', roomCode: 'AB2CD9', playerId: 'guest' });
  signaling.domain({ type: 'member-resumed', roomCode: 'AB2CD9', playerId: 'guest' });
  transport.receive('guest', control(0));

  assert.deepEqual(inputs.map(({ seq }) => seq), [5, 0]);
});

test('peer-close resets the source control sequence', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host' }));
  const inputs = collect(session, 'remote-input');
  const control = (seq) => ({
    type: 'control', roomCode: 'AB2CD9', hostEpoch: 1, seq, tick: 60 + seq, intent: CONTROL,
  });

  transport.receive('guest', control(5));
  transport.peerClose({
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  });
  transport.receive('guest', control(0));

  assert.deepEqual(inputs.map(({ seq }) => seq), [5, 0]);
});

test('lossy state channel close does not reset source identity watermarks', () => {
  const { signaling, transport, session } = makeHarness({
    playerId: 'host',
    chatLimit: { maxMessages: 1, windowMs: 10_000 },
  });
  signaling.room(makeRoom({ localId: 'host' }));
  const inputs = collect(session, 'remote-input');
  const control = (seq) => ({
    type: 'control', roomCode: 'AB2CD9', hostEpoch: 1, seq, tick: 60 + seq, intent: CONTROL,
  });
  const chat = {
    type: 'chat', roomCode: 'AB2CD9', hostEpoch: 1, text: 'same identity',
  };

  transport.receive('guest', control(5));
  transport.receive('guest', chat, { reliable: true });
  transport.peerClose({
    playerId: 'guest', channel: 'state', reliable: false, hostEpoch: 1,
  });
  transport.receive('guest', control(0));
  transport.receive('guest', chat, { reliable: true });

  assert.deepEqual(inputs.map(({ seq }) => seq), [5]);
  assert.equal(
    transport.broadcasts.filter(({ message }) => message.type === 'chat-delivery').length,
    1,
  );
});

test('guest ignores authority state until a canonical start establishes race identity', () => {
  const checkpointIntegrityMonitor = new FakeIntegrityMonitor();
  const {
    signaling,
    transport,
    integrityMonitor,
    session,
  } = makeHarness({ checkpointIntegrityMonitor });
  signaling.room(makeRoom({ phase: 'racing' }));
  const snapshots = collect(session, 'snapshot');
  const checkpoints = collect(session, 'checkpoint');
  const rejected = collect(session, 'message-rejected');

  transport.receive('host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 1, tick: 60,
    state: makeAuthorizedWorldState({ tick: 60, worldTime: 1 }),
  });
  transport.receive('host', {
    type: 'checkpoint', roomCode: 'AB2CD9', hostEpoch: 1, tick: 66,
    state: makeAuthorizedWorldState({ tick: 66, worldTime: 1.1 }),
  }, { reliable: true });

  assert.equal(integrityMonitor.calls.length, 0);
  assert.equal(checkpointIntegrityMonitor.calls.length, 0);
  assert.equal(snapshots.length, 0);
  assert.equal(checkpoints.length, 0);
  assert.equal(session.state.invalidated, false);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason, /start|race identity|metadata/i);

  transport.receive('host', {
    type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, tick: 70, seed: 'race-seed',
    config: startConfigForTick(70),
  }, { reliable: true });
  transport.receive('host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 1, tick: 72,
    state: makeAuthorizedWorldState({ tick: 72, worldTime: 1.2 }),
  });
  transport.receive('host', {
    type: 'checkpoint', roomCode: 'AB2CD9', hostEpoch: 1, tick: 78,
    state: makeAuthorizedWorldState({ tick: 78, worldTime: 1.3 }),
  }, { reliable: true });

  const authorization = {
    expectedEpoch: 1,
    expectedBoatIds: ['host', 'guest', 'ai:0'],
    expectedSeed: 'race-seed',
    expectedStartTick: 70,
  };
  assert.deepEqual(integrityMonitor.calls[0].authorization, authorization);
  assert.deepEqual(checkpointIntegrityMonitor.calls[0].authorization, authorization);
  assert.equal(snapshots.length, 1);
  assert.equal(checkpoints.length, 1);
});

for (const type of ['snapshot', 'checkpoint']) {
  test(`${type} invalidates a schema-valid foreign first authority state`, () => {
    const { signaling, transport, session } = makeHarness({
      integrityMonitor: new IntegrityMonitor(),
      checkpointIntegrityMonitor: new IntegrityMonitor(),
    });
    signaling.room(makeRoom({ phase: 'racing' }));
    const invalidations = collect(session, 'invalidated');
    transport.receive('host', {
      type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, tick: 60, seed: 'race-seed',
      config: startConfigForTick(60),
    }, { reliable: true });

    transport.receive('host', {
      type, roomCode: 'AB2CD9', hostEpoch: 1, tick: 66,
      state: makeWorldState({ tick: 66, worldTime: 1.1 }),
    }, { reliable: type === 'checkpoint' });

    assert.equal(session.state.invalidated, true);
    assert.match(invalidations[0].reasons.join(' '), /authorized roster|authorized seed/i);
  });
}

test('guest invalidates a schema-valid first authority state outside the authorized start timeline', () => {
  const { signaling, transport, session } = makeHarness({
    integrityMonitor: new IntegrityMonitor(),
    checkpointIntegrityMonitor: new IntegrityMonitor(),
  });
  const start = startDescriptorForTick(0);
  signaling.room(makeRoom({ phase: 'racing', start }));
  const invalidations = collect(session, 'invalidated');

  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({ tick: 600, worldTime: 0.1 }),
  });

  assert.equal(session.state.invalidated, true);
  assert.match(invalidations[0].reasons.join(' '), /tick|worldTime|60 Hz|timeline/i);
});

test('guest accepts legal first authority states before and after host migration', () => {
  const { signaling, transport, session } = makeHarness({
    integrityMonitor: new IntegrityMonitor(),
    checkpointIntegrityMonitor: new IntegrityMonitor(),
  });
  const boatIds = ['host', 'guest', 'new-host', 'ai:0'];
  const room = makeRoom({
    phase: 'racing',
    start: startDescriptorForTick(0, ['host', 'guest', 'new-host']),
  });
  room.members.push({
    playerId: 'new-host', nickname: 'new-host', joinOrder: 3,
    connected: true, ready: true, isHost: false,
  });
  const snapshots = collect(session, 'snapshot');
  signaling.room(room);

  transport.receive('host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 1, tick: 6,
    state: makeAuthorizedWorldState({ tick: 6, worldTime: 0.1, boatIds }),
  });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'new-host', hostEpoch: 2,
  });
  transport.receive('new-host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 2, tick: 12,
    state: makeAuthorizedWorldState({ tick: 12, worldTime: 0.2, hostEpoch: 2, boatIds, x: 1 }),
  });

  assert.equal(session.state.invalidated, false);
  assert.deepEqual(snapshots.map(({ snapshot }) => snapshot.hostEpoch), [1, 2]);
});

test('race seed authorization uses Object.is semantics', () => {
  const { signaling, transport, session } = makeHarness({
    integrityMonitor: new IntegrityMonitor(),
    checkpointIntegrityMonitor: new IntegrityMonitor(),
  });
  signaling.room(makeRoom({ phase: 'racing' }));
  const invalidations = collect(session, 'invalidated');
  transport.receive('host', {
    type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, tick: 60, seed: -0,
    config: startConfigForTick(60),
  }, { reliable: true });
  transport.receive('host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 1, tick: 66,
    state: makeAuthorizedWorldState({ tick: 66, worldTime: 1.1, seed: 0 }),
  });

  assert.equal(session.state.invalidated, true);
  assert.match(invalidations[0].reasons.join(' '), /authorized seed/i);
});

for (const type of ['snapshot', 'checkpoint']) {
  test(`malformed active-host ${type} invalidates the guest session`, () => {
    const { signaling, transport, session } = makeHarness();
    signaling.room(makeRoom({ phase: 'racing' }));
    const invalidations = collect(session, 'invalidated');
    transport.receive('host', {
      type, roomCode: 'AB2CD9', hostEpoch: 1, tick: 60,
      state: { ...makeWorldState(), injected: true },
    }, { reliable: type === 'checkpoint' });

    assert.equal(session.state.invalidated, true);
    assert.match(invalidations[0].reasons.join(' '), /malformed|invalid|authority/i);
  });
}

test('malformed state from a non-host or stale authority is rejected without invalidation', () => {
  for (const { sourceId, roomCode, hostEpoch } of [
    { sourceId: 'guest', roomCode: 'AB2CD9', hostEpoch: 1 },
    { sourceId: 'host', roomCode: 'ZZ2ZZ9', hostEpoch: 1 },
    { sourceId: 'host', roomCode: 'AB2CD9', hostEpoch: 0 },
  ]) {
    const { signaling, transport, session } = makeHarness();
    signaling.room(makeRoom({ phase: 'racing' }));
    const rejected = collect(session, 'message-rejected');
    transport.receive(sourceId, {
      type: 'snapshot', roomCode, hostEpoch, tick: 60,
      state: { ...makeWorldState({ hostEpoch }), injected: true },
    });

    assert.equal(session.state.invalidated, false);
    assert.equal(rejected.length, 1);
  }
});

test('race identity survives host epochs but resets on leave and room change', () => {
  const checkpointIntegrityMonitor = new FakeIntegrityMonitor();
  const {
    signaling,
    transport,
    integrityMonitor,
    session,
  } = makeHarness({ checkpointIntegrityMonitor });
  const room = makeRoom({ phase: 'racing' });
  room.members.push({
    playerId: 'new-host', nickname: 'new-host', joinOrder: 3,
    connected: true, ready: true, isHost: false,
  });
  signaling.room(room);
  receiveStartRace(transport, {
    tick: 0,
    playerIds: ['host', 'guest', 'guest-b'],
  });
  transport.receive('host', {
    type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, tick: 60, seed: 'race-seed',
    config: startConfigForTick(60, ['host', 'guest', 'new-host']),
  }, { reliable: true });
  transport.receive('host', {
    type: 'checkpoint', roomCode: 'AB2CD9', hostEpoch: 1, tick: 66,
    state: makeAuthorizedWorldState({
      tick: 66,
      worldTime: 1.1,
      boatIds: ['host', 'guest', 'new-host', 'ai:0'],
    }),
  }, { reliable: true });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'guest', hostId: 'new-host', hostEpoch: 3,
  });
  transport.receive('new-host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 3, tick: 72,
    state: makeAuthorizedWorldState({
      tick: 72,
      worldTime: 1.2,
      hostEpoch: 3,
      boatIds: ['host', 'guest', 'new-host', 'ai:0'],
    }),
  });
  assert.deepEqual(integrityMonitor.calls.at(-1).authorization, {
    expectedEpoch: 3,
    expectedBoatIds: ['host', 'guest', 'new-host', 'ai:0'],
    expectedSeed: 'race-seed',
    expectedStartTick: 60,
  });

  const callsBeforeLeave = integrityMonitor.calls.length;
  assert.equal(session.leaveRoom(), true);
  transport.receive('new-host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 3, tick: 78,
    state: makeAuthorizedWorldState({
      tick: 78,
      worldTime: 1.3,
      hostEpoch: 3,
      boatIds: ['host', 'guest', 'new-host', 'ai:0'],
    }),
  });
  assert.equal(integrityMonitor.calls.length, callsBeforeLeave);

  signaling.room({ ...makeRoom({ phase: 'racing' }), roomCode: 'XY7ZW8' });
  transport.receive('host', {
    type: 'snapshot', roomCode: 'XY7ZW8', hostEpoch: 1, tick: 84,
    state: makeAuthorizedWorldState({ tick: 84, worldTime: 1.4 }),
  });
  assert.equal(integrityMonitor.calls.length, callsBeforeLeave);
  assert.equal(session.state.invalidated, false);
});

test('guest audits authority, deep-caches checkpoints, ignores old state, and freezes on invalidation', () => {
  const { signaling, transport, integrityMonitor, session } = makeHarness({
    checkpointIntegrityMonitor: new FakeIntegrityMonitor(),
  });
  signaling.room(makeRoom({ phase: 'racing' }));
  receiveStartRace(transport);
  session.configure({ controlProvider: () => CONTROL });
  const snapshots = collect(session, 'snapshot');
  const checkpoints = collect(session, 'checkpoint');
  const invalidations = collect(session, 'invalidated');
  const snapshotState = makeAuthorizedWorldState({ tick: 60, worldTime: 1 });
  const checkpointState = makeAuthorizedWorldState({ tick: 66, worldTime: 1.1, x: 1 });

  transport.receive('host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 1, tick: 60, state: snapshotState,
  });
  transport.receive('host', {
    type: 'checkpoint', roomCode: 'AB2CD9', hostEpoch: 1, tick: 66, state: checkpointState,
  }, { reliable: true });
  checkpointState.boats[0].phys.x = 999;

  integrityMonitor.queue({ status: 'ignored', ignored: true, invalidated: false, reasons: [], snapshot: null });
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 72,
    state: makeAuthorizedWorldState({ tick: 72, worldTime: 1.2 }),
  });
  integrityMonitor.queue({
    status: 'invalidated',
    ignored: false,
    invalidated: true,
    reasons: ['impossible displacement'],
    snapshot: null,
  });
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 78,
    state: makeAuthorizedWorldState({ tick: 78, worldTime: 1.3 }),
  });

  assert.equal(snapshots.length, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(session.latestCheckpoint.boats[0].phys.x, 1);
  assert.deepEqual(integrityMonitor.calls[0].authorization, {
    expectedEpoch: 1,
    expectedBoatIds: ['host', 'guest', 'ai:0'],
    expectedSeed: 'race-seed',
    expectedStartTick: 0,
  });
  assert.equal(session.state.invalidated, true);
  assert.deepEqual(invalidations[0].reasons, ['impossible displacement']);
  session.update({ tick: 80, now: 2_000 });
  assert.equal(transport.toHost.length, 0);

  const promotions = collect(session, 'promote');
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  assert.equal(session.state.migrating, false);
  assert.equal(promotions.length, 0);
});

test('checkpoint audit remains independent when lossy snapshots overtake the reliable channel', () => {
  const { signaling, transport, session } = makeHarness({
    integrityMonitor: new IntegrityMonitor(),
    checkpointIntegrityMonitor: new IntegrityMonitor(),
  });
  signaling.room(makeRoom({ phase: 'racing' }));
  const checkpoints = collect(session, 'checkpoint');
  const promotions = collect(session, 'promote');
  receiveStartRace(transport, { tick: 0 });

  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({ tick: 600, worldTime: 10 }),
  });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 606,
    state: makeAuthorizedWorldState({ tick: 606, worldTime: 10.1 }),
  }, { reliable: true });
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 642,
    state: makeAuthorizedWorldState({ tick: 642, worldTime: 10.7 }),
  });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 618,
    state: makeAuthorizedWorldState({ tick: 618, worldTime: 10.3, x: 1 }),
  }, { reliable: true });

  assert.deepEqual(checkpoints.map(({ checkpoint }) => checkpoint.tick), [606, 618]);
  assert.equal(session.latestCheckpoint.tick, 618);
  assert.equal(session.latestCheckpoint.boats[0].phys.x, 1);

  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  assert.equal(session.state.invalidated, false);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].checkpoint.worldTime, 10.3);
});

test('a conflicting checkpoint at the same tick cannot replace the cached state', () => {
  const { signaling, transport, session } = makeHarness({
    integrityMonitor: new IntegrityMonitor(),
    checkpointIntegrityMonitor: new IntegrityMonitor(),
  });
  signaling.room(makeRoom({ phase: 'racing' }));
  const checkpoints = collect(session, 'checkpoint');
  receiveStartRace(transport, { tick: 0 });

  for (const state of [
    makeAuthorizedWorldState({ tick: 600, worldTime: 10, x: 0 }),
    makeAuthorizedWorldState({ tick: 600, worldTime: 10, x: 9 }),
  ]) {
    transport.receive('host', {
      type: 'checkpoint',
      roomCode: 'AB2CD9',
      hostEpoch: 1,
      tick: 600,
      state,
    }, { reliable: true });
  }

  assert.equal(checkpoints.length, 1);
  assert.equal(session.latestCheckpoint.boats[0].phys.x, 0);
});

test('migration fallback timing dependencies and deadline are validated', () => {
  assert.throws(
    () => makeHarness({ timers: { setTimeout() {} } }),
    /timers.*setTimeout.*clearTimeout/i,
  );
  assert.throws(
    () => makeHarness({ migrationReadyTimeoutMs: 0 }),
    /migrationReadyTimeoutMs/i,
  );
  assert.throws(
    () => makeHarness({ migrationReadyTimeoutMs: 5_001 }),
    /migrationReadyTimeoutMs/i,
  );
});

test('promotion schedules a 500ms fallback so total host-loss recovery stays within five seconds', () => {
  const { signaling, timers, session } = makeHarness();
  signaling.room(makeRoom());

  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  assert.deepEqual(timers.pendingDelays(), [500]);
  session.close();
});

test('migration fallback resumes authority when one reliable peer remains stuck', () => {
  const { signaling, transport, timers, session } = makeHarness({
    migrationReadyTimeoutMs: 250,
  });
  const room = makeRoom({ phase: 'racing' });
  room.members.push({
    playerId: 'guest-b',
    nickname: 'guest-b',
    joinOrder: 3,
    connected: true,
    ready: true,
    isHost: false,
  });
  signaling.room(room);
  receiveStartRace(transport, {
    tick: 0,
    playerIds: ['host', 'guest', 'guest-b'],
  });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({
      tick: 600,
      worldTime: 10,
      boatIds: ['host', 'guest', 'guest-b', 'ai:0'],
    }),
  }, { reliable: true });
  const readyEvents = collect(session, 'migration-ready');
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  assert.equal(timers.pendingCount, 1);
  transport.topology({
    roomCode: 'AB2CD9',
    hostId: 'guest',
    hostEpoch: 2,
    selfId: 'guest',
    isHost: true,
    peerIds: ['host', 'guest-b'],
  });
  transport.peerOpen({
    playerId: 'guest-b', channel: 'control', reliable: true, hostEpoch: 2,
  });

  timers.advance(249);
  assert.equal(session.state.migrating, true);
  assert.deepEqual(transport.broadcasts, []);

  // A false aggregate result models the stuck peer rejecting the reliable batch;
  // broadcast still gives every available peer a chance to send or queue it.
  transport.broadcastResults.push(false, false);
  timers.advance(1);

  assert.equal(session.state.migrating, false);
  assert.deepEqual(
    transport.broadcasts.map(({ message }) => message.type),
    ['checkpoint', 'host-ready'],
  );
  assert.deepEqual(readyEvents, [{ hostEpoch: 2, tick: 600 }]);

  session.configure({
    snapshotProvider: () => makeWorldState({ tick: 601, worldTime: 10.1, hostEpoch: 2 }),
  });
  assert.equal(session.update({ tick: 601, now: 250 }), true);
  assert.deepEqual(
    transport.broadcasts.slice(2).map(({ message }) => message.type),
    ['snapshot', 'checkpoint'],
  );
});

test('normal all-ready promotion cancels its fallback timer', () => {
  const { signaling, transport, timers, session } = makeHarness({
    migrationReadyTimeoutMs: 250,
  });
  signaling.room(makeRoom());
  const readyEvents = collect(session, 'migration-ready');
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  transport.topology({
    roomCode: 'AB2CD9',
    hostId: 'guest',
    hostEpoch: 2,
    selfId: 'guest',
    isHost: true,
    peerIds: ['host'],
  });
  transport.peerOpen({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });

  assert.equal(session.state.migrating, false);
  assert.equal(timers.pendingCount, 0);
  assert.equal(readyEvents.length, 1);
  timers.advance(250);
  assert.equal(readyEvents.length, 1);
  assert.deepEqual(transport.broadcasts.map(({ message }) => message.type), ['host-ready']);
});

test('a stale promotion timer cannot act after demotion into another host epoch', () => {
  const { signaling, transport, timers, session } = makeHarness({
    migrationReadyTimeoutMs: 250,
  });
  const room = makeRoom({ phase: 'racing' });
  room.members.push({
    playerId: 'new-host',
    nickname: 'new-host',
    joinOrder: 3,
    connected: true,
    ready: true,
    isHost: false,
  });
  signaling.room(room);
  receiveStartRace(transport, {
    tick: 0,
    playerIds: ['host', 'guest', 'new-host'],
  });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({
      tick: 600,
      worldTime: 10,
      boatIds: ['host', 'guest', 'new-host', 'ai:0'],
    }),
  }, { reliable: true });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  assert.equal(timers.pendingCount, 1);
  const staleCallback = timers.callback(1);

  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'guest', hostId: 'new-host', hostEpoch: 3,
  });
  assert.equal(timers.pendingCount, 0);
  staleCallback();

  assert.equal(session.role, 'guest');
  assert.equal(session.state.hostEpoch, 3);
  assert.equal(session.state.migrating, false);
  assert.deepEqual(transport.broadcasts, []);
});

test('changing rooms clears promotion fallback and suppresses its retained callback', () => {
  const { signaling, transport, timers, session } = makeHarness({
    migrationReadyTimeoutMs: 250,
  });
  signaling.room(makeRoom());
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  const retainedCallback = timers.callback(1);

  signaling.room({
    ...makeRoom(),
    roomCode: 'XY7ZW8',
  });
  assert.equal(timers.pendingCount, 0);
  retainedCallback();

  assert.equal(session.state.roomCode, 'XY7ZW8');
  assert.equal(session.role, 'guest');
  assert.deepEqual(transport.broadcasts, []);
});

test('leaving clears promotion fallback and suppresses a retained callback', () => {
  const { signaling, transport, timers, session } = makeHarness({
    migrationReadyTimeoutMs: 250,
  });
  signaling.room(makeRoom());
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  const retainedCallback = timers.callback(1);

  assert.equal(session.leaveRoom(), true);
  assert.equal(timers.pendingCount, 0);
  retainedCallback();

  assert.equal(signaling.leaveCalls, 1);
  assert.deepEqual(transport.broadcasts, []);
});

test('closing clears promotion fallback and suppresses all post-close action', () => {
  const { signaling, transport, timers, session } = makeHarness({
    migrationReadyTimeoutMs: 250,
  });
  signaling.room(makeRoom());
  const readyEvents = collect(session, 'migration-ready');
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  const retainedCallback = timers.callback(1);

  session.close();
  assert.equal(timers.pendingCount, 0);
  retainedCallback();

  assert.equal(session.state.closed, true);
  assert.equal(session.state.migrating, false);
  assert.deepEqual(transport.broadcasts, []);
  assert.deepEqual(readyEvents, []);
});

test('promotion exposes a checkpoint within 0.5s rollback and announces host readiness', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom({ phase: 'racing' }));
  const promotions = collect(session, 'promote');
  receiveStartRace(transport, { tick: 0 });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 624,
    state: makeAuthorizedWorldState({ tick: 624, worldTime: 10.4 }),
  });

  signaling.hostChanged({ roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2 });

  assert.equal(session.role, 'host');
  assert.equal(session.state.migrating, true);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].checkpoint.hostEpoch, 2);
  assert.equal(promotions[0].checkpoint.worldTime, 10);

  transport.ready(2);
  const migrationMessages = transport.broadcasts.slice(-2);
  assert.deepEqual(migrationMessages.map((entry) => entry.message.type), ['checkpoint', 'host-ready']);
  assert.equal(migrationMessages.every((entry) => entry.options.reliable === true), true);
  assert.equal(session.state.migrating, false);
});

test('promotion preflights checkpoint and host-ready as one reliable batch before completing', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom({ phase: 'racing' }));
  receiveStartRace(transport, { tick: 0 });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  transport.reliableAvailable = false;
  transport.topology({
    roomCode: 'AB2CD9',
    hostId: 'guest',
    hostEpoch: 2,
    selfId: 'guest',
    isHost: true,
    peerIds: ['host'],
  });
  transport.peerOpen({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });

  assert.equal(session.state.migrating, true);
  assert.equal(transport.broadcasts.length, 0);
  assert.deepEqual(
    transport.reliablePreflights.at(-1).messageOrMessages.map(({ type }) => type),
    ['checkpoint', 'host-ready'],
  );
  assert.deepEqual(transport.reliablePreflights.at(-1).options.playerIds, ['host']);

  transport.reliableAvailable = true;
  transport.peerClose({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });
  transport.peerOpen({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });

  assert.equal(session.state.migrating, false);
  assert.deepEqual(
    transport.broadcasts.map(({ message }) => message.type),
    ['checkpoint', 'host-ready'],
  );
});

test('promotion remains migrating when a preflighted reliable broadcast is rejected', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom());
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  transport.topology({
    roomCode: 'AB2CD9',
    hostId: 'guest',
    hostEpoch: 2,
    selfId: 'guest',
    isHost: true,
    peerIds: ['host'],
  });
  transport.broadcastResults.push(false);
  transport.peerOpen({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });

  assert.equal(session.state.migrating, true);
  assert.deepEqual(transport.broadcasts.map(({ message }) => message.type), ['host-ready']);

  transport.peerClose({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });
  transport.peerOpen({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });

  assert.equal(session.state.migrating, false);
  assert.deepEqual(
    transport.broadcasts.map(({ message }) => message.type),
    ['host-ready', 'host-ready'],
  );
});

test('lobby host migration promotes without a checkpoint and becomes ready', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom());
  const promotions = collect(session, 'promote');

  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  assert.equal(session.state.invalidated, false);
  assert.equal(session.state.migrating, true);
  assert.deepEqual(promotions, [{ checkpoint: null }]);

  transport.topology({
    roomCode: 'AB2CD9',
    hostId: 'guest',
    hostEpoch: 2,
    selfId: 'guest',
    isHost: true,
    peerIds: [],
  });

  assert.equal(session.state.migrating, false);
  assert.deepEqual(transport.broadcasts.map(({ message }) => message.type), ['host-ready']);
});

test('a server start descriptor recovers the first half-second after host loss without a checkpoint', () => {
  const { signaling, transport, session } = makeHarness();
  const start = startDescriptorForTick(0);
  const promotions = collect(session, 'promote');
  const snapshots = collect(session, 'snapshot');
  signaling.room(makeRoom({ phase: 'racing', start }));
  transport.receive('host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 1, tick: 30,
    state: makeAuthorizedWorldState({ tick: 30, worldTime: 0.5 }),
  });
  assert.equal(snapshots.length, 1);

  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  assert.equal(session.state.invalidated, false);
  assert.equal(session.state.migrating, true);
  assert.deepEqual(session.state.start, start);
  assert.deepEqual(promotions, [{ checkpoint: null }]);
});

test('closing reentrantly from promote stops all subsequent promotion work', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom());
  const topologyCount = transport.topologies.length;
  const roles = collect(session, 'rolechange');
  const states = collect(session, 'statechange');
  session.addEventListener('promote', () => session.close(), { once: true });

  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  assert.equal(session.state.closed, true);
  assert.equal(session.state.migrating, false);
  assert.equal(transport.closed, true);
  assert.equal(transport.topologies.length, topologyCount);
  assert.deepEqual(roles, []);
  assert.deepEqual(states, []);
  assert.deepEqual(transport.broadcasts, []);
});

test('a started race still requires a migration checkpoint', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom({ phase: 'racing' }));
  transport.receive('host', {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120),
  }, { reliable: true });

  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  assert.equal(session.state.invalidated, true);
  assert.equal(session.state.migrating, false);
});

test('duplicate topology events preserve already-open peers during migration', () => {
  const { signaling, transport, session } = makeHarness();
  const room = makeRoom({ phase: 'racing' });
  room.members.push({
    playerId: 'guest-b',
    nickname: 'guest-b',
    joinOrder: 3,
    connected: true,
    ready: true,
    isHost: false,
  });
  signaling.room(room);
  receiveStartRace(transport, {
    tick: 0,
    playerIds: ['host', 'guest', 'guest-b'],
  });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({
      tick: 600,
      worldTime: 10,
      boatIds: ['host', 'guest', 'guest-b', 'ai:0'],
    }),
  }, { reliable: true });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  const topology = {
    roomCode: 'AB2CD9',
    hostId: 'guest',
    hostEpoch: 2,
    selfId: 'guest',
    isHost: true,
    peerIds: ['host', 'guest-b'],
  };
  transport.topology(topology);
  transport.peerOpen({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });
  transport.topology(topology);
  transport.peerOpen({
    playerId: 'guest-b', channel: 'control', reliable: true, hostEpoch: 2,
  });

  assert.equal(session.state.migrating, false);
  assert.deepEqual(
    transport.broadcasts.slice(-2).map(({ message }) => message.type),
    ['checkpoint', 'host-ready'],
  );
});

test('migration waits for a reliable peer that closes and reopens before another peer opens', () => {
  const { signaling, transport, session } = makeHarness();
  const room = makeRoom();
  room.members.push({
    playerId: 'guest-b',
    nickname: 'guest-b',
    joinOrder: 3,
    connected: true,
    ready: true,
    isHost: false,
  });
  signaling.room(room);
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });
  transport.topology({
    roomCode: 'AB2CD9',
    hostId: 'guest',
    hostEpoch: 2,
    selfId: 'guest',
    isHost: true,
    peerIds: ['host', 'guest-b'],
  });

  transport.peerOpen({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });
  transport.peerClose({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });
  transport.peerOpen({
    playerId: 'guest-b', channel: 'control', reliable: true, hostEpoch: 2,
  });

  assert.equal(session.state.migrating, true);
  assert.equal(transport.broadcasts.length, 0);

  transport.peerOpen({
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  });

  assert.equal(session.state.migrating, false);
  assert.deepEqual(transport.broadcasts.map(({ message }) => message.type), ['host-ready']);
});

test('promotion invalidates a checkpoint requiring more than 0.5s rollback', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom({ phase: 'racing' }));
  const promotions = collect(session, 'promote');
  receiveStartRace(transport, { tick: 0 });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 636,
    state: makeAuthorizedWorldState({ tick: 636, worldTime: 10.6 }),
  });

  signaling.hostChanged({ roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2 });

  assert.equal(promotions.length, 0);
  assert.equal(session.state.invalidated, true);
});

test('snapshot audit accepts authority after a guest-host-guest epoch transition', () => {
  const { signaling, transport, session } = makeHarness({
    integrityMonitor: new IntegrityMonitor(),
    checkpointIntegrityMonitor: new IntegrityMonitor(),
  });
  const snapshots = collect(session, 'snapshot');
  enterGuestHostGuestEpochs(signaling, transport);

  transport.receive('new-host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 3,
    tick: 612,
    state: makeAuthorizedWorldState({
      tick: 612,
      worldTime: 10.2,
      hostEpoch: 3,
      x: 1,
      boatIds: ['host', 'guest', 'new-host', 'ai:0'],
    }),
  });

  assert.equal(session.state.invalidated, false);
  assert.equal(snapshots.at(-1).snapshot.hostEpoch, 3);
});

test('checkpoint audit accepts authority after a guest-host-guest epoch transition', () => {
  const { signaling, transport, session } = makeHarness({
    integrityMonitor: new IntegrityMonitor(),
    checkpointIntegrityMonitor: new IntegrityMonitor(),
  });
  const checkpoints = collect(session, 'checkpoint');
  enterGuestHostGuestEpochs(signaling, transport);

  transport.receive('new-host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 3,
    tick: 618,
    state: makeAuthorizedWorldState({
      tick: 618,
      worldTime: 10.3,
      hostEpoch: 3,
      x: 1,
      boatIds: ['host', 'guest', 'new-host', 'ai:0'],
    }),
  }, { reliable: true });

  assert.equal(session.state.invalidated, false);
  assert.equal(checkpoints.at(-1).checkpoint.hostEpoch, 3);
  assert.equal(session.latestCheckpoint.hostEpoch, 3);
});

test('chat is reliable, uncensored, source-owned, and host rate-limited', () => {
  const clock = new FakeClock();
  const hostHarness = makeHarness({
    playerId: 'host',
    clock,
    chatLimit: { maxMessages: 1, windowMs: 1_000 },
  });
  hostHarness.signaling.room(makeRoom({ localId: 'host' }));
  const chats = collect(hostHarness.session, 'chat');
  const limited = collect(hostHarness.session, 'chat-rate-limited');
  const text = '  \u0000完全自由<script>🏴‍☠️\n  ';
  const incoming = {
    type: 'chat', roomCode: 'AB2CD9', hostEpoch: 1, text,
  };

  hostHarness.transport.receive('guest', incoming, { reliable: true });
  hostHarness.transport.receive('guest', incoming, { reliable: true });
  assert.equal(hostHarness.transport.broadcasts.length, 1);
  assert.equal(hostHarness.transport.broadcasts[0].message.type, 'chat-delivery');
  assert.equal(hostHarness.transport.broadcasts[0].message.sourceId, 'guest');
  assert.equal(hostHarness.transport.broadcasts[0].message.text, text);
  assert.equal(hostHarness.transport.broadcasts[0].options.reliable, true);
  assert.equal(chats[0].text, text);
  assert.equal(limited.length, 1);

  clock.advance(1_001);
  hostHarness.transport.receive('guest', incoming, { reliable: true });
  assert.equal(hostHarness.transport.broadcasts.length, 2);

  const guestHarness = makeHarness();
  guestHarness.signaling.room(makeRoom());
  guestHarness.session.sendChat(text);
  assert.equal(guestHarness.transport.toHost[0].message.text, text);
  assert.equal(guestHarness.transport.toHost[0].options.reliable, true);
  assert.throws(() => guestHarness.session.sendChat('🚩'.repeat(501)), /500/);
});

test('host chat is not displayed locally unless reliable delivery preflight and broadcast succeed', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host' }));
  const chats = collect(session, 'chat');

  transport.reliableAvailable = false;
  assert.equal(session.sendChat('no reliable path'), false);
  assert.equal(transport.reliablePreflights.length, 1);
  assert.equal(transport.broadcasts.length, 0);
  assert.equal(chats.length, 0);

  transport.reliableAvailable = true;
  transport.broadcastResults.push(false);
  assert.equal(session.sendChat('broadcast rejected'), false);
  assert.equal(transport.broadcasts.length, 1);
  assert.equal(chats.length, 0);

  assert.equal(session.sendChat('delivered'), true);
  assert.equal(transport.broadcasts.length, 2);
  assert.deepEqual(chats.map(({ text }) => text), ['delivered']);
});

test('rescue and start-race messages remain room, source, and epoch scoped', () => {
  const guestHarness = makeHarness();
  guestHarness.signaling.room(makeRoom({ phase: 'racing' }));
  guestHarness.session.update({ tick: 42, now: 0 });
  guestHarness.session.requestRescue();
  assert.deepEqual(guestHarness.transport.toHost[0], {
    message: {
      type: 'rescue-request',
      roomCode: 'AB2CD9',
      hostEpoch: 1,
      tick: 42,
      seq: 0,
    },
    options: { reliable: true },
  });

  const hostHarness = makeHarness({ playerId: 'host' });
  hostHarness.signaling.room(makeRoom({ localId: 'host' }));
  const rescues = collect(hostHarness.session, 'rescue-request');
  hostHarness.transport.receive('guest', guestHarness.transport.toHost[0].message, { reliable: true });
  assert.equal(rescues[0].playerId, 'guest');

  const starts = collect(guestHarness.session, 'start-race');
  guestHarness.transport.receive('host', {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120),
  }, { reliable: true });
  assert.equal(starts[0].seed, 'race-seed');
  guestHarness.transport.receive('host', {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120),
  }, { reliable: true });
  assert.equal(starts.length, 1);
});

test('host startRace requires the signaling room to be locked in racing phase', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host', phase: 'lobby' }));

  assert.throws(() => session.startRace({
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120),
  }), /phase|locked|racing/i);
  assert.equal(transport.broadcasts.length, 0);
});

test('guest buffers one canonical start-race until its room view has racing phase', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom({ phase: 'lobby' }));
  const starts = collect(session, 'start-race');
  const rejected = collect(session, 'message-rejected');
  const message = {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120),
  };

  transport.receive('host', message, { reliable: true });
  assert.equal(starts.length, 0);
  assert.equal(rejected.length, 0);
  transport.receive('host', {
    ...message,
    tick: 121,
    seed: 'conflicting-race-seed',
    config: startConfigForTick(121),
  }, { reliable: true });
  assert.equal(starts.length, 0);

  signaling.room(makeRoom({ phase: 'racing' }));
  assert.equal(starts.length, 1);
  assert.equal(starts[0].seed, 'race-seed');
});

test('a racing room start descriptor starts a guest exactly once without a peer start message', () => {
  const { signaling, transport, session } = makeHarness();
  const starts = collect(session, 'start-race');
  const rejected = collect(session, 'message-rejected');
  const start = startDescriptorForTick(120);

  signaling.room(makeRoom({ phase: 'racing', start }));

  assert.deepEqual(starts, [{ hostEpoch: 1, ...start }]);
  assert.deepEqual(session.state.start, start);

  transport.receive('host', {
    type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, ...start,
  }, { reliable: true });
  assert.equal(starts.length, 1);
  assert.equal(rejected.length, 0);
});

test('the host callback is idempotent when the authoritative room already started the same race', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  const starts = collect(session, 'start-race');
  const start = startDescriptorForTick(120);
  signaling.room(makeRoom({ localId: 'host', phase: 'racing', start }));

  assert.equal(session.startRace(structuredClone(start)), true);
  assert.equal(starts.length, 1);
  assert.deepEqual(transport.broadcasts, []);

  const conflicting = structuredClone(start);
  conflicting.seed = 'conflicting-seed';
  assert.throws(() => session.startRace(conflicting), /authoritative|descriptor|different|match/i);
  assert.equal(starts.length, 1);
});

test('a racing room cannot replace its authoritative start descriptor', () => {
  const { signaling, session } = makeHarness();
  const invalidations = collect(session, 'invalidated');
  const start = startDescriptorForTick(120);
  signaling.room(makeRoom({ phase: 'racing', start }));
  const changed = structuredClone(start);
  changed.seed = 'replacement-seed';

  signaling.room(makeRoom({ phase: 'racing', start: changed }));

  assert.equal(session.state.invalidated, true);
  assert.deepEqual(session.state.start, start);
  assert.match(invalidations[0].reasons.join(' '), /start|descriptor|changed/i);
});

test('guest clears a buffered start-race when the host epoch changes before room lock', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom({ phase: 'lobby' }));
  const starts = collect(session, 'start-race');
  transport.receive('host', {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 120,
    seed: 'stale-race-seed',
    config: startConfigForTick(120),
  }, { reliable: true });

  signaling.room(makeRoom({ phase: 'racing', hostEpoch: 2 }));

  assert.equal(starts.length, 0);
});

test('leaveRoom clears a buffered start-race before a later racing room view', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom({ phase: 'lobby' }));
  const starts = collect(session, 'start-race');
  transport.receive('host', {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 120,
    seed: 'departed-race-seed',
    config: startConfigForTick(120),
  }, { reliable: true });

  assert.equal(session.leaveRoom(), true);
  signaling.room(makeRoom({ phase: 'racing' }));

  assert.equal(starts.length, 0);
});

test('host startRace broadcasts a canonical reliable message and starts locally', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host', phase: 'racing' }));
  const starts = collect(session, 'start-race');

  assert.equal(session.startRace({
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120),
  }), true);
  assert.deepEqual(transport.broadcasts[0], {
    message: {
      type: 'start-race',
      roomCode: 'AB2CD9',
      hostEpoch: 1,
      tick: 120,
      seed: 'race-seed',
      config: startConfigForTick(120),
    },
    options: { reliable: true },
  });
  assert.deepEqual(starts[0], {
    hostEpoch: 1,
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120),
  });
});

test('startRace rejects a duplicate start after the local race has begun', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host', phase: 'racing' }));
  const start = {
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120),
  };

  assert.equal(session.startRace(start), true);
  assert.throws(() => session.startRace(start), /already started/i);
  assert.equal(transport.broadcasts.length, 1);
});

test('startRace preflights every connected guest before any reliable broadcast or local start', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  const room = makeRoom({ localId: 'host', phase: 'racing' });
  room.members.push({
    playerId: 'guest-b',
    nickname: 'guest-b',
    joinOrder: 3,
    connected: true,
    ready: true,
    isHost: false,
  });
  signaling.room(room);
  const starts = collect(session, 'start-race');
  const start = {
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120, ['host', 'guest', 'guest-b']),
  };
  transport.reliableAvailable = false;

  assert.equal(session.startRace(start), false);
  assert.deepEqual(transport.reliablePreflights[0].options.playerIds, ['guest', 'guest-b']);
  assert.equal(transport.broadcasts.length, 0);
  assert.equal(starts.length, 0);

  transport.reliableAvailable = true;
  assert.equal(session.startRace(start), true);
  assert.equal(transport.broadcasts.length, 1);
  assert.equal(starts.length, 1);
});

test('startRace strictly canonicalizes and forwards the complete multiplayer race config', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host', phase: 'racing' }));
  const starts = collect(session, 'start-race');

  assert.equal(session.startRace({
    tick: 120,
    seed: 'race-seed',
    config: START_CONFIG,
  }), true);

  assert.deepEqual(transport.broadcasts[0].message.config, START_CONFIG);
  assert.deepEqual(starts[0].config, START_CONFIG);
  assert.throws(() => session.startRace({
    tick: 120,
    seed: 'race-seed',
    config: { ...START_CONFIG, injected: true },
  }), /unknown field/i);
  assert.throws(() => session.startRace({
    tick: 120,
    seed: 'race-seed',
    config: {
      ...START_CONFIG,
      roster: [
        { playerId: 'host', nickname: 'host' },
        { playerId: 'outsider', nickname: 'outsider' },
      ],
    },
  }), /roster.*room|room.*roster/i);
  assert.throws(() => session.startRace({
    tick: 120,
    seed: 'race-seed',
    config: {
      ...START_CONFIG,
      roster: [
        { playerId: 'host', nickname: 'forged-host-name' },
        { playerId: 'guest', nickname: 'guest' },
      ],
    },
  }), /roster.*room|room.*roster/i);
});

test('startRace accepts only a strict message for the active room and epoch', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host', phase: 'racing' }));
  const message = {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 180,
    seed: 42,
    config: startConfigForTick(180),
  };

  assert.equal(session.startRace(message), true);
  assert.equal(transport.broadcasts[0].message.seed, 42);
  assert.throws(
    () => session.startRace({ ...message, roomCode: 'ZZ2ZZ9' }),
    /active room|room code/i,
  );
  assert.throws(
    () => session.startRace({ ...message, injected: true }),
    /unknown field/i,
  );
});

test('only the current host may call startRace', () => {
  const { signaling, session } = makeHarness();
  signaling.room(makeRoom());

  assert.throws(() => session.startRace({ tick: 120, seed: 'race-seed' }), /host/i);
});

test('startRace requires every connected member to be ready', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  const room = makeRoom({ localId: 'host' });
  room.members.find(({ playerId }) => playerId === 'guest').ready = false;
  signaling.room(room);

  assert.throws(() => session.startRace({ tick: 120, seed: 'race-seed' }), /ready/i);
  assert.equal(transport.broadcasts.length, 0);
});

test('startRace requires at least two connected human players', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  const room = makeRoom({ localId: 'host' });
  const guest = room.members.find(({ playerId }) => playerId === 'guest');
  guest.connected = false;
  guest.ready = false;
  signaling.room(room);

  assert.throws(() => session.startRace({
    tick: 120,
    seed: 'race-seed',
    config: startConfigForTick(120),
  }), /at least two connected/i);
  assert.equal(transport.broadcasts.length, 0);
});

test('startRace waits until host migration is transport-ready', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom());
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  assert.throws(() => session.startRace({ tick: 600, seed: 'race-seed' }), /migration|ready/i);
});

test('guest rejects stale epochs and authority messages not sent by the current host', () => {
  const { signaling, transport, integrityMonitor, session } = makeHarness();
  signaling.room(makeRoom());
  const rejected = collect(session, 'message-rejected');
  const state = makeWorldState();

  transport.receive('guest', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 1, tick: 60, state,
  });
  const stale = makeWorldState({ hostEpoch: 0 });
  transport.receive('host', {
    type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 0, tick: 60, state: stale,
  });

  assert.equal(integrityMonitor.calls.length, 0);
  assert.equal(rejected.length, 2);
});

test('close detaches the coordinator and closes its injected transport', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom());
  session.configure({ controlProvider: () => CONTROL });

  session.close();
  session.update({ tick: 1, now: 100 });
  signaling.hostChanged({ roomCode: 'AB2CD9', hostId: 'guest', hostEpoch: 2 });

  assert.equal(transport.closed, true);
  assert.equal(transport.toHost.length, 0);
  assert.equal(session.state.closed, true);
});
