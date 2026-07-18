import { SnapshotBuffer } from '../net/snapshotBuffer.js';
import { captureWorldState, cloneWorldState } from '../net/worldState.js';
import { wrapPi } from '../util/math.js';

export const MULTIPLAYER_TICK_HZ = 60;
export const MULTIPLAYER_INTERPOLATION_DELAY_MS = 125;

export const EMPTY_CONTROL_INTENT = Object.freeze({
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

const PHYS_FIELDS = Object.freeze([
  'x', 'z', 'psi', 'u', 'v', 'yawRate', 'phi', 'phiRate', 'boom', 'rudder',
  'sheet', 'board', 'crewY', 'rightProgress', 'capsized',
]);
const CONTROL_FIELDS = Object.freeze(['rudderCmd', 'hikeLevel', 'manualSheetAt']);
const ANGLE_FIELDS = new Set(['psi', 'phi', 'boom', 'rudder']);
const HARD_CLOCK_DRIFT_SECONDS = 0.5;

function finiteNumber(value, path, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${path} must be a finite number no smaller than ${minimum}`);
  }
  return value;
}

function requiredId(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function copyBoatState(boat, state) {
  for (const field of PHYS_FIELDS) boat.phys[field] = state.phys[field];
  Object.assign(boat.phys.ctl, state.phys.ctl);
  for (const field of CONTROL_FIELDS) boat[field] = state.control[field];
}

function copyRemoteBoatState(boat, state) {
  copyBoatState(boat, state);
  if (boat.phys.out && state.phys.out) Object.assign(boat.phys.out, state.phys.out);
}

export function buildRaceRoster({ roster, aiFill = 0, localPlayerId = null } = {}) {
  if (!Array.isArray(roster) || roster.length < 2 || roster.length > 8) {
    throw new TypeError('multiplayer roster must contain two to eight humans');
  }
  if (!Number.isSafeInteger(aiFill) || aiFill < 0 || roster.length + aiFill > 8) {
    throw new TypeError('human roster plus AI fill cannot exceed eight boats');
  }

  const ids = new Set();
  const humans = roster.map((member, index) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      throw new TypeError(`roster[${index}] must be an object`);
    }
    const playerId = requiredId(member.playerId, `roster[${index}].playerId`);
    if (ids.has(playerId)) throw new TypeError(`duplicate roster playerId ${playerId}`);
    if (typeof member.nickname !== 'string' || member.nickname.length === 0) {
      throw new TypeError(`roster[${index}].nickname must be a non-empty string`);
    }
    ids.add(playerId);
    return Object.freeze({
      boatId: playerId,
      playerId,
      nickname: member.nickname,
      isHuman: true,
      isLocal: playerId === localPlayerId,
      rosterIndex: index,
    });
  });
  const ai = Array.from({ length: aiFill }, (_, index) => Object.freeze({
    boatId: `ai:${index}`,
    playerId: null,
    nickname: `AI ${index + 1}`,
    isHuman: false,
    isLocal: false,
    rosterIndex: humans.length + index,
    aiIndex: index,
  }));
  return Object.freeze([...humans, ...ai]);
}

export function buildStartGrid(boatCount) {
  if (!Number.isSafeInteger(boatCount) || boatCount < 2 || boatCount > 8) {
    throw new TypeError('start grid must contain two to eight boats');
  }
  const spacing = Math.min(15, 74 / (boatCount - 1));
  return Object.freeze(Array.from({ length: boatCount }, (_, index) => Object.freeze({
    lateral: (index - (boatCount - 1) / 2) * spacing,
    downwind: 46 + (index % 2) * 9,
  })));
}

export function resolveRaceStartClock({ tick, startTick } = {}) {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new TypeError('tick must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(startTick) || startTick < tick) {
    throw new TypeError('startTick must be a safe integer no smaller than tick');
  }
  const countdown = (startTick - tick) / MULTIPLAYER_TICK_HZ;
  return Object.freeze({
    tick,
    startTick,
    worldTime: 0,
    raceTime: -countdown,
    countdown,
  });
}

export function restartModePolicy(mode, paused) {
  if (mode === 'multiplayer-race') {
    return Object.freeze({ restart: false, paused: !!paused });
  }
  return Object.freeze({ restart: true, paused: false });
}

export class FixedStepAccumulator {
  #step;

  #accumulator = 0;

  #maxFrameSeconds;

  constructor({ hz = MULTIPLAYER_TICK_HZ, tick = 0, maxFrameSeconds = 0.25 } = {}) {
    finiteNumber(hz, 'hz', Number.MIN_VALUE);
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new TypeError('tick must be a non-negative safe integer');
    }
    this.#maxFrameSeconds = finiteNumber(maxFrameSeconds, 'maxFrameSeconds', Number.MIN_VALUE);
    this.#step = 1 / hz;
    this.tick = tick;
  }

  get stepSeconds() {
    return this.#step;
  }

  get accumulatorSeconds() {
    return this.#accumulator;
  }

  reset({ tick = this.tick, accumulator = 0 } = {}) {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new TypeError('tick must be a non-negative safe integer');
    }
    finiteNumber(accumulator, 'accumulator');
    if (accumulator >= this.#step) throw new TypeError('accumulator must be smaller than one step');
    this.tick = tick;
    this.#accumulator = accumulator;
  }

  advance(frameSeconds, step) {
    finiteNumber(frameSeconds, 'frameSeconds');
    if (typeof step !== 'function') throw new TypeError('step must be a function');
    this.#accumulator += Math.min(frameSeconds, this.#maxFrameSeconds);
    let count = 0;
    const epsilon = this.#step * 1e-9;
    while (this.#accumulator + epsilon >= this.#step) {
      this.#accumulator = Math.max(0, this.#accumulator - this.#step);
      if (this.tick >= Number.MAX_SAFE_INTEGER) throw new RangeError('fixed simulation tick is exhausted');
      this.tick += 1;
      count += 1;
      step(this.#step, this.tick);
    }
    return count;
  }
}

export function reconcilePredictedBoat(boat, state, {
  softBlend = 0.18,
  hardDistance = 8,
  hardAngle = Math.PI / 2,
} = {}) {
  const hasNonFiniteState = PHYS_FIELDS.some((field) => (
    field !== 'capsized' && !Number.isFinite(boat.phys[field])
  )) || Object.values(boat.phys.ctl).some((value) => (
    typeof value === 'number' && !Number.isFinite(value)
  )) || CONTROL_FIELDS.some((field) => !Number.isFinite(boat[field]));
  const distance = Math.hypot(boat.phys.x - state.phys.x, boat.phys.z - state.phys.z);
  const angleError = Math.abs(wrapPi(boat.phys.psi - state.phys.psi));
  const hard = hasNonFiniteState
    || distance >= hardDistance
    || angleError >= hardAngle
    || boat.phys.capsized !== state.phys.capsized;
  if (hard) {
    copyBoatState(boat, state);
    return 'hard';
  }

  for (const field of PHYS_FIELDS) {
    if (field === 'capsized') continue;
    if (ANGLE_FIELDS.has(field)) {
      boat.phys[field] = wrapPi(boat.phys[field] + wrapPi(state.phys[field] - boat.phys[field]) * softBlend);
    } else {
      boat.phys[field] += (state.phys[field] - boat.phys[field]) * softBlend;
    }
  }
  Object.assign(boat.phys.ctl, state.phys.ctl);
  for (const field of CONTROL_FIELDS) {
    boat[field] += (state.control[field] - boat[field]) * softBlend;
  }
  return 'soft';
}

export class MultiplayerRaceController {
  #session = null;

  #listeners = [];

  #clock;

  #snapshotBuffer;

  #controlProvider;

  #authorityStep;

  #predictionStep;

  #onAuthoritySnapshot;

  #onApplyEnvironment;

  #onRescueRequest;

  #onStartRace;

  #remoteInputs = new Map();

  #connectedByPlayerId = new Map();

  #takeoverPlayerIds = new Set();

  #localPaused = false;

  #migrating = false;

  #guestAwaitingAuthority = false;

  #hostEpoch = null;

  #now;

  #authorityClock = null;

  #role = 'disconnected';

  constructor({
    session = null,
    boats = [],
    race,
    seed,
    localPlayerId = null,
    tick = 0,
    startTick = tick,
    worldTime = 0,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    controlProvider = () => EMPTY_CONTROL_INTENT,
    authorityStep = () => {},
    predictionStep = () => {},
    onAuthoritySnapshot = () => {},
    onApplyEnvironment = () => {},
    onRescueRequest = () => {},
    onStartRace = () => {},
    snapshotBuffer = new SnapshotBuffer({
      interpolationDelayMs: MULTIPLAYER_INTERPOLATION_DELAY_MS,
    }),
  } = {}) {
    if (!Array.isArray(boats) || boats.length === 0 || boats.length > 8) {
      throw new TypeError('boats must contain one to eight boats');
    }
    if (!race || typeof race !== 'object') throw new TypeError('race is required');
    if (typeof controlProvider !== 'function') throw new TypeError('controlProvider must be a function');
    for (const [name, callback] of Object.entries({
      authorityStep,
      predictionStep,
      onAuthoritySnapshot,
      onApplyEnvironment,
      onRescueRequest,
      onStartRace,
    })) {
      if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
    }
    this.boats = boats;
    this.race = race;
    this.seed = seed;
    this.localPlayerId = localPlayerId;
    if (!Number.isSafeInteger(startTick) || startTick < tick) {
      throw new TypeError('startTick must be a safe integer no smaller than tick');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.startTick = startTick;
    this.#now = now;
    this.worldTime = finiteNumber(worldTime, 'worldTime');
    this.#clock = new FixedStepAccumulator({ hz: MULTIPLAYER_TICK_HZ, tick });
    this.#snapshotBuffer = snapshotBuffer;
    this.#controlProvider = controlProvider;
    this.#authorityStep = authorityStep;
    this.#predictionStep = predictionStep;
    this.#onAuthoritySnapshot = onAuthoritySnapshot;
    this.#onApplyEnvironment = onApplyEnvironment;
    this.#onRescueRequest = onRescueRequest;
    this.#onStartRace = onStartRace;
    if (session) this.attach(session);
  }

  get tick() {
    return this.#clock.tick;
  }

  get role() {
    return this.#role;
  }

  get migrating() {
    return this.#migrating || this.#guestAwaitingAuthority;
  }

  get takeoverPlayerIds() {
    return new Set(this.#takeoverPlayerIds);
  }

  get snapshotBuffer() {
    return this.#snapshotBuffer;
  }

  get session() {
    return this.#session;
  }

  estimatedHostWorldTime(now = this.#now()) {
    const timestamp = finiteNumber(now, 'now');
    if (!this.#authorityClock) return this.worldTime;
    return this.#authorityClock.worldTime
      + Math.max(0, timestamp - this.#authorityClock.receivedAt) / 1_000;
  }

  attach(session) {
    if (!session
      || typeof session.addEventListener !== 'function'
      || typeof session.configure !== 'function'
      || typeof session.update !== 'function') {
      throw new TypeError('session must provide EventTarget, configure(), and update() APIs');
    }
    this.detach();
    this.#session = session;
    this.#role = session.role ?? session.state?.role ?? 'disconnected';
    this.#migrating = !!session.state?.migrating;
    this.#hostEpoch = session.state?.hostEpoch ?? null;
    this.#guestAwaitingAuthority = this.#role === 'guest';
    this.localPlayerId ??= session.state?.playerId ?? null;
    if (Array.isArray(session.state?.members)) this.syncRoom(session.state);
    this.#listen('remote-input', ({ detail }) => {
      this.#remoteInputs.set(detail.playerId, {
        intent: detail.intent,
        seq: detail.seq,
        tick: detail.tick,
      });
    });
    this.#listen('snapshot', ({ detail }) => this.receiveAuthoritySnapshot(detail.snapshot));
    this.#listen('checkpoint', ({ detail }) => this.receiveAuthorityCheckpoint(detail.checkpoint));
    this.#listen('promote', ({ detail }) => {
      this.#migrating = true;
      if (detail.checkpoint) this.applyWorldState(detail.checkpoint);
    });
    this.#listen('rolechange', ({ detail }) => {
      const previousRole = this.#role;
      const nextEpoch = this.#session?.state?.hostEpoch ?? this.#hostEpoch;
      this.#role = detail.role;
      this.#migrating = !!this.#session?.state?.migrating;
      if (detail.role === 'guest'
        && (previousRole !== 'guest' || nextEpoch !== this.#hostEpoch)) {
        this.#enterGuestAuthorityWait(nextEpoch);
      } else if (detail.role !== 'guest') {
        this.#guestAwaitingAuthority = false;
        this.#hostEpoch = nextEpoch;
      }
    });
    this.#listen('migration-ready', () => {
      this.#role = this.#session?.role ?? 'host';
      this.#migrating = false;
    });
    this.#listen('statechange', ({ detail }) => {
      const previousRole = this.#role;
      const previousEpoch = this.#hostEpoch;
      this.#role = detail.role;
      this.#migrating = !!detail.migrating;
      if (detail.role === 'guest'
        && (previousRole !== 'guest' || detail.hostEpoch !== previousEpoch)) {
        this.#enterGuestAuthorityWait(detail.hostEpoch);
      } else {
        this.#hostEpoch = detail.hostEpoch ?? this.#hostEpoch;
        if (detail.role !== 'guest') this.#guestAwaitingAuthority = false;
      }
      if (Array.isArray(detail.members)) this.syncRoom(detail);
    });
    this.#listen('rescue-request', ({ detail }) => {
      if (this.#role === 'host') this.#onRescueRequest(detail);
    });
    this.#listen('start-race', ({ detail }) => this.#onStartRace(detail));
    session.configure({
      controlProvider: () => (this.#localPaused ? EMPTY_CONTROL_INTENT : this.#controlProvider()),
      snapshotProvider: ({ hostEpoch }) => this.captureWorldState(hostEpoch),
    });
    return this;
  }

  detach() {
    if (this.#session) {
      for (const [type, listener] of this.#listeners) {
        this.#session.removeEventListener(type, listener);
      }
      this.#session.configure?.({ controlProvider: null, snapshotProvider: null });
    }
    this.#listeners = [];
    this.#session = null;
    this.#role = 'disconnected';
    this.#migrating = false;
    this.#guestAwaitingAuthority = false;
    this.#hostEpoch = null;
    this.#authorityClock = null;
    this.#remoteInputs.clear();
    this.#connectedByPlayerId.clear();
    this.#takeoverPlayerIds.clear();
    this.#snapshotBuffer.clear();
    this.#clock.reset({ tick: this.#clock.tick });
    this.#localPaused = false;
  }

  #listen(type, listener) {
    this.#session.addEventListener(type, listener);
    this.#listeners.push([type, listener]);
  }

  setLocalPaused(paused) {
    this.#localPaused = !!paused;
  }

  syncRoom(room) {
    if (!room || !Array.isArray(room.members)) throw new TypeError('room.members must be an array');
    const connected = new Map(room.members.map((member) => [member.playerId, member.connected === true]));
    for (const playerId of new Set([
      ...this.#connectedByPlayerId.keys(),
      ...connected.keys(),
    ])) {
      if (this.#connectedByPlayerId.get(playerId) !== connected.get(playerId)) {
        this.#remoteInputs.delete(playerId);
      }
    }
    this.#connectedByPlayerId = connected;
    this.#takeoverPlayerIds.clear();
    for (const boat of this.boats) {
      if (!boat.playerId) continue;
      if (connected.get(boat.playerId) !== true) this.#takeoverPlayerIds.add(boat.playerId);
    }
  }

  controlModeFor(playerId) {
    const boat = this.boats.find((candidate) => candidate.playerId === playerId);
    if (!boat) return null;
    if (this.#takeoverPlayerIds.has(playerId)) return 'ai-takeover';
    return 'human';
  }

  controlFor(playerId) {
    if (this.#takeoverPlayerIds.has(playerId)) return null;
    if (playerId === this.localPlayerId) {
      return this.#localPaused ? EMPTY_CONTROL_INTENT : this.#controlProvider();
    }
    return this.#remoteInputs.get(playerId)?.intent ?? EMPTY_CONTROL_INTENT;
  }

  advanceFrame(frameSeconds, { now = this.#now() } = {}) {
    finiteNumber(frameSeconds, 'frameSeconds');
    finiteNumber(now, 'now');
    if (!this.#session || this.#session.state?.invalidated) return 0;
    if (this.#migrating || this.#guestAwaitingAuthority) return 0;
    this.#role = this.#session.role ?? this.#session.state?.role ?? this.#role;
    let count = 0;
    if (this.#role === 'host' || this.#role === 'guest') {
      count = this.#clock.advance(frameSeconds, (dt, tick) => {
        this.worldTime += dt;
        const context = {
          dt,
          tick,
          worldTime: this.worldTime,
          localPaused: this.#localPaused,
          takeoverPlayerIds: this.takeoverPlayerIds,
          controlFor: (playerId) => this.controlFor(playerId),
        };
        if (this.#role === 'host') this.#authorityStep(context);
        else this.#predictionStep(context);
      });
    }
    if (this.#role === 'guest') this.#rebaseGuestClock(now);
    this.#session.update({ tick: this.tick, now });
    return count;
  }

  captureWorldState(hostEpoch = this.#session?.state?.hostEpoch ?? 0) {
    return captureWorldState({
      tick: this.tick,
      worldTime: this.worldTime,
      seed: this.seed,
      hostEpoch,
      boats: this.boats,
      race: this.race,
    });
  }

  applyWorldState(snapshot) {
    const state = cloneWorldState(snapshot);
    const boatsById = new Map(this.boats.map((boat) => [boat.boatId, boat]));
    if (boatsById.size !== this.boats.length || boatsById.size !== state.boats.length) {
      throw new TypeError('checkpoint boats must exactly match the active race boats');
    }
    for (const boatState of state.boats) {
      if (!boatsById.has(boatState.boatId)) {
        throw new TypeError(`checkpoint references unknown boatId ${boatState.boatId}`);
      }
    }
    for (const boatState of state.boats) copyBoatState(boatsById.get(boatState.boatId), boatState);
    this.race.applyState(state.race);
    this.#clock.reset({ tick: state.tick });
    this.worldTime = state.worldTime;
    this.seed = state.seed;
    this.#snapshotBuffer.clear();
    this.#onApplyEnvironment(state);
    return state;
  }

  receiveAuthoritySnapshot(snapshot) {
    const state = cloneWorldState(snapshot);
    if (this.#guestAwaitingAuthority) return this.#acceptGuestAuthority(state);
    if (!this.#snapshotBuffer.add(state)) return false;
    this.#recordAuthorityClock(state);
    const localBoat = this.boats.find((boat) => (
      boat.isLocal || (this.localPlayerId !== null && boat.playerId === this.localPlayerId)
    ));
    const localState = localBoat
      ? state.boats.find((boat) => boat.boatId === localBoat.boatId)
      : null;
    if (localBoat && localState) reconcilePredictedBoat(localBoat, localState);
    this.race.applyState(state.race);
    this.#onAuthoritySnapshot(state);
    this.#rebaseGuestClock(this.#authorityClock.receivedAt);
    return true;
  }

  receiveAuthorityCheckpoint(checkpoint) {
    const state = cloneWorldState(checkpoint);
    if (this.#guestAwaitingAuthority) return this.#acceptGuestAuthority(state);
    if (!this.#snapshotBuffer.add(state)) return false;
    this.#recordAuthorityClock(state);
    this.#rebaseGuestClock(this.#authorityClock.receivedAt);
    return true;
  }

  #acceptGuestAuthority(snapshot) {
    const state = cloneWorldState(snapshot);
    if (this.#hostEpoch !== null && state.hostEpoch !== this.#hostEpoch) return false;
    this.applyWorldState(state);
    this.#snapshotBuffer.add(state);
    this.#recordAuthorityClock(state, { reset: true });
    this.#guestAwaitingAuthority = false;
    this.#migrating = false;
    this.#role = 'guest';
    return true;
  }

  #enterGuestAuthorityWait(hostEpoch) {
    this.#hostEpoch = hostEpoch ?? null;
    this.#guestAwaitingAuthority = true;
    this.#migrating = false;
    this.#snapshotBuffer.clear();
    this.#remoteInputs.clear();
    this.#authorityClock = null;
  }

  #recordAuthorityClock(state, { reset = false } = {}) {
    const receivedAt = finiteNumber(this.#now(), 'now');
    let tick = state.tick;
    let worldTime = state.worldTime;
    if (!reset && this.#authorityClock?.hostEpoch === state.hostEpoch) {
      const elapsed = Math.max(0, receivedAt - this.#authorityClock.receivedAt) / 1_000;
      const estimatedTick = this.#authorityClock.tick + elapsed * MULTIPLAYER_TICK_HZ;
      const estimatedWorldTime = this.#authorityClock.worldTime + elapsed;
      if (estimatedWorldTime > worldTime) {
        tick = Math.max(tick, estimatedTick);
        worldTime = estimatedWorldTime;
      }
    }
    this.#authorityClock = {
      hostEpoch: state.hostEpoch,
      tick,
      worldTime,
      receivedAt,
    };
  }

  #estimatedHostClock(now) {
    if (!this.#authorityClock) return null;
    const elapsed = Math.max(0, now - this.#authorityClock.receivedAt) / 1_000;
    return {
      tick: this.#authorityClock.tick + elapsed * MULTIPLAYER_TICK_HZ,
      worldTime: this.#authorityClock.worldTime + elapsed,
    };
  }

  #rebaseGuestClock(now) {
    const estimated = this.#estimatedHostClock(now);
    if (!estimated) return false;
    const tickDrift = estimated.tick - this.tick;
    const timeDrift = estimated.worldTime - this.worldTime;
    const hard = Math.abs(timeDrift) > HARD_CLOCK_DRIFT_SECONDS
      || Math.abs(tickDrift) > HARD_CLOCK_DRIFT_SECONDS * MULTIPLAYER_TICK_HZ;
    if (!hard && tickDrift < 1 && timeDrift < 1 / MULTIPLAYER_TICK_HZ) return false;
    if (!hard && (tickDrift < 0 || timeDrift < 0)) return false;

    const tick = Math.max(0, Math.floor(estimated.tick + 1e-9));
    const fractionalTicks = Math.max(0, estimated.tick - tick);
    const worldTime = estimated.worldTime - fractionalTicks / MULTIPLAYER_TICK_HZ;
    this.#clock.reset({
      tick,
      accumulator: Math.min(
        this.#clock.stepSeconds * (1 - 1e-12),
        fractionalTicks / MULTIPLAYER_TICK_HZ,
      ),
    });
    this.worldTime = worldTime;
    this.#onApplyEnvironment({
      tick,
      worldTime,
      seed: this.seed,
      hostEpoch: this.#hostEpoch ?? 0,
    });
    return true;
  }

  sampleRemoteBoats({ now = this.#now() } = {}) {
    const renderWorldTime = this.estimatedHostWorldTime(now);
    const rendered = this.#snapshotBuffer.sample(renderWorldTime);
    if (!rendered) return null;
    const boatsById = new Map(this.boats.map((boat) => [boat.boatId, boat]));
    for (const boatState of rendered.state.boats) {
      const boat = boatsById.get(boatState.boatId);
      if (!boat || boat.isLocal || boat.playerId === this.localPlayerId) continue;
      copyRemoteBoatState(boat, boatState);
    }
    return rendered;
  }
}
