import {
  cloneWorldState,
  MAX_SEED_BYTES,
  MAX_WORLD_STATE_BYTES,
} from './worldState.js';

export const PROTOCOL_VERSION = 1;
export const MAX_PLAYERS = 8;
export const MAX_NICKNAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 500;
export const MAX_NEGOTIATION_ID_BYTES = 128;
export const MAX_PLAYER_ID_BYTES = 128;
export const MAX_RESUME_TOKEN_BYTES = 256;
export const MAX_SDP_BYTES = 48 * 1024;
export const MAX_ICE_CANDIDATE_BYTES = 4 * 1024;
export const MAX_ICE_METADATA_BYTES = 256;
export const MAX_START_WIND_KNOTS = 40;
export const MAX_START_COUNTDOWN_SECONDS = 120;

const ROOM_CODE_INPUT_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjklmnpqrstuvwxyz23456789]{6}$/;

const CONTROL_FIELDS = Object.freeze([
  'steerLeft',
  'steerRight',
  'sheetIn',
  'sheetOut',
  'hikeOut',
  'hikeIn',
  'boardDown',
  'boardUp',
  'righting',
]);

const CONTROL_FIELD_SET = new Set(CONTROL_FIELDS);
const SIGNAL_TYPES = new Set([
  'create-room',
  'join-room',
  'resume',
  'set-ready',
  'lock-room',
  'signal',
  'leave',
  'ping',
]);
const PEER_TYPES = new Set([
  'control',
  'chat',
  'snapshot',
  'checkpoint',
  'chat-delivery',
  'start-race',
  'rescue-request',
  'host-ready',
]);

const textEncoder = new TextEncoder();

function success(value) {
  return Object.freeze({ ok: true, value });
}

function failure(error) {
  return Object.freeze({ ok: false, error });
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function codePointLength(value) {
  return Array.from(value).length;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function rejectUnknownFields(value, allowedFields, context) {
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== 'string' || !allowedFields.has(field)) {
      return failure(`unknown field "${String(field)}" in ${context}`);
    }
  }
  for (const field in value) {
    if (!Object.hasOwn(value, field)) {
      return failure(`inherited field "${field}" is not allowed in ${context}`);
    }
  }
  return null;
}

function rejectMissingOwnFields(value, requiredFields, context) {
  const missing = requiredFields.find((field) => !Object.hasOwn(value, field));
  return missing === undefined
    ? null
    : failure(`${context} requires own field "${missing}"`);
}

function normalizeOpaqueId(value, field) {
  if (typeof value !== 'string') return failure(`${field} must be a string`);
  if (value.length === 0) return failure(`${field} cannot be empty`);
  return success(value);
}

function normalizeBoundedOpaqueId(value, field, maximumBytes) {
  const normalized = normalizeOpaqueId(value, field);
  if (!normalized.ok) return normalized;
  if (textEncoder.encode(normalized.value).byteLength > maximumBytes) {
    return failure(`${field} cannot exceed ${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function normalizeNonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return failure(`${field} must be a non-negative safe integer`);
  }
  return success(value);
}

function normalizeSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return success(value);
  if (typeof value !== 'string' || value.length === 0) {
    return failure('seed must be a non-empty string or finite number');
  }
  if (textEncoder.encode(value).byteLength > MAX_SEED_BYTES) {
    return failure(`seed cannot exceed ${MAX_SEED_BYTES} UTF-8 bytes`);
  }
  return success(value);
}

function normalizeBoundedFinite(value, field, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    return failure(`${field} must be a finite number between ${minimum} and ${maximum}`);
  }
  return success(value);
}

function normalizeStartRoster(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_PLAYERS) {
    return failure(`start-race roster must contain two to ${MAX_PLAYERS} players`);
  }
  const ids = new Set();
  const roster = [];
  for (let index = 0; index < value.length; index += 1) {
    const member = value[index];
    const context = `start-race roster[${index}]`;
    if (!isRecord(member)) return failure(`${context} must be a plain object`);
    const unknown = rejectUnknownFields(member, new Set(['playerId', 'nickname']), context);
    if (unknown) return unknown;
    const missing = rejectMissingOwnFields(member, ['playerId', 'nickname'], context);
    if (missing) return missing;
    const playerId = normalizeOpaqueId(member.playerId, `${context}.playerId`);
    if (!playerId.ok) return playerId;
    if (textEncoder.encode(playerId.value).byteLength > MAX_NEGOTIATION_ID_BYTES) {
      return failure(`${context}.playerId cannot exceed ${MAX_NEGOTIATION_ID_BYTES} UTF-8 bytes`);
    }
    if (ids.has(playerId.value)) return failure(`duplicate roster playerId ${playerId.value}`);
    const nickname = normalizeNickname(member.nickname);
    if (!nickname.ok) return failure(`${context}: ${nickname.error}`);
    ids.add(playerId.value);
    roster.push(Object.freeze({ playerId: playerId.value, nickname: nickname.value }));
  }
  return success(Object.freeze(roster));
}

function normalizeStartRaceConfig(value, envelopeTick) {
  if (!isRecord(value)) return failure('start-race config must be a plain object');
  const fields = new Set([
    'windPsi', 'windKn', 'gustiness', 'countdown', 'startTick', 'roster', 'aiFill',
  ]);
  const unknown = rejectUnknownFields(value, fields, 'start-race config');
  if (unknown) return unknown;
  const missing = rejectMissingOwnFields(value, [...fields], 'start-race config');
  if (missing) return missing;

  const windPsi = normalizeBoundedFinite(value.windPsi, 'windPsi', -Math.PI, Math.PI);
  if (!windPsi.ok) return windPsi;
  const windKn = normalizeBoundedFinite(value.windKn, 'windKn', 0.5, MAX_START_WIND_KNOTS);
  if (!windKn.ok) return windKn;
  const gustiness = normalizeBoundedFinite(value.gustiness, 'gustiness', 0, 1);
  if (!gustiness.ok) return gustiness;
  if (!Number.isSafeInteger(value.countdown)
    || value.countdown < 0
    || value.countdown > MAX_START_COUNTDOWN_SECONDS) {
    return failure(`countdown must be an integer between 0 and ${MAX_START_COUNTDOWN_SECONDS}`);
  }
  const startTick = normalizeNonNegativeSafeInteger(value.startTick, 'startTick');
  if (!startTick.ok) return startTick;
  const expectedStartTick = envelopeTick + value.countdown * 60;
  if (!Number.isSafeInteger(expectedStartTick) || startTick.value !== expectedStartTick) {
    return failure('startTick must equal message tick plus countdown at 60 Hz');
  }
  const roster = normalizeStartRoster(value.roster);
  if (!roster.ok) return roster;
  if (!Number.isSafeInteger(value.aiFill) || value.aiFill < 0) {
    return failure('aiFill must be a non-negative safe integer');
  }
  if (roster.value.length + value.aiFill > MAX_PLAYERS) {
    return failure(`roster plus aiFill cannot exceed ${MAX_PLAYERS} boats`);
  }

  return success(deepFreeze({
    windPsi: windPsi.value,
    windKn: windKn.value,
    gustiness: gustiness.value,
    countdown: value.countdown,
    startTick: startTick.value,
    roster: roster.value,
    aiFill: value.aiFill,
  }));
}

export function normalizeStartDescriptor(value) {
  if (!isRecord(value)) return failure('start descriptor must be a plain object');
  const fields = new Set(['tick', 'seed', 'config']);
  const unknown = rejectUnknownFields(value, fields, 'start descriptor');
  if (unknown) return unknown;
  const missing = rejectMissingOwnFields(value, [...fields], 'start descriptor');
  if (missing) return missing;

  const tick = normalizeNonNegativeSafeInteger(value.tick, 'tick');
  if (!tick.ok) return tick;
  const seed = normalizeSeed(value.seed);
  if (!seed.ok) return seed;
  const config = normalizeStartRaceConfig(value.config, tick.value);
  if (!config.ok) return config;

  return success(deepFreeze({
    tick: tick.value,
    seed: seed.value,
    config: config.value,
  }));
}

export function startDescriptorsEqual(left, right) {
  const normalizedLeft = normalizeStartDescriptor(left);
  if (!normalizedLeft.ok) return false;
  const normalizedRight = normalizeStartDescriptor(right);
  if (!normalizedRight.ok) return false;
  return JSON.stringify(normalizedLeft.value) === JSON.stringify(normalizedRight.value);
}

function normalizeNegotiationId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return failure('negotiationId must be a non-empty string');
  }
  if (textEncoder.encode(value).byteLength > MAX_NEGOTIATION_ID_BYTES) {
    return failure(`negotiationId cannot exceed ${MAX_NEGOTIATION_ID_BYTES} UTF-8 bytes`);
  }
  return success(value);
}

function normalizeChatText(value) {
  if (typeof value !== 'string') return failure('chat text must be a string');
  if (codePointLength(value) > MAX_CHAT_LENGTH) {
    return failure(`chat text cannot exceed ${MAX_CHAT_LENGTH} Unicode characters`);
  }
  return success(value);
}

function normalizePeerWorldState(value, envelope, tick) {
  let state;
  try {
    state = cloneWorldState(value);
  } catch (error) {
    return failure(`invalid world state: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (state.tick !== tick) return failure('world state tick must match message tick');
  if (state.hostEpoch !== envelope.hostEpoch) {
    return failure('world state hostEpoch must match message hostEpoch');
  }
  if (textEncoder.encode(JSON.stringify(state)).byteLength > MAX_WORLD_STATE_BYTES) {
    return failure(`world state cannot exceed ${MAX_WORLD_STATE_BYTES} bytes`);
  }
  return success(deepFreeze(state));
}

export function normalizeNickname(value) {
  if (typeof value !== 'string') return failure('nickname must be a string');

  const nickname = value.trim();
  if (nickname.length === 0) return failure('nickname cannot be empty');
  if (codePointLength(nickname) > MAX_NICKNAME_LENGTH) {
    return failure(`nickname cannot exceed ${MAX_NICKNAME_LENGTH} Unicode characters`);
  }

  return success(nickname);
}

export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return failure('room code must be a string');

  const input = value.trim();
  if (!ROOM_CODE_INPUT_PATTERN.test(input)) {
    return failure('room code must contain six unambiguous uppercase characters');
  }

  return success(input.toUpperCase());
}

export function normalizeControlIntent(value) {
  if (!isRecord(value)) return failure('control intent must be a plain or null-prototype object');

  const unknown = rejectUnknownFields(value, CONTROL_FIELD_SET, 'control intent');
  if (unknown) return unknown;

  const intent = {};
  for (const field of CONTROL_FIELDS) {
    if (Object.hasOwn(value, field) && typeof value[field] !== 'boolean') {
      return failure(`${field} must be a Boolean`);
    }
    intent[field] = Object.hasOwn(value, field) ? value[field] : false;
  }

  return success(Object.freeze(intent));
}

function normalizeRtcSignal(value) {
  if (!isRecord(value)) return failure('signal data must be a plain or null-prototype object');

  const missingType = rejectMissingOwnFields(value, ['type'], 'signal data');
  if (missingType) return missingType;

  if (value.type === 'offer' || value.type === 'answer') {
    const unknown = rejectUnknownFields(
      value,
      new Set(['type', 'sdp', 'negotiationId']),
      'signal data',
    );
    if (unknown) return unknown;
    const missing = rejectMissingOwnFields(value, ['type', 'sdp'], 'signal data');
    if (missing) return missing;
    if (typeof value.sdp !== 'string') return failure('signal sdp must be a string');
    if (textEncoder.encode(value.sdp).byteLength > MAX_SDP_BYTES) {
      return failure(`signal sdp cannot exceed ${MAX_SDP_BYTES} UTF-8 bytes`);
    }
    const data = { type: value.type, sdp: value.sdp };
    if (Object.hasOwn(value, 'negotiationId')) {
      const negotiationId = normalizeNegotiationId(value.negotiationId);
      if (!negotiationId.ok) return negotiationId;
      data.negotiationId = negotiationId.value;
    }
    return success(Object.freeze(data));
  }

  if (value.type === 'ice') {
    const allowed = new Set([
      'type',
      'candidate',
      'sdpMid',
      'sdpMLineIndex',
      'usernameFragment',
      'negotiationId',
    ]);
    const unknown = rejectUnknownFields(value, allowed, 'signal data');
    if (unknown) return unknown;
    const missing = rejectMissingOwnFields(value, ['type', 'candidate'], 'signal data');
    if (missing) return missing;
    if (value.candidate !== null && typeof value.candidate !== 'string') {
      return failure('ICE candidate must be a string or null');
    }
    if (typeof value.candidate === 'string'
      && textEncoder.encode(value.candidate).byteLength > MAX_ICE_CANDIDATE_BYTES) {
      return failure(`ICE candidate cannot exceed ${MAX_ICE_CANDIDATE_BYTES} UTF-8 bytes`);
    }
    if (Object.hasOwn(value, 'sdpMid') && value.sdpMid !== null && typeof value.sdpMid !== 'string') {
      return failure('ICE sdpMid must be a string or null');
    }
    if (typeof value.sdpMid === 'string'
      && textEncoder.encode(value.sdpMid).byteLength > MAX_ICE_METADATA_BYTES) {
      return failure(`ICE sdpMid cannot exceed ${MAX_ICE_METADATA_BYTES} UTF-8 bytes`);
    }
    if (
      Object.hasOwn(value, 'sdpMLineIndex')
      && value.sdpMLineIndex !== null
      && (!Number.isSafeInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0)
    ) {
      return failure('ICE sdpMLineIndex must be a non-negative safe integer or null');
    }
    if (
      Object.hasOwn(value, 'usernameFragment')
      && value.usernameFragment !== null
      && typeof value.usernameFragment !== 'string'
    ) {
      return failure('ICE usernameFragment must be a string or null');
    }
    if (typeof value.usernameFragment === 'string'
      && textEncoder.encode(value.usernameFragment).byteLength > MAX_ICE_METADATA_BYTES) {
      return failure(`ICE usernameFragment cannot exceed ${MAX_ICE_METADATA_BYTES} UTF-8 bytes`);
    }

    const data = { type: 'ice', candidate: value.candidate };
    for (const field of ['sdpMid', 'sdpMLineIndex', 'usernameFragment']) {
      if (Object.hasOwn(value, field)) data[field] = value[field];
    }
    if (Object.hasOwn(value, 'negotiationId')) {
      const negotiationId = normalizeNegotiationId(value.negotiationId);
      if (!negotiationId.ok) return negotiationId;
      data.negotiationId = negotiationId.value;
    }
    return success(Object.freeze(data));
  }

  return failure(`unknown RTC signal type: ${String(value.type)}`);
}

export function validateSignalMessage(value) {
  if (!isRecord(value)) return failure('signal message must be a plain or null-prototype object');
  const missingType = rejectMissingOwnFields(value, ['type'], 'signal message');
  if (missingType) return missingType;
  if (typeof value.type !== 'string' || !SIGNAL_TYPES.has(value.type)) {
    return failure(`unknown signal type: ${String(value.type)}`);
  }

  if (value.type === 'create-room') {
    const unknown = rejectUnknownFields(value, new Set(['type', 'nickname']), 'create-room message');
    if (unknown) return unknown;
    const missing = rejectMissingOwnFields(value, ['type', 'nickname'], 'create-room message');
    if (missing) return missing;
    const nickname = normalizeNickname(value.nickname);
    if (!nickname.ok) return nickname;
    return success(Object.freeze({ type: value.type, nickname: nickname.value }));
  }

  if (value.type === 'join-room') {
    const unknown = rejectUnknownFields(
      value,
      new Set(['type', 'roomCode', 'nickname']),
      'join-room message',
    );
    if (unknown) return unknown;
    const missing = rejectMissingOwnFields(
      value,
      ['type', 'roomCode', 'nickname'],
      'join-room message',
    );
    if (missing) return missing;
    const roomCode = normalizeRoomCode(value.roomCode);
    if (!roomCode.ok) return roomCode;
    const nickname = normalizeNickname(value.nickname);
    if (!nickname.ok) return nickname;
    return success(Object.freeze({
      type: value.type,
      roomCode: roomCode.value,
      nickname: nickname.value,
    }));
  }

  if (value.type === 'resume') {
    const unknown = rejectUnknownFields(
      value,
      new Set(['type', 'roomCode', 'playerId', 'resumeToken']),
      'resume message',
    );
    if (unknown) return unknown;
    const missing = rejectMissingOwnFields(
      value,
      ['type', 'roomCode', 'playerId', 'resumeToken'],
      'resume message',
    );
    if (missing) return missing;
    const roomCode = normalizeRoomCode(value.roomCode);
    if (!roomCode.ok) return roomCode;
    const playerId = normalizeBoundedOpaqueId(
      value.playerId,
      'playerId',
      MAX_PLAYER_ID_BYTES,
    );
    if (!playerId.ok) return playerId;
    const resumeToken = normalizeBoundedOpaqueId(
      value.resumeToken,
      'resumeToken',
      MAX_RESUME_TOKEN_BYTES,
    );
    if (!resumeToken.ok) return resumeToken;
    return success(Object.freeze({
      type: value.type,
      roomCode: roomCode.value,
      playerId: playerId.value,
      resumeToken: resumeToken.value,
    }));
  }

  if (value.type === 'set-ready') {
    const unknown = rejectUnknownFields(value, new Set(['type', 'ready']), 'set-ready message');
    if (unknown) return unknown;
    const missing = rejectMissingOwnFields(value, ['type', 'ready'], 'set-ready message');
    if (missing) return missing;
    if (typeof value.ready !== 'boolean') return failure('ready must be a Boolean');
    return success(Object.freeze({ type: value.type, ready: value.ready }));
  }

  if (value.type === 'lock-room') {
    const unknown = rejectUnknownFields(
      value,
      new Set(['type', 'start']),
      'lock-room message',
    );
    if (unknown) return unknown;
    const missing = rejectMissingOwnFields(value, ['type', 'start'], 'lock-room message');
    if (missing) return missing;
    const start = normalizeStartDescriptor(value.start);
    if (!start.ok) return start;
    return success(deepFreeze({ type: value.type, start: start.value }));
  }

  if (value.type === 'signal') {
    const unknown = rejectUnknownFields(
      value,
      new Set(['type', 'targetId', 'data']),
      'signal message',
    );
    if (unknown) return unknown;
    const missing = rejectMissingOwnFields(value, ['type', 'targetId', 'data'], 'signal message');
    if (missing) return missing;
    const targetId = normalizeOpaqueId(value.targetId, 'targetId');
    if (!targetId.ok) return targetId;
    const data = normalizeRtcSignal(value.data);
    if (!data.ok) return data;
    return success(Object.freeze({
      type: value.type,
      targetId: targetId.value,
      data: data.value,
    }));
  }

  const unknown = rejectUnknownFields(value, new Set(['type']), `${value.type} message`);
  if (unknown) return unknown;
  const missing = rejectMissingOwnFields(value, ['type'], `${value.type} message`);
  if (missing) return missing;
  return success(Object.freeze({ type: value.type }));
}

function validatePeerEnvelope(value, expectedEpoch, allowedFields) {
  const unknown = rejectUnknownFields(value, allowedFields, `${value.type} peer message`);
  if (unknown) return unknown;
  const missing = rejectMissingOwnFields(
    value,
    ['type', 'roomCode', 'hostEpoch'],
    `${value.type} peer message`,
  );
  if (missing) return missing;

  const roomCode = normalizeRoomCode(value.roomCode);
  if (!roomCode.ok) return roomCode;

  const hostEpoch = normalizeNonNegativeSafeInteger(value.hostEpoch, 'hostEpoch');
  if (!hostEpoch.ok) return hostEpoch;

  if (expectedEpoch !== undefined) {
    const expected = normalizeNonNegativeSafeInteger(expectedEpoch, 'expectedEpoch');
    if (!expected.ok) return expected;
    if (hostEpoch.value < expected.value) {
      return failure(`stale host epoch ${hostEpoch.value}; expected ${expected.value}`);
    }
    if (hostEpoch.value > expected.value) {
      return failure(`future host epoch ${hostEpoch.value}; expected ${expected.value}`);
    }
  }

  return success(Object.freeze({ roomCode: roomCode.value, hostEpoch: hostEpoch.value }));
}

export function validatePeerMessage(value, expectedEpoch) {
  if (!isRecord(value)) return failure('peer message must be a plain or null-prototype object');
  const missingType = rejectMissingOwnFields(value, ['type'], 'peer message');
  if (missingType) return missingType;
  if (typeof value.type !== 'string' || !PEER_TYPES.has(value.type)) {
    return failure(`unknown peer type: ${String(value.type)}`);
  }

  if (value.type === 'control') {
    const envelope = validatePeerEnvelope(
      value,
      expectedEpoch,
      new Set(['type', 'roomCode', 'hostEpoch', 'seq', 'tick', 'intent']),
    );
    if (!envelope.ok) return envelope;
    const missing = rejectMissingOwnFields(
      value,
      ['type', 'roomCode', 'hostEpoch', 'seq', 'tick', 'intent'],
      'control peer message',
    );
    if (missing) return missing;
    const seq = normalizeNonNegativeSafeInteger(value.seq, 'seq');
    if (!seq.ok) return seq;
    const tick = normalizeNonNegativeSafeInteger(value.tick, 'tick');
    if (!tick.ok) return tick;
    const intent = normalizeControlIntent(value.intent);
    if (!intent.ok) return intent;

    return success(Object.freeze({
      type: value.type,
      roomCode: envelope.value.roomCode,
      hostEpoch: envelope.value.hostEpoch,
      seq: seq.value,
      tick: tick.value,
      intent: intent.value,
    }));
  }

  if (value.type === 'snapshot' || value.type === 'checkpoint') {
    const envelope = validatePeerEnvelope(
      value,
      expectedEpoch,
      new Set(['type', 'roomCode', 'hostEpoch', 'tick', 'state']),
    );
    if (!envelope.ok) return envelope;
    const missing = rejectMissingOwnFields(
      value,
      ['type', 'roomCode', 'hostEpoch', 'tick', 'state'],
      `${value.type} peer message`,
    );
    if (missing) return missing;
    const tick = normalizeNonNegativeSafeInteger(value.tick, 'tick');
    if (!tick.ok) return tick;
    const state = normalizePeerWorldState(value.state, envelope.value, tick.value);
    if (!state.ok) return state;

    return success(Object.freeze({
      type: value.type,
      roomCode: envelope.value.roomCode,
      hostEpoch: envelope.value.hostEpoch,
      tick: tick.value,
      state: state.value,
    }));
  }

  if (value.type === 'chat-delivery') {
    const envelope = validatePeerEnvelope(
      value,
      expectedEpoch,
      new Set(['type', 'roomCode', 'hostEpoch', 'sourceId', 'text']),
    );
    if (!envelope.ok) return envelope;
    const missing = rejectMissingOwnFields(
      value,
      ['type', 'roomCode', 'hostEpoch', 'sourceId', 'text'],
      'chat-delivery peer message',
    );
    if (missing) return missing;
    const sourceId = normalizeOpaqueId(value.sourceId, 'sourceId');
    if (!sourceId.ok) return sourceId;
    const text = normalizeChatText(value.text);
    if (!text.ok) return text;

    return success(Object.freeze({
      type: value.type,
      roomCode: envelope.value.roomCode,
      hostEpoch: envelope.value.hostEpoch,
      sourceId: sourceId.value,
      text: text.value,
    }));
  }

  if (value.type === 'start-race') {
    const envelope = validatePeerEnvelope(
      value,
      expectedEpoch,
      new Set(['type', 'roomCode', 'hostEpoch', 'tick', 'seed', 'config']),
    );
    if (!envelope.ok) return envelope;
    const missing = rejectMissingOwnFields(
      value,
      ['type', 'roomCode', 'hostEpoch', 'tick', 'seed', 'config'],
      'start-race peer message',
    );
    if (missing) return missing;
    const tick = normalizeNonNegativeSafeInteger(value.tick, 'tick');
    if (!tick.ok) return tick;
    const seed = normalizeSeed(value.seed);
    if (!seed.ok) return seed;
    const config = normalizeStartRaceConfig(value.config, tick.value);
    if (!config.ok) return config;

    return success(Object.freeze({
      type: value.type,
      roomCode: envelope.value.roomCode,
      hostEpoch: envelope.value.hostEpoch,
      tick: tick.value,
      seed: seed.value,
      config: config.value,
    }));
  }

  if (value.type === 'rescue-request') {
    const envelope = validatePeerEnvelope(
      value,
      expectedEpoch,
      new Set(['type', 'roomCode', 'hostEpoch', 'tick', 'seq']),
    );
    if (!envelope.ok) return envelope;
    const missing = rejectMissingOwnFields(
      value,
      ['type', 'roomCode', 'hostEpoch', 'tick', 'seq'],
      'rescue-request peer message',
    );
    if (missing) return missing;
    const tick = normalizeNonNegativeSafeInteger(value.tick, 'tick');
    if (!tick.ok) return tick;
    const seq = normalizeNonNegativeSafeInteger(value.seq, 'seq');
    if (!seq.ok) return seq;

    return success(Object.freeze({
      type: value.type,
      roomCode: envelope.value.roomCode,
      hostEpoch: envelope.value.hostEpoch,
      tick: tick.value,
      seq: seq.value,
    }));
  }

  if (value.type === 'host-ready') {
    const envelope = validatePeerEnvelope(
      value,
      expectedEpoch,
      new Set(['type', 'roomCode', 'hostEpoch', 'tick']),
    );
    if (!envelope.ok) return envelope;
    const missing = rejectMissingOwnFields(
      value,
      ['type', 'roomCode', 'hostEpoch', 'tick'],
      'host-ready peer message',
    );
    if (missing) return missing;
    const tick = normalizeNonNegativeSafeInteger(value.tick, 'tick');
    if (!tick.ok) return tick;

    return success(Object.freeze({
      type: value.type,
      roomCode: envelope.value.roomCode,
      hostEpoch: envelope.value.hostEpoch,
      tick: tick.value,
    }));
  }

  const envelope = validatePeerEnvelope(
    value,
    expectedEpoch,
    new Set(['type', 'roomCode', 'hostEpoch', 'text']),
  );
  if (!envelope.ok) return envelope;
  const missing = rejectMissingOwnFields(
    value,
    ['type', 'roomCode', 'hostEpoch', 'text'],
    'chat peer message',
  );
  if (missing) return missing;
  const text = normalizeChatText(value.text);
  if (!text.ok) return text;

  return success(Object.freeze({
    type: value.type,
    roomCode: envelope.value.roomCode,
    hostEpoch: envelope.value.hostEpoch,
    text: text.value,
  }));
}
