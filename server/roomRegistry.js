import { randomBytes as cryptoRandomBytes } from 'node:crypto';

import { normalizeStartDescriptor } from '../src/net/protocol.js';

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_SAMPLE_LIMIT = Math.floor(256 / ROOM_CODE_ALPHABET.length)
  * ROOM_CODE_ALPHABET.length;
const MAX_PLAYERS = 8;
const PLAYER_ID_BYTES = 16;
const RESUME_TOKEN_BYTES = 32;
const MAX_RANDOM_ATTEMPTS = 1_024;

export class RoomRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomRegistryError';
    this.code = code;
  }
}

export class RoomRegistry {
  #now;

  #randomBytes;

  #reconnectGraceMs;

  #players = new Map();

  #rooms = new Map();

  get roomCount() { return this.#rooms.size; }

  constructor({
    now = Date.now,
    randomBytes = cryptoRandomBytes,
    reconnectGraceMs = 30_000,
  } = {}) {
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (typeof randomBytes !== 'function') {
      throw new TypeError('randomBytes must be a function');
    }
    if (!Number.isFinite(reconnectGraceMs) || reconnectGraceMs < 0) {
      throw new TypeError('reconnectGraceMs must be a non-negative finite number');
    }

    this.#now = now;
    this.#randomBytes = randomBytes;
    this.#reconnectGraceMs = reconnectGraceMs;
  }

  createPlayer(nickname) {
    if (typeof nickname !== 'string' || nickname.trim().length === 0) {
      throw new RoomRegistryError('INVALID_NICKNAME', 'Nickname must be a non-empty string');
    }

    const playerId = this.#uniquePlayerId();
    const player = {
      playerId,
      resumeToken: this.#randomHex(RESUME_TOKEN_BYTES),
      nickname: nickname.trim(),
      roomCode: null,
      joinOrder: null,
      connected: false,
      ready: false,
      resumeUntil: null,
    };
    this.#players.set(playerId, player);

    return Object.freeze({
      playerId: player.playerId,
      nickname: player.nickname,
      resumeToken: player.resumeToken,
    });
  }

  createRoom(player) {
    const member = this.#availablePlayer(player);
    const roomCode = this.#uniqueRoomCode();
    const room = {
      roomCode,
      hostId: member.playerId,
      hostEpoch: 1,
      phase: 'lobby',
      start: null,
      nextJoinOrder: 2,
      members: new Map(),
    };

    this.#addMember(room, member, 1);
    this.#rooms.set(roomCode, room);

    const events = [
      {
        type: 'member-joined',
        roomCode,
        playerId: member.playerId,
        joinOrder: member.joinOrder,
      },
      {
        type: 'host-changed',
        roomCode,
        previousHostId: null,
        hostId: member.playerId,
        hostEpoch: room.hostEpoch,
      },
    ];

    return { roomCode, room: this.#view(room), events };
  }

  joinRoom(code, player) {
    const room = this.#requiredRoom(code);
    if (room.phase !== 'lobby') {
      throw new RoomRegistryError('ROOM_IN_PROGRESS', 'Room race is already in progress');
    }
    const member = this.#availablePlayer(player);
    if (room.members.size >= MAX_PLAYERS) {
      throw new RoomRegistryError('ROOM_FULL', 'Room already has eight reserved seats');
    }

    this.#addMember(room, member, room.nextJoinOrder);
    room.nextJoinOrder += 1;

    const events = [{
      type: 'member-joined',
      roomCode: room.roomCode,
      playerId: member.playerId,
      joinOrder: member.joinOrder,
    }];

    if (room.hostId === null) {
      const previousHostId = room.hostId;
      room.hostId = this.#earliestConnectedMember(room)?.playerId ?? null;
      room.hostEpoch += 1;
      events.push(this.#hostChangedEvent(room, previousHostId));
    }

    return {
      room: this.#view(room),
      events,
    };
  }

  disconnect(playerId) {
    const member = this.#players.get(playerId);
    if (!member?.roomCode) {
      return { room: null, events: [] };
    }

    const room = this.#rooms.get(member.roomCode);
    if (!room || !member.connected) {
      return { room: room ? this.#view(room) : null, events: [] };
    }

    member.connected = false;
    member.ready = false;
    member.resumeUntil = this.#now() + this.#reconnectGraceMs;

    const events = [{
      type: 'member-left',
      roomCode: room.roomCode,
      playerId: member.playerId,
      resumeUntil: member.resumeUntil,
    }];

    if (room.hostId === member.playerId) {
      const previousHostId = room.hostId;
      const nextHost = this.#earliestConnectedMember(room);
      room.hostId = nextHost?.playerId ?? null;
      room.hostEpoch += 1;
      events.push(this.#hostChangedEvent(room, previousHostId));
    }

    return { room: this.#view(room), events };
  }

  resume({ roomCode, playerId, resumeToken }) {
    const room = this.#requiredRoom(roomCode);
    const member = room.members.get(playerId);
    if (!member) {
      throw new RoomRegistryError('PLAYER_NOT_FOUND', 'Player has no reserved seat in this room');
    }
    if (typeof resumeToken !== 'string' || resumeToken !== member.resumeToken) {
      throw new RoomRegistryError('INVALID_RESUME_TOKEN', 'Resume token is invalid');
    }
    if (member.connected) {
      return { room: this.#view(room), events: [] };
    }
    if (member.resumeUntil === null || this.#now() >= member.resumeUntil) {
      throw new RoomRegistryError('RESUME_EXPIRED', 'Reserved seat has expired');
    }

    member.connected = true;
    member.resumeUntil = null;

    const events = [{
      type: 'member-resumed',
      roomCode: room.roomCode,
      playerId: member.playerId,
    }];

    if (room.hostId === null) {
      const previousHostId = room.hostId;
      room.hostId = this.#earliestConnectedMember(room)?.playerId ?? null;
      room.hostEpoch += 1;
      events.push(this.#hostChangedEvent(room, previousHostId));
    }

    return { room: this.#view(room), events };
  }

  removeExpired() {
    const events = [];
    const now = this.#now();

    for (const room of this.#rooms.values()) {
      const expiredMembers = [...room.members.values()]
        .filter((member) => !member.connected
          && member.resumeUntil !== null
          && now >= member.resumeUntil)
        .sort((left, right) => left.joinOrder - right.joinOrder);

      for (const member of expiredMembers) {
        room.members.delete(member.playerId);
        this.#players.delete(member.playerId);
        events.push({
          type: 'member-removed',
          roomCode: room.roomCode,
          playerId: member.playerId,
        });

        if (room.hostId === member.playerId) {
          const previousHostId = room.hostId;
          room.hostId = this.#earliestConnectedMember(room)?.playerId ?? null;
          room.hostEpoch += 1;
          events.push(this.#hostChangedEvent(room, previousHostId));
        }
      }

      if (room.members.size === 0) {
        this.#rooms.delete(room.roomCode);
        events.push({ type: 'room-removed', roomCode: room.roomCode });
      }
    }

    return { events };
  }

  setReady(playerId, ready) {
    if (typeof ready !== 'boolean') {
      throw new RoomRegistryError('INVALID_READY_STATE', 'Ready state must be a boolean');
    }

    const member = this.#players.get(playerId);
    if (!member?.roomCode) {
      throw new RoomRegistryError('PLAYER_NOT_FOUND', 'Player is not in a room');
    }
    const room = this.#rooms.get(member.roomCode);
    if (!room || !room.members.has(playerId)) {
      throw new RoomRegistryError('PLAYER_NOT_FOUND', 'Player is not in a room');
    }
    if (room.phase !== 'lobby') {
      throw new RoomRegistryError('ROOM_IN_PROGRESS', 'Ready state is locked after racing starts');
    }
    if (!member.connected) {
      throw new RoomRegistryError('PLAYER_DISCONNECTED', 'Disconnected players cannot become ready');
    }
    if (member.ready === ready) {
      return { room: this.#view(room), events: [] };
    }

    member.ready = ready;
    return {
      room: this.#view(room),
      events: [{
        type: 'ready-changed',
        roomCode: room.roomCode,
        playerId,
        ready,
      }],
    };
  }

  roomView(code) {
    const room = this.#rooms.get(this.#normalizeRoomCode(code));
    return room ? this.#view(room) : null;
  }

  lockRoom(playerId, startDescriptor) {
    const member = this.#players.get(playerId);
    if (!member?.roomCode) {
      throw new RoomRegistryError('PLAYER_NOT_FOUND', 'Player is not in a room');
    }
    const room = this.#rooms.get(member.roomCode);
    if (!room || !room.members.has(playerId)) {
      throw new RoomRegistryError('PLAYER_NOT_FOUND', 'Player is not in a room');
    }
    if (room.phase !== 'lobby') {
      throw new RoomRegistryError('ROOM_IN_PROGRESS', 'Room race is already in progress');
    }
    if (room.hostId !== playerId) {
      throw new RoomRegistryError('NOT_HOST', 'Only the current host can lock the room');
    }
    const connected = [...room.members.values()].filter((candidate) => candidate.connected);
    if (connected.length < 2) {
      throw new RoomRegistryError(
        'NOT_ENOUGH_PLAYERS',
        'At least two connected players are required',
      );
    }
    if (connected.some((candidate) => !candidate.ready)) {
      throw new RoomRegistryError('PLAYERS_NOT_READY', 'Every connected player must be ready');
    }

    const normalizedStart = normalizeStartDescriptor(startDescriptor);
    if (!normalizedStart.ok) {
      throw new RoomRegistryError('INVALID_START_DESCRIPTOR', normalizedStart.error);
    }
    if (normalizedStart.value.tick !== 0) {
      throw new RoomRegistryError(
        'INVALID_START_DESCRIPTOR',
        'Initial race start tick must be zero',
      );
    }
    const reservedRoster = [...room.members.values()]
      .sort((left, right) => left.joinOrder - right.joinOrder);
    const startRoster = normalizedStart.value.config.roster;
    const rosterMatches = startRoster.length === reservedRoster.length
      && reservedRoster.every((reserved, index) => (
        startRoster[index].playerId === reserved.playerId
        && startRoster[index].nickname === reserved.nickname
      ));
    if (!rosterMatches) {
      throw new RoomRegistryError(
        'START_ROSTER_MISMATCH',
        'Start roster must exactly match the reserved room roster',
      );
    }

    room.start = normalizedStart.value;
    room.phase = 'racing';
    return {
      room: this.#view(room),
      events: [{
        type: 'room-locked',
        roomCode: room.roomCode,
        playerId,
        phase: room.phase,
        start: room.start,
      }],
    };
  }

  #availablePlayer(player) {
    const playerId = typeof player === 'string' ? player : player?.playerId;
    const member = this.#players.get(playerId);
    if (!member) {
      throw new RoomRegistryError('PLAYER_NOT_FOUND', 'Player was not created by this registry');
    }
    if (member.roomCode !== null) {
      throw new RoomRegistryError('ALREADY_IN_ROOM', 'Player already has a reserved seat');
    }
    return member;
  }

  #requiredRoom(code) {
    const roomCode = this.#normalizeRoomCode(code);
    const room = this.#rooms.get(roomCode);
    if (!room) {
      throw new RoomRegistryError('ROOM_NOT_FOUND', 'Room does not exist');
    }
    return room;
  }

  #normalizeRoomCode(code) {
    return typeof code === 'string' ? code.trim().toUpperCase() : '';
  }

  #addMember(room, member, joinOrder) {
    member.roomCode = room.roomCode;
    member.joinOrder = joinOrder;
    member.connected = true;
    member.ready = false;
    member.resumeUntil = null;
    room.members.set(member.playerId, member);
  }

  #earliestConnectedMember(room) {
    let earliest = null;
    for (const member of room.members.values()) {
      if (!member.connected) continue;
      if (!earliest || member.joinOrder < earliest.joinOrder) {
        earliest = member;
      }
    }
    return earliest;
  }

  #view(room) {
    const members = [...room.members.values()]
      .sort((left, right) => left.joinOrder - right.joinOrder)
      .map((member) => ({
        playerId: member.playerId,
        nickname: member.nickname,
        joinOrder: member.joinOrder,
        connected: member.connected,
        ready: member.ready,
        isHost: member.playerId === room.hostId,
      }));

    const view = {
      roomCode: room.roomCode,
      hostId: room.hostId,
      hostEpoch: room.hostEpoch,
      phase: room.phase,
      members,
    };
    if (room.phase === 'racing') view.start = room.start;
    return view;
  }

  #hostChangedEvent(room, previousHostId) {
    return {
      type: 'host-changed',
      roomCode: room.roomCode,
      previousHostId,
      hostId: room.hostId,
      hostEpoch: room.hostEpoch,
    };
  }

  #uniqueRoomCode() {
    let code = '';
    for (let draw = 0; draw < MAX_RANDOM_ATTEMPTS; draw += 1) {
      const bytes = this.#bytes(ROOM_CODE_LENGTH);
      for (const byte of bytes) {
        if (byte >= ROOM_CODE_SAMPLE_LIMIT) continue;
        code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
        if (code.length < ROOM_CODE_LENGTH) continue;
        if (!this.#rooms.has(code)) return code;
        code = '';
      }
    }
    throw new RoomRegistryError('CODE_GENERATION_FAILED', 'Could not generate a unique room code');
  }

  #uniquePlayerId() {
    for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
      const playerId = this.#randomHex(PLAYER_ID_BYTES);
      if (!this.#players.has(playerId)) return playerId;
    }
    throw new RoomRegistryError('PLAYER_ID_GENERATION_FAILED', 'Could not generate a unique player ID');
  }

  #randomHex(size) {
    return Buffer.from(this.#bytes(size)).toString('hex');
  }

  #bytes(size) {
    const bytes = this.#randomBytes(size);
    if (!(bytes instanceof Uint8Array) || bytes.length !== size) {
      throw new TypeError(`randomBytes(${size}) must return exactly ${size} bytes`);
    }
    return bytes;
  }
}
