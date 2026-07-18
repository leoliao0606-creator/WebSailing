import {
  MAX_PLAYER_ID_BYTES,
  MAX_RESUME_TOKEN_BYTES,
} from './protocol.js';

export const SIGNALING_SESSION_KEY = 'windchaser.signaling.session.v1';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const MAX_SIGNAL_DATA_BYTES = 64 * 1024;
const MAX_NEGOTIATION_ID_BYTES = 128;
const MAX_ICE_SERVERS = 32;
const MAX_ICE_URLS = 32;
const TERMINAL_RESUME_ERROR_CODES = new Set([
  'ROOM_NOT_FOUND',
  'PLAYER_NOT_FOUND',
  'INVALID_RESUME_TOKEN',
  'RESUME_EXPIRED',
]);
const DOMAIN_EVENT_TYPES = new Set([
  'member-joined',
  'host-changed',
  'member-left',
  'member-resumed',
  'member-removed',
  'room-removed',
  'ready-changed',
  'room-locked',
]);
const ROOM_PHASES = new Set(['lobby', 'racing']);
const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const MAX_STORED_CREDENTIALS_BYTES = 4 * 1024;
const CANONICAL_ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (...args) => globalThis.setTimeout(...args),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  now: () => Date.now(),
});
const UTF8_ENCODER = new TextEncoder();

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactRecord(value, allowedFields, requiredFields, path) {
  if (!isRecord(value)) throw new TypeError(`${path} must be a plain object`);
  const allowed = new Set(allowedFields);
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== 'string' || !allowed.has(field)) {
      throw new TypeError(`${path} contains unknown field ${String(field)}`);
    }
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${path} requires ${field}`);
  }
}

function stringValue(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string${nullable ? ' or null' : ''}`);
  }
  return value;
}

function boundedStringValue(value, path, maximumBytes, options) {
  const normalized = stringValue(value, path, options);
  if (normalized !== null && UTF8_ENCODER.encode(normalized).byteLength > maximumBytes) {
    throw new TypeError(`${path} cannot exceed ${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function canonicalRoomCode(value, path) {
  const code = stringValue(value, path);
  if (!CANONICAL_ROOM_CODE_PATTERN.test(code)) {
    throw new TypeError(`${path} must be a canonical six-character room code`);
  }
  return code;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function finiteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}

function booleanValue(value, path) {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a Boolean`);
  return value;
}

function boundedJson(value, path, maximumBytes = MAX_SIGNAL_DATA_BYTES) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || UTF8_ENCODER.encode(serialized).byteLength > maximumBytes) {
    throw new TypeError(`${path} cannot exceed ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function eventWithDetail(type, detail) {
  const frozenDetail = deepFreeze(detail);
  if (typeof globalThis.CustomEvent === 'function') {
    return new globalThis.CustomEvent(type, { detail: frozenDetail });
  }
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { enumerable: true, value: frozenDetail });
  return event;
}

function resolveSignalUrl(explicitUrl) {
  if (explicitUrl !== undefined) {
    if (typeof explicitUrl !== 'string' || explicitUrl.length === 0) {
      throw new TypeError('url must be a non-empty string');
    }
    const parsed = new URL(explicitUrl, globalThis.location?.href);
    if (parsed.pathname === '/') parsed.pathname = '/signal';
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:';
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new TypeError('url must use ws, wss, http, or https');
    }
    return parsed.href;
  }

  const pageHref = globalThis.location?.href;
  if (typeof pageHref !== 'string' || pageHref.length === 0) {
    throw new TypeError('url is required when location is unavailable');
  }
  const parsed = new URL('/signal', pageHref);
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else throw new TypeError('page location must use http or https');
  return parsed.href;
}

function sanitizeMember(value, index) {
  const path = `room.members[${index}]`;
  const fields = ['playerId', 'nickname', 'joinOrder', 'connected', 'ready', 'isHost'];
  exactRecord(value, fields, fields, path);
  return {
    playerId: stringValue(value.playerId, `${path}.playerId`),
    nickname: typeof value.nickname === 'string'
      ? value.nickname
      : (() => { throw new TypeError(`${path}.nickname must be a string`); })(),
    joinOrder: nonNegativeInteger(value.joinOrder, `${path}.joinOrder`),
    connected: booleanValue(value.connected, `${path}.connected`),
    ready: booleanValue(value.ready, `${path}.ready`),
    isHost: booleanValue(value.isHost, `${path}.isHost`),
  };
}

function sanitizeRoom(value) {
  const fields = ['roomCode', 'hostId', 'hostEpoch', 'phase', 'members'];
  exactRecord(value, fields, fields, 'room');
  if (!Array.isArray(value.members) || value.members.length > 8) {
    throw new TypeError('room.members must be an array of at most eight members');
  }
  if (typeof value.phase !== 'string' || !ROOM_PHASES.has(value.phase)) {
    throw new TypeError('room.phase must be lobby or racing');
  }
  return {
    roomCode: stringValue(value.roomCode, 'room.roomCode'),
    hostId: stringValue(value.hostId, 'room.hostId', { nullable: true }),
    hostEpoch: nonNegativeInteger(value.hostEpoch, 'room.hostEpoch'),
    phase: value.phase,
    members: value.members.map(sanitizeMember),
  };
}

function sanitizeCredentials(value) {
  if (!isRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !['playerId', 'resumeToken', 'roomCode'].every((key) => (
    Object.hasOwn(value, key)
  ))) return null;
  try {
    return {
      playerId: boundedStringValue(
        value.playerId,
        'stored playerId',
        MAX_PLAYER_ID_BYTES,
      ),
      resumeToken: boundedStringValue(
        value.resumeToken,
        'stored resumeToken',
        MAX_RESUME_TOKEN_BYTES,
      ),
      roomCode: canonicalRoomCode(value.roomCode, 'stored roomCode'),
    };
  } catch {
    return null;
  }
}

function sanitizeIceServers(value) {
  if (!Array.isArray(value) || value.length > MAX_ICE_SERVERS) {
    throw new TypeError(`session.iceServers must be an array of at most ${MAX_ICE_SERVERS} entries`);
  }
  const servers = value.map((server, index) => {
    const path = `session.iceServers[${index}]`;
    const fields = ['urls', 'username', 'credential', 'credentialType'];
    exactRecord(server, fields, ['urls'], path);

    let urls;
    if (typeof server.urls === 'string') {
      urls = stringValue(server.urls, `${path}.urls`);
    } else if (Array.isArray(server.urls)
      && server.urls.length > 0
      && server.urls.length <= MAX_ICE_URLS) {
      urls = server.urls.map((url, urlIndex) => (
        stringValue(url, `${path}.urls[${urlIndex}]`)
      ));
    } else {
      throw new TypeError(`${path}.urls must be a non-empty string or bounded string array`);
    }

    const normalized = { urls };
    for (const field of ['username', 'credential', 'credentialType']) {
      if (!Object.hasOwn(server, field)) continue;
      if (typeof server[field] !== 'string') {
        throw new TypeError(`${path}.${field} must be a string`);
      }
      normalized[field] = server[field];
    }
    return normalized;
  });
  return deepFreeze(boundedJson(servers, 'session.iceServers'));
}

function sanitizeRtcSignalData(value) {
  if (!isRecord(value)) throw new TypeError('signal.data must be a plain object');
  if (value.type === 'offer' || value.type === 'answer') {
    exactRecord(
      value,
      ['type', 'sdp', 'negotiationId'],
      ['type', 'sdp'],
      'signal.data',
    );
    if (typeof value.sdp !== 'string') throw new TypeError('signal.data.sdp must be a string');
    const normalized = { type: value.type, sdp: value.sdp };
    copyNegotiationId(value, normalized);
    return deepFreeze(boundedJson(normalized, 'signal.data'));
  }
  if (value.type !== 'ice') throw new TypeError('signal.data has an unknown RTC type');

  const fields = [
    'type',
    'candidate',
    'sdpMid',
    'sdpMLineIndex',
    'usernameFragment',
    'negotiationId',
  ];
  exactRecord(value, fields, ['type', 'candidate'], 'signal.data');
  if (value.candidate !== null && typeof value.candidate !== 'string') {
    throw new TypeError('signal.data.candidate must be a string or null');
  }
  const normalized = { type: 'ice', candidate: value.candidate };
  if (Object.hasOwn(value, 'sdpMid')) {
    if (value.sdpMid !== null && typeof value.sdpMid !== 'string') {
      throw new TypeError('signal.data.sdpMid must be a string or null');
    }
    normalized.sdpMid = value.sdpMid;
  }
  if (Object.hasOwn(value, 'sdpMLineIndex')) {
    if (value.sdpMLineIndex !== null
      && (!Number.isSafeInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0)) {
      throw new TypeError('signal.data.sdpMLineIndex must be non-negative or null');
    }
    normalized.sdpMLineIndex = value.sdpMLineIndex;
  }
  if (Object.hasOwn(value, 'usernameFragment')) {
    if (value.usernameFragment !== null && typeof value.usernameFragment !== 'string') {
      throw new TypeError('signal.data.usernameFragment must be a string or null');
    }
    normalized.usernameFragment = value.usernameFragment;
  }
  copyNegotiationId(value, normalized);
  return deepFreeze(boundedJson(normalized, 'signal.data'));
}

function copyNegotiationId(source, target) {
  if (!Object.hasOwn(source, 'negotiationId')) return;
  if (typeof source.negotiationId !== 'string' || source.negotiationId.length === 0) {
    throw new TypeError('signal.data.negotiationId must be a non-empty string');
  }
  if (UTF8_ENCODER.encode(source.negotiationId).byteLength > MAX_NEGOTIATION_ID_BYTES) {
    throw new TypeError(
      `signal.data.negotiationId cannot exceed ${MAX_NEGOTIATION_ID_BYTES} UTF-8 bytes`,
    );
  }
  target.negotiationId = source.negotiationId;
}

function sanitizeDomainEvent(message) {
  const base = ['type', 'roomCode', 'playerId'];
  if (message.type === 'member-joined') {
    exactRecord(message, [...base, 'joinOrder'], [...base, 'joinOrder'], message.type);
    return {
      type: message.type,
      roomCode: stringValue(message.roomCode, `${message.type}.roomCode`),
      playerId: stringValue(message.playerId, `${message.type}.playerId`),
      joinOrder: nonNegativeInteger(message.joinOrder, `${message.type}.joinOrder`),
    };
  }
  if (message.type === 'host-changed') {
    const fields = ['type', 'roomCode', 'previousHostId', 'hostId', 'hostEpoch'];
    exactRecord(message, fields, fields, message.type);
    return {
      type: message.type,
      roomCode: stringValue(message.roomCode, `${message.type}.roomCode`),
      previousHostId: stringValue(
        message.previousHostId,
        `${message.type}.previousHostId`,
        { nullable: true },
      ),
      hostId: stringValue(message.hostId, `${message.type}.hostId`, { nullable: true }),
      hostEpoch: nonNegativeInteger(message.hostEpoch, `${message.type}.hostEpoch`),
    };
  }
  if (message.type === 'member-left') {
    exactRecord(message, [...base, 'resumeUntil'], [...base, 'resumeUntil'], message.type);
    return {
      type: message.type,
      roomCode: stringValue(message.roomCode, `${message.type}.roomCode`),
      playerId: stringValue(message.playerId, `${message.type}.playerId`),
      resumeUntil: finiteNumber(message.resumeUntil, `${message.type}.resumeUntil`),
    };
  }
  if (message.type === 'ready-changed') {
    exactRecord(message, [...base, 'ready'], [...base, 'ready'], message.type);
    return {
      type: message.type,
      roomCode: stringValue(message.roomCode, `${message.type}.roomCode`),
      playerId: stringValue(message.playerId, `${message.type}.playerId`),
      ready: booleanValue(message.ready, `${message.type}.ready`),
    };
  }
  if (message.type === 'room-locked') {
    exactRecord(message, [...base, 'phase'], [...base, 'phase'], message.type);
    if (message.phase !== 'racing') {
      throw new TypeError('room-locked.phase must be racing');
    }
    return {
      type: message.type,
      roomCode: stringValue(message.roomCode, `${message.type}.roomCode`),
      playerId: stringValue(message.playerId, `${message.type}.playerId`),
      phase: message.phase,
    };
  }
  if (message.type === 'room-removed') {
    exactRecord(message, ['type', 'roomCode'], ['type', 'roomCode'], message.type);
    return {
      type: message.type,
      roomCode: stringValue(message.roomCode, `${message.type}.roomCode`),
    };
  }

  exactRecord(message, base, base, message.type);
  return {
    type: message.type,
    roomCode: stringValue(message.roomCode, `${message.type}.roomCode`),
    playerId: stringValue(message.playerId, `${message.type}.playerId`),
  };
}

export class SignalingClient extends EventTarget {
  #url;

  #WebSocketImpl;

  #storage;

  #timers;

  #random;

  #credentials = null;

  #socket = null;

  #generation = 0;

  #manualClose = false;

  #reconnectTimer = null;

  #reconnectAttempt = 0;

  #pendingConnect = null;

  #pendingLock = null;

  #state;

  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    storage = globalThis.sessionStorage,
    timers = DEFAULT_TIMERS,
    random = Math.random,
  } = {}) {
    super();
    if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocketImpl is required');
    if (!timers
      || typeof timers.setTimeout !== 'function'
      || typeof timers.clearTimeout !== 'function'
      || typeof timers.now !== 'function') {
      throw new TypeError('timers must provide setTimeout, clearTimeout, and now');
    }
    if (typeof random !== 'function') throw new TypeError('random must be a function');

    this.#url = resolveSignalUrl(url);
    this.#WebSocketImpl = WebSocketImpl;
    this.#storage = storage ?? null;
    this.#timers = timers;
    this.#random = random;
    this.#credentials = this.#loadCredentials();
    this.#state = {
      url: this.#url,
      connection: 'idle',
      connected: false,
      playerId: this.#credentials?.playerId ?? null,
      roomCode: this.#credentials?.roomCode ?? null,
      room: null,
      iceServers: [],
      reconnectAttempt: 0,
      lastError: null,
      lastPongAt: null,
    };
  }

  get state() {
    return deepFreeze(jsonClone(this.#state));
  }

  connect() {
    this.#manualClose = false;
    if (this.#socket?.readyState === this.#openState()) return Promise.resolve();
    this.#cancelReconnect();
    if (this.#pendingConnect && !this.#pendingConnect.reconnecting) {
      return this.#pendingConnect.promise;
    }
    if (this.#socket || this.#pendingConnect) {
      this.#abandonCurrentSocket(
        new Error('Signaling connection superseded by an explicit connect'),
        'superseded',
      );
    }
    return this.#openSocket(false);
  }

  createRoom(nickname) {
    return this.#send({ type: 'create-room', nickname });
  }

  joinRoom(roomCode, nickname) {
    return this.#send({ type: 'join-room', roomCode, nickname });
  }

  setReady(ready) {
    return this.#send({ type: 'set-ready', ready });
  }

  lockRoom({ timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
    if (this.#pendingLock) return this.#pendingLock.promise;
    if (!this.#state.roomCode || !this.#state.playerId) {
      return Promise.reject(new Error('A room session is required before locking'));
    }
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError('timeoutMs must be a positive finite number'));
    }
    let resolveLock;
    let rejectLock;
    const promise = new Promise((resolve, reject) => {
      resolveLock = resolve;
      rejectLock = reject;
    });
    const pending = {
      promise,
      resolve: resolveLock,
      reject: rejectLock,
      roomCode: this.#state.roomCode,
      playerId: this.#state.playerId,
      timer: null,
    };
    this.#pendingLock = pending;
    try {
      this.#send({ type: 'lock-room' });
    } catch (error) {
      this.#settlePendingLock(error);
      return promise;
    }
    pending.timer = this.#timers.setTimeout(() => {
      if (this.#pendingLock !== pending) return;
      this.#settlePendingLock(new Error('Room lock timed out'));
    }, timeoutMs);
    return promise;
  }

  sendSignal(targetId, data) {
    return this.#send({ type: 'signal', targetId, data });
  }

  leave() {
    this.#manualClose = false;
    this.#settlePendingLock(new Error('Room lock cancelled by leave'));
    this.#clearCredentials();
    const socket = this.#socket;
    if (socket?.readyState === this.#openState()) {
      return this.#sendOn(socket, { type: 'leave' });
    }
    return false;
  }

  close() {
    this.#manualClose = true;
    this.#cancelReconnect();
    this.#settlePendingLock(new Error('Room lock cancelled by close'));
    const socket = this.#socket;
    this.#socket = null;
    this.#generation += 1;
    this.#rejectPendingConnect(new Error('Signaling connection closed by client'));
    this.#safelyCloseSocket(socket, 1000, 'client closed');
    this.#discardCredentials();
    this.#commit({
      connection: 'closed',
      connected: false,
      playerId: null,
      roomCode: null,
      room: null,
      iceServers: [],
      reconnectAttempt: 0,
    });
  }

  #openState() {
    return this.#WebSocketImpl.OPEN ?? 1;
  }

  #closedState() {
    return this.#WebSocketImpl.CLOSED ?? 3;
  }

  #openSocket(reconnecting) {
    if (this.#socket || this.#pendingConnect) {
      this.#abandonCurrentSocket(
        new Error('Signaling connection superseded by a newer socket'),
        'superseded',
      );
    }
    const generation = this.#generation + 1;
    this.#generation = generation;
    let socket;
    try {
      socket = new this.#WebSocketImpl(this.#url);
    } catch (error) {
      if (reconnecting && !this.#manualClose) this.#scheduleReconnect();
      return Promise.reject(error);
    }
    let resolveOpen;
    let rejectOpen;
    const promise = new Promise((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    this.#socket = socket;
    this.#pendingConnect = {
      generation,
      promise,
      resolve: resolveOpen,
      reject: rejectOpen,
      settled: false,
      reconnecting,
    };
    this.#commit({ connection: reconnecting ? 'reconnecting' : 'connecting', connected: false });

    socket.addEventListener('open', () => {
      if (!this.#isCurrent(socket, generation)) return;
      try {
        if (this.#credentials) {
          this.#sendOn(socket, { type: 'resume', ...this.#credentials });
        }
      } catch (error) {
        this.#failOpen(socket, generation, error);
        return;
      }
      this.#reconnectAttempt = 0;
      this.#settlePendingConnect(generation);
      this.#commit({ connection: 'open', connected: true, reconnectAttempt: 0 });
      if (!this.#isCurrent(socket, generation)) return;
      this.dispatchEvent(eventWithDetail('open', { generation }));
    });

    socket.addEventListener('message', (event) => {
      if (!this.#isCurrent(socket, generation)) return;
      this.#handleMessage(event.data);
    });

    socket.addEventListener('error', () => {
      if (!this.#isCurrent(socket, generation)) return;
      this.dispatchEvent(eventWithDetail('transport-error', { generation }));
    });

    socket.addEventListener('close', (event) => {
      if (!this.#isCurrent(socket, generation)) return;
      this.#socket = null;
      this.#settlePendingLock(new Error('Signaling socket closed while locking room'));
      this.#rejectPendingConnect(
        new Error(`WebSocket closed before opening (${event.code ?? 0})`),
        generation,
      );
      const detail = deepFreeze({
        code: event.code ?? 0,
        reason: event.reason ?? '',
        wasClean: !!event.wasClean,
      });
      if (this.#manualClose) {
        this.#commit({ connection: 'closed', connected: false });
      } else {
        this.#scheduleReconnect(generation);
      }
      this.dispatchEvent(eventWithDetail('close', detail));
    });

    return promise;
  }

  #failOpen(socket, generation, error) {
    if (!this.#isCurrent(socket, generation)) return;
    this.#socket = null;
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.#rejectPendingConnect(normalized, generation);
    this.#safelyCloseSocket(socket, 1011, 'resume failed');
    if (this.#manualClose) {
      this.#commit({ connection: 'closed', connected: false });
    } else {
      this.#scheduleReconnect(generation);
    }
  }

  #abandonCurrentSocket(error, reason) {
    const socket = this.#socket;
    const generation = this.#generation;
    this.#socket = null;
    this.#rejectPendingConnect(error, generation);
    this.#safelyCloseSocket(socket, 1000, reason);
  }

  #safelyCloseSocket(socket, code, reason) {
    if (!socket || socket.readyState === this.#closedState()) return;
    try {
      socket.close(code, reason);
    } catch {
      // Closing is best effort after the generation has already been invalidated.
    }
  }

  #settlePendingConnect(generation, error = null) {
    const pending = this.#pendingConnect;
    if (!pending || pending.settled || pending.generation !== generation) return false;
    pending.settled = true;
    this.#pendingConnect = null;
    if (error === null) pending.resolve();
    else pending.reject(error);
    return true;
  }

  #rejectPendingConnect(error, generation = this.#pendingConnect?.generation) {
    if (generation === undefined) return false;
    return this.#settlePendingConnect(generation, error);
  }

  #isCurrent(socket, generation) {
    return this.#socket === socket && this.#generation === generation;
  }

  #scheduleReconnect(generation = this.#generation) {
    if (this.#manualClose
      || this.#reconnectTimer !== null
      || generation !== this.#generation
      || this.#socket !== null
      || this.#pendingConnect !== null) return false;
    const attempt = this.#reconnectAttempt;
    const exponential = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * (2 ** Math.min(attempt, 30)),
    );
    const randomValue = Math.max(0, Math.min(1, Number(this.#random()) || 0));
    const jittered = Math.round(exponential * (0.8 + randomValue * 0.4));
    const delay = Math.min(RECONNECT_MAX_MS, jittered);
    this.#reconnectAttempt += 1;
    const scheduled = { id: null, generation };
    scheduled.id = this.#timers.setTimeout(() => {
      if (this.#reconnectTimer !== scheduled) return;
      this.#reconnectTimer = null;
      if (this.#manualClose
        || this.#generation !== scheduled.generation
        || this.#socket !== null
        || this.#pendingConnect !== null) return;
      void this.#openSocket(true).catch(() => {});
    }, delay);
    this.#reconnectTimer = scheduled;
    this.#commit({
      connection: 'reconnecting',
      connected: false,
      reconnectAttempt: this.#reconnectAttempt,
    });
    if (this.#reconnectTimer !== scheduled) return true;
    this.dispatchEvent(eventWithDetail('reconnecting', {
      attempt: this.#reconnectAttempt,
      delay,
    }));
    return true;
  }

  #cancelReconnect() {
    if (this.#reconnectTimer === null) return;
    this.#timers.clearTimeout(this.#reconnectTimer.id);
    this.#reconnectTimer = null;
  }

  #send(message) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== this.#openState()) {
      throw new Error('Signaling socket is not open');
    }
    return this.#sendOn(socket, message);
  }

  #sendOn(socket, message) {
    socket.send(JSON.stringify(message));
    return true;
  }

  #handleMessage(data) {
    if (typeof data !== 'string') {
      this.#protocolError('server message must be text');
      return;
    }

    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.#protocolError('server message is not valid JSON');
      return;
    }
    if (!isRecord(message) || typeof message.type !== 'string') {
      this.#protocolError('server message requires a string type');
      return;
    }

    try {
      if (message.type === 'session') this.#handleSession(message);
      else if (message.type === 'room-view') this.#handleRoomView(message);
      else if (DOMAIN_EVENT_TYPES.has(message.type)) this.#handleDomainEvent(message);
      else if (message.type === 'signal') this.#handleSignal(message);
      else if (message.type === 'error') this.#handleServerError(message);
      else if (message.type === 'pong') this.#handlePong(message);
      else this.#protocolError(`unknown server message type: ${message.type}`, message.type);
    } catch (error) {
      this.#protocolError(error instanceof Error ? error.message : String(error), message.type);
    }
  }

  #handleSession(message) {
    const fields = ['type', 'playerId', 'resumeToken', 'roomCode', 'iceServers', 'room'];
    exactRecord(message, fields, fields, 'session');
    const room = sanitizeRoom(message.room);
    const credentials = {
      playerId: boundedStringValue(
        message.playerId,
        'session.playerId',
        MAX_PLAYER_ID_BYTES,
      ),
      resumeToken: boundedStringValue(
        message.resumeToken,
        'session.resumeToken',
        MAX_RESUME_TOKEN_BYTES,
      ),
      roomCode: canonicalRoomCode(message.roomCode, 'session.roomCode'),
    };
    if (credentials.roomCode !== room.roomCode) {
      throw new TypeError('session roomCode must match room.roomCode');
    }
    const iceServers = sanitizeIceServers(message.iceServers);

    this.#credentials = credentials;
    this.#saveCredentials();
    this.#manualClose = false;
    this.#reconnectAttempt = 0;
    this.#commit({
      playerId: credentials.playerId,
      roomCode: credentials.roomCode,
      room,
      iceServers,
      reconnectAttempt: 0,
      lastError: null,
    });
    this.dispatchEvent(eventWithDetail('session', deepFreeze({
      playerId: credentials.playerId,
      roomCode: credentials.roomCode,
      room: deepFreeze(jsonClone(room)),
      iceServers: deepFreeze(jsonClone(iceServers)),
    })));
  }

  #handleRoomView(message) {
    exactRecord(message, ['type', 'room'], ['type', 'room'], 'room-view');
    const room = sanitizeRoom(message.room);
    this.#commit({ roomCode: room.roomCode, room });
    this.dispatchEvent(eventWithDetail('room-view', deepFreeze(jsonClone(room))));
  }

  #handleDomainEvent(message) {
    const event = sanitizeDomainEvent(message);
    this.#applyDomainEvent(event);
    const detail = deepFreeze(jsonClone(event));
    this.dispatchEvent(eventWithDetail('domain-event', detail));
    this.dispatchEvent(eventWithDetail(event.type, detail));
    if (event.type === 'room-locked'
      && this.#pendingLock?.roomCode === event.roomCode
      && this.#pendingLock?.playerId === event.playerId) {
      this.#settlePendingLock(null, detail);
    }
    if (event.type === 'host-changed') {
      this.dispatchEvent(eventWithDetail('host-change', detail));
    }
  }

  #applyDomainEvent(event) {
    const current = this.#state.room;
    if (!current || current.roomCode !== event.roomCode) return;
    if (event.type === 'room-removed') {
      this.#clearCredentials();
      return;
    }

    const room = jsonClone(current);
    const member = Object.hasOwn(event, 'playerId')
      ? room.members.find((item) => item.playerId === event.playerId)
      : null;
    if (event.type === 'host-changed') {
      room.hostId = event.hostId;
      room.hostEpoch = event.hostEpoch;
      for (const item of room.members) item.isHost = item.playerId === event.hostId;
    } else if (event.type === 'ready-changed' && member) {
      member.ready = event.ready;
    } else if (event.type === 'room-locked') {
      room.phase = event.phase;
    } else if (event.type === 'member-left' && member) {
      member.connected = false;
      member.ready = false;
    } else if (event.type === 'member-resumed' && member) {
      member.connected = true;
    } else if (event.type === 'member-removed') {
      room.members = room.members.filter((item) => item.playerId !== event.playerId);
    }
    this.#commit({ room });
  }

  #handleSignal(message) {
    const fields = ['type', 'sourceId', 'data'];
    exactRecord(message, fields, fields, 'signal');
    const sourceId = stringValue(message.sourceId, 'signal.sourceId');
    const data = sanitizeRtcSignalData(message.data);
    const detail = deepFreeze(jsonClone({ sourceId, data }));
    this.dispatchEvent(eventWithDetail('signal', detail));
  }

  #handleServerError(message) {
    const fields = ['type', 'code', 'message'];
    exactRecord(message, fields, fields, 'error');
    const detail = deepFreeze({
      code: stringValue(message.code, 'error.code'),
      message: stringValue(message.message, 'error.message'),
    });
    if (this.#pendingLock) {
      const error = new Error(`${detail.code}: ${detail.message}`);
      Object.defineProperty(error, 'code', { value: detail.code, enumerable: true });
      this.#settlePendingLock(error);
    }
    if (TERMINAL_RESUME_ERROR_CODES.has(detail.code)) this.#clearCredentials();
    this.#commit({ lastError: detail });
    this.dispatchEvent(eventWithDetail('error', detail));
    if (TERMINAL_RESUME_ERROR_CODES.has(detail.code)) {
      this.dispatchEvent(eventWithDetail('session-expired', detail));
    }
  }

  #handlePong(message) {
    exactRecord(message, ['type'], ['type'], 'pong');
    const detail = deepFreeze({ at: finiteNumber(this.#timers.now(), 'timers.now()') });
    this.#commit({ lastPongAt: detail.at });
    this.dispatchEvent(eventWithDetail('pong', detail));
  }

  #protocolError(message, serverType = null) {
    this.dispatchEvent(eventWithDetail('protocol-error', deepFreeze({ message, serverType })));
  }

  #loadCredentials() {
    if (!this.#storage || typeof this.#storage.getItem !== 'function') return null;
    try {
      const raw = this.#storage.getItem(SIGNALING_SESSION_KEY);
      if (raw === null) return null;
      if (typeof raw !== 'string'
        || UTF8_ENCODER.encode(raw).byteLength > MAX_STORED_CREDENTIALS_BYTES) {
        this.#storage.removeItem?.(SIGNALING_SESSION_KEY);
        return null;
      }
      const credentials = sanitizeCredentials(JSON.parse(raw));
      if (credentials) return credentials;
      this.#storage.removeItem?.(SIGNALING_SESSION_KEY);
    } catch {
      try { this.#storage.removeItem?.(SIGNALING_SESSION_KEY); } catch {}
    }
    return null;
  }

  #settlePendingLock(error = null, detail = undefined) {
    const pending = this.#pendingLock;
    if (!pending) return false;
    this.#pendingLock = null;
    if (pending.timer !== null) this.#timers.clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(detail);
    return true;
  }

  #saveCredentials() {
    if (!this.#storage || typeof this.#storage.setItem !== 'function' || !this.#credentials) return;
    try {
      this.#storage.setItem(SIGNALING_SESSION_KEY, JSON.stringify(this.#credentials));
    } catch {}
  }

  #clearCredentials() {
    this.#discardCredentials();
    this.#commit({
      playerId: null,
      roomCode: null,
      room: null,
      iceServers: [],
      reconnectAttempt: 0,
    });
  }

  #discardCredentials() {
    this.#credentials = null;
    if (this.#storage && typeof this.#storage.removeItem === 'function') {
      try { this.#storage.removeItem(SIGNALING_SESSION_KEY); } catch {}
    }
    this.#reconnectAttempt = 0;
  }

  #commit(patch) {
    this.#state = { ...this.#state, ...patch };
    this.dispatchEvent(eventWithDetail('statechange', this.state));
  }
}
