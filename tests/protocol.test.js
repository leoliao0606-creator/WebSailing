import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_CHAT_LENGTH,
  MAX_NICKNAME_LENGTH,
  MAX_PLAYER_ID_BYTES,
  MAX_PLAYERS,
  MAX_RESUME_TOKEN_BYTES,
  PROTOCOL_VERSION,
  normalizeControlIntent,
  normalizeNickname,
  normalizeRoomCode,
  normalizeStartDescriptor,
  startDescriptorsEqual,
  validatePeerMessage,
  validateSignalMessage,
} from '../src/net/protocol.js';

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

const START_RACE_CONFIG = Object.freeze({
  windPsi: 0.35,
  windKn: 14,
  gustiness: 0.3,
  countdown: 30,
  startTick: 1_920,
  roster: Object.freeze([
    Object.freeze({ playerId: 'host', nickname: '船长' }),
    Object.freeze({ playerId: 'guest', nickname: '水手' }),
  ]),
  aiFill: 2,
});

function startConfigForTick(tick) {
  return { ...START_RACE_CONFIG, startTick: tick + START_RACE_CONFIG.countdown * 60 };
}

function startDescriptor(tick = 120) {
  return {
    tick,
    seed: 'recoverable-race',
    config: startConfigForTick(tick),
  };
}

function successfulValue(result) {
  assert.equal(result.ok, true, result.error);
  return result.value;
}

function assertRejected(result, pattern) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  if (pattern) assert.match(result.error, pattern);
}

function makeWorldState({ tick = 60, worldTime = 1, hostEpoch = 4 } = {}) {
  return {
    tick,
    worldTime,
    seed: 'session-seed',
    hostEpoch,
    boats: [{
      boatId: 'boat-a',
      phys: {
        x: 0,
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
        prevX: 0,
        prevZ: 0,
      }],
      results: [],
    },
  };
}

test('protocol exports the first-version limits', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(MAX_PLAYERS, 8);
  assert.equal(MAX_NICKNAME_LENGTH, 20);
  assert.equal(MAX_CHAT_LENGTH, 500);
});

test('nickname normalization trims Unicode whitespace without filtering content', () => {
  const nickname = successfulValue(normalizeNickname('\u3000<script>帆船🚩\n\u00a0'));

  assert.equal(nickname, '<script>帆船🚩');
});

test('nickname length is measured in Unicode code points', () => {
  assert.equal(successfulValue(normalizeNickname('🚩'.repeat(20))), '🚩'.repeat(20));
  assertRejected(normalizeNickname('🚩'.repeat(21)), /20/);
});

test('nickname normalization rejects non-strings and blank names', () => {
  assertRejected(normalizeNickname(42), /string/i);
  assertRejected(normalizeNickname('\u3000\u00a0'), /empty/i);
});

test('room-code normalization trims and uppercases a valid six-character code', () => {
  assert.equal(successfulValue(normalizeRoomCode('  ab2cd9\n')), 'AB2CD9');
});

test('room-code normalization rejects ambiguous or malformed codes', () => {
  for (const value of ['AB0CD9', 'AB1CD9', 'ABICD9', 'ABOCD9', 'ABC-DE', 'ABCDE', 'ABCDEFG']) {
    assertRejected(normalizeRoomCode(value), /room code/i);
  }
  assertRejected(normalizeRoomCode(123456), /string/i);
});

test('room-code normalization rejects Unicode case expansion and confusables', () => {
  for (const value of ['ßßß', 'ﬀﬀﬀ', 'ſſſſſſ', 'ＡＢ２ＣＤ９']) {
    assertRejected(normalizeRoomCode(value), /room code/i);
  }
});

test('control intent canonicalizes omitted controls to false', () => {
  const intent = successfulValue(normalizeControlIntent({ steerLeft: true, sheetOut: true }));

  assert.deepEqual(intent, {
    ...EMPTY_INTENT,
    steerLeft: true,
    sheetOut: true,
  });
  assert.equal(Object.isFrozen(intent), true);
});

test('control intent rejects non-Boolean controls', () => {
  assertRejected(normalizeControlIntent({ steerLeft: 1 }), /Boolean/i);
  assertRejected(normalizeControlIntent({ righting: 'true' }), /Boolean/i);
});

test('control intent rejects fields outside the fixed control allowlist', () => {
  assertRejected(normalizeControlIntent({ throttle: true }), /unknown field/i);
  assertRejected(normalizeControlIntent({ seq: 1, tick: 2 }), /unknown field/i);
});

test('control intent rejects inherited control fields', () => {
  assertRejected(normalizeControlIntent(Object.create({ steerLeft: 'true' })), /object|prototype|inherited/i);
});

test('protocol validators reject class instances', () => {
  class ForgedSignalMessage {
    constructor() {
      this.type = 'ping';
    }
  }

  assertRejected(validateSignalMessage(new ForgedSignalMessage()), /object|prototype/i);
});

test('protocol validators accept null-prototype records with own fields', () => {
  const message = Object.assign(Object.create(null), { type: 'ping' });

  assert.deepEqual(successfulValue(validateSignalMessage(message)), { type: 'ping' });
});

test('signal validator accepts only the declared client command types', () => {
  const messages = [
    { type: 'create-room', nickname: '船长' },
    { type: 'join-room', roomCode: 'AB2CD9', nickname: '水手' },
    { type: 'resume', roomCode: 'AB2CD9', playerId: 'player-1', resumeToken: 'secret' },
    { type: 'set-ready', ready: true },
    { type: 'lock-room', start: startDescriptor() },
    { type: 'signal', targetId: 'player-2', data: { type: 'offer', sdp: 'v=0' } },
    { type: 'signal', targetId: 'player-2', data: { type: 'answer', sdp: 'v=0' } },
    {
      type: 'signal',
      targetId: 'player-2',
      data: {
        type: 'ice',
        candidate: 'candidate:1 1 UDP 1 192.0.2.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: null,
      },
    },
    { type: 'leave' },
    { type: 'ping' },
  ];

  for (const message of messages) {
    assert.equal(validateSignalMessage(message).ok, true, message.type);
  }
});

test('lock-room carries one canonical deeply immutable start descriptor', () => {
  const input = startDescriptor();
  const message = successfulValue(validateSignalMessage({ type: 'lock-room', start: input }));

  assert.deepEqual(message, {
    type: 'lock-room',
    start: startDescriptor(),
  });
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.start), true);
  assert.equal(Object.isFrozen(message.start.config), true);
  assert.equal(Object.isFrozen(message.start.config.roster), true);
  assert.notEqual(message.start, input);
  assert.deepEqual(successfulValue(normalizeStartDescriptor(input)), input);
});

test('start descriptor equality compares canonical wire values and rejects invalid inputs', () => {
  const descriptor = startDescriptor();
  const equivalent = {
    config: {
      aiFill: descriptor.config.aiFill,
      roster: descriptor.config.roster.map(({ nickname, playerId }) => ({ nickname, playerId })),
      startTick: descriptor.config.startTick,
      countdown: descriptor.config.countdown,
      gustiness: descriptor.config.gustiness,
      windKn: descriptor.config.windKn,
      windPsi: descriptor.config.windPsi,
    },
    seed: descriptor.seed,
    tick: descriptor.tick,
  };

  assert.equal(startDescriptorsEqual(descriptor, equivalent), true);
  assert.equal(startDescriptorsEqual(
    { ...descriptor, seed: -0 },
    { ...descriptor, seed: 0 },
  ), true);
  assert.equal(startDescriptorsEqual(descriptor, startDescriptor(240)), false);
  assert.equal(startDescriptorsEqual(descriptor, { ...descriptor, injected: true }), false);
});

test('lock-room strictly rejects missing, malformed, or injected start descriptors', () => {
  assertRejected(validateSignalMessage({ type: 'lock-room' }), /start|required/i);
  assertRejected(validateSignalMessage({
    type: 'lock-room', start: { ...startDescriptor(), injected: true },
  }), /unknown field/i);
  assertRejected(validateSignalMessage({
    type: 'lock-room', start: { ...startDescriptor(), tick: 121 },
  }), /startTick|countdown/i);
  assertRejected(validateSignalMessage({
    type: 'lock-room', start: { ...startDescriptor(), seed: '界'.repeat(100) },
  }), /seed|256|UTF-8/i);
  assertRejected(validateSignalMessage({
    type: 'lock-room', start: { ...startDescriptor(), config: { ...START_RACE_CONFIG, cheat: true } },
  }), /unknown field/i);
  assertRejected(validateSignalMessage({
    type: 'lock-room', start: Object.assign(Object.create({ tick: 120 }), {
      seed: 'recoverable-race', config: startConfigForTick(120),
    }),
  }), /plain|object|prototype/i);
  assertRejected(validateSignalMessage({
    type: 'lock-room', start: startDescriptor(), phase: 'racing',
  }), /unknown field/i);
});

test('resume credentials enforce UTF-8 byte limits and a canonical room code', () => {
  assertRejected(validateSignalMessage({
    type: 'resume',
    roomCode: 'AB2CD9',
    playerId: '界'.repeat(Math.floor(MAX_PLAYER_ID_BYTES / 3) + 1),
    resumeToken: 'secret',
  }), /playerId|UTF-8|128/i);
  assertRejected(validateSignalMessage({
    type: 'resume',
    roomCode: 'AB2CD9',
    playerId: 'player-1',
    resumeToken: '界'.repeat(Math.floor(MAX_RESUME_TOKEN_BYTES / 3) + 1),
  }), /resumeToken|UTF-8|256/i);
  assertRejected(validateSignalMessage({
    type: 'resume',
    roomCode: 'AB0CD9',
    playerId: 'player-1',
    resumeToken: 'secret',
  }), /room code/i);
});

test('signal validator returns canonical immutable data', () => {
  const message = successfulValue(validateSignalMessage({
    type: 'join-room',
    roomCode: ' ab2cd9 ',
    nickname: '\u3000海盗🏴‍☠️ ',
  }));

  assert.deepEqual(message, {
    type: 'join-room',
    roomCode: 'AB2CD9',
    nickname: '海盗🏴‍☠️',
  });
  assert.equal(Object.isFrozen(message), true);
});

test('signal validator rejects unknown types and fields', () => {
  assertRejected(validateSignalMessage({ type: 'become-host' }), /unknown signal type/i);
  assertRejected(validateSignalMessage({
    type: 'create-room',
    nickname: '船长',
    isAdmin: true,
  }), /unknown field/i);
  assertRejected(validateSignalMessage({
    type: 'signal',
    targetId: 'player-2',
    data: { type: 'offer', sdp: 'v=0', injected: true },
  }), /unknown field/i);
});

test('RTC signaling strictly validates an optional bounded negotiationId', () => {
  const offer = successfulValue(validateSignalMessage({
    type: 'signal',
    targetId: 'player-2',
    data: { type: 'offer', sdp: 'v=0', negotiationId: 'epoch-4-attempt-2' },
  }));
  const ice = successfulValue(validateSignalMessage({
    type: 'signal',
    targetId: 'player-2',
    data: { type: 'ice', candidate: null, negotiationId: 'epoch-4-attempt-2' },
  }));

  assert.equal(offer.data.negotiationId, 'epoch-4-attempt-2');
  assert.equal(ice.data.negotiationId, 'epoch-4-attempt-2');
  assert.equal(Object.isFrozen(offer.data), true);
  assertRejected(validateSignalMessage({
    type: 'signal',
    targetId: 'player-2',
    data: { type: 'answer', sdp: 'v=0', negotiationId: '' },
  }), /negotiationId/i);
  assertRejected(validateSignalMessage({
    type: 'signal',
    targetId: 'player-2',
    data: { type: 'ice', candidate: null, negotiationId: '界'.repeat(43) },
  }), /negotiationId|128/i);
});

test('RTC signaling bounds SDP and ICE text before the server can relay it', () => {
  assertRejected(validateSignalMessage({
    type: 'signal',
    targetId: 'player-2',
    data: { type: 'offer', sdp: 's'.repeat((48 * 1024) + 1) },
  }), /sdp|49152|bytes/i);
  assertRejected(validateSignalMessage({
    type: 'signal',
    targetId: 'player-2',
    data: { type: 'ice', candidate: 'c'.repeat(4097) },
  }), /candidate|4096|bytes/i);
  for (const field of ['sdpMid', 'usernameFragment']) {
    assertRejected(validateSignalMessage({
      type: 'signal',
      targetId: 'player-2',
      data: { type: 'ice', candidate: 'candidate:1', [field]: 'm'.repeat(257) },
    }), new RegExp(`${field}|256|bytes`, 'i'));
  }
});

test('signal validator rejects a type inherited from a custom prototype', () => {
  assertRejected(validateSignalMessage(Object.create({ type: 'ping' })), /object|prototype|own/i);
});

test('signal validator does not let inherited unknown fields bypass its allowlist', () => {
  const message = Object.assign(Object.create({ isAdmin: true }), {
    type: 'create-room',
    nickname: '船长',
  });

  assertRejected(validateSignalMessage(message), /object|prototype|inherited|unknown field/i);
});

test('control peer messages keep sequence and tick outside canonical intent', () => {
  const message = successfulValue(validatePeerMessage({
    type: 'control',
    roomCode: 'ab2cd9',
    hostEpoch: 4,
    seq: 12,
    tick: 360,
    intent: { steerRight: true, hikeOut: true },
  }, 4));

  assert.deepEqual(message, {
    type: 'control',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    seq: 12,
    tick: 360,
    intent: {
      ...EMPTY_INTENT,
      steerRight: true,
      hikeOut: true,
    },
  });
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.intent), true);
});

test('control peer messages reject invalid sequence and tick metadata', () => {
  const base = {
    type: 'control',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    seq: 0,
    tick: 0,
    intent: {},
  };

  for (const [field, value] of [
    ['seq', -1],
    ['seq', 1.5],
    ['seq', Number.MAX_SAFE_INTEGER + 1],
    ['tick', -1],
    ['tick', 1.5],
    ['tick', Number.MAX_SAFE_INTEGER + 1],
  ]) {
    assertRejected(validatePeerMessage({ ...base, [field]: value }, 4), new RegExp(field, 'i'));
  }
});

test('chat preserves unrestricted Unicode content exactly', () => {
  const text = '  \u0000你好\n<script>alert("x")</script>🏴‍☠️  ';
  const message = successfulValue(validatePeerMessage({
    type: 'chat',
    roomCode: 'AB2CD9',
    hostEpoch: 7,
    text,
  }, 7));

  assert.equal(message.text, text);
});

test('chat rejects text over 500 Unicode code points instead of truncating it', () => {
  const accepted = validatePeerMessage({
    type: 'chat',
    roomCode: 'AB2CD9',
    hostEpoch: 7,
    text: '🚩'.repeat(MAX_CHAT_LENGTH),
  }, 7);
  const rejected = validatePeerMessage({
    type: 'chat',
    roomCode: 'AB2CD9',
    hostEpoch: 7,
    text: '🚩'.repeat(MAX_CHAT_LENGTH + 1),
  }, 7);

  assert.equal(accepted.ok, true, accepted.error);
  assertRejected(rejected, /500/);
});

test('peer validator rejects messages from a stale host epoch', () => {
  assertRejected(validatePeerMessage({
    type: 'chat',
    roomCode: 'AB2CD9',
    hostEpoch: 3,
    text: 'still here',
  }, 4), /stale.*epoch/i);
});

test('peer validator rejects messages from an unannounced future host epoch', () => {
  assertRejected(validatePeerMessage({
    type: 'chat',
    roomCode: 'AB2CD9',
    hostEpoch: 5,
    text: 'too early',
  }, 4), /future.*epoch/i);
});

test('peer validator rejects a complete envelope inherited from a custom prototype', () => {
  const message = Object.create({
    type: 'chat',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    text: 'forged',
  });

  assertRejected(validatePeerMessage(message, 4), /object|prototype|own/i);
});

test('peer validator rejects unknown types and never passes unknown fields through', () => {
  assertRejected(validatePeerMessage({
    type: 'teleport',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
  }, 4), /unknown peer type/i);
  assertRejected(validatePeerMessage({
    type: 'chat',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    text: 'hello',
    coordinates: { x: 999, z: 999 },
  }, 4), /unknown field/i);
});

test('peer validator rejects non-enumerable and symbol unknown fields', () => {
  const hidden = {
    type: 'chat',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    text: 'hello',
  };
  Object.defineProperty(hidden, 'payload', { value: { injected: true } });
  assertRejected(validatePeerMessage(hidden, 4), /unknown field/i);

  const symbol = Symbol('payload');
  assertRejected(validatePeerMessage({
    type: 'host-ready',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    tick: 60,
    [symbol]: true,
  }, 4), /unknown field/i);
});

test('snapshot and checkpoint messages clone bounded world state and match envelope authority', () => {
  for (const type of ['snapshot', 'checkpoint']) {
    const state = makeWorldState();
    const message = successfulValue(validatePeerMessage({
      type,
      roomCode: 'AB2CD9',
      hostEpoch: 4,
      tick: 60,
      state,
    }, 4));
    state.boats[0].phys.x = 999;

    assert.equal(message.state.boats[0].phys.x, 0);
    assert.equal(Object.isFrozen(message), true);
    assert.equal(Object.isFrozen(message.state), true);
  }

  assertRejected(validatePeerMessage({
    type: 'snapshot',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    tick: 61,
    state: makeWorldState({ tick: 60 }),
  }, 4), /tick/i);
  assertRejected(validatePeerMessage({
    type: 'checkpoint',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    tick: 60,
    state: { ...makeWorldState(), injected: true },
  }, 4), /unknown|world state/i);
});

test('chat-delivery preserves Unicode but requires an explicit sourceId', () => {
  const text = '  \u0000自由聊天🏴‍☠️\n  ';
  const message = successfulValue(validatePeerMessage({
    type: 'chat-delivery',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    sourceId: 'guest-1',
    text,
  }, 4));

  assert.equal(message.text, text);
  assert.equal(message.sourceId, 'guest-1');
  assertRejected(validatePeerMessage({
    type: 'chat-delivery',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    text,
  }, 4), /sourceId/i);
  assertRejected(validatePeerMessage({
    type: 'chat-delivery',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    sourceId: 'guest-1',
    text: '🚩'.repeat(MAX_CHAT_LENGTH + 1),
  }, 4), /500/);
});

test('start-race, rescue-request, and host-ready use strict numeric metadata', () => {
  const messages = [
    {
      type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 4, tick: 120, seed: 'race-1',
      config: startConfigForTick(120),
    },
    { type: 'rescue-request', roomCode: 'AB2CD9', hostEpoch: 4, tick: 121, seq: 3 },
    { type: 'host-ready', roomCode: 'AB2CD9', hostEpoch: 4, tick: 122 },
  ];
  for (const raw of messages) {
    assert.equal(validatePeerMessage(raw, 4).ok, true, raw.type);
    assertRejected(validatePeerMessage({ ...raw, tick: -1 }, 4), /tick/i);
    assertRejected(validatePeerMessage({ ...raw, injected: true }, 4), /unknown field/i);
  }
  assertRejected(validatePeerMessage({ ...messages[0], seed: '' }, 4), /seed/i);
  assertRejected(validatePeerMessage({ ...messages[1], seq: 1.5 }, 4), /seq/i);
});

test('start-race carries one strict bounded environment and roster configuration', () => {
  const raw = {
    type: 'start-race',
    roomCode: 'AB2CD9',
    hostEpoch: 4,
    tick: 120,
    seed: 'race-1',
    config: START_RACE_CONFIG,
  };

  const message = successfulValue(validatePeerMessage(raw, 4));
  assert.deepEqual(message.config, START_RACE_CONFIG);
  assert.equal(Object.isFrozen(message.config), true);
  assert.equal(Object.isFrozen(message.config.roster), true);
  assert.equal(Object.isFrozen(message.config.roster[0]), true);

  const missingConfig = { ...raw };
  delete missingConfig.config;
  assertRejected(validatePeerMessage(missingConfig, 4), /config/i);

  assertRejected(validatePeerMessage({
    ...raw,
    config: { ...START_RACE_CONFIG, weatherHack: true },
  }, 4), /unknown field/i);
  assertRejected(validatePeerMessage({
    ...raw,
    config: {
      ...START_RACE_CONFIG,
      roster: [
        { playerId: 'host', nickname: '船长' },
        { playerId: 'host', nickname: '冒名者' },
      ],
    },
  }, 4), /duplicate/i);
  assertRejected(validatePeerMessage({
    ...raw,
    config: { ...START_RACE_CONFIG, windKn: 100 },
  }, 4), /windKn/i);
  assertRejected(validatePeerMessage({
    ...raw,
    config: { ...START_RACE_CONFIG, startTick: 121 },
  }, 4), /startTick|countdown/i);
  assertRejected(validatePeerMessage({
    ...raw,
    config: {
      ...START_RACE_CONFIG,
      roster: Array.from({ length: 8 }, (_, index) => ({
        playerId: `p-${index}`,
        nickname: `P${index}`,
      })),
      aiFill: 1,
    },
  }, 4), /eight|8/i);
});

test('every authoritative peer type rejects a stale epoch', () => {
  const state = makeWorldState({ hostEpoch: 3 });
  const messages = [
    { type: 'snapshot', roomCode: 'AB2CD9', hostEpoch: 3, tick: 60, state },
    { type: 'checkpoint', roomCode: 'AB2CD9', hostEpoch: 3, tick: 60, state },
    { type: 'chat-delivery', roomCode: 'AB2CD9', hostEpoch: 3, sourceId: 'guest-1', text: 'hi' },
    {
      type: 'start-race', roomCode: 'AB2CD9', hostEpoch: 3, tick: 60, seed: 'race-1',
      config: startConfigForTick(60),
    },
    { type: 'host-ready', roomCode: 'AB2CD9', hostEpoch: 3, tick: 60 },
  ];

  for (const message of messages) {
    assertRejected(validatePeerMessage(message, 4), /stale.*epoch/i);
  }
});
