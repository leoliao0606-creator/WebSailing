// 联机测试共享桩件:信令/传输/时钟/完整性监视器的可控替身,
// 以及房间视图与世界状态的标准 fixture。
// 供 multiplayerSession.test.js 与 hostMigration.test.js 共用。

import { MultiplayerSession } from '../../src/net/multiplayerSession.js';

export function emit(target, type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail });
  target.dispatchEvent(event);
}

export class FakeSignaling extends EventTarget {
  constructor(playerId) {
    super();
    this.state = Object.freeze({ playerId, room: null });
    this.leaveCalls = 0;
    this.closeCalls = 0;
    this.leaveResult = true;
  }

  room(room) {
    emit(this, 'room-view', { room });
  }

  hostChanged(detail) {
    emit(this, 'host-changed', detail);
  }

  domain(detail) {
    emit(this, 'domain-event', detail);
  }

  stateChange(patch) {
    this.state = Object.freeze({ ...this.state, ...patch });
    emit(this, 'statechange', this.state);
  }

  leave() {
    this.leaveCalls += 1;
    return this.leaveResult;
  }

  close() { this.closeCalls += 1; }
}

export class FakeTransport extends EventTarget {
  constructor() {
    super();
    this.toHost = [];
    this.broadcasts = [];
    this.reliablePreflights = [];
    this.reliableAvailable = true;
    this.broadcastResults = [];
    this.topologies = [];
    this.closed = false;
  }

  sendToHost(message, options) {
    this.toHost.push({ message, options });
  }

  broadcast(message, options) {
    this.broadcasts.push({ message, options });
    return this.broadcastResults.length > 0 ? this.broadcastResults.shift() : true;
  }

  canBroadcastReliable(messageOrMessages, options) {
    this.reliablePreflights.push({ messageOrMessages, options });
    return this.reliableAvailable;
  }

  receive(sourceId, message, { reliable = false } = {}) {
    emit(this, 'message', { sourceId, message, reliable });
  }

  ready(hostEpoch) {
    emit(this, 'ready', { hostEpoch });
  }

  topology(detail) {
    emit(this, 'topology', detail);
  }

  peerOpen(detail) {
    emit(this, 'peer-open', detail);
  }

  peerClose(detail) {
    emit(this, 'peer-close', detail);
  }

  reconcileTopology(room) {
    this.topologies.push(room);
    return true;
  }

  close() {
    this.closed = true;
  }
}

export class FakeClock {
  constructor(now = 0) {
    this.time = now;
  }

  now = () => this.time;

  advance(milliseconds) {
    this.time += milliseconds;
  }
}

export class FakeIntegrityMonitor {
  constructor() {
    this.calls = [];
    this.outcomes = [];
    this.resetCalls = 0;
  }

  queue(outcome) {
    this.outcomes.push(outcome);
  }

  inspect(state, authorization) {
    this.calls.push({ state: structuredClone(state), authorization: { ...authorization } });
    const queued = this.outcomes.shift();
    if (queued) return queued;
    return {
      status: 'accepted',
      ignored: false,
      invalidated: false,
      reasons: [],
      snapshot: structuredClone(state),
    };
  }

  reset() {
    this.resetCalls += 1;
  }
}

export function makeRoom({
  hostId = 'host',
  hostEpoch = 1,
  localId = 'guest',
  includeGuest = true,
  phase = 'lobby',
  extraIds = [],
} = {}) {
  const ids = includeGuest ? ['host', 'guest'] : [localId];
  if (!ids.includes(hostId)) ids.push(hostId);
  if (!ids.includes(localId)) ids.push(localId);
  for (const id of extraIds) if (!ids.includes(id)) ids.push(id);
  return {
    roomCode: 'AB2CD9',
    hostId,
    hostEpoch,
    phase,
    members: ids.map((playerId, index) => ({
      playerId,
      nickname: playerId,
      joinOrder: index + 1,
      connected: true,
      ready: true,
      isHost: playerId === hostId,
    })),
  };
}

export function makeWorldState({ tick = 60, worldTime = 1, hostEpoch = 1, x = 0 } = {}) {
  return {
    tick,
    worldTime,
    seed: 'session-seed',
    hostEpoch,
    boats: [{
      boatId: 'boat-a',
      phys: {
        x,
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
        powerScale: 1,
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
      rules: { penaltyT: 0, ruleCooldown: 0, penaltyTurns: 0, turnAcc: 0 },
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
        prevX: x,
        prevZ: 0,
        roundAcc: 0,
        nearMark: false,
      }],
      results: [],
    },
  };
}

export const CONTROL = Object.freeze({
  steerLeft: true,
  steerRight: false,
  sheetIn: false,
  sheetOut: true,
  hikeOut: false,
  hikeIn: false,
  boardDown: false,
  boardUp: false,
  righting: false,
});

export const START_CONFIG = Object.freeze({
  windPsi: 0.25,
  windKn: 12,
  gustiness: 0.25,
  countdown: 30,
  startTick: 1_920,
  roster: Object.freeze([
    Object.freeze({ playerId: 'host', nickname: 'host' }),
    Object.freeze({ playerId: 'guest', nickname: 'guest' }),
  ]),
  aiFill: 1,
  penaltyMode: 'turns',
});

export function startConfigForTick(tick, playerIds = ['host', 'guest']) {
  return {
    ...START_CONFIG,
    startTick: tick + START_CONFIG.countdown * 60,
    roster: playerIds.map((playerId) => ({ playerId, nickname: playerId })),
  };
}

export function makeHarness({
  playerId = 'guest',
  clock = new FakeClock(),
  integrityMonitor = new FakeIntegrityMonitor(),
  ...options
} = {}) {
  const signaling = new FakeSignaling(playerId);
  const transport = new FakeTransport();
  const session = new MultiplayerSession({
    signaling,
    transport,
    integrityMonitor,
    clock,
    ...options,
  });
  return { signaling, transport, integrityMonitor, clock, session };
}

export function collect(target, type) {
  const details = [];
  target.addEventListener(type, (event) => details.push(event.detail));
  return details;
}
