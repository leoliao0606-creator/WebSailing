// 房主迁移专项回归(docs/plans/2026-07-10 Task 12 的欠账):
// 覆盖 2/8 人房主丢失、按加入序选举、hostEpoch 恰好 +1、
// 旧 host 过期权威拒收、0.5s 回滚边界、旧 host 以 guest 回归后输入水位重置。
// 注册表计时/心跳类场景见 signalingServer.test.js 与 roomRegistry.test.js;
// 比赛控制器的 AI 接管见 multiplayerRaceController.test.js。

import assert from 'node:assert/strict';
import test from 'node:test';

import { RoomRegistry } from '../server/roomRegistry.js';
import { IntegrityMonitor } from '../src/net/integrityMonitor.js';
import {
  makeRoom,
  makeWorldState,
  CONTROL,
  startConfigForTick,
  makeHarness,
  collect,
} from './helpers/netFakes.js';

function deterministicRandomBytes() {
  let call = 0;
  return (size) => {
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) {
      bytes[index] = (call * 31 + index * 17) % 256;
    }
    call += 1;
    return bytes;
  };
}

function createRegistry() {
  return new RoomRegistry({
    now: () => 1_000,
    randomBytes: deterministicRandomBytes(),
    reconnectGraceMs: 30_000,
  });
}

function fillRoom(registry, humanCount) {
  const host = registry.createPlayer('Player 1');
  const { roomCode } = registry.createRoom(host);
  const players = [host];
  for (let index = 2; index <= humanCount; index += 1) {
    const player = registry.createPlayer(`Player ${index}`);
    registry.joinRoom(roomCode, player);
    players.push(player);
  }
  for (const player of players) registry.setReady(player.playerId, true);
  return { roomCode, players };
}

test('two-player racing migration: registry election drives session promotion within rollback budget', () => {
  const registry = createRegistry();
  const { roomCode, players: [host, guest] } = fillRoom(registry, 2);
  const locked = registry.lockRoom(host.playerId);
  assert.equal(locked.room.phase, 'racing');

  const { signaling, transport, session } = makeHarness({
    playerId: guest.playerId,
    integrityMonitor: new IntegrityMonitor(),
    checkpointIntegrityMonitor: new IntegrityMonitor(),
  });
  const promotions = collect(session, 'promote');
  signaling.room(locked.room);
  assert.equal(session.role, 'guest');

  transport.receive(host.playerId, {
    type: 'checkpoint',
    roomCode,
    hostEpoch: 1,
    tick: 600,
    state: makeWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  transport.receive(host.playerId, {
    type: 'snapshot',
    roomCode,
    hostEpoch: 1,
    tick: 624,
    state: makeWorldState({ tick: 624, worldTime: 10.4 }),
  });
  transport.receive(host.playerId, {
    type: 'start-race',
    roomCode,
    hostEpoch: 1,
    tick: 630,
    seed: 'race-seed',
    config: startConfigForTick(630, [host.playerId, guest.playerId]),
  }, { reliable: true });

  const migrated = registry.disconnect(host.playerId);
  assert.equal(migrated.room.hostId, guest.playerId);
  assert.equal(migrated.room.hostEpoch, 2);
  signaling.room(migrated.room);
  const hostChanged = migrated.events.find((event) => event.type === 'host-changed');
  signaling.hostChanged(hostChanged);

  assert.equal(session.role, 'host');
  assert.equal(session.state.hostEpoch, 2);
  assert.equal(session.state.invalidated, false);
  assert.equal(session.state.migrating, true);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].checkpoint.hostEpoch, 2);
  assert.equal(promotions[0].checkpoint.worldTime, 10);

  transport.ready(2);
  assert.equal(session.state.migrating, false);
  assert.deepEqual(
    transport.broadcasts.slice(-2).map(({ message }) => message.type),
    ['checkpoint', 'host-ready'],
  );
  assert.equal(transport.broadcasts.at(-1).message.hostEpoch, 2);
});

test('eight-player room elects strictly by join order across consecutive host losses', () => {
  const registry = createRegistry();
  const { players } = fillRoom(registry, 8);

  // 第 2 位先掉线:选举应跳过它,落到第 3 位。
  registry.disconnect(players[1].playerId);
  const first = registry.disconnect(players[0].playerId);
  assert.equal(first.room.hostId, players[2].playerId);
  assert.equal(first.room.hostEpoch, 2);

  const second = registry.disconnect(players[2].playerId);
  assert.equal(second.room.hostId, players[3].playerId);
  assert.equal(second.room.hostEpoch, 3);

  const remaining = second.room.members.filter((member) => member.connected);
  assert.equal(remaining.length, 5);
  assert.equal(second.room.members.filter((member) => member.isHost).length, 1);
});

test('eight-player promotion preflights checkpoint and host-ready to every remaining peer', () => {
  const others = ['g2', 'g3', 'g4', 'g5', 'g6', 'g7'];
  const { signaling, transport, session } = makeHarness();
  signaling.room(makeRoom({ extraIds: others }));
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
    config: { ...startConfigForTick(606, ['host', 'guest', ...others]), aiFill: 0 },
  }, { reliable: true });
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  const peerIds = ['host', ...others];
  transport.reliableAvailable = false;
  transport.topology({
    roomCode: 'AB2CD9',
    hostId: 'guest',
    hostEpoch: 2,
    selfId: 'guest',
    isHost: true,
    peerIds,
  });
  for (const playerId of peerIds) {
    transport.peerOpen({ playerId, channel: 'control', reliable: true, hostEpoch: 2 });
  }

  assert.equal(session.state.migrating, true);
  assert.equal(transport.broadcasts.length, 0);
  const preflight = transport.reliablePreflights.at(-1);
  assert.deepEqual(preflight.messageOrMessages.map(({ type }) => type), ['checkpoint', 'host-ready']);
  assert.deepEqual([...preflight.options.playerIds].sort(), [...peerIds].sort());

  // 预检失败会清空整份 ready 集合,恢复可靠通道后须重新宣告每个 peer。
  transport.reliableAvailable = true;
  for (const playerId of peerIds) {
    transport.peerOpen({ playerId, channel: 'control', reliable: true, hostEpoch: 2 });
  }

  assert.equal(session.state.migrating, false);
  assert.deepEqual(
    transport.broadcasts.map(({ message }) => message.type),
    ['checkpoint', 'host-ready'],
  );
});

test('after migration the stale host authority is rejected without consulting integrity', () => {
  const { signaling, transport, integrityMonitor, session } = makeHarness();
  signaling.room(makeRoom({ extraIds: ['new-host'] }));
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
    config: startConfigForTick(606, ['host', 'guest', 'new-host']),
  }, { reliable: true });

  signaling.room(makeRoom({ hostId: 'new-host', extraIds: ['new-host'], hostEpoch: 2, phase: 'racing' }));
  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'new-host', hostEpoch: 2,
  });
  assert.equal(session.role, 'guest');

  const rejected = collect(session, 'message-rejected');
  const snapshots = collect(session, 'snapshot');
  const callsBefore = integrityMonitor.calls.length;

  transport.receive('host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 660,
    state: makeWorldState({ tick: 660, worldTime: 11, hostEpoch: 1 }),
  });
  assert.equal(rejected.length, 1);
  assert.equal(integrityMonitor.calls.length, callsBefore);
  assert.equal(snapshots.length, 0);

  transport.receive('new-host', {
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 2,
    tick: 666,
    state: makeWorldState({ tick: 666, worldTime: 11.1, hostEpoch: 2 }),
  });
  assert.equal(snapshots.length, 1);
  assert.equal(session.state.invalidated, false);
});

test('promotion accepts a checkpoint at exactly the 0.5s rollback boundary', () => {
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
    tick: 630,
    state: makeWorldState({ tick: 630, worldTime: 10.5 }),
  });
  transport.receive('host', {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 1,
    tick: 632,
    seed: 'race-seed',
    config: startConfigForTick(632),
  }, { reliable: true });

  signaling.hostChanged({
    roomCode: 'AB2CD9', previousHostId: 'host', hostId: 'guest', hostEpoch: 2,
  });

  assert.equal(session.state.invalidated, false);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].checkpoint.worldTime, 10);
});

test('an old host resuming as guest gets a fresh input watermark under the new epoch', () => {
  const registry = createRegistry();
  const { roomCode, players: [oldHost, guest] } = fillRoom(registry, 2);
  registry.lockRoom(oldHost.playerId);

  const { signaling, transport, session } = makeHarness({ playerId: guest.playerId });
  const locked = registry.roomView(roomCode);
  signaling.room(locked);
  transport.receive(oldHost.playerId, {
    type: 'checkpoint',
    roomCode,
    hostEpoch: 1,
    tick: 600,
    state: makeWorldState({ tick: 600, worldTime: 10 }),
  }, { reliable: true });
  transport.receive(oldHost.playerId, {
    type: 'start-race',
    roomCode,
    hostEpoch: 1,
    tick: 606,
    seed: 'race-seed',
    config: startConfigForTick(606, [oldHost.playerId, guest.playerId]),
  }, { reliable: true });

  const migrated = registry.disconnect(oldHost.playerId);
  signaling.room(migrated.room);
  signaling.hostChanged(migrated.events.find((event) => event.type === 'host-changed'));
  assert.equal(session.role, 'host');
  transport.ready(2);
  assert.equal(session.state.migrating, false);

  const resumed = registry.resume({
    roomCode,
    playerId: oldHost.playerId,
    resumeToken: oldHost.resumeToken,
  });
  const resumedMember = resumed.room.members.find(
    (member) => member.playerId === oldHost.playerId,
  );
  assert.equal(resumedMember.isHost, false);
  signaling.room(resumed.room);
  for (const event of resumed.events) {
    if (event.type === 'member-resumed') signaling.domain(event);
  }

  const inputs = collect(session, 'remote-input');
  transport.receive(oldHost.playerId, {
    type: 'control', roomCode, hostEpoch: 2, seq: 0, tick: 700, intent: CONTROL,
  });
  assert.deepEqual(inputs.map(({ playerId, seq }) => ({ playerId, seq })), [
    { playerId: oldHost.playerId, seq: 0 },
  ]);
});
