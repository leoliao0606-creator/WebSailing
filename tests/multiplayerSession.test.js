import assert from 'node:assert/strict';
import test from 'node:test';

import { IntegrityMonitor } from '../src/net/integrityMonitor.js';
import { leaveOrCloseMultiplayer } from '../src/net/multiplayerSession.js';
import {
  FakeIntegrityMonitor,
  FakeClock,
  makeRoom,
  makeWorldState,
  CONTROL,
  START_CONFIG,
  startConfigForTick,
  makeHarness,
  collect,
} from './helpers/netFakes.js';

function enterGuestHostGuestEpochs(signaling, transport) {
  const room = makeRoom();
  room.members.push({
    playerId: 'new-host',
    nickname: 'new-host',
    joinOrder: 3,
    connected: true,
    ready: true,
    isHost: false,
  });
  signaling.room(room);
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeWorldState({ tick: 600, worldTime: 10 }),
  });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 606,
    state: makeWorldState({ tick: 606, worldTime: 10.1 }),
  }, { reliable: true });
  transport.receive('host', {
    type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, tick: 610, seed: 'race-seed',
    config: startConfigForTick(610, ['host', 'guest', 'new-host']),
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

test('guest audits authority, deep-caches checkpoints, ignores old state, and freezes on invalidation', () => {
  const { signaling, transport, integrityMonitor, session } = makeHarness();
  signaling.room(makeRoom());
  session.configure({ controlProvider: () => CONTROL });
  const snapshots = collect(session, 'snapshot');
  const checkpoints = collect(session, 'checkpoint');
  const invalidations = collect(session, 'invalidated');
  const snapshotState = makeWorldState({ tick: 60, worldTime: 1 });
  const checkpointState = makeWorldState({ tick: 66, worldTime: 1.1, x: 1 });

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
    state: makeWorldState({ tick: 72, worldTime: 1.2 }),
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
    state: makeWorldState({ tick: 78, worldTime: 1.3 }),
  });

  assert.equal(snapshots.length, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(session.latestCheckpoint.boats[0].phys.x, 1);
  assert.deepEqual(integrityMonitor.calls[0].authorization, { expectedEpoch: 1 });
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
  signaling.room(makeRoom());
  const checkpoints = collect(session, 'checkpoint');
  const promotions = collect(session, 'promote');

  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeWorldState({ tick: 600, worldTime: 10 }),
  });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 606,
    state: makeWorldState({ tick: 606, worldTime: 10.1 }),
  }, { reliable: true });
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 642,
    state: makeWorldState({ tick: 642, worldTime: 10.7 }),
  });
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 618,
    state: makeWorldState({ tick: 618, worldTime: 10.3, x: 1 }),
  }, { reliable: true });

  assert.deepEqual(checkpoints.map(({ checkpoint }) => checkpoint.tick), [606, 618]);
  assert.equal(session.latestCheckpoint.tick, 618);
  assert.equal(session.latestCheckpoint.boats[0].phys.x, 1);

  transport.receive('host', {
    type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, tick: 650, seed: 'race-seed',
    config: startConfigForTick(650),
  }, { reliable: true });
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
  signaling.room(makeRoom());
  const checkpoints = collect(session, 'checkpoint');

  for (const state of [
    makeWorldState({ tick: 600, worldTime: 10, x: 0 }),
    makeWorldState({ tick: 600, worldTime: 10, x: 9 }),
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

test('promotion exposes a checkpoint within 0.5s rollback and announces host readiness', () => {
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom());
  const promotions = collect(session, 'promote');
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 624,
    state: makeWorldState({ tick: 624, worldTime: 10.4 }),
  });
  transport.receive('host', {
    type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, tick: 630, seed: 'race-seed',
    config: startConfigForTick(630),
  }, { reliable: true });

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
  signaling.room(makeRoom());
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  transport.receive('host', {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 606,
    seed: 'race-seed',
    config: startConfigForTick(606),
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
  signaling.room(makeRoom());
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
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  transport.receive('host', {
    type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, tick: 606, seed: 'race-seed',
    config: startConfigForTick(606, ['host', 'guest', 'guest-b']),
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
  signaling.room(makeRoom());
  const promotions = collect(session, 'promote');
  transport.receive('host', {
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 600,
    state: makeWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 636,
    state: makeWorldState({ tick: 636, worldTime: 10.6 }),
  });
  transport.receive('host', {
    type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 1, tick: 640, seed: 'race-seed',
    config: startConfigForTick(640),
  }, { reliable: true });

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
    state: makeWorldState({ tick: 612, worldTime: 10.2, hostEpoch: 3, x: 1 }),
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
    state: makeWorldState({ tick: 618, worldTime: 10.3, hostEpoch: 3, x: 1 }),
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
  guestHarness.signaling.room(makeRoom());
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

test('host startRace broadcasts a canonical reliable message and starts locally', () => {
  const { signaling, transport, session } = makeHarness({ playerId: 'host' });
  signaling.room(makeRoom({ localId: 'host' }));
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
  signaling.room(makeRoom({ localId: 'host' }));
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
  const room = makeRoom({ localId: 'host' });
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
  signaling.room(makeRoom({ localId: 'host' }));
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
  signaling.room(makeRoom({ localId: 'host' }));
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
