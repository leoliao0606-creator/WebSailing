import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MultiplayerLobby,
  NICKNAME_STORAGE_KEY,
  buildMultiplayerStartOptions,
  lobbyEligibility,
} from '../src/game/multiplayerLobby.js';
import {
  AI_COUNT_OPTIONS,
  Menu,
  resolveSimulationEnvironment,
  simulationControlSettings,
} from '../src/game/menu.js';
import { setLang, t } from '../src/i18n.js';

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) this.values.add(name);
    this.element.className = [...this.values].join(' ');
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
    this.element.className = [...this.values].join(' ');
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    this.element.className = [...this.values].join(' ');
    return enabled;
  }

  contains(name) { return this.values.has(name); }
}

function matches(element, selector) {
  const testId = selector.match(/^\[data-testid="([^"]+)"\]$/)?.[1];
  if (testId !== undefined) return element.dataset.testid === testId;
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeElement extends EventTarget {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.id = '';
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.type = '';
    this._text = '';
    this._innerHTML = '';
    this.innerHTMLAssignments = 0;
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.innerHTMLAssignments += 1;
    this.children = [];
    this._text = '';
  }

  get innerHTML() { return this._innerHTML; }

  setAttribute(name, value) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    if (name === 'id') this.id = normalized;
    if (name === 'class') {
      this.className = normalized;
      this.classList.values = new Set(normalized.split(/\s+/).filter(Boolean));
    }
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      this.dataset[key] = normalized;
      if (name === 'data-testid') this.dataset.testid = normalized;
    }
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }

  append(...children) {
    for (const child of children) {
      if (typeof child === 'string') {
        const text = new FakeElement('span', this.ownerDocument);
        text.textContent = child;
        this.append(text);
        continue;
      }
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(child) { this.append(child); return child; }

  replaceChildren(...children) {
    this.children = [];
    this._text = '';
    this.append(...children);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (matches(child, selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (matches(child, selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }

  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  select() {}
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this);
    this.documentElement = new FakeElement('html', this);
    this.activeElement = null;
  }

  createElement(tagName) { return new FakeElement(tagName, this); }
  getElementById(id) { return this.body.querySelector(`#${id}`); }
}

class FakeStorage {
  values = new Map();

  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('multiplayer simulation environment stays pinned to the authoritative start config', () => {
  const localSettings = { windKn: 25, gustiness: 0.5 };
  const multiplayerStart = {
    config: { windPsi: -0.42, windKn: 13, gustiness: 0.28 },
  };

  assert.deepEqual(resolveSimulationEnvironment({
    mode: 'multiplayer-race',
    settings: localSettings,
    multiplayerStart,
    currentWindPsi: 1.2,
  }), {
    windPsi: -0.42,
    windKn: 13,
    gustiness: 0.28,
  });
  assert.deepEqual(resolveSimulationEnvironment({
    mode: 'race',
    settings: localSettings,
    multiplayerStart,
    currentWindPsi: 1.2,
  }), {
    windPsi: 1.2,
    windKn: 25,
    gustiness: 0.5,
  });
});

test('multiplayer human controls use one immutable assist policy instead of host settings', () => {
  const hostSettings = { autoHike: false, autoTrim: true };
  const guestSettings = { autoHike: true, autoTrim: false };

  const hostPolicy = simulationControlSettings('multiplayer-race', hostSettings);
  const guestPolicy = simulationControlSettings('multiplayer-race', guestSettings);

  assert.deepEqual(hostPolicy, { autoHike: true, autoTrim: false });
  assert.strictEqual(hostPolicy, guestPolicy);
  assert.equal(Object.isFrozen(hostPolicy), true);
  assert.strictEqual(simulationControlSettings('race', hostSettings), hostSettings);
});

test('game settings offer a zero-AI option for a pure human multiplayer race', () => {
  assert.deepEqual(AI_COUNT_OPTIONS, [0, 1, 2, 3]);
  assert.equal(Object.isFrozen(AI_COUNT_OPTIONS), true);
});

class FakeSignaling extends EventTarget {
  constructor() {
    super();
    this.calls = [];
    this.lockRoomImpl = null;
    this.state = {
      connection: 'idle', connected: false, playerId: null, roomCode: null, room: null,
    };
  }

  async connect() {
    this.calls.push(['connect']);
    this.state = { ...this.state, connection: 'open', connected: true };
    this.dispatchEvent(detailEvent('statechange', this.state));
  }

  createRoom(nickname) { this.calls.push(['createRoom', nickname]); return true; }
  joinRoom(roomCode, nickname) { this.calls.push(['joinRoom', roomCode, nickname]); return true; }
  setReady(ready) { this.calls.push(['setReady', ready]); return true; }
  lockRoom(options) {
    this.calls.push(['lockRoom', options]);
    return this.lockRoomImpl
      ? this.lockRoomImpl(options)
      : Promise.resolve({
        type: 'room-locked', roomCode: 'AB2CD9', playerId: 'host', phase: 'racing', start: options,
      });
  }

  leave() {
    this.calls.push(['leave']);
    this.state = { ...this.state, playerId: null, roomCode: null, room: null };
    this.dispatchEvent(detailEvent('statechange', this.state));
    return true;
  }

  room(room) {
    this.state = {
      ...this.state,
      playerId: this.state.playerId ?? 'host',
      roomCode: room.roomCode,
      room,
    };
    this.dispatchEvent(detailEvent('room-view', room));
    this.dispatchEvent(detailEvent('statechange', this.state));
  }
}

class FakeTransport extends EventTarget {
  close() {}
}

class FakeSession extends EventTarget {
  constructor() {
    super();
    this.leaveCalls = 0;
    this.leaveResult = true;
    this.closeCalls = 0;
    this.onLeave = null;
    this.state = {
      roomCode: null,
      playerId: null,
      hostId: null,
      hostEpoch: null,
      phase: null,
      role: 'disconnected',
      migrating: false,
      invalidated: false,
      closed: false,
      members: [],
    };
  }

  startRace() { return true; }
  sendChat() { return true; }
  leaveRoom() {
    this.leaveCalls += 1;
    if (this.leaveResult && this.onLeave) this.onLeave();
    return this.leaveResult;
  }
  close() { this.closeCalls += 1; }

  updateState(patch) {
    this.state = { ...this.state, ...patch };
    this.dispatchEvent(detailEvent('statechange', this.state));
    if (Object.hasOwn(patch, 'role')) {
      this.dispatchEvent(detailEvent('rolechange', { role: patch.role }));
    }
  }
}

function member(playerId, {
  nickname = playerId,
  connected = true,
  ready = true,
  isHost = false,
  joinOrder = 1,
} = {}) {
  return { playerId, nickname, connected, ready, isHost, joinOrder };
}

function room({
  hostId = 'host',
  hostEpoch = 1,
  guestReady = true,
  guestConnected = true,
  phase = 'lobby',
} = {}) {
  return {
    roomCode: 'AB2CD9',
    hostId,
    hostEpoch,
    phase,
    members: [
      member('host', { nickname: '船长', isHost: hostId === 'host', joinOrder: 1 }),
      member('guest', {
        nickname: '水手', ready: guestReady, connected: guestConnected,
        isHost: hostId === 'guest', joinOrder: 2,
      }),
    ],
  };
}

function sessionState(overrides = {}) {
  const currentRoom = room(overrides);
  return {
    roomCode: currentRoom.roomCode,
    playerId: overrides.playerId ?? 'host',
    hostId: currentRoom.hostId,
    hostEpoch: currentRoom.hostEpoch,
    phase: currentRoom.phase,
    role: overrides.role ?? (currentRoom.hostId === (overrides.playerId ?? 'host') ? 'host' : 'guest'),
    migrating: overrides.migrating ?? false,
    invalidated: overrides.invalidated ?? false,
    closed: false,
    members: currentRoom.members,
  };
}

function harness() {
  const documentRef = new FakeDocument();
  const root = documentRef.createElement('div');
  root.id = 'menus';
  documentRef.body.append(root);
  const storage = new FakeStorage();
  const signaling = new FakeSignaling();
  const transport = new FakeTransport();
  const session = new FakeSession();
  session.onLeave = () => signaling.leave();
  const shown = [];
  const starts = [];
  const app = {
    settings: { windKn: 14, gustiness: 0.35, countdown: 30, aiCount: 3 },
    attachMultiplayer(value) { this.attached = value; },
    startMultiplayerRace(options) { starts.push(options); return true; },
  };
  let stacks = 0;
  const lobby = new MultiplayerLobby({
    app,
    documentRef,
    storage,
    mountRoot: documentRef.body,
    showScreen: (id) => shown.push(id),
    createStack: () => {
      stacks += 1;
      return { signaling, transport, session };
    },
    random: () => 0.5,
    now: () => 1_234,
  });
  lobby.mount(root);
  return {
    app, documentRef, lobby, root, session, signaling, shown, starts, storage, transport,
    stackCount: () => stacks,
  };
}

test('lobby eligibility requires host role, two connected ready humans, and ready transport', () => {
  const ready = sessionState();
  assert.deepEqual(lobbyEligibility(ready, { transportReady: true }), {
    canStart: true,
    reason: null,
    connectedCount: 2,
  });
  assert.equal(lobbyEligibility(sessionState({ role: 'guest', playerId: 'guest' }), {
    transportReady: true,
  }).reason, 'not-host');
  assert.equal(lobbyEligibility(sessionState({ guestConnected: false }), {
    transportReady: true,
  }).reason, 'need-players');
  assert.equal(lobbyEligibility(sessionState({ guestReady: false }), {
    transportReady: true,
  }).reason, 'not-ready');
  assert.equal(lobbyEligibility(sessionState({ migrating: true }), {
    transportReady: true,
  }).reason, 'migrating');
  assert.equal(lobbyEligibility(sessionState({ invalidated: true }), {
    transportReady: true,
  }).reason, 'invalidated');
  assert.equal(lobbyEligibility(ready, { transportReady: false }).reason, 'transport');
});

test('start options are strict, use the full reserved roster, and cap AI fill at eight boats', () => {
  const state = sessionState({ guestConnected: false });
  const options = buildMultiplayerStartOptions({
    settings: { windKn: 99, gustiness: 0.35, countdown: 30, aiCount: 7 },
    sessionState: state,
    tick: 12,
    random: () => 0.5,
    now: () => 99,
  });

  assert.deepEqual(options, {
    tick: 12,
    seed: 'AB2CD9:1:12:99',
    config: {
      windPsi: -0.65,
      windKn: 40,
      gustiness: 0.35,
      countdown: 30,
      startTick: 1_812,
      roster: [
        { playerId: 'host', nickname: '船长' },
        { playerId: 'guest', nickname: '水手' },
      ],
      aiFill: 6,
    },
  });
});

test('opening multiplayer lazily creates one real stack, connects, and attaches its session', async () => {
  const { app, lobby, session, signaling, stackCount } = harness();

  await lobby.open();
  await lobby.open();

  assert.equal(stackCount(), 1);
  assert.equal(signaling.calls.filter(([name]) => name === 'connect').length, 1);
  assert.equal(app.attached, session);
});

test('create and join persist a temporary nickname and normalize a six-character code', async () => {
  const createHarness = harness();
  const {
    lobby, root, signaling, storage,
  } = createHarness;

  assert.ok(
    root.querySelector('[data-testid="multiplayer-nickname"]').maxLength >= 40,
    'native UTF-16 limit must allow twenty astral nickname characters',
  );

  assert.equal(await lobby.createRoom('  海风🌊  '), true);
  assert.equal(storage.getItem(NICKNAME_STORAGE_KEY), '海风🌊');
  assert.deepEqual(signaling.calls.at(-1), ['createRoom', '海风🌊']);

  const joinHarness = harness();
  assert.equal(await joinHarness.lobby.joinRoom('ab2cd9', ' 水手 '), true);
  assert.deepEqual(joinHarness.signaling.calls.at(-1), ['joinRoom', 'AB2CD9', '水手']);

  const invalidHarness = harness();
  assert.equal(await invalidHarness.lobby.joinRoom('bad', '水手'), false);
  assert.notDeepEqual(invalidHarness.signaling.calls.at(-1), ['joinRoom', 'BAD', '水手']);
});

test('create and join share one in-flight command and disable duplicate form submits', async () => {
  const { lobby, root, signaling } = harness();
  let resolveConnect;
  signaling.connect = () => {
    signaling.calls.push(['connect']);
    return new Promise((resolve) => { resolveConnect = resolve; });
  };

  const creating = lobby.createRoom('船长');
  const duplicateJoin = lobby.joinRoom('AB2CD9', '水手');

  assert.equal(creating, duplicateJoin);
  assert.equal(root.querySelector('[data-testid="multiplayer-create"]').disabled, true);
  assert.equal(root.querySelector('[data-testid="multiplayer-join"]').disabled, true);
  resolveConnect();
  assert.equal(await creating, true);
  assert.deepEqual(signaling.calls.filter(([name]) => (
    name === 'createRoom' || name === 'joinRoom'
  )), [['createRoom', '船长']]);
  assert.equal(root.querySelector('[data-testid="multiplayer-create"]').disabled, true);

  signaling.room(room());
  assert.equal(lobby.state.roomCode, 'AB2CD9');
});

test('successful reconnection clears stale disconnected status and host loss shows migration', async () => {
  const { lobby, root, session, signaling } = harness();
  await lobby.open();
  signaling.state.playerId = 'guest';
  signaling.room(room());
  session.updateState(sessionState({ playerId: 'guest', role: 'guest' }));

  signaling.state = { ...signaling.state, connection: 'reconnecting', connected: false };
  signaling.dispatchEvent(detailEvent('statechange', signaling.state));
  assert.match(root.querySelector('[data-testid="lobby-status"]').textContent, /重连|reconnect/i);
  assert.equal(root.querySelector('[data-testid="lobby-ready"]').disabled, true);

  signaling.state = { ...signaling.state, connection: 'open', connected: true };
  signaling.dispatchEvent(detailEvent('statechange', signaling.state));
  signaling.room(room());
  assert.doesNotMatch(root.querySelector('[data-testid="lobby-status"]').textContent, /重连|reconnect/i);

  const hostLost = room();
  hostLost.members[0].connected = false;
  hostLost.members[0].ready = false;
  signaling.room(hostLost);
  session.updateState({ members: hostLost.members });
  assert.match(root.querySelector('[data-testid="lobby-status"]').textContent, /迁移|migrat/i);
});

test('a racing room view does not reopen the lobby over an active multiplayer race', async () => {
  const {
    app, lobby, session, signaling, shown,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'guest';
  signaling.room(room({ phase: 'racing' }));
  session.updateState(sessionState({ playerId: 'guest', role: 'guest', phase: 'racing' }));

  app.mode = 'multiplayer-race';
  shown.length = 0;
  signaling.room(room({ hostId: 'guest', hostEpoch: 2, phase: 'racing' }));

  assert.deepEqual(shown, []);
});

test('an accepted session start keeps later racing room views behind the active race', async () => {
  const {
    lobby, session, signaling, shown,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'guest';
  signaling.room(room({ phase: 'racing' }));
  session.updateState(sessionState({ playerId: 'guest', role: 'guest', phase: 'racing' }));
  session.dispatchEvent(detailEvent('start-race', { tick: 0 }));

  shown.length = 0;
  signaling.room(room({ hostId: 'guest', hostEpoch: 2, phase: 'racing' }));

  assert.deepEqual(shown, []);
});

test('a racing room view still opens the lobby before the local race has started', async () => {
  const { lobby, signaling, shown } = harness();
  await lobby.open();
  shown.length = 0;

  signaling.room(room({ phase: 'racing' }));

  assert.deepEqual(shown, ['menu-online-lobby']);
});

test('initial host assignment never shows a false migration banner', async () => {
  const { documentRef, lobby, root, session, signaling, transport } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());
  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));

  const initialAssignment = {
    type: 'host-changed',
    roomCode: 'AB2CD9',
    previousHostId: null,
    hostId: 'host',
    hostEpoch: 1,
  };
  signaling.dispatchEvent(detailEvent('host-change', initialAssignment));
  signaling.dispatchEvent(detailEvent('host-changed', initialAssignment));

  assert.doesNotMatch(
    root.querySelector('[data-testid="lobby-status"]').textContent,
    /迁移|migrat/i,
  );
  assert.equal(
    documentRef.body.querySelector('[data-testid="multiplayer-status-banner"]').hidden,
    true,
  );
  assert.deepEqual([...lobby.reliablePeers], ['guest']);
});

test('ready toggles through signaling and host starts only after the reliable peer opens', async () => {
  const { app, lobby, session, signaling, starts, transport } = harness();
  await lobby.open();
  const currentRoom = room({ guestReady: true });
  signaling.state.playerId = 'host';
  signaling.room(currentRoom);
  session.updateState(sessionState());

  assert.equal(lobby.toggleReady(), true);
  assert.deepEqual(signaling.calls.at(-1), ['setReady', false]);
  assert.equal(await lobby.startRace(), false);
  assert.equal(starts.length, 0);

  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));
  signaling.room(room({ guestReady: true }));
  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  assert.equal(await lobby.startRace(), true);
  assert.equal(starts.length, 1);
  assert.equal(signaling.calls.filter(([name]) => name === 'lockRoom').length, 1);
  assert.deepEqual(
    signaling.calls.find(([name]) => name === 'lockRoom'),
    ['lockRoom', starts[0]],
  );
  assert.deepEqual(starts[0].config.roster, [
    { playerId: 'host', nickname: '船长' },
    { playerId: 'guest', nickname: '水手' },
  ]);
  assert.equal(starts[0].config.aiFill, 3);
  assert.equal(app.attached, session);

  signaling.state = { ...signaling.state, connection: 'reconnecting', connected: false };
  signaling.dispatchEvent(detailEvent('statechange', signaling.state));
  assert.equal(await lobby.startRace(), false);
  assert.equal(starts.length, 1);
});

test('a successful lock starts from the authoritative descriptor in its acknowledgement', async () => {
  const {
    lobby, session, signaling, starts, transport,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());
  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));
  let authoritativeStart;
  signaling.lockRoomImpl = (requestedStart) => {
    authoritativeStart = { ...requestedStart, seed: 'server-authoritative-start' };
    return Promise.resolve({
      type: 'room-locked',
      roomCode: 'AB2CD9',
      playerId: 'host',
      phase: 'racing',
      start: authoritativeStart,
    });
  };

  assert.equal(await lobby.startRace(), true);
  assert.deepEqual(starts, [authoritativeStart]);
});

test('start lock is single-flight and a rejected lock restores the host controls', async () => {
  const { lobby, root, session, signaling, starts, transport } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());
  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));
  let rejectLock;
  signaling.lockRoomImpl = () => new Promise((_, reject) => { rejectLock = reject; });

  const first = lobby.startRace();
  const duplicate = lobby.startRace();
  assert.equal(first, duplicate);
  assert.equal(root.querySelector('[data-testid="lobby-start"]').disabled, true);
  assert.equal(root.querySelector('[data-testid="lobby-ready"]').disabled, true);
  assert.equal(signaling.calls.filter(([name]) => name === 'lockRoom').length, 1);
  rejectLock(new Error('PLAYERS_NOT_READY'));

  assert.equal(await first, false);
  assert.equal(starts.length, 0);
  assert.equal(root.querySelector('[data-testid="lobby-start"]').disabled, false);
  assert.match(root.querySelector('[data-testid="lobby-status"]').textContent, /锁定|lock|准备/i);
});

test('a definitive start-roster mismatch discards stale lock options for a fresh retry', async () => {
  const {
    lobby, session, signaling, transport,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());
  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));
  const mismatch = Object.assign(new Error('Start roster changed'), {
    code: 'START_ROSTER_MISMATCH',
  });
  signaling.lockRoomImpl = () => Promise.reject(mismatch);

  assert.equal(await lobby.startRace(), false);
  assert.equal(lobby.pendingLockedStart, null);
  assert.equal(lobby.startButton.disabled, false);
});

test('an ambiguous lock failure can be retried while the room still reports lobby phase', async () => {
  const {
    lobby, session, signaling, starts, transport,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());
  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));
  let attempt = 0;
  signaling.lockRoomImpl = (requestedStart) => {
    attempt += 1;
    if (attempt === 1) return Promise.reject(new Error('Room lock timed out'));
    signaling.room({ ...room({ phase: 'racing' }), start: requestedStart });
    session.updateState({ ...sessionState({ phase: 'racing' }), start: requestedStart });
    return Promise.resolve({
      type: 'room-locked', roomCode: 'AB2CD9', playerId: 'host', phase: 'racing',
      start: requestedStart,
    });
  };

  assert.equal(await lobby.startRace(), false);
  assert.ok(lobby.pendingLockedStart);
  assert.equal(lobby.startButton.disabled, false);

  assert.equal(await lobby.startRace(), true);
  assert.equal(attempt, 2);
  assert.equal(starts.length, 1);
});

test('a late racing room view recovers from its authoritative start instead of cached options', async () => {
  const {
    lobby, session, signaling, starts, transport,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());
  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));
  signaling.lockRoomImpl = () => Promise.reject(new Error('Room lock timed out'));

  assert.equal(await lobby.startRace(), false);
  assert.equal(starts.length, 0);
  assert.ok(lobby.pendingLockedStart);

  const requestedStart = signaling.calls.find(([name]) => name === 'lockRoom')[1];
  const authoritativeStart = { ...requestedStart, seed: 'server-recovered-start' };
  const racingState = { ...sessionState({ phase: 'racing' }), start: authoritativeStart };
  session.updateState(racingState);
  signaling.room({ ...room({ phase: 'racing' }), start: authoritativeStart });
  await Promise.resolve();

  assert.deepEqual(starts, [authoritativeStart]);
  assert.equal(lobby.pendingLockedStart, null);
  assert.equal(signaling.calls.filter(([name]) => name === 'lockRoom').length, 1);
});

test('a locked room retries the same start after reliable topology reopens without relocking', async () => {
  const {
    app, lobby, session, signaling, shown, starts, transport,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());
  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));
  signaling.lockRoomImpl = (requestedStart) => {
    signaling.room({ ...room({ phase: 'racing' }), start: requestedStart });
    session.updateState({ ...sessionState({ phase: 'racing' }), start: requestedStart });
    return Promise.resolve({
      type: 'room-locked', roomCode: 'AB2CD9', playerId: 'host', phase: 'racing',
      start: requestedStart,
    });
  };
  let attempt = 0;
  app.startMultiplayerRace = (options) => {
    starts.push(options);
    attempt += 1;
    if (attempt === 1) return false;
    if (attempt === 2) throw new Error('reliable channel closed after preflight');
    return true;
  };

  const first = lobby.startRace();
  const duplicate = lobby.startRace();
  assert.equal(first, duplicate);
  assert.equal(await first, false);
  assert.equal(starts.length, 1);
  assert.equal(lobby.state.phase, 'racing');
  assert.ok(lobby.pendingLockedStart);
  assert.equal(lobby._transportReady(lobby.state), true);
  assert.equal(signaling.calls.filter(([name]) => name === 'lockRoom').length, 1);

  for (let reopen = 0; reopen < 2; reopen += 1) {
    transport.dispatchEvent(detailEvent('peer-close', {
      playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
    }));
    transport.dispatchEvent(detailEvent('peer-open', {
      playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
    }));
  }

  assert.equal(starts.length, 3);
  assert.deepEqual(starts[1], starts[0]);
  assert.deepEqual(starts[2], starts[0]);
  assert.equal(signaling.calls.filter(([name]) => name === 'lockRoom').length, 1);

  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));
  assert.equal(starts.length, 3, 'successful recovery must stop retrying');

  shown.length = 0;
  signaling.room({ ...room({ phase: 'racing' }), start: starts[0] });
  assert.deepEqual(shown, []);
});

test('locked start recovery is bounded when every retry fails', async () => {
  const {
    app, lobby, session, signaling, starts, transport,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());
  transport.dispatchEvent(detailEvent('topology', {
    roomCode: 'AB2CD9', hostId: 'host', hostEpoch: 1, selfId: 'host', isHost: true,
    peerIds: ['guest'],
  }));
  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
  }));
  signaling.lockRoomImpl = (requestedStart) => {
    signaling.room({ ...room({ phase: 'racing' }), start: requestedStart });
    session.updateState({ ...sessionState({ phase: 'racing' }), start: requestedStart });
    return Promise.resolve({
      type: 'room-locked', roomCode: 'AB2CD9', playerId: 'host', phase: 'racing',
      start: requestedStart,
    });
  };
  let recovered = false;
  app.startMultiplayerRace = (options) => { starts.push(options); return recovered; };

  assert.equal(await lobby.startRace(), false);
  for (let reopen = 0; reopen < 5; reopen += 1) {
    transport.dispatchEvent(detailEvent('peer-close', {
      playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
    }));
    transport.dispatchEvent(detailEvent('peer-open', {
      playerId: 'guest', channel: 'control', reliable: true, hostEpoch: 1,
    }));
  }

  assert.equal(starts.length, 3);
  assert.equal(signaling.calls.filter(([name]) => name === 'lockRoom').length, 1);

  recovered = true;
  const retry = lobby.startRace();
  const duplicateRetry = lobby.startRace();
  assert.equal(retry, duplicateRetry);
  assert.equal(await retry, true);
  assert.equal(starts.length, 4);
  assert.equal(signaling.calls.filter(([name]) => name === 'lockRoom').length, 1);
});

test('host migration and menu rebuild preserve the live room instead of stale DOM state', async () => {
  const { documentRef, lobby, root, session, signaling, transport } = harness();
  await lobby.open();
  signaling.state.playerId = 'guest';
  signaling.room(room());
  session.updateState(sessionState({ playerId: 'guest', role: 'guest' }));

  const replacement = documentRef.createElement('div');
  root.remove();
  documentRef.body.append(replacement);
  lobby.mount(replacement);
  assert.equal(
    replacement.querySelector('[data-testid="lobby-room-code"]').textContent,
    'AB2CD9',
  );

  const migratedRoom = room({ hostId: 'guest', hostEpoch: 2 });
  signaling.room(migratedRoom);
  session.updateState(sessionState({
    hostId: 'guest', hostEpoch: 2, playerId: 'guest', role: 'host', migrating: true,
  }));
  assert.equal(replacement.querySelector('[data-testid="lobby-start"]').disabled, true);
  assert.match(replacement.querySelector('[data-testid="lobby-status"]').textContent, /迁移|migrat/i);

  transport.dispatchEvent(detailEvent('peer-open', {
    playerId: 'host', channel: 'control', reliable: true, hostEpoch: 2,
  }));
  session.updateState({ migrating: false });
  assert.equal(replacement.querySelector('[data-testid="lobby-start"]').disabled, false);

  session.dispatchEvent(detailEvent('host-ready', { hostEpoch: 2, tick: 0 }));
  assert.equal(
    documentRef.body.querySelector('[data-testid="multiplayer-status-banner"]').hidden,
    true,
  );
});

test('migration and integrity failures remain visible in a persistent race-safe banner', async () => {
  const { documentRef, lobby, session, signaling } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState({ migrating: true }));

  const banner = documentRef.body.querySelector('[data-testid="multiplayer-status-banner"]');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /迁移|migrat/i);

  session.updateState({ migrating: false, invalidated: true });
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /作废|完整性|integrity|invalid/i);
});

test('a late-resumed former host clears the stale migration banner on its first checkpoint', async () => {
  const {
    documentRef, lobby, session, signaling,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room({ phase: 'racing' }));
  session.updateState(sessionState({ phase: 'racing' }));

  const migrated = room({ hostId: 'guest', hostEpoch: 2, phase: 'racing' });
  signaling.room(migrated);
  session.updateState(sessionState({
    hostId: 'guest', hostEpoch: 2, phase: 'racing', playerId: 'host', role: 'guest',
    migrating: false,
  }));
  const banner = documentRef.body.querySelector('[data-testid="multiplayer-status-banner"]');
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /迁移|migrat/i);

  session.dispatchEvent(detailEvent('checkpoint', {
    checkpoint: { tick: 600, hostEpoch: 2 },
  }));

  assert.equal(banner.hidden, true);
  assert.doesNotMatch(
    lobby.lobbyStatus.textContent,
    /迁移|migrat/i,
  );
});

test('menu rebuild asks the persistent chat panel to refresh its language', async () => {
  const { documentRef, lobby } = harness();
  await lobby.open();
  let refreshes = 0;
  lobby.chatPanel.refreshLanguage = () => { refreshes += 1; };

  lobby.mount(documentRef.createElement('div'));

  assert.equal(refreshes, 1);
});

test('leave releases the room through MultiplayerSession and keeps a reusable stack', async () => {
  const { lobby, session, signaling, shown, stackCount } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());

  assert.equal(lobby.leave(), true);
  assert.equal(session.leaveCalls, 1);
  assert.deepEqual(signaling.calls.at(-1), ['leave']);
  assert.equal(stackCount(), 1);
  assert.equal(shown.at(-1), 'menu-online');
});

test('lobby leave closes the session when signaling cannot send leave', async () => {
  const {
    app, lobby, session, signaling,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());
  session.leaveResult = false;

  assert.equal(lobby.leave(), false);
  assert.equal(session.leaveCalls, 1);
  assert.equal(session.closeCalls, 1);
  assert.equal(lobby.stack, null);

  const replacementSignaling = new FakeSignaling();
  const replacementTransport = new FakeTransport();
  const replacementSession = new FakeSession();
  replacementSession.onLeave = () => replacementSignaling.leave();
  lobby.createStack = () => ({
    signaling: replacementSignaling,
    transport: replacementTransport,
    session: replacementSession,
  });

  assert.equal(await lobby.open(), true);
  assert.equal(lobby.stack.session, replacementSession);
  assert.equal(app.attached, replacementSession);
  assert.equal(
    replacementSignaling.calls.filter(([name]) => name === 'connect').length,
    1,
  );
});

test('a dropped create request re-enables the form so the player can retry', async () => {
  const { lobby, root, signaling } = harness();
  await lobby.open();

  assert.equal(await lobby.createRoom('船长'), true);
  assert.equal(root.querySelector('[data-testid="multiplayer-create"]').disabled, true);

  signaling.state = { ...signaling.state, connection: 'reconnecting', connected: false };
  signaling.dispatchEvent(detailEvent('statechange', signaling.state));

  assert.equal(root.querySelector('[data-testid="multiplayer-create"]').disabled, false);
  assert.equal(root.querySelector('[data-testid="multiplayer-join"]').disabled, false);

  signaling.state = { ...signaling.state, connection: 'open', connected: true };
  signaling.dispatchEvent(detailEvent('statechange', signaling.state));
  assert.equal(await lobby.createRoom('船长'), true);
  assert.equal(
    signaling.calls.filter(([name]) => name === 'createRoom').length,
    2,
  );
});

test('copying without a Clipboard API reports the existing manual-copy fallback', async () => {
  const {
    lobby, root, session, signaling,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());

  assert.equal(await lobby.copyRoomCode(), false);
  assert.match(
    root.querySelector('[data-testid="lobby-status"]').textContent,
    /复制失败|copy failed|手动|manual/i,
  );
});

test('the lobby exposes real list semantics for its member roster', async () => {
  const {
    lobby, root, session, signaling,
  } = harness();
  await lobby.open();
  signaling.state.playerId = 'host';
  signaling.room(room());
  session.updateState(sessionState());

  const list = root.querySelector('[data-testid="lobby-members"]');
  assert.equal(list.getAttribute('role'), 'list');
  const rows = root.querySelectorAll('.lobby-member');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.getAttribute('role') === 'listitem'));
});

test('main menu exposes a stable multiplayer test id and complete labels in all three languages', () => {
  const previousDocument = globalThis.document;
  const documentRef = new FakeDocument();
  globalThis.document = documentRef;
  try {
    for (const [language, label] of [
      ['zh', '多人联机'],
      ['en', 'Multiplayer'],
      ['ja', 'マルチプレイ'],
    ]) {
      setLang(language);
      const root = documentRef.createElement('div');
      const menu = Object.create(Menu.prototype);
      menu.root = root;
      menu.app = { audio: { start() {} } };
      menu._buildMain();
      assert.match(root.children[0].innerHTML, /data-testid="multiplayer-button"/);
      assert.match(root.children[0].innerHTML, new RegExp(`>${label}<`));
      for (const key of [
        'online.title',
        'lobby.title',
        'lobby.status.locking',
        'lobby.status.lockFailed',
        'lobby.status.inProgress',
        'lobby.status.lockedWaiting',
        'lobby.status.startFailed',
        'lobby.status.migrating',
        'chat.title',
      ]) {
        assert.notEqual(t(key), key, `${language} is missing ${key}`);
      }
    }
  } finally {
    setLang('zh');
    globalThis.document = previousDocument;
  }
});

test('race results render an unrestricted hostile nickname as inert text', () => {
  const previousDocument = globalThis.document;
  const documentRef = new FakeDocument();
  globalThis.document = documentRef;
  try {
    const resultsBody = documentRef.createElement('div');
    resultsBody.id = 'results-body';
    documentRef.body.append(resultsBody);
    const menu = Object.create(Menu.prototype);
    menu.show = () => {};
    const hostile = '<svg/onload=alert()>';

    menu.showResults([{ isPlayer: false, name: hostile, time: null }], false);

    assert.equal(resultsBody.innerHTMLAssignments, 0);
    const cells = resultsBody.querySelectorAll('td');
    assert.equal(cells.length, 3);
    assert.equal(cells[1].textContent, hostile);
    assert.equal(cells[1].children.length, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('multiplayer results hide the unsupported restart action while offline results keep it', () => {
  const previousDocument = globalThis.document;
  const documentRef = new FakeDocument();
  globalThis.document = documentRef;
  try {
    const resultsBody = documentRef.createElement('div');
    resultsBody.id = 'results-body';
    const again = documentRef.createElement('button');
    again.id = 'results-again';
    documentRef.body.append(resultsBody, again);
    const menu = Object.create(Menu.prototype);
    menu.show = () => {};

    menu.showResults([], false, { allowRestart: false });
    assert.equal(again.hidden, true);

    menu.showResults([], false, { allowRestart: true });
    assert.equal(again.hidden, false);
  } finally {
    globalThis.document = previousDocument;
  }
});
