// 房主迁移专项回归 —— 聚焦「真实 RoomRegistry 选举」驱动客户端 session 晋升的集成路径
// (docs/plans/2026-07-10 Task 12 的欠账)。覆盖:按加入序选举、注册表锁定+断线触发
// 的两人迁移、旧 host 以 guest 回归后输入水位重置。
//
// 纯 session 侧的晋升机制(预检 checkpoint+host-ready 批次、0.5s 回滚边界、脏权威拒收、
// 迁移回退计时)由 multiplayerSession.test.js 用假件详尽覆盖;注册表计时/心跳见
// roomRegistry.test.js 与 signalingServer.test.js;比赛控制器的 AI 接管见
// multiplayerRaceController.test.js。

import assert from 'node:assert/strict';
import test from 'node:test';

import { RoomRegistry } from '../server/roomRegistry.js';
import { IntegrityMonitor } from '../src/net/integrityMonitor.js';
import {
  makeAuthorizedWorldState,
  CONTROL,
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

// 供 registry.lockRoom 使用的初始开赛描述符:tick 必须为 0,roster 须与房间保留名单一致。
function initialStart(players, { seed = 'migration-seed' } = {}) {
  const countdown = 30;
  return {
    tick: 0,
    seed,
    config: {
      windPsi: 0.25,
      windKn: 12,
      gustiness: 0.25,
      countdown,
      startTick: countdown * 60,
      roster: players.map(({ playerId, nickname }) => ({ playerId, nickname })),
      aiFill: 1,
      penaltyMode: 'turns',
    },
  };
}

test('two-player racing migration: registry election drives session promotion within rollback budget', () => {
  const registry = createRegistry();
  const { roomCode, players: [host, guest] } = fillRoom(registry, 2);
  const start = initialStart([host, guest]);
  const locked = registry.lockRoom(host.playerId, start);
  assert.equal(locked.room.phase, 'racing');

  const { signaling, transport, session } = makeHarness({
    playerId: guest.playerId,
    integrityMonitor: new IntegrityMonitor(),
    checkpointIntegrityMonitor: new IntegrityMonitor(),
  });
  const promotions = collect(session, 'promote');
  // 房间视图携带 start 描述符即建立赛事身份,guest 无需额外的 start-race 消息。
  signaling.room(locked.room);
  assert.equal(session.role, 'guest');

  const boatIds = [host.playerId, guest.playerId, 'ai:0'];
  transport.receive(host.playerId, {
    type: 'checkpoint',
    roomCode,
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({ tick: 600, worldTime: 10, seed: start.seed, boatIds }),
  }, { reliable: true });
  transport.receive(host.playerId, {
    type: 'snapshot',
    roomCode,
    hostEpoch: 1,
    tick: 624,
    state: makeAuthorizedWorldState({ tick: 624, worldTime: 10.4, seed: start.seed, boatIds }),
  });

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

test('an old host resuming as guest gets a fresh input watermark under the new epoch', () => {
  const registry = createRegistry();
  const { roomCode, players: [oldHost, guest] } = fillRoom(registry, 2);
  const start = initialStart([oldHost, guest]);
  registry.lockRoom(oldHost.playerId, start);

  const { signaling, transport, session } = makeHarness({ playerId: guest.playerId });
  const locked = registry.roomView(roomCode);
  signaling.room(locked);
  const boatIds = [oldHost.playerId, guest.playerId, 'ai:0'];
  transport.receive(oldHost.playerId, {
    type: 'checkpoint',
    roomCode,
    hostEpoch: 1,
    tick: 600,
    state: makeAuthorizedWorldState({ tick: 600, worldTime: 10, seed: start.seed, boatIds }),
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
