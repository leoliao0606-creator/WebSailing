import { IntegrityMonitor } from './integrityMonitor.js';
import { validatePeerMessage } from './protocol.js';
import { cloneWorldState } from './worldState.js';

const AUTHORITY_TYPES = new Set([
  'snapshot',
  'checkpoint',
  'chat-delivery',
  'start-race',
  'host-ready',
]);

const GUEST_TYPES = new Set(['control', 'chat', 'rescue-request']);
const DEFAULT_CHAT_LIMIT = Object.freeze({ maxMessages: 5, windowMs: 5_000 });
const MAX_ROLLBACK_SECONDS = 0.5;
const ROLLBACK_EPSILON = 1e-9;
const CADENCE_EPSILON = 1e-9;

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
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

function requireEventTarget(value, path) {
  if (!value
    || typeof value.addEventListener !== 'function'
    || typeof value.removeEventListener !== 'function') {
    throw new TypeError(`${path} must be an EventTarget`);
  }
  return value;
}

function positiveRate(value, path, { minimum = Number.MIN_VALUE, maximum = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function nonNegativeTick(value, path = 'tick') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function finiteNow(value, path = 'now') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative finite number`);
  }
  return value;
}

function requiredId(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function normalizeRoom(value) {
  if (!isRecord(value)) throw new TypeError('room view must be a plain object');
  const roomCode = requiredId(value.roomCode, 'room.roomCode');
  const hostId = value.hostId === null
    ? null
    : requiredId(value.hostId, 'room.hostId');
  const hostEpoch = nonNegativeTick(value.hostEpoch, 'room.hostEpoch');
  if (value.phase !== 'lobby' && value.phase !== 'racing') {
    throw new TypeError('room.phase must be lobby or racing');
  }
  if (!Array.isArray(value.members) || value.members.length > 8) {
    throw new TypeError('room.members must be an array of at most eight members');
  }

  const memberIds = new Set();
  const members = value.members.map((member, index) => {
    if (!isRecord(member)) throw new TypeError(`room.members[${index}] must be an object`);
    const playerId = requiredId(member.playerId, `room.members[${index}].playerId`);
    if (memberIds.has(playerId)) throw new TypeError(`duplicate room member ${playerId}`);
    if (typeof member.connected !== 'boolean') {
      throw new TypeError(`room.members[${index}].connected must be a Boolean`);
    }
    if (typeof member.ready !== 'boolean') {
      throw new TypeError(`room.members[${index}].ready must be a Boolean`);
    }
    const nickname = member.nickname === undefined ? playerId : member.nickname;
    if (typeof nickname !== 'string' || nickname.length === 0) {
      throw new TypeError(`room.members[${index}].nickname must be a non-empty string`);
    }
    memberIds.add(playerId);
    return {
      playerId,
      nickname,
      connected: member.connected,
      ready: member.ready,
    };
  });

  if (hostId !== null && !memberIds.has(hostId)) {
    throw new TypeError('room.hostId must identify a room member');
  }
  return deepFreeze({ roomCode, hostId, hostEpoch, phase: value.phase, members });
}

function playerIdFromSignaling(signaling) {
  const state = signaling.state;
  const playerId = state?.playerId ?? state?.selfId;
  return typeof playerId === 'string' && playerId.length > 0 ? playerId : null;
}

function clockFunction(clock) {
  if (clock === undefined) return () => Date.now();
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return () => clock.now();
  throw new TypeError('clock must be a function or provide now()');
}

function normalizeChatLimit(value) {
  if (!isRecord(value)) throw new TypeError('chatLimit must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'maxMessages' && key !== 'windowMs') {
      throw new TypeError(`chatLimit contains unknown field ${String(key)}`);
    }
  }
  if (!Number.isSafeInteger(value.maxMessages) || value.maxMessages < 1) {
    throw new TypeError('chatLimit.maxMessages must be a positive safe integer');
  }
  const windowMs = positiveRate(value.windowMs, 'chatLimit.windowMs');
  return Object.freeze({ maxMessages: value.maxMessages, windowMs });
}

function immutableWorldState(value) {
  return deepFreeze(cloneWorldState(value));
}

function cadenceDue(nextAt, now) {
  return nextAt === null || now + CADENCE_EPSILON >= nextAt;
}

function advanceCadence(nextAt, now, interval) {
  if (nextAt === null) return now + interval;
  const elapsedIntervals = Math.max(1, Math.floor((now - nextAt) / interval) + 1);
  return nextAt + elapsedIntervals * interval;
}

export function leaveOrCloseMultiplayer(session) {
  if (!session || typeof session !== 'object') return false;
  if (!session.state?.roomCode) return true;
  let sent = false;
  try {
    sent = typeof session.leaveRoom === 'function' && session.leaveRoom() === true;
  } catch {
    sent = false;
  }
  if (!sent) session.close?.();
  return sent;
}

export class MultiplayerSession extends EventTarget {
  #signaling;

  #transport;

  #integrityMonitor;

  #checkpointIntegrityMonitor;

  #now;

  #inputInterval;

  #snapshotInterval;

  #checkpointInterval;

  #chatLimit;

  #listeners = [];

  #playerId;

  #room = null;

  #role = 'disconnected';

  #migrating = false;

  #invalidated = false;

  #raceStarted = false;

  #closed = false;

  #controlProvider = null;

  #snapshotProvider = null;

  #nextInputAt = null;

  #nextSnapshotAt = null;

  #nextCheckpointAt = null;

  #lastNow = -Infinity;

  #latestTick = 0;

  #controlSeq = 0;

  #rescueSeq = 0;

  #controlSeqBySource = new Map();

  #rescueSeqBySource = new Map();

  #chatTimesBySource = new Map();

  #latestCheckpoint = null;

  #latestAuthorityWorldTime = null;

  #promotedEpoch = null;

  #topologyPeerIds = null;

  #readyPeerIds = new Set();

  constructor({
    signaling,
    transport,
    integrityMonitor,
    checkpointIntegrityMonitor = new IntegrityMonitor(),
    clock,
    inputHz = 30,
    snapshotHz = 20,
    checkpointHz = 2,
    chatLimit = DEFAULT_CHAT_LIMIT,
  } = {}) {
    super();
    this.#signaling = requireEventTarget(signaling, 'signaling');
    this.#transport = requireEventTarget(transport, 'transport');
    if (typeof transport.sendToHost !== 'function' || typeof transport.broadcast !== 'function') {
      throw new TypeError('transport must provide sendToHost() and broadcast()');
    }
    if (!integrityMonitor || typeof integrityMonitor.inspect !== 'function') {
      throw new TypeError('integrityMonitor must provide inspect()');
    }
    this.#integrityMonitor = integrityMonitor;
    if (!checkpointIntegrityMonitor || typeof checkpointIntegrityMonitor.inspect !== 'function') {
      throw new TypeError('checkpointIntegrityMonitor must provide inspect()');
    }
    this.#checkpointIntegrityMonitor = checkpointIntegrityMonitor;
    this.#now = clockFunction(clock);
    this.#inputInterval = 1_000 / positiveRate(inputHz, 'inputHz');
    this.#snapshotInterval = 1_000 / positiveRate(
      snapshotHz,
      'snapshotHz',
      { minimum: 15, maximum: 20 },
    );
    this.#checkpointInterval = 1_000 / positiveRate(checkpointHz, 'checkpointHz');
    this.#chatLimit = normalizeChatLimit(chatLimit);
    this.#playerId = playerIdFromSignaling(signaling);

    this.#listen(this.#signaling, 'session', (event) => this.#handleSessionEvent(event));
    this.#listen(this.#signaling, 'room-view', (event) => this.#handleRoomEvent(event));
    this.#listen(this.#signaling, 'statechange', (event) => this.#handleSignalingStateChange(event));
    this.#listen(this.#signaling, 'host-changed', (event) => this.#handleHostChange(event));
    this.#listen(this.#signaling, 'domain-event', (event) => this.#handleDomainEvent(event));
    this.#listen(this.#transport, 'message', (event) => this.#handleTransportMessage(event));
    this.#listen(this.#transport, 'peer-message', (event) => this.#handleTransportMessage(event));
    this.#listen(this.#transport, 'ready', (event) => this.#handleTransportReady(event));
    this.#listen(this.#transport, 'topology', (event) => this.#handleTopology(event));
    this.#listen(this.#transport, 'peer-open', (event) => this.#handlePeerOpen(event));
    this.#listen(this.#transport, 'peer-close', (event) => this.#handlePeerClose(event));

    const initialRoom = signaling.state?.room;
    if (initialRoom) this.#safelyApplyRoom(initialRoom);
  }

  get state() {
    return deepFreeze({
      roomCode: this.#room?.roomCode ?? null,
      playerId: this.#playerId,
      hostId: this.#room?.hostId ?? null,
      hostEpoch: this.#room?.hostEpoch ?? null,
      phase: this.#room?.phase ?? null,
      role: this.#role,
      migrating: this.#migrating,
      invalidated: this.#invalidated,
      closed: this.#closed,
      members: this.#room?.members.map((member) => ({ ...member })) ?? [],
    });
  }

  get role() {
    return this.#role;
  }

  get latestCheckpoint() {
    return this.#latestCheckpoint;
  }

  configure(configuration = {}) {
    if (!isRecord(configuration)) throw new TypeError('configuration must be a plain object');
    for (const key of Reflect.ownKeys(configuration)) {
      if (key !== 'controlProvider' && key !== 'snapshotProvider') {
        throw new TypeError(`configuration contains unknown field ${String(key)}`);
      }
    }
    if (Object.hasOwn(configuration, 'controlProvider')) {
      const provider = configuration.controlProvider;
      if (provider !== null && provider !== undefined && typeof provider !== 'function') {
        throw new TypeError('controlProvider must be a function, null, or undefined');
      }
      this.#controlProvider = provider ?? null;
    }
    if (Object.hasOwn(configuration, 'snapshotProvider')) {
      const provider = configuration.snapshotProvider;
      if (provider !== null && provider !== undefined && typeof provider !== 'function') {
        throw new TypeError('snapshotProvider must be a function, null, or undefined');
      }
      this.#snapshotProvider = provider ?? null;
    }
    return this;
  }

  update({ tick, now } = {}) {
    nonNegativeTick(tick);
    const timestamp = finiteNow(now === undefined ? this.#now() : now);
    this.#latestTick = tick;
    if (timestamp < this.#lastNow) this.#resetCadence();
    this.#lastNow = timestamp;
    if (this.#closed || this.#invalidated || this.#migrating || !this.#room) return false;

    if (this.#role === 'guest') return this.#updateGuest(tick, timestamp);
    if (this.#role === 'host') return this.#updateHost(tick, timestamp);
    return false;
  }

  sendChat(text) {
    this.#assertActiveRoom();
    const message = this.#canonicalMessage({
      type: 'chat',
      roomCode: this.#room.roomCode,
      hostEpoch: this.#room.hostEpoch,
      text,
    });

    if (this.#role === 'guest') {
      return this.#transport.sendToHost(message, { reliable: true });
    }
    if (this.#role !== 'host') return false;
    return this.#relayChat(this.#playerId, message.text);
  }

  requestRescue() {
    this.#assertActiveRoom();
    if (this.#rescueSeq > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('rescue sequence is exhausted');
    }
    const message = this.#canonicalMessage({
      type: 'rescue-request',
      roomCode: this.#room.roomCode,
      hostEpoch: this.#room.hostEpoch,
      tick: this.#latestTick,
      seq: this.#rescueSeq,
    });
    this.#rescueSeq += 1;

    if (this.#role === 'guest') {
      return this.#transport.sendToHost(message, { reliable: true });
    }
    if (this.#role === 'host') {
      this.#dispatch('rescue-request', {
        playerId: this.#playerId,
        seq: message.seq,
        tick: message.tick,
      });
      return true;
    }
    return false;
  }

  leaveRoom() {
    if (this.#closed) return false;
    if (typeof this.#signaling.leave !== 'function') return false;
    return this.#signaling.leave() !== false;
  }

  startRace(configOrMessage) {
    this.#assertActiveRoom();
    if (this.#role !== 'host') throw new Error('only the current host may start the race');
    if (this.#migrating) throw new Error('host migration must be ready before starting the race');
    const connectedMembers = this.#room.members.filter((member) => member.connected);
    if (connectedMembers.length < 2) {
      throw new Error('at least two connected human players are required to start the race');
    }
    if (connectedMembers.some((member) => !member.ready)) {
      throw new Error('every connected member must be ready before starting the race');
    }
    if (!isRecord(configOrMessage)) {
      throw new TypeError('startRace configuration must be a plain object');
    }

    let rawMessage = configOrMessage;
    if (!Object.hasOwn(configOrMessage, 'type')) {
      const allowed = new Set(['tick', 'seed', 'config']);
      for (const key of Reflect.ownKeys(configOrMessage)) {
        if (typeof key !== 'string' || !allowed.has(key)) {
          throw new TypeError(`startRace configuration contains unknown field ${String(key)}`);
        }
      }
      rawMessage = {
        type: 'start-race',
        roomCode: this.#room.roomCode,
        hostEpoch: this.#room.hostEpoch,
        tick: configOrMessage.tick,
        seed: configOrMessage.seed,
        config: configOrMessage.config,
      };
    }

    const message = this.#canonicalMessage(rawMessage);
    if (message.type !== 'start-race') {
      throw new TypeError('startRace requires a start-race message');
    }
    if (message.roomCode !== this.#room.roomCode) {
      throw new TypeError('start-race room code must match the active room');
    }
    if (!this.#startRosterMatchesRoom(message.config.roster)) {
      throw new TypeError('start-race roster must exactly match the active room roster');
    }
    if (this.#raceStarted) throw new Error('race has already started');
    const guestIds = connectedMembers
      .map((member) => member.playerId)
      .filter((playerId) => playerId !== this.#playerId);
    if (typeof this.#transport.canBroadcastReliable !== 'function'
      || this.#transport.canBroadcastReliable(message, { playerIds: guestIds }) !== true) {
      return false;
    }
    const accepted = this.#transport.broadcast(message, { reliable: true });
    if (accepted === false) return false;
    this.#raceStarted = true;
    this.#dispatch('start-race', {
      hostEpoch: message.hostEpoch,
      tick: message.tick,
      seed: message.seed,
      config: message.config,
    });
    return true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#migrating = false;
    for (const [target, type, listener] of this.#listeners) {
      target.removeEventListener(type, listener);
    }
    this.#listeners.length = 0;
    this.#transport.close?.();
    this.#signaling.close?.();
  }

  #listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.#listeners.push([target, type, listener]);
  }

  #dispatch(type, detail) {
    this.dispatchEvent(eventWithDetail(type, detail));
  }

  #assertActiveRoom() {
    if (this.#closed) throw new Error('multiplayer session is closed');
    if (this.#invalidated) throw new Error('multiplayer session is invalidated');
    if (!this.#room || this.#role === 'disconnected') {
      throw new Error('multiplayer session is not in a room');
    }
  }

  #canonicalMessage(message) {
    const result = validatePeerMessage(message, this.#room?.hostEpoch);
    if (!result.ok) throw new TypeError(result.error);
    return result.value;
  }

  #updateGuest(tick, now) {
    if (!this.#controlProvider || !cadenceDue(this.#nextInputAt, now)) return false;
    if (this.#controlSeq > Number.MAX_SAFE_INTEGER) {
      this.#invalidate(['control sequence is exhausted']);
      return false;
    }

    let message;
    try {
      message = this.#canonicalMessage({
        type: 'control',
        roomCode: this.#room.roomCode,
        hostEpoch: this.#room.hostEpoch,
        seq: this.#controlSeq,
        tick,
        intent: this.#controlProvider({ tick, now, hostEpoch: this.#room.hostEpoch }),
      });
    } catch (error) {
      this.#dispatch('provider-error', {
        provider: 'control',
        message: error instanceof Error ? error.message : String(error),
      });
      this.#nextInputAt = advanceCadence(this.#nextInputAt, now, this.#inputInterval);
      return false;
    }

    this.#controlSeq += 1;
    this.#nextInputAt = advanceCadence(this.#nextInputAt, now, this.#inputInterval);
    this.#transport.sendToHost(message, { reliable: false });
    return true;
  }

  #updateHost(tick, now) {
    if (!this.#snapshotProvider) return false;
    const snapshotDue = cadenceDue(this.#nextSnapshotAt, now);
    const checkpointDue = cadenceDue(this.#nextCheckpointAt, now);
    if (!snapshotDue && !checkpointDue) return false;

    let state;
    try {
      state = this.#snapshotProvider({ tick, now, hostEpoch: this.#room.hostEpoch });
    } catch (error) {
      this.#dispatch('provider-error', {
        provider: 'snapshot',
        message: error instanceof Error ? error.message : String(error),
      });
      if (snapshotDue) {
        this.#nextSnapshotAt = advanceCadence(
          this.#nextSnapshotAt,
          now,
          this.#snapshotInterval,
        );
      }
      if (checkpointDue) {
        this.#nextCheckpointAt = advanceCadence(
          this.#nextCheckpointAt,
          now,
          this.#checkpointInterval,
        );
      }
      return false;
    }

    let sent = false;
    if (snapshotDue) {
      try {
        const snapshot = this.#canonicalMessage({
          type: 'snapshot',
          roomCode: this.#room.roomCode,
          hostEpoch: this.#room.hostEpoch,
          tick,
          state,
        });
        this.#transport.broadcast(snapshot, { reliable: false });
        sent = true;
      } catch (error) {
        this.#dispatch('provider-error', {
          provider: 'snapshot',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      this.#nextSnapshotAt = advanceCadence(
        this.#nextSnapshotAt,
        now,
        this.#snapshotInterval,
      );
    }

    if (checkpointDue) {
      try {
        const checkpoint = this.#canonicalMessage({
          type: 'checkpoint',
          roomCode: this.#room.roomCode,
          hostEpoch: this.#room.hostEpoch,
          tick,
          state,
        });
        this.#transport.broadcast(checkpoint, { reliable: true });
        this.#latestCheckpoint = immutableWorldState(checkpoint.state);
        this.#latestAuthorityWorldTime = Math.max(
          this.#latestAuthorityWorldTime ?? 0,
          checkpoint.state.worldTime,
        );
        sent = true;
      } catch (error) {
        this.#dispatch('provider-error', {
          provider: 'checkpoint',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      this.#nextCheckpointAt = advanceCadence(
        this.#nextCheckpointAt,
        now,
        this.#checkpointInterval,
      );
    }
    return sent;
  }

  #handleSessionEvent(event) {
    if (this.#closed) return;
    const detail = event?.detail;
    if (typeof detail?.playerId === 'string' && detail.playerId.length > 0) {
      this.#playerId = detail.playerId;
    } else {
      this.#playerId = playerIdFromSignaling(this.#signaling) ?? this.#playerId;
    }
    if (detail?.room) this.#safelyApplyRoom(detail.room);
  }

  #handleRoomEvent(event) {
    if (this.#closed) return;
    this.#playerId = playerIdFromSignaling(this.#signaling) ?? this.#playerId;
    const detail = event?.detail;
    this.#safelyApplyRoom(detail?.room ?? detail);
  }

  #handleSignalingStateChange(event) {
    if (this.#closed) return;
    const previousPlayerId = this.#playerId;
    const signalingState = isRecord(event?.detail) ? event.detail : this.#signaling.state;
    this.#playerId = playerIdFromSignaling(this.#signaling);
    if (signalingState?.room) {
      this.#safelyApplyRoom(signalingState.room);
      return;
    }
    if (signalingState?.room === null) {
      this.#clearActiveRoom(previousPlayerId !== this.#playerId);
    }
  }

  #handleDomainEvent(event) {
    if (this.#closed || event?.detail?.type === 'host-changed') return;
    const detail = event?.detail;
    if (detail?.roomCode === this.#room?.roomCode
      && ['member-left', 'member-resumed', 'member-removed', 'member-joined'].includes(detail.type)) {
      this.#resetSourceState(detail.playerId);
    }
    const room = this.#signaling.state?.room;
    if (room) this.#safelyApplyRoom(room);
  }

  #safelyApplyRoom(value) {
    try {
      this.#applyRoom(normalizeRoom(value));
    } catch (error) {
      this.#dispatch('session-error', {
        source: 'room-view',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #applyRoom(nextRoom) {
    const previousRoom = this.#room;
    if (previousRoom
      && previousRoom.roomCode === nextRoom.roomCode
      && nextRoom.hostEpoch < previousRoom.hostEpoch) {
      this.#dispatch('session-error', {
        source: 'room-view',
        message: `stale host epoch ${nextRoom.hostEpoch}; expected ${previousRoom.hostEpoch}`,
      });
      return;
    }

    const changedRoom = previousRoom && previousRoom.roomCode !== nextRoom.roomCode;
    if (changedRoom) this.#resetForRoom();
    if (previousRoom && previousRoom.roomCode === nextRoom.roomCode) {
      const previousMembers = new Map(
        previousRoom.members.map((member) => [member.playerId, member.connected]),
      );
      const nextMembers = new Map(
        nextRoom.members.map((member) => [member.playerId, member.connected]),
      );
      for (const playerId of new Set([...previousMembers.keys(), ...nextMembers.keys()])) {
        if (previousMembers.get(playerId) !== nextMembers.get(playerId)) {
          this.#resetSourceState(playerId);
        }
      }
    }
    const previousRole = this.#role;
    const previousEpoch = previousRoom?.hostEpoch ?? null;
    this.#room = nextRoom;
    const nextRole = this.#playerId === null
      ? 'disconnected'
      : (nextRoom.hostId === this.#playerId ? 'host' : 'guest');
    this.#role = nextRole;

    const epochChanged = previousEpoch !== null && previousEpoch !== nextRoom.hostEpoch;
    const hostChanged = previousRoom !== null && previousRoom.hostId !== nextRoom.hostId;
    const roleChanged = previousRole !== nextRole;
    if (!changedRoom && (epochChanged || hostChanged || roleChanged)) {
      this.#resetIntegrityMonitors();
    }
    if (changedRoom || epochChanged || hostChanged || roleChanged) {
      this.#readyPeerIds.clear();
      this.#topologyPeerIds = null;
    }
    if (this.#invalidated) {
      this.#migrating = false;
    } else if (previousRole === 'guest'
      && nextRole === 'host'
      && this.#promotedEpoch !== nextRoom.hostEpoch) {
      this.#beginPromotion(previousEpoch);
    } else if (nextRole !== 'host') {
      this.#migrating = false;
    }
    if (this.#closed) return;
    if (roleChanged) {
      this.#resetCadence();
      this.#dispatch('rolechange', { role: nextRole, previousRole });
    } else if (epochChanged) {
      this.#resetCadence();
    }
    if (epochChanged) {
      this.#controlSeqBySource.clear();
      this.#rescueSeqBySource.clear();
      this.#chatTimesBySource.clear();
    }

    this.#reconcileTopology();
    this.#dispatch('statechange', this.state);
  }

  #handleHostChange(event) {
    if (this.#closed) return;
    const detail = event?.detail;
    if (!isRecord(detail)) return;
    if (!this.#room || detail.roomCode !== this.#room.roomCode) {
      this.#dispatch('session-error', {
        source: 'host-changed',
        message: 'host change does not match the active room',
      });
      return;
    }
    if (!Number.isSafeInteger(detail.hostEpoch) || detail.hostEpoch < this.#room.hostEpoch) {
      this.#dispatch('session-error', {
        source: 'host-changed',
        message: 'host change has a stale or invalid epoch',
      });
      return;
    }
    if (detail.hostId !== null && (typeof detail.hostId !== 'string' || detail.hostId.length === 0)) {
      this.#dispatch('session-error', {
        source: 'host-changed',
        message: 'host change has an invalid hostId',
      });
      return;
    }

    const members = this.#room.members.map((member) => ({ ...member }));
    if (detail.hostId !== null && !members.some((member) => member.playerId === detail.hostId)) {
      this.#dispatch('session-error', {
        source: 'host-changed',
        message: 'host change identifies a non-member',
      });
      return;
    }
    this.#applyRoom(normalizeRoom({
      roomCode: this.#room.roomCode,
      hostId: detail.hostId,
      hostEpoch: detail.hostEpoch,
      phase: this.#room.phase,
      members,
    }));
  }

  #resetForRoom() {
    this.#latestCheckpoint = null;
    this.#latestAuthorityWorldTime = null;
    this.#promotedEpoch = null;
    this.#invalidated = false;
    this.#raceStarted = false;
    this.#migrating = false;
    this.#controlSeq = 0;
    this.#rescueSeq = 0;
    this.#controlSeqBySource.clear();
    this.#rescueSeqBySource.clear();
    this.#chatTimesBySource.clear();
    this.#readyPeerIds.clear();
    this.#topologyPeerIds = null;
    this.#latestTick = 0;
    this.#lastNow = -Infinity;
    this.#resetIntegrityMonitors();
    this.#resetCadence();
  }

  #clearActiveRoom(playerChanged) {
    const previousRole = this.#role;
    const hadRoom = this.#room !== null;
    if (!hadRoom && previousRole === 'disconnected' && !playerChanged) return;
    this.#resetForRoom();
    this.#room = null;
    this.#role = 'disconnected';
    this.#reconcileTopology(null);
    if (previousRole !== 'disconnected') {
      this.#dispatch('rolechange', { role: 'disconnected', previousRole });
    }
    this.#dispatch('statechange', this.state);
  }

  #resetIntegrityMonitors() {
    this.#integrityMonitor.reset?.();
    this.#checkpointIntegrityMonitor.reset?.();
  }

  #resetCadence() {
    this.#nextInputAt = null;
    this.#nextSnapshotAt = null;
    this.#nextCheckpointAt = null;
  }

  #beginPromotion(previousEpoch) {
    this.#promotedEpoch = this.#room.hostEpoch;
    if (!this.#raceStarted && this.#room.phase === 'lobby') {
      this.#latestCheckpoint = null;
      this.#latestAuthorityWorldTime = null;
      this.#migrating = true;
      this.#dispatch('promote', { checkpoint: null });
      return;
    }
    const checkpoint = this.#latestCheckpoint;
    if (!checkpoint || checkpoint.hostEpoch !== previousEpoch) {
      this.#invalidate(['host migration requires a checkpoint from the previous host epoch']);
      return;
    }

    const authorityTime = this.#latestAuthorityWorldTime ?? checkpoint.worldTime;
    const rollback = Math.max(0, authorityTime - checkpoint.worldTime);
    if (rollback > MAX_ROLLBACK_SECONDS + ROLLBACK_EPSILON) {
      this.#invalidate([
        `host migration rollback ${rollback.toFixed(3)}s exceeds ${MAX_ROLLBACK_SECONDS}s`,
      ]);
      return;
    }

    const migrated = cloneWorldState(checkpoint);
    migrated.hostEpoch = this.#room.hostEpoch;
    this.#latestCheckpoint = immutableWorldState(migrated);
    this.#migrating = true;
    this.#dispatch('promote', { checkpoint: this.#latestCheckpoint });
  }

  #reconcileTopology(room = this.#room) {
    if (typeof this.#transport.reconcileTopology !== 'function') return;
    try {
      this.#transport.reconcileTopology(room);
    } catch (error) {
      this.#dispatch('session-error', {
        source: 'transport-topology',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #handleTopology(event) {
    if (this.#closed || !this.#migrating || this.#role !== 'host') return;
    const detail = event?.detail;
    if (detail?.hostEpoch !== this.#room?.hostEpoch || !Array.isArray(detail.peerIds)) return;
    const peerIds = new Set(detail.peerIds);
    this.#readyPeerIds = new Set(
      [...this.#readyPeerIds].filter((playerId) => peerIds.has(playerId)),
    );
    this.#topologyPeerIds = peerIds;
    if ([...peerIds].every((playerId) => this.#readyPeerIds.has(playerId))) {
      this.#finishPromotion(detail.hostEpoch);
    }
  }

  #handlePeerOpen(event) {
    if (this.#closed || !this.#migrating || this.#role !== 'host') return;
    const detail = event?.detail;
    if (detail?.hostEpoch !== this.#room?.hostEpoch || detail.channel !== 'control') return;
    const playerId = detail.playerId;
    if (typeof playerId !== 'string') return;
    this.#readyPeerIds.add(playerId);
    if (this.#topologyPeerIds
      && [...this.#topologyPeerIds].every((peerId) => this.#readyPeerIds.has(peerId))) {
      this.#finishPromotion(detail.hostEpoch);
    }
  }

  #handlePeerClose(event) {
    if (this.#closed) return;
    const detail = event?.detail;
    if (detail?.hostEpoch !== this.#room?.hostEpoch) return;
    if (detail.channel !== 'control' || detail.reliable !== true) return;
    this.#readyPeerIds.delete(detail.playerId);
    this.#resetSourceState(detail.playerId);
  }

  #resetSourceState(playerId) {
    if (typeof playerId !== 'string' || playerId.length === 0) return;
    this.#controlSeqBySource.delete(playerId);
    this.#rescueSeqBySource.delete(playerId);
    this.#chatTimesBySource.delete(playerId);
  }

  #handleTransportReady(event) {
    if (this.#closed || !this.#migrating || this.#role !== 'host') return;
    this.#finishPromotion(event?.detail?.hostEpoch);
  }

  #finishPromotion(hostEpoch) {
    if (!this.#migrating || hostEpoch !== this.#room?.hostEpoch) return;
    try {
      const tick = this.#latestCheckpoint?.tick ?? this.#latestTick;
      let checkpoint = null;
      if (this.#latestCheckpoint) {
        checkpoint = this.#canonicalMessage({
          type: 'checkpoint',
          roomCode: this.#room.roomCode,
          hostEpoch: this.#room.hostEpoch,
          tick,
          state: this.#latestCheckpoint,
        });
      }
      const ready = this.#canonicalMessage({
        type: 'host-ready',
        roomCode: this.#room.roomCode,
        hostEpoch: this.#room.hostEpoch,
        tick,
      });
      const messages = checkpoint ? [checkpoint, ready] : [ready];
      const playerIds = this.#topologyPeerIds
        ? [...this.#topologyPeerIds]
        : this.#room.members
          .filter((member) => member.connected && member.playerId !== this.#playerId)
          .map((member) => member.playerId);
      if (typeof this.#transport.canBroadcastReliable !== 'function'
        || this.#transport.canBroadcastReliable(messages, { playerIds }) !== true) {
        this.#readyPeerIds.clear();
        return;
      }
      for (const message of messages) {
        if (this.#transport.broadcast(message, { reliable: true }) === false) {
          this.#readyPeerIds.clear();
          return;
        }
      }
      this.#migrating = false;
      this.#dispatch('migration-ready', {
        hostEpoch: this.#room.hostEpoch,
        tick,
      });
      this.#dispatch('statechange', this.state);
    } catch (error) {
      this.#invalidate([error instanceof Error ? error.message : String(error)]);
    }
  }

  #handleTransportMessage(event) {
    if (this.#closed || this.#invalidated || !this.#room) return;
    const detail = event?.detail;
    const sourceId = detail?.sourceId ?? detail?.playerId;
    const rawMessage = detail?.message;
    const reliable = detail?.reliable === true;
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      this.#rejectMessage('message sourceId is required', null, rawMessage?.type);
      return;
    }
    if (detail?.hostEpoch !== undefined && detail.hostEpoch !== this.#room.hostEpoch) {
      this.#rejectMessage('transport host epoch does not match the active epoch', sourceId, rawMessage?.type);
      return;
    }

    const validated = validatePeerMessage(rawMessage, this.#room.hostEpoch);
    if (!validated.ok) {
      this.#rejectMessage(validated.error, sourceId, rawMessage?.type);
      return;
    }
    const message = validated.value;
    if (message.roomCode !== this.#room.roomCode) {
      this.#rejectMessage('message room code does not match the active room', sourceId, message.type);
      return;
    }
    if (!this.#isConnectedMember(sourceId)) {
      this.#rejectMessage('message source is not a connected room member', sourceId, message.type);
      return;
    }

    if (this.#role === 'host') this.#handleGuestMessage(sourceId, message, reliable);
    else if (this.#role === 'guest') this.#handleAuthorityMessage(sourceId, message, reliable);
  }

  #isConnectedMember(playerId) {
    return this.#room.members.some((member) => (
      member.playerId === playerId && member.connected
    ));
  }

  #handleGuestMessage(sourceId, message, reliable) {
    if (!GUEST_TYPES.has(message.type) || sourceId === this.#playerId) {
      this.#rejectMessage('host received a message not owned by a guest', sourceId, message.type);
      return;
    }

    if (message.type === 'control') {
      if (reliable) {
        this.#rejectMessage('control messages must use the lossy channel', sourceId, message.type);
        return;
      }
      const previous = this.#controlSeqBySource.get(sourceId);
      if (previous !== undefined && message.seq <= previous) return;
      this.#controlSeqBySource.set(sourceId, message.seq);
      this.#dispatch('remote-input', {
        playerId: sourceId,
        seq: message.seq,
        tick: message.tick,
        intent: message.intent,
      });
      return;
    }

    if (!reliable) {
      this.#rejectMessage(`${message.type} messages require the reliable channel`, sourceId, message.type);
      return;
    }
    if (message.type === 'chat') {
      this.#relayChat(sourceId, message.text);
      return;
    }

    const previous = this.#rescueSeqBySource.get(sourceId);
    if (previous !== undefined && message.seq <= previous) return;
    this.#rescueSeqBySource.set(sourceId, message.seq);
    this.#dispatch('rescue-request', {
      playerId: sourceId,
      seq: message.seq,
      tick: message.tick,
    });
  }

  #handleAuthorityMessage(sourceId, message, reliable) {
    if (!AUTHORITY_TYPES.has(message.type) || sourceId !== this.#room.hostId) {
      this.#rejectMessage('authority message was not sent by the current host', sourceId, message.type);
      return;
    }

    const requiresReliable = message.type !== 'snapshot';
    if (reliable !== requiresReliable) {
      this.#rejectMessage(
        `${message.type} message used the wrong transport channel`,
        sourceId,
        message.type,
      );
      return;
    }
    if (message.type === 'snapshot' || message.type === 'checkpoint') {
      this.#inspectAuthorityState(message);
      return;
    }
    if (message.type === 'chat-delivery') {
      if (!this.#isConnectedMember(message.sourceId)) {
        this.#rejectMessage('chat delivery identifies a non-member', sourceId, message.type);
        return;
      }
      this.#dispatch('chat', { sourceId: message.sourceId, text: message.text });
      return;
    }
    if (message.type === 'start-race') {
      if (this.#raceStarted) {
        this.#rejectMessage('race has already started', sourceId, message.type);
        return;
      }
      if (!this.#startRosterMatchesRoom(message.config.roster)) {
        this.#rejectMessage(
          'start-race roster does not match the active room roster',
          sourceId,
          message.type,
        );
        return;
      }
      this.#raceStarted = true;
      this.#dispatch('start-race', {
        hostEpoch: message.hostEpoch,
        tick: message.tick,
        seed: message.seed,
        config: message.config,
      });
      return;
    }
    this.#dispatch('host-ready', {
      hostEpoch: message.hostEpoch,
      tick: message.tick,
    });
  }

  #startRosterMatchesRoom(roster) {
    if (!Array.isArray(roster) || !this.#room) return false;
    const roomMembers = new Map(
      this.#room.members.map((member) => [member.playerId, member.nickname]),
    );
    const rosterMembers = new Map(
      roster.map((member) => [member.playerId, member.nickname]),
    );
    if (roomMembers.size !== rosterMembers.size) return false;
    for (const [playerId, nickname] of roomMembers) {
      if (rosterMembers.get(playerId) !== nickname) return false;
    }
    return true;
  }

  #inspectAuthorityState(message) {
    let outcome;
    try {
      const monitor = message.type === 'checkpoint'
        ? this.#checkpointIntegrityMonitor
        : this.#integrityMonitor;
      outcome = monitor.inspect(message.state, {
        expectedEpoch: this.#room.hostEpoch,
      });
    } catch (error) {
      this.#invalidate([`integrity monitor failed: ${error instanceof Error ? error.message : String(error)}`]);
      return;
    }
    if (outcome?.invalidated || outcome?.status === 'invalidated') {
      const reasons = Array.isArray(outcome?.reasons) && outcome.reasons.length > 0
        ? outcome.reasons.map(String)
        : ['integrity monitor invalidated the authoritative state'];
      this.#invalidate(reasons);
      return;
    }
    if (outcome?.ignored || outcome?.status === 'ignored') return;
    if (outcome?.status !== 'accepted') {
      this.#invalidate(['integrity monitor returned an invalid outcome']);
      return;
    }

    let snapshot;
    try {
      snapshot = immutableWorldState(outcome.snapshot ?? message.state);
    } catch (error) {
      this.#invalidate([`integrity monitor returned invalid state: ${error instanceof Error ? error.message : String(error)}`]);
      return;
    }
    this.#latestAuthorityWorldTime = Math.max(
      this.#latestAuthorityWorldTime ?? 0,
      snapshot.worldTime,
    );
    if (message.type === 'checkpoint') {
      this.#latestCheckpoint = snapshot;
      this.#dispatch('checkpoint', { checkpoint: snapshot });
    } else {
      this.#dispatch('snapshot', { snapshot });
    }
  }

  #relayChat(sourceId, text) {
    const delivery = this.#canonicalMessage({
      type: 'chat-delivery',
      roomCode: this.#room.roomCode,
      hostEpoch: this.#room.hostEpoch,
      sourceId,
      text,
    });
    const guestIds = this.#room.members
      .filter((member) => member.connected && member.playerId !== this.#playerId)
      .map((member) => member.playerId);
    if (typeof this.#transport.canBroadcastReliable !== 'function'
      || this.#transport.canBroadcastReliable(delivery, { playerIds: guestIds }) !== true) {
      return false;
    }
    if (!this.#consumeChatAllowance(sourceId)) {
      this.#dispatch('chat-rate-limited', { sourceId });
      return false;
    }
    const accepted = this.#transport.broadcast(delivery, { reliable: true });
    if (accepted === false) return false;
    this.#dispatch('chat', { sourceId, text: delivery.text });
    return true;
  }

  #consumeChatAllowance(sourceId) {
    let now;
    try {
      now = finiteNow(this.#now(), 'clock.now()');
    } catch (error) {
      this.#dispatch('session-error', {
        source: 'clock',
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const threshold = now - this.#chatLimit.windowMs;
    const timestamps = (this.#chatTimesBySource.get(sourceId) ?? [])
      .filter((timestamp) => timestamp > threshold);
    if (timestamps.length >= this.#chatLimit.maxMessages) {
      this.#chatTimesBySource.set(sourceId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.#chatTimesBySource.set(sourceId, timestamps);
    return true;
  }

  #rejectMessage(reason, sourceId, type) {
    this.#dispatch('message-rejected', {
      reason: String(reason),
      sourceId: typeof sourceId === 'string' ? sourceId : null,
      type: typeof type === 'string' ? type : null,
    });
  }

  #invalidate(reasons) {
    if (this.#invalidated) return;
    this.#invalidated = true;
    this.#migrating = false;
    const normalized = Array.isArray(reasons) && reasons.length > 0
      ? reasons.map(String)
      : ['multiplayer session was invalidated'];
    this.#dispatch('invalidated', { reasons: normalized });
    this.#dispatch('statechange', this.state);
  }
}
