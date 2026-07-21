import assert from 'node:assert/strict';
import test from 'node:test';

import { RoomRegistry } from '../server/roomRegistry.js';

const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

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

function createHarness({ start = 1_000, reconnectGraceMs = 30_000 } = {}) {
  let time = start;
  const registry = new RoomRegistry({
    now: () => time,
    randomBytes: deterministicRandomBytes(),
    reconnectGraceMs,
  });

  return {
    registry,
    advance(milliseconds) {
      time += milliseconds;
    },
  };
}

function createRoom(registry, nickname = 'Skipper 1') {
  const player = registry.createPlayer(nickname);
  const result = registry.createRoom(player);
  return { player, code: result.roomCode, result };
}

function join(registry, code, nickname) {
  const player = registry.createPlayer(nickname);
  const result = registry.joinRoom(code, player);
  return { player, result };
}

function startDescriptor(players, tick = 0) {
  const countdown = 30;
  return {
    tick,
    seed: 'recoverable-race',
    config: {
      windPsi: 0.35,
      windKn: 14,
      gustiness: 0.3,
      countdown,
      startTick: tick + countdown * 60,
      roster: players.map(({ playerId, nickname }) => ({ playerId, nickname })),
      aiFill: 2,
      penaltyMode: 'turns',
    },
  };
}

test('room codes are unique six-character strings using only unambiguous characters', () => {
  let identityCall = 0;
  const roomBytes = [
    Buffer.alloc(6, 0),
    Buffer.alloc(6, 0),
    Buffer.alloc(6, 1),
  ];
  const registry = new RoomRegistry({
    randomBytes(size) {
      if (size === 6) return roomBytes.shift();
      identityCall += 1;
      return Buffer.alloc(size, identityCall);
    },
  });

  const first = createRoom(registry, 'One');
  const second = createRoom(registry, 'Two');

  assert.equal(first.code, ROOM_ALPHABET[0].repeat(6));
  assert.equal(second.code, ROOM_ALPHABET[1].repeat(6));
  assert.notEqual(first.code, second.code);
  assert.match(first.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.match(second.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
});

test('room code generation rejects bytes outside the unbiased sampling range', () => {
  let identityCall = 0;
  let roomCall = 0;
  const registry = new RoomRegistry({
    randomBytes(size) {
      if (size !== 6) {
        identityCall += 1;
        return Buffer.alloc(size, identityCall);
      }
      roomCall += 1;
      if (roomCall === 1) return Buffer.from([248, 249, 250, 251, 252, 253]);
      return Buffer.from([0, 31, 62, 93, 124, 247]);
    },
  });

  const { code } = createRoom(registry, 'Unbiased');

  assert.equal(code, 'AAAAA9');
  assert.equal(roomCall, 2);
});

test('room code generation stops after a bounded number of rejected random batches', () => {
  let identityCall = 0;
  let roomCall = 0;
  const registry = new RoomRegistry({
    randomBytes(size) {
      if (size !== 6) {
        identityCall += 1;
        return Buffer.alloc(size, identityCall);
      }
      roomCall += 1;
      return Buffer.alloc(size, 255);
    },
  });
  const player = registry.createPlayer('No entropy');

  assert.throws(
    () => registry.createRoom(player),
    (error) => error.code === 'CODE_GENERATION_FAILED',
  );
  assert.ok(roomCall > 0 && roomCall <= 1_024);
});

test('room code generation stops after a bounded number of collisions', () => {
  let identityCall = 0;
  let roomCall = 0;
  const registry = new RoomRegistry({
    randomBytes(size) {
      if (size === 6) {
        roomCall += 1;
        return Buffer.alloc(size, 0);
      }
      identityCall += 1;
      return Buffer.alloc(size, identityCall);
    },
  });
  createRoom(registry, 'First');
  const second = registry.createPlayer('Second');

  assert.throws(
    () => registry.createRoom(second),
    (error) => error.code === 'CODE_GENERATION_FAILED',
  );
  assert.ok(roomCall > 1 && roomCall <= 1_025);
});

test('a room may wait with one player and accepts eight ordered human seats', () => {
  const { registry } = createHarness();
  const { code } = createRoom(registry);

  assert.equal(registry.roomView(code).members.length, 1);

  for (let number = 2; number <= 8; number += 1) {
    join(registry, code, `Skipper ${number}`);
  }

  const room = registry.roomView(code);
  assert.equal(room.phase, 'lobby');
  assert.equal(Object.hasOwn(room, 'start'), false);
  assert.equal(room.members.length, 8);
  assert.deepEqual(room.members.map((member) => member.joinOrder), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('only a ready host with two connected humans can lock a lobby', () => {
  const { registry } = createHarness();
  const { player: host, code } = createRoom(registry, 'Host');
  const preJoinStart = startDescriptor([
    host,
    { playerId: 'future-guest', nickname: 'Guest' },
  ]);

  assert.throws(
    () => registry.lockRoom(host.playerId, preJoinStart),
    (error) => error.code === 'NOT_ENOUGH_PLAYERS',
  );

  const { player: guest } = join(registry, code, 'Guest');
  const start = startDescriptor([host, guest]);
  registry.setReady(host.playerId, true);
  assert.throws(
    () => registry.lockRoom(host.playerId, start),
    (error) => error.code === 'PLAYERS_NOT_READY',
  );
  registry.setReady(guest.playerId, true);
  assert.throws(
    () => registry.lockRoom(guest.playerId, start),
    (error) => error.code === 'NOT_HOST',
  );

  const locked = registry.lockRoom(host.playerId, start);
  assert.equal(locked.room.phase, 'racing');
  assert.deepEqual(locked.room.start, start);
  assert.equal(Object.isFrozen(locked.room.start), true);
  assert.equal(Object.isFrozen(locked.room.start.config.roster), true);
  assert.deepEqual(locked.events, [{
    type: 'room-locked',
    roomCode: code,
    playerId: host.playerId,
    phase: 'racing',
    start,
  }]);
});

test('lock atomically stores a canonical start and cannot be mutated after racing begins', () => {
  const { registry } = createHarness();
  const { player: host, code } = createRoom(registry, 'Host');
  const { player: guest } = join(registry, code, 'Guest');
  registry.setReady(host.playerId, true);
  registry.setReady(guest.playerId, true);
  const input = startDescriptor([host, guest]);

  assert.throws(
    () => registry.lockRoom(host.playerId, { ...input, tick: input.tick + 1 }),
    (error) => error.code === 'INVALID_START_DESCRIPTOR',
  );
  assert.equal(registry.roomView(code).phase, 'lobby');
  assert.equal(Object.hasOwn(registry.roomView(code), 'start'), false);

  const locked = registry.lockRoom(host.playerId, input);
  input.seed = 'mutated';
  input.config.roster[0].nickname = 'mutated';
  assert.equal(registry.roomView(code).start.seed, 'recoverable-race');
  assert.equal(registry.roomView(code).start.config.roster[0].nickname, 'Host');

  assert.throws(
    () => registry.lockRoom(host.playerId, startDescriptor([host, guest], 240)),
    (error) => error.code === 'ROOM_IN_PROGRESS',
  );
  assert.deepEqual(registry.roomView(code).start, locked.room.start);
});

test('a room rejects a valid initial start descriptor with a non-zero tick', () => {
  const { registry } = createHarness();
  const { player: host, code } = createRoom(registry, 'Host');
  const { player: guest } = join(registry, code, 'Guest');
  registry.setReady(host.playerId, true);
  registry.setReady(guest.playerId, true);

  assert.throws(
    () => registry.lockRoom(host.playerId, startDescriptor([host, guest], 120)),
    (error) => error.code === 'INVALID_START_DESCRIPTOR' && /tick.*zero/i.test(error.message),
  );
  assert.equal(registry.roomView(code).phase, 'lobby');
  assert.equal(Object.hasOwn(registry.roomView(code), 'start'), false);
});

test('lock rejects a descriptor whose reserved human roster differs from the room', () => {
  const { registry } = createHarness();
  const { player: host, code } = createRoom(registry, 'Host');
  const { player: guest } = join(registry, code, 'Guest');
  registry.setReady(host.playerId, true);
  registry.setReady(guest.playerId, true);
  const start = startDescriptor([host, guest]);
  start.config.roster[1].playerId = 'not-the-guest';

  assert.throws(
    () => registry.lockRoom(host.playerId, start),
    (error) => error.code === 'START_ROSTER_MISMATCH',
  );
  assert.equal(registry.roomView(code).phase, 'lobby');
});

test('a racing room rejects late joins without changing its reserved roster', () => {
  const { registry } = createHarness();
  const { player: host, code } = createRoom(registry, 'Host');
  const { player: guest } = join(registry, code, 'Guest');
  registry.setReady(host.playerId, true);
  registry.setReady(guest.playerId, true);
  registry.lockRoom(host.playerId, startDescriptor([host, guest]));
  const late = registry.createPlayer('Late');

  assert.throws(
    () => registry.joinRoom(code, late),
    (error) => error.code === 'ROOM_IN_PROGRESS',
  );
  assert.equal(registry.roomView(code).members.length, 2);
  assert.throws(
    () => registry.setReady(host.playerId, false),
    (error) => error.code === 'ROOM_IN_PROGRESS',
  );
});

test('host migration and resume preserve the racing phase', () => {
  const { registry } = createHarness();
  const { player: host, code } = createRoom(registry, 'Host');
  const { player: guest } = join(registry, code, 'Guest');
  registry.setReady(host.playerId, true);
  registry.setReady(guest.playerId, true);
  const start = startDescriptor([host, guest]);
  registry.lockRoom(host.playerId, start);

  const migrated = registry.disconnect(host.playerId);
  assert.equal(migrated.room.phase, 'racing');
  assert.deepEqual(migrated.room.start, start);
  assert.equal(migrated.room.hostId, guest.playerId);
  const resumed = registry.resume({
    roomCode: code,
    playerId: host.playerId,
    resumeToken: host.resumeToken,
  });
  assert.equal(resumed.room.phase, 'racing');
  assert.equal(resumed.room.hostId, guest.playerId);
  assert.deepEqual(resumed.room.start, start);
});

test('a ninth player is rejected without changing the room', () => {
  const { registry } = createHarness();
  const { code } = createRoom(registry);
  for (let number = 2; number <= 8; number += 1) {
    join(registry, code, `Skipper ${number}`);
  }
  const ninth = registry.createPlayer('Skipper 9');

  assert.throws(
    () => registry.joinRoom(code, ninth),
    (error) => error.code === 'ROOM_FULL',
  );
  assert.equal(registry.roomView(code).members.length, 8);
});

test('ready changes are reflected in the room and emitted as domain events', () => {
  const { registry } = createHarness();
  const { player, code } = createRoom(registry);

  const result = registry.setReady(player.playerId, true);

  assert.equal(result.room.members[0].ready, true);
  assert.deepEqual(result.events, [{
    type: 'ready-changed',
    roomCode: code,
    playerId: player.playerId,
    ready: true,
  }]);
  assert.equal(registry.setReady(player.playerId, false).room.members[0].ready, false);
});

test('the first member is the initial host by join order', () => {
  const { registry } = createHarness();
  const { player: creator, code, result } = createRoom(registry);
  const { player: guest } = join(registry, code, 'Guest');

  const room = registry.roomView(code);
  assert.equal(result.room.hostEpoch, 1);
  assert.equal(room.hostId, creator.playerId);
  assert.equal(room.members.find((member) => member.playerId === creator.playerId).isHost, true);
  assert.equal(room.members.find((member) => member.playerId === guest.playerId).isHost, false);
});

test('host loss immediately elects the earliest connected member and increments hostEpoch', () => {
  const { registry } = createHarness();
  const { player: host, code } = createRoom(registry, 'Host');
  const { player: firstGuest } = join(registry, code, 'First guest');
  const { player: secondGuest } = join(registry, code, 'Second guest');
  registry.disconnect(firstGuest.playerId);

  const result = registry.disconnect(host.playerId);

  assert.equal(result.room.hostId, secondGuest.playerId);
  assert.equal(result.room.hostEpoch, 2);
  assert.deepEqual(result.events.map((event) => event.type), ['member-left', 'host-changed']);
  assert.deepEqual(result.events[1], {
    type: 'host-changed',
    roomCode: code,
    previousHostId: host.playerId,
    hostId: secondGuest.playerId,
    hostEpoch: 2,
  });
});

test('joining a hostless room elects the earliest connected member and keeps the old host a guest', () => {
  const { registry } = createHarness();
  const { player: oldHost, code } = createRoom(registry, 'Old host');
  const disconnected = registry.disconnect(oldHost.playerId);
  assert.equal(disconnected.room.hostId, null);
  assert.equal(disconnected.room.hostEpoch, 2);

  const { player: newHost, result: joined } = join(registry, code, 'New host');

  assert.equal(joined.room.hostId, newHost.playerId);
  assert.equal(joined.room.hostEpoch, 3);
  assert.deepEqual(joined.events.map((event) => event.type), ['member-joined', 'host-changed']);
  assert.deepEqual(joined.events[1], {
    type: 'host-changed',
    roomCode: code,
    previousHostId: null,
    hostId: newHost.playerId,
    hostEpoch: 3,
  });

  const resumed = registry.resume({
    roomCode: code,
    playerId: oldHost.playerId,
    resumeToken: oldHost.resumeToken,
  });
  assert.equal(resumed.room.hostId, newHost.playerId);
  assert.equal(resumed.room.members.find((member) => member.playerId === oldHost.playerId).isHost, false);
});

test('a disconnected seat remains reserved until the exact grace deadline', () => {
  const { registry, advance } = createHarness();
  const { code } = createRoom(registry, 'Host');
  const { player: guest } = join(registry, code, 'Guest');
  registry.disconnect(guest.playerId);

  advance(29_999);
  assert.deepEqual(registry.removeExpired().events, []);
  assert.equal(registry.roomView(code).members.length, 2);

  advance(1);
  const result = registry.removeExpired();
  assert.deepEqual(result.events, [{
    type: 'member-removed',
    roomCode: code,
    playerId: guest.playerId,
  }]);
  assert.equal(registry.roomView(code).members.length, 1);
});

test('resume rejects an invalid token and accepts the matching token before expiry', () => {
  const { registry } = createHarness();
  const { code } = createRoom(registry, 'Host');
  const { player: guest } = join(registry, code, 'Guest');
  registry.disconnect(guest.playerId);

  assert.throws(
    () => registry.resume({
      roomCode: code,
      playerId: guest.playerId,
      resumeToken: 'not-the-token',
    }),
    (error) => error.code === 'INVALID_RESUME_TOKEN',
  );

  const result = registry.resume({
    roomCode: code,
    playerId: guest.playerId,
    resumeToken: guest.resumeToken,
  });
  const resumed = result.room.members.find((member) => member.playerId === guest.playerId);
  assert.equal(resumed.connected, true);
  assert.deepEqual(result.events, [{
    type: 'member-resumed',
    roomCode: code,
    playerId: guest.playerId,
  }]);
});

test('resume is rejected once the disconnected seat has expired', () => {
  const { registry, advance } = createHarness();
  const { code } = createRoom(registry, 'Host');
  const { player: guest } = join(registry, code, 'Guest');
  registry.disconnect(guest.playerId);
  advance(30_000);

  assert.throws(
    () => registry.resume({
      roomCode: code,
      playerId: guest.playerId,
      resumeToken: guest.resumeToken,
    }),
    (error) => error.code === 'RESUME_EXPIRED',
  );
});

test('a former host resumes as a guest after another host was elected', () => {
  const { registry } = createHarness();
  const { player: oldHost, code } = createRoom(registry, 'Old host');
  const { player: newHost } = join(registry, code, 'New host');
  registry.disconnect(oldHost.playerId);

  const result = registry.resume({
    roomCode: code,
    playerId: oldHost.playerId,
    resumeToken: oldHost.resumeToken,
  });

  const resumedMember = result.room.members.find((member) => member.playerId === oldHost.playerId);
  assert.equal(result.room.hostId, newHost.playerId);
  assert.equal(result.room.hostEpoch, 2);
  assert.equal(resumedMember.isHost, false);
});

test('expiring the final reserved seat removes the empty room', () => {
  const { registry, advance } = createHarness();
  const { player, code } = createRoom(registry, 'Only player');
  registry.disconnect(player.playerId);
  advance(30_000);

  const result = registry.removeExpired();

  assert.equal(registry.roomView(code), null);
  assert.deepEqual(result.events.map((event) => event.type), ['member-removed', 'room-removed']);
  assert.deepEqual(result.events[1], { type: 'room-removed', roomCode: code });
});

test('room views and domain events never expose resume tokens', () => {
  const { registry } = createHarness();
  const { player, code, result } = createRoom(registry, 'Private token');
  const { player: guest, result: joined } = join(registry, code, 'Guest');

  assert.ok(player.resumeToken);
  assert.ok(guest.resumeToken);
  for (const externalValue of [registry.roomView(code), result, joined]) {
    const serialized = JSON.stringify(externalValue);
    assert.equal(serialized.includes('resumeToken'), false);
    assert.equal(serialized.includes(player.resumeToken), false);
    assert.equal(serialized.includes(guest.resumeToken), false);
  }
});

test('registry internals cannot expose or mutate player and room indexes', () => {
  const { registry } = createHarness();
  createRoom(registry, 'Private state');

  assert.equal(registry.players, undefined);
  assert.equal(registry.rooms, undefined);
  assert.equal(Object.hasOwn(registry, 'players'), false);
  assert.equal(Object.hasOwn(registry, 'rooms'), false);
});
