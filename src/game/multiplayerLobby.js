import { t } from '../i18n.js';
import { IntegrityMonitor } from '../net/integrityMonitor.js';
import {
  MultiplayerSession,
  leaveOrCloseMultiplayer,
} from '../net/multiplayerSession.js';
import { PeerTransport } from '../net/peerTransport.js';
import { normalizeNickname, normalizeRoomCode } from '../net/protocol.js';
import { SignalingClient } from '../net/signalingClient.js';
import { ChatPanel } from './chatPanel.js';

export const NICKNAME_STORAGE_KEY = 'windchaser.multiplayer.nickname.v1';
const MAX_PLAYERS = 8;
const MAX_LOCKED_START_ATTEMPTS = 3;
const DEFINITIVE_LOCK_ERRORS = [
  'NOT_HOST',
  'NOT_ENOUGH_PLAYERS',
  'PLAYERS_NOT_READY',
  'START_ROSTER_MISMATCH',
];

function defaultStackFactory() {
  const signaling = new SignalingClient();
  const transport = new PeerTransport({ signaling });
  const session = new MultiplayerSession({
    signaling,
    transport,
    integrityMonitor: new IntegrityMonitor(),
  });
  return { signaling, transport, session };
}

function validEventTarget(value) {
  return value
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function';
}

function setTestId(element, value) {
  element.setAttribute('data-testid', value);
  return element;
}

function makeButton(documentRef, testId, label) {
  const element = setTestId(documentRef.createElement('button'), testId);
  element.type = 'button';
  element.textContent = label;
  return element;
}

function makeLabel(documentRef, labelText, control) {
  const label = documentRef.createElement('label');
  const text = documentRef.createElement('span');
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

function normalizeMembers(members) {
  if (!Array.isArray(members)) return [];
  return members.slice(0, MAX_PLAYERS).map((member, index) => ({
    playerId: String(member?.playerId ?? ''),
    nickname: typeof member?.nickname === 'string' ? member.nickname : String(member?.playerId ?? ''),
    connected: member?.connected === true,
    ready: member?.ready === true,
    isHost: member?.isHost === true,
    joinOrder: Number.isSafeInteger(member?.joinOrder) ? member.joinOrder : index + 1,
  })).filter(({ playerId }) => playerId.length > 0);
}

function stateMembers(state) {
  return normalizeMembers(state?.members);
}

export function lobbyEligibility(sessionState, { transportReady = false } = {}) {
  const members = stateMembers(sessionState);
  const connected = members.filter((member) => member.connected);
  let reason = null;
  if (sessionState?.invalidated) reason = 'invalidated';
  else if (sessionState?.migrating) reason = 'migrating';
  else if (sessionState?.phase === 'racing') reason = 'inProgress';
  else if (sessionState?.role !== 'host') reason = 'not-host';
  else if (connected.length < 2) reason = 'need-players';
  else if (connected.some((member) => !member.ready)) reason = 'not-ready';
  else if (!transportReady) reason = 'transport';
  return {
    canStart: reason === null,
    reason,
    connectedCount: connected.length,
  };
}

function finiteSetting(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function integerSetting(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}

export function buildMultiplayerStartOptions({
  settings,
  sessionState,
  tick = 0,
  random = Math.random,
  now = Date.now,
} = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError('settings must be an object');
  }
  if (!sessionState?.roomCode || !Number.isSafeInteger(sessionState.hostEpoch)) {
    throw new TypeError('an active multiplayer room is required');
  }
  if (!Number.isSafeInteger(tick) || tick < 0) throw new TypeError('tick must be non-negative');
  if (typeof random !== 'function' || typeof now !== 'function') {
    throw new TypeError('random and now must be functions');
  }
  const roster = stateMembers(sessionState).map(({ playerId, nickname }) => ({
    playerId,
    nickname,
  }));
  if (roster.length === 0 || roster.length > MAX_PLAYERS) {
    throw new TypeError('room roster must contain one to eight players');
  }
  const countdown = Math.max(0, Math.min(120, integerSetting(settings.countdown, 45)));
  const desiredAi = Math.max(0, integerSetting(settings.aiCount, 0));
  const aiFill = Math.min(desiredAi, MAX_PLAYERS - roster.length);
  const penaltyMode = settings.penaltyMode === 'slow' ? 'slow' : 'turns';
  const randomValue = Math.max(0, Math.min(1, Number(random()) || 0));
  const windPsi = -0.65 + (randomValue - 0.5) * 0.9;
  const timestamp = Number(now());
  const seedSuffix = Number.isFinite(timestamp) ? timestamp : 0;
  return {
    tick,
    seed: `${sessionState.roomCode}:${sessionState.hostEpoch}:${tick}:${seedSuffix}`,
    config: {
      windPsi,
      windKn: Math.max(0.5, Math.min(40, finiteSetting(settings.windKn, 12))),
      gustiness: Math.max(0, Math.min(1, finiteSetting(settings.gustiness, 0.32))),
      countdown,
      startTick: tick + countdown * 60,
      roster,
      aiFill,
      penaltyMode,
    },
  };
}

export class MultiplayerLobby {
  constructor({
    app,
    documentRef = globalThis.document,
    storage = globalThis.sessionStorage,
    clipboard = globalThis.navigator?.clipboard,
    mountRoot = documentRef?.body,
    showScreen,
    createStack = defaultStackFactory,
    createChatPanel = (options) => new ChatPanel(options),
    random = Math.random,
    now = Date.now,
    translate = t,
  } = {}) {
    if (!app
      || typeof app.attachMultiplayer !== 'function'
      || typeof app.startMultiplayerRace !== 'function') {
      throw new TypeError('app must provide attachMultiplayer() and startMultiplayerRace()');
    }
    if (!documentRef || typeof documentRef.createElement !== 'function') {
      throw new TypeError('documentRef must provide createElement()');
    }
    if (typeof showScreen !== 'function') throw new TypeError('showScreen must be a function');
    if (typeof createStack !== 'function' || typeof createChatPanel !== 'function') {
      throw new TypeError('stack and chat factories must be functions');
    }
    this.app = app;
    this.document = documentRef;
    this.storage = storage ?? null;
    this.clipboard = clipboard ?? null;
    this.mountRoot = mountRoot;
    this.showScreen = showScreen;
    this.createStack = createStack;
    this.createChatPanel = createChatPanel;
    this.random = random;
    this.now = now;
    this.translate = translate;
    this.stack = null;
    this.chatPanel = null;
    this.listeners = [];
    this.connectPromise = null;
    this.connectedOnce = false;
    this.room = null;
    this.sessionState = null;
    this.reliablePeers = new Set();
    this.topologyContext = null;
    this.startPromise = null;
    this.pendingLockedStart = null;
    this.roomCommandPromise = null;
    this.roomCommandPending = false;
    this.raceStarted = false;
    this.statusKey = null;
    this.statusVars = null;
    this.root = null;
    this.statusBanner = setTestId(this.document.createElement('div'), 'multiplayer-status-banner');
    this.statusBanner.classList.add('multiplayer-status-banner');
    this.statusBanner.setAttribute('role', 'status');
    this.statusBanner.setAttribute('aria-live', 'assertive');
    this.statusBanner.hidden = true;
    this.mountRoot?.append?.(this.statusBanner);
  }

  get state() { return this._effectiveState(); }

  mount(root) {
    if (!root || typeof root.append !== 'function') {
      throw new TypeError('root must provide append()');
    }
    this.root = root;
    this._buildOnlineScreen();
    this._buildLobbyScreen();
    root.append(this.onlineScreen, this.lobbyScreen);
    this._render();
    this.chatPanel?.refreshLanguage?.();
    return this;
  }

  async open() {
    this._ensureStack();
    this.showScreen(this._effectiveState().roomCode ? 'menu-online-lobby' : 'menu-online');
    try {
      await this._connect();
      this.statusKey = null;
      this._render();
      return true;
    } catch {
      this.statusKey = 'online.error.connection';
      this._render();
      return false;
    }
  }

  createRoom(nickname = this.nicknameInput?.value ?? '') {
    if (this.roomCommandPromise) return this.roomCommandPromise;
    const normalized = normalizeNickname(nickname);
    if (!normalized.ok) {
      this.statusKey = 'online.error.nickname';
      this._render();
      return Promise.resolve(false);
    }
    this._saveNickname(normalized.value);
    return this._beginRoomCommand(
      () => this.stack.signaling.createRoom(normalized.value),
      'online.status.creating',
    );
  }

  joinRoom(code = this.codeInput?.value ?? '', nickname = this.nicknameInput?.value ?? '') {
    if (this.roomCommandPromise) return this.roomCommandPromise;
    const normalizedName = normalizeNickname(nickname);
    const normalizedCode = normalizeRoomCode(code);
    if (!normalizedName.ok) {
      this.statusKey = 'online.error.nickname';
      this._render();
      return Promise.resolve(false);
    }
    if (!normalizedCode.ok) {
      this.statusKey = 'online.error.code';
      this._render();
      return Promise.resolve(false);
    }
    this._saveNickname(normalizedName.value);
    return this._beginRoomCommand(
      () => this.stack.signaling.joinRoom(normalizedCode.value, normalizedName.value),
      'online.status.joining',
    );
  }

  _beginRoomCommand(command, pendingStatusKey) {
    if (this.roomCommandPromise) return this.roomCommandPromise;
    this.roomCommandPending = true;
    this.statusKey = pendingStatusKey;
    const operation = (async () => {
      if (!await this.open()) {
        this.roomCommandPending = false;
        return false;
      }
      try {
        const accepted = command();
        this.statusKey = pendingStatusKey;
        if (accepted === false) this.roomCommandPending = false;
        this._render();
        return accepted !== false;
      } catch {
        this.roomCommandPending = false;
        this.statusKey = 'online.error.connection';
        this._render();
        return false;
      }
    })();
    this.roomCommandPromise = operation;
    this._render();
    void operation.finally(() => {
      if (this.roomCommandPromise === operation) this.roomCommandPromise = null;
      this._render();
    });
    return operation;
  }

  toggleReady() {
    const state = this._effectiveState();
    const local = state.members.find((member) => member.playerId === state.playerId);
    if (!local || !this.stack) return false;
    try {
      return this.stack.signaling.setReady(!local.ready) !== false;
    } catch {
      this.statusKey = 'online.error.connection';
      this._render();
      return false;
    }
  }

  startRace() {
    if (this.startPromise) return this.startPromise;
    if (this.pendingLockedStart) {
      const state = this._effectiveState();
      if (this.pendingLockedStart.lockUncertain && state.phase === 'lobby') {
        const eligibility = lobbyEligibility(state, { transportReady: this._transportReady(state) });
        if (!eligibility.canStart) {
          this.statusKey = `lobby.status.${eligibility.reason}`;
          this._render();
          return Promise.resolve(false);
        }
        const options = this.pendingLockedStart.options;
        this.pendingLockedStart = null;
        this.statusKey = 'lobby.status.locking';
        const operation = this._lockAndStart(options);
        this.startPromise = operation;
        this._render();
        void operation.finally(() => {
          if (this.startPromise === operation) this.startPromise = null;
          this._render();
          this._retryUncertainLockedStart();
        });
        return operation;
      }
      const operation = Promise.resolve(this._retryLockedStart({ manual: true }));
      this.startPromise = operation;
      this._render();
      void operation.finally(() => {
        if (this.startPromise === operation) this.startPromise = null;
        this._render();
      });
      return operation;
    }
    const state = this._effectiveState();
    const eligibility = lobbyEligibility(state, { transportReady: this._transportReady(state) });
    if (!eligibility.canStart) {
      this.statusKey = `lobby.status.${eligibility.reason}`;
      this._render();
      return Promise.resolve(false);
    }
    const options = buildMultiplayerStartOptions({
      settings: this.app.settings,
      sessionState: state,
      tick: 0,
      random: this.random,
      now: this.now,
    });
    this.statusKey = 'lobby.status.locking';
    const operation = this._lockAndStart(options);
    this.startPromise = operation;
    this._render();
    void operation.finally(() => {
      if (this.startPromise === operation) this.startPromise = null;
      this._render();
      this._retryUncertainLockedStart();
    });
    return operation;
  }

  async _lockAndStart(options) {
    let locked;
    try {
      if (typeof this.stack?.signaling?.lockRoom !== 'function') {
        throw new Error('signaling room lock is unavailable');
      }
      locked = await this.stack.signaling.lockRoom(options);
    } catch (error) {
      const state = this._effectiveState();
      if (state.phase === 'racing' && state.start) return this._startLockedRoom(state.start);
      const errorIdentity = String(error?.code ?? error?.message ?? '').toUpperCase();
      const definitive = DEFINITIVE_LOCK_ERRORS.some((code) => errorIdentity.includes(code));
      if (!definitive) {
        this.pendingLockedStart = {
          options,
          roomCode: state.roomCode,
          hostEpoch: state.hostEpoch,
          attempts: 0,
          retrying: false,
          lockUncertain: true,
        };
      }
      this.statusKey = 'lobby.status.lockFailed';
      this._render();
      return false;
    }
    const authoritativeStart = locked?.start ?? this._effectiveState().start;
    if (!authoritativeStart) {
      this.statusKey = 'lobby.status.lockFailed';
      this._render();
      return false;
    }
    return this._startLockedRoom(authoritativeStart);
  }

  _startLockedRoom(options) {
    let accepted = false;
    try {
      accepted = this.app.startMultiplayerRace(options) !== false;
    } catch {
      accepted = false;
    }
    if (accepted) {
      this.raceStarted = true;
      this.pendingLockedStart = null;
      this.statusKey = 'lobby.status.starting';
      this._render();
      return true;
    }
    const state = this._effectiveState();
    this.pendingLockedStart = {
      options,
      roomCode: state.roomCode,
      hostEpoch: state.hostEpoch,
      attempts: 1,
      retrying: false,
      lockUncertain: false,
    };
    this.statusKey = 'lobby.status.lockedWaiting';
    this._render();
    return false;
  }

  _retryLockedStart({ manual = false } = {}) {
    const pending = this.pendingLockedStart;
    if (!pending || pending.retrying
      || (!manual && pending.attempts >= MAX_LOCKED_START_ATTEMPTS)) {
      return false;
    }
    const state = this._effectiveState();
    if (state.roomCode !== pending.roomCode
      || state.hostEpoch !== pending.hostEpoch
      || state.phase !== 'racing'
      || state.role !== 'host'
      || state.invalidated
      || state.migrating
      || !this._transportReady(state)) {
      return false;
    }

    if (manual && pending.attempts >= MAX_LOCKED_START_ATTEMPTS) pending.attempts = 0;
    pending.retrying = true;
    pending.lockUncertain = false;
    pending.attempts += 1;
    const authoritativeStart = state.start;
    if (!authoritativeStart) {
      pending.retrying = false;
      return false;
    }
    let accepted = false;
    try {
      accepted = this.app.startMultiplayerRace(authoritativeStart) !== false;
    } catch {
      accepted = false;
    } finally {
      pending.retrying = false;
    }
    if (accepted) {
      this.raceStarted = true;
      this.pendingLockedStart = null;
      this.statusKey = 'lobby.status.starting';
    } else {
      this.statusKey = pending.attempts >= MAX_LOCKED_START_ATTEMPTS
        ? 'lobby.status.startFailed'
        : 'lobby.status.lockedWaiting';
    }
    this._render();
    return accepted;
  }

  _retryUncertainLockedStart() {
    const pending = this.pendingLockedStart;
    if (!pending?.lockUncertain || this.startPromise !== null) return false;
    if (this._effectiveState().phase !== 'racing') return false;
    return this._retryLockedStart();
  }

  leave() {
    if (!this.stack) {
      this.showScreen('menu-online');
      return false;
    }
    let accepted = false;
    accepted = leaveOrCloseMultiplayer(this.stack.session);
    if (!accepted) {
      for (const [target, type, listener] of this.listeners) {
        target.removeEventListener(type, listener);
      }
      this.listeners.length = 0;
      this.chatPanel?.destroy?.();
      this.chatPanel = null;
      this.stack = null;
      this.connectedOnce = false;
      this.connectPromise = null;
      this.roomCommandPromise = null;
    }
    this.room = null;
    this.sessionState = null;
    this.reliablePeers.clear();
    this.topologyContext = null;
    this.pendingLockedStart = null;
    this.roomCommandPending = false;
    this.raceStarted = false;
    this.statusKey = null;
    this._render();
    this.showScreen('menu-online');
    return accepted;
  }

  async copyRoomCode() {
    const code = this._effectiveState().roomCode;
    if (!code) return false;
    if (typeof this.clipboard?.writeText !== 'function') {
      this.statusKey = 'lobby.status.copyFailed';
      this._render();
      return false;
    }
    try {
      await this.clipboard.writeText(code);
      this.statusKey = 'lobby.status.copied';
      this._render();
      return true;
    } catch {
      this.statusKey = 'lobby.status.copyFailed';
      this._render();
      return false;
    }
  }

  _ensureStack() {
    if (this.stack) return this.stack;
    const stack = this.createStack();
    if (!stack
      || !validEventTarget(stack.signaling)
      || !validEventTarget(stack.transport)
      || !validEventTarget(stack.session)
      || typeof stack.signaling.connect !== 'function') {
      throw new TypeError('createStack must return signaling, transport, and session');
    }
    this.stack = stack;
    this.sessionState = stack.session.state ?? null;
    this.room = stack.signaling.state?.room ?? null;
    this.app.attachMultiplayer(stack.session);
    this.chatPanel = this.createChatPanel({
      documentRef: this.document,
      mountRoot: this.mountRoot,
      session: stack.session,
      translate: this.translate,
    });
    this._bindStack();
    return stack;
  }

  _connect() {
    if (this.connectedOnce || this.stack.signaling.state?.connected === true) {
      this.connectedOnce = true;
      return Promise.resolve();
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = Promise.resolve(this.stack.signaling.connect())
      .then(() => { this.connectedOnce = true; })
      .finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  _bindStack() {
    const { signaling, transport, session } = this.stack;
    this._listen(signaling, 'room-view', (event) => {
      this._applyRoom(event?.detail?.room ?? event?.detail);
    });
    this._listen(signaling, 'host-change', (event) => this._applyHostChange(event?.detail));
    this._listen(signaling, 'host-changed', (event) => this._applyHostChange(event?.detail));
    this._listen(signaling, 'statechange', (event) => {
      const state = event?.detail ?? signaling.state;
      if (state?.room) this._applyRoom(state.room, false);
      else if (state?.room === null && !this.sessionState?.roomCode) {
        this.room = null;
        this.raceStarted = false;
      }
      if (state?.connection === 'reconnecting' || state?.connected === false) {
        this.roomCommandPending = false;
        this.statusKey = state?.connection === 'reconnecting'
          ? 'lobby.status.reconnecting'
          : 'lobby.status.disconnected';
      } else if (state?.connected === true && [
        'lobby.status.reconnecting',
        'lobby.status.disconnected',
        'online.error.connection',
      ].includes(this.statusKey)) {
        this.statusKey = null;
      }
      this._render();
    });
    this._listen(signaling, 'reconnecting', () => {
      this.roomCommandPending = false;
      this.statusKey = 'lobby.status.reconnecting';
      this._render();
    });
    this._listen(signaling, 'error', () => {
      this.roomCommandPending = false;
      this.statusKey = 'online.error.server';
      this._render();
    });

    this._listen(session, 'statechange', (event) => {
      const previousRole = this.sessionState?.role ?? 'disconnected';
      this.sessionState = event?.detail ?? session.state;
      if (previousRole !== this.sessionState?.role) {
        this.reliablePeers.clear();
        this.topologyContext = null;
        this.pendingLockedStart = null;
      }
      if (this.sessionState?.roomCode) {
        this._applyRoom(this.sessionState, false);
      } else if (this.sessionState?.role === 'disconnected') {
        this.room = null;
      }
      this._render();
    });
    this._listen(session, 'rolechange', () => {
      this.sessionState = session.state;
      this._render();
    });
    this._listen(session, 'start-race', () => {
      this.raceStarted = true;
    });
    this._listen(session, 'promote', () => {
      this.statusKey = 'lobby.status.migrating';
      this._render();
    });
    this._listen(session, 'migration-ready', () => {
      this.statusKey = 'lobby.status.migrationReady';
      this.sessionState = session.state;
      this._render();
    });
    this._listen(session, 'host-ready', () => {
      if (this.statusKey === 'lobby.status.migrating') {
        this.statusKey = 'lobby.status.migrationReady';
      }
      this.sessionState = session.state;
      this._render();
    });
    this._listen(session, 'checkpoint', () => {
      this.sessionState = session.state;
      const state = this._effectiveState();
      const currentHost = state.members.find((member) => member.playerId === state.hostId);
      if (this.statusKey === 'lobby.status.migrating'
        && !state.migrating
        && !state.invalidated
        && currentHost?.connected === true) {
        this.statusKey = null;
      }
      this._render();
    });
    this._listen(session, 'invalidated', () => {
      this.statusKey = 'lobby.status.invalidated';
      this.sessionState = session.state;
      this._render();
    });

    this._listen(transport, 'topology', (event) => {
      this._applyTopology(event?.detail);
      this._render();
    });
    this._listen(transport, 'peer-open', (event) => {
      if (event?.detail?.reliable || event?.detail?.channel === 'control') {
        this.reliablePeers.add(event.detail.playerId);
        this._render();
        this._retryLockedStart();
      }
    });
    this._listen(transport, 'peer-close', (event) => {
      if (event?.detail?.reliable || event?.detail?.channel === 'control') {
        this.reliablePeers.delete(event.detail.playerId);
        this._render();
      }
    });
    this._listen(transport, 'ready', () => {
      const state = this._effectiveState();
      for (const member of state.members) {
        if (member.connected && member.playerId !== state.playerId) {
          this.reliablePeers.add(member.playerId);
        }
      }
      this._render();
      this._retryLockedStart();
    });
  }

  _listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.listeners.push([target, type, listener]);
  }

  _applyRoom(value, navigate = true) {
    if (!value?.roomCode) return;
    this.roomCommandPending = false;
    const previousRoomCode = this.room?.roomCode;
    const previousHostId = this.room?.hostId;
    const previousEpoch = this.room?.hostEpoch;
    this.room = {
      roomCode: value.roomCode,
      hostId: value.hostId ?? null,
      hostEpoch: Number.isSafeInteger(value.hostEpoch) ? value.hostEpoch : 0,
      phase: value.phase === 'racing' ? 'racing' : 'lobby',
      members: normalizeMembers(value.members),
    };
    if (this.room.phase === 'lobby') this.raceStarted = false;
    if (this.room.phase === 'racing' && value.start) this.room.start = value.start;
    if (previousRoomCode !== undefined && (
      previousRoomCode !== this.room.roomCode
      || previousHostId !== this.room.hostId
      || previousEpoch !== this.room.hostEpoch
    )) {
      this.reliablePeers.clear();
      this.topologyContext = null;
      this.pendingLockedStart = null;
    }
    if (previousEpoch !== undefined && previousEpoch !== this.room.hostEpoch) {
      this.statusKey = 'lobby.status.migrating';
    } else if ([
      'online.status.creating',
      'online.status.joining',
      'lobby.status.reconnecting',
      'lobby.status.disconnected',
      'online.error.connection',
    ].includes(this.statusKey)) {
      this.statusKey = null;
    }
    this._render();
    this._retryUncertainLockedStart();
    const activeRace = this.app.mode === 'multiplayer-race' || this.raceStarted;
    if (navigate && !(this.room.phase === 'racing' && activeRace)) {
      this.showScreen('menu-online-lobby');
    }
  }

  _applyHostChange(detail) {
    if (!detail || detail.roomCode !== this.room?.roomCode) return;
    if (Number.isSafeInteger(detail.hostEpoch)
      && Number.isSafeInteger(this.room.hostEpoch)
      && detail.hostEpoch < this.room.hostEpoch) {
      return;
    }
    if (detail.previousHostId === null) {
      this.room = {
        ...this.room,
        hostId: detail.hostId,
        hostEpoch: detail.hostEpoch,
      };
      if (this.statusKey === 'lobby.status.migrating') this.statusKey = null;
      this._render();
      return;
    }
    // A genuine migration may have reached us through the session listener
    // before this signaling alias. Preserve its banner/topology state.
    if (detail.hostId === this.room.hostId && detail.hostEpoch === this.room.hostEpoch) return;
    this.room = {
      ...this.room,
      hostId: detail.hostId,
      hostEpoch: detail.hostEpoch,
    };
    this.reliablePeers.clear();
    this.topologyContext = null;
    this.statusKey = 'lobby.status.migrating';
    this._render();
  }

  _effectiveState() {
    const session = this.sessionState ?? {};
    const room = this.room ?? {};
    const signalingPlayerId = this.stack?.signaling?.state?.playerId ?? null;
    const playerId = session.playerId ?? signalingPlayerId;
    const hostId = session.hostId ?? room.hostId ?? null;
    const members = stateMembers(session).length > 0
      ? stateMembers(session)
      : normalizeMembers(room.members);
    return {
      roomCode: session.roomCode ?? room.roomCode ?? null,
      playerId,
      hostId,
      hostEpoch: session.hostEpoch ?? room.hostEpoch ?? null,
      phase: session.phase ?? room.phase ?? null,
      start: session.start ?? room.start ?? null,
      role: session.role && session.role !== 'disconnected'
        ? session.role
        : (playerId && playerId === hostId ? 'host' : (playerId ? 'guest' : 'disconnected')),
      migrating: session.migrating === true,
      invalidated: session.invalidated === true,
      members,
    };
  }

  _transportReady(state) {
    if (state.role !== 'host') return false;
    if (this.stack?.signaling?.state?.connected !== true) return false;
    return state.members
      .filter((member) => member.connected && member.playerId !== state.playerId)
      .every((member) => this.reliablePeers.has(member.playerId));
  }

  _applyTopology(detail) {
    if (!detail || !Array.isArray(detail.peerIds)) return;
    const context = {
      roomCode: detail.roomCode ?? null,
      hostId: detail.hostId ?? null,
      hostEpoch: detail.hostEpoch ?? null,
      selfId: detail.selfId ?? null,
      isHost: detail.isHost === true,
    };
    const previous = this.topologyContext;
    const authorityChanged = previous && Object.keys(context)
      .some((key) => previous[key] !== context[key]);
    if (authorityChanged) this.reliablePeers.clear();
    const connected = new Set(detail.peerIds);
    this.reliablePeers = new Set(
      [...this.reliablePeers].filter((playerId) => connected.has(playerId)),
    );
    this.topologyContext = context;
  }

  _loadNickname() {
    try { return this.storage?.getItem?.(NICKNAME_STORAGE_KEY) ?? ''; } catch { return ''; }
  }

  _saveNickname(nickname) {
    try { this.storage?.setItem?.(NICKNAME_STORAGE_KEY, nickname); } catch {}
    if (this.nicknameInput) this.nicknameInput.value = nickname;
  }

  _buildOnlineScreen() {
    const documentRef = this.document;
    const screen = documentRef.createElement('div');
    screen.id = 'menu-online';
    screen.classList.add('screen', 'multiplayer-screen');
    setTestId(screen, 'multiplayer-online-screen');

    const title = documentRef.createElement('h2');
    title.textContent = this.translate('online.title');
    const form = documentRef.createElement('div');
    form.classList.add('online-form');
    this.nicknameInput = setTestId(documentRef.createElement('input'), 'multiplayer-nickname');
    this.nicknameInput.type = 'text';
    // Native maxlength counts UTF-16 code units; protocol nicknames allow 20 code points.
    this.nicknameInput.maxLength = 40;
    this.nicknameInput.value = this._loadNickname();
    this.nicknameInput.setAttribute('autocomplete', 'nickname');
    this.nicknameInput.setAttribute('aria-label', this.translate('online.nickname'));

    this.createButton = makeButton(documentRef, 'multiplayer-create', this.translate('online.create'));
    this.codeInput = setTestId(documentRef.createElement('input'), 'multiplayer-room-code');
    this.codeInput.type = 'text';
    this.codeInput.maxLength = 6;
    this.codeInput.setAttribute('autocomplete', 'off');
    this.codeInput.setAttribute('aria-label', this.translate('online.code'));
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase();
    });
    this.joinButton = makeButton(documentRef, 'multiplayer-join', this.translate('online.join'));
    this.onlineStatus = setTestId(documentRef.createElement('div'), 'multiplayer-status');
    this.onlineStatus.classList.add('online-status');
    this.onlineStatus.setAttribute('role', 'status');
    const back = makeButton(documentRef, 'multiplayer-back', this.translate('online.back'));

    this.createButton.addEventListener('click', () => { void this.createRoom(); });
    this.joinButton.addEventListener('click', () => { void this.joinRoom(); });
    this.codeInput.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.joinRoom();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.codeInput.blur();
      }
    });
    this.nicknameInput.addEventListener('keydown', (event) => event.stopPropagation());
    back.addEventListener('click', () => this.showScreen('menu-main'));

    form.append(
      makeLabel(documentRef, this.translate('online.nickname'), this.nicknameInput),
      this.createButton,
      makeLabel(documentRef, this.translate('online.code'), this.codeInput),
      this.joinButton,
    );
    screen.append(title, form, this.onlineStatus, back);
    this.onlineScreen = screen;
  }

  _buildLobbyScreen() {
    const documentRef = this.document;
    const screen = documentRef.createElement('div');
    screen.id = 'menu-online-lobby';
    screen.classList.add('screen', 'multiplayer-screen');
    setTestId(screen, 'multiplayer-lobby-screen');
    const title = documentRef.createElement('h2');
    title.textContent = this.translate('lobby.title');

    const codeRow = documentRef.createElement('div');
    codeRow.classList.add('lobby-code-row');
    const codeLabel = documentRef.createElement('span');
    codeLabel.textContent = this.translate('lobby.roomCode');
    this.lobbyCode = setTestId(documentRef.createElement('strong'), 'lobby-room-code');
    this.copyButton = makeButton(documentRef, 'lobby-copy-code', this.translate('lobby.copy'));
    this.copyButton.addEventListener('click', () => { void this.copyRoomCode(); });
    codeRow.append(codeLabel, this.lobbyCode, this.copyButton);

    this.memberList = setTestId(documentRef.createElement('ul'), 'lobby-members');
    this.memberList.classList.add('lobby-members');
    this.memberList.setAttribute('aria-label', this.translate('lobby.members'));
    this.memberList.setAttribute('role', 'list');
    this.lobbyStatus = setTestId(documentRef.createElement('div'), 'lobby-status');
    this.lobbyStatus.classList.add('lobby-status');
    this.lobbyStatus.setAttribute('role', 'status');

    const actions = documentRef.createElement('div');
    actions.classList.add('btn-row', 'lobby-actions');
    this.readyButton = makeButton(documentRef, 'lobby-ready', this.translate('lobby.ready'));
    this.startButton = makeButton(documentRef, 'lobby-start', this.translate('lobby.start'));
    const leaveButton = makeButton(documentRef, 'lobby-leave', this.translate('lobby.leave'));
    this.readyButton.addEventListener('click', () => this.toggleReady());
    this.startButton.addEventListener('click', () => this.startRace());
    leaveButton.addEventListener('click', () => this.leave());
    actions.append(this.readyButton, this.startButton, leaveButton);
    screen.append(title, codeRow, this.memberList, this.lobbyStatus, actions);
    this.lobbyScreen = screen;
  }

  _render() {
    if (!this.onlineScreen || !this.lobbyScreen) return;
    const state = this._effectiveState();
    this.lobbyCode.textContent = state.roomCode ?? '------';
    this.copyButton.disabled = !state.roomCode;
    this.createButton.disabled = this.roomCommandPending;
    this.joinButton.disabled = this.roomCommandPending;
    this.nicknameInput.disabled = this.roomCommandPending;
    this.codeInput.disabled = this.roomCommandPending;
    this._renderMembers(state);
    const local = state.members.find((member) => member.playerId === state.playerId);
    this.readyButton.textContent = this.translate(local?.ready ? 'lobby.unready' : 'lobby.ready');
    this.readyButton.disabled = !local
      || !local.connected
      || state.invalidated
      || state.migrating
      || this.startPromise !== null
      || (this.pendingLockedStart !== null
        && !(this.pendingLockedStart.lockUncertain && state.phase === 'lobby'))
      || this.stack?.signaling?.state?.connected !== true;
    const eligibility = lobbyEligibility(state, { transportReady: this._transportReady(state) });
    const canRetryLockedStart = this.pendingLockedStart !== null
      && state.phase === 'racing'
      && state.role === 'host'
      && !state.invalidated
      && !state.migrating
      && this._transportReady(state);
    const canRetryUncertainLock = this.pendingLockedStart?.lockUncertain === true
      && state.phase === 'lobby'
      && eligibility.canStart;
    this.startButton.disabled = this.startPromise !== null
      || (this.pendingLockedStart !== null
        ? !(canRetryLockedStart || canRetryUncertainLock)
        : !eligibility.canStart);
    this.startButton.hidden = state.role !== 'host';
    const statusKey = this._resolvedStatusKey(state, eligibility);
    const text = statusKey ? this.translate(statusKey, this.statusVars ?? undefined) : '';
    this.onlineStatus.textContent = text;
    this.lobbyStatus.textContent = text;
    const bannerKey = this._persistentStatusKey(state);
    this.statusBanner.textContent = bannerKey ? this.translate(bannerKey) : '';
    this.statusBanner.hidden = bannerKey === null;
  }

  _renderMembers(state) {
    const rows = state.members.map((member) => {
      const row = this.document.createElement('li');
      row.classList.add('lobby-member');
      row.setAttribute('role', 'listitem');
      row.setAttribute('data-testid', `lobby-member-${member.playerId}`);
      const name = this.document.createElement('span');
      name.classList.add('lobby-member-name');
      name.textContent = member.nickname;
      const badges = this.document.createElement('span');
      badges.classList.add('lobby-member-badges');
      const labels = [];
      if (member.playerId === state.hostId) labels.push(this.translate('lobby.badge.host'));
      if (member.playerId === state.playerId) labels.push(this.translate('lobby.badge.you'));
      labels.push(this.translate(member.connected ? 'lobby.badge.connected' : 'lobby.badge.disconnected'));
      if (member.ready) labels.push(this.translate('lobby.badge.ready'));
      badges.textContent = labels.join(' · ');
      row.classList.toggle('disconnected', !member.connected);
      row.append(name, badges);
      return row;
    });
    this.memberList.replaceChildren(...rows);
  }

  _resolvedStatusKey(state, eligibility) {
    if (state.invalidated) return 'lobby.status.invalidated';
    if (state.migrating) return 'lobby.status.migrating';
    const currentHost = state.members.find((member) => member.playerId === state.hostId);
    if (state.hostId && currentHost && !currentHost.connected) return 'lobby.status.migrating';
    if (this.statusKey) return this.statusKey;
    if (!state.roomCode) return null;
    if (eligibility.canStart) return 'lobby.status.readyToStart';
    return `lobby.status.${eligibility.reason}`;
  }

  _persistentStatusKey(state) {
    if (!state.roomCode) return null;
    if (state.invalidated || this.statusKey === 'lobby.status.invalidated') {
      return 'lobby.status.invalidated';
    }
    const currentHost = state.members.find((member) => member.playerId === state.hostId);
    if (state.migrating
      || this.statusKey === 'lobby.status.migrating'
      || (state.hostId && currentHost && !currentHost.connected)) {
      return 'lobby.status.migrating';
    }
    if (this.statusKey === 'lobby.status.reconnecting'
      || this.statusKey === 'lobby.status.disconnected') {
      return this.statusKey;
    }
    return null;
  }

  destroy() {
    for (const [target, type, listener] of this.listeners) {
      target.removeEventListener(type, listener);
    }
    this.listeners.length = 0;
    this.chatPanel?.destroy?.();
    this.statusBanner?.remove?.();
    this.stack?.session?.close?.();
    this.stack?.signaling?.close?.();
    this.chatPanel = null;
    this.stack = null;
  }
}
