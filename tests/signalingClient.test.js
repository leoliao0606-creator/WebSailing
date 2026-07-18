import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SIGNALING_SESSION_KEY,
  SignalingClient,
} from '../src/net/signalingClient.js';

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;

  static OPEN = 1;

  static CLOSING = 2;

  static CLOSED = 3;

  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open');
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  receive(value) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value });
    this.dispatchEvent(event);
  }

  serverClose(code = 1006, reason = 'network lost') {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event('close');
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
      wasClean: { value: code === 1000 },
    });
    this.dispatchEvent(event);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.serverClose(code, reason);
  }
}

class AsyncCloseWebSocket extends FakeWebSocket {
  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSING
      || this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSING;
    this.pendingClose = { code, reason };
  }

  finishClose() {
    const { code = 1000, reason = '' } = this.pendingClose ?? {};
    this.serverClose(code, reason);
  }
}

class ResumeSendErrorWebSocket extends AsyncCloseWebSocket {
  send(data) {
    const message = JSON.parse(data);
    if (message.type === 'resume') throw new Error('resume send failed');
    super.send(data);
  }
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    snapshot() {
      return Object.fromEntries(values);
    },
  };
}

function createTimers(start = 1_000) {
  let now = start;
  let nextId = 1;
  const tasks = new Map();

  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    pendingDelays() {
      return [...tasks.values()].map((task) => task.at - now).sort((a, b) => a - b);
    },
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        const [id, task] = due;
        tasks.delete(id);
        now = task.at;
        task.callback();
      }
      now = target;
    },
  };
}

function roomView({
  roomCode = 'ABC234',
  hostId = 'player-a',
  hostEpoch = 1,
  guestReady = false,
  phase = 'lobby',
} = {}) {
  return {
    roomCode,
    hostId,
    hostEpoch,
    phase,
    members: [
      {
        playerId: 'player-a',
        nickname: 'Host',
        joinOrder: 1,
        connected: true,
        ready: false,
        isHost: hostId === 'player-a',
      },
      {
        playerId: 'player-b',
        nickname: 'Guest',
        joinOrder: 2,
        connected: true,
        ready: guestReady,
        isHost: hostId === 'player-b',
      },
    ],
  };
}

function serverMessage(socket, message) {
  socket.receive(JSON.stringify(message));
}

function sessionMessage(overrides = {}) {
  const room = overrides.room ?? roomView({ roomCode: overrides.roomCode });
  return {
    type: 'session',
    playerId: 'player-a',
    resumeToken: 'private-resume-token',
    roomCode: room.roomCode,
    iceServers: [{ urls: 'turn:turn.example.test' }],
    room,
    ...overrides,
  };
}

function createHarness(options = {}) {
  FakeWebSocket.instances = [];
  const storage = options.storage ?? createStorage();
  const timers = options.timers ?? createTimers();
  const client = new SignalingClient({
    url: options.url ?? 'ws://signal.example.test/signal',
    WebSocketImpl: options.WebSocketImpl ?? FakeWebSocket,
    storage,
    timers,
    random: options.random ?? (() => 0.5),
  });
  return { client, storage, timers };
}

async function openClient(client) {
  const connected = client.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  await connected;
  return socket;
}

function sentMessages(socket) {
  return socket.sent.map((message) => JSON.parse(message));
}

function within(promise, milliseconds = 50) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('connect remained pending')), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

test('explicit signaling URL is used unchanged', async () => {
  const { client } = createHarness({ url: 'wss://explicit.example.test/custom-signal' });

  const socket = await openClient(client);

  assert.equal(socket.url, 'wss://explicit.example.test/custom-signal');
});

test('explicit signaling base URLs append signal while explicit endpoint paths stay intact', async () => {
  for (const [url, expected] of [
    ['http://api.example.test/', 'ws://api.example.test/signal'],
    ['https://secure-api.example.test/', 'wss://secure-api.example.test/signal'],
    ['ws://socket.example.test/', 'ws://socket.example.test/signal'],
    ['wss://secure-socket.example.test/', 'wss://secure-socket.example.test/signal'],
    ['http://api.example.test/custom?ticket=one', 'ws://api.example.test/custom?ticket=one'],
    ['https://secure-api.example.test/custom?ticket=two', 'wss://secure-api.example.test/custom?ticket=two'],
    ['ws://socket.example.test/custom?ticket=three', 'ws://socket.example.test/custom?ticket=three'],
    ['wss://secure-socket.example.test/custom?ticket=four', 'wss://secure-socket.example.test/custom?ticket=four'],
  ]) {
    const { client } = createHarness({ url });
    const socket = await openClient(client);
    assert.equal(socket.url, expected);
    client.close();
  }
});

test('page http and https locations derive ws and wss signal URLs', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else delete globalThis.location;
  });

  for (const [href, expected] of [
    ['http://game.example.test/play', 'ws://game.example.test/signal'],
    ['https://secure.example.test/play', 'wss://secure.example.test/signal'],
  ]) {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { href },
    });
    FakeWebSocket.instances = [];
    const client = new SignalingClient({
      WebSocketImpl: FakeWebSocket,
      storage: createStorage(),
      timers: createTimers(),
      random: () => 0.5,
    });
    const socket = await openClient(client);
    assert.equal(socket.url, expected);
    client.close();
  }
});

test('connect resolves on open and exposes an immutable state snapshot', async () => {
  const { client } = createHarness();
  const states = [];
  client.addEventListener('statechange', (event) => states.push(event.detail));

  const connecting = client.connect();
  assert.equal(client.state.connection, 'connecting');
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connecting;

  const state = client.state;
  assert.equal(state.connection, 'open');
  assert.equal(state.connected, true);
  assert.equal(Object.isFrozen(state), true);
  assert.ok(states.some((item) => item.connection === 'open'));
  assert.throws(() => { state.connection = 'tampered'; }, TypeError);
});

test('room commands send the exact server protocol messages', async () => {
  const { client } = createHarness();
  const socket = await openClient(client);

  client.createRoom('船长');
  client.joinRoom('abc234', '水手');
  client.setReady(true);
  client.sendSignal('player-b', { type: 'offer', sdp: 'v=0' });

  assert.deepEqual(sentMessages(socket), [
    { type: 'create-room', nickname: '船长' },
    { type: 'join-room', roomCode: 'abc234', nickname: '水手' },
    { type: 'set-ready', ready: true },
    { type: 'signal', targetId: 'player-b', data: { type: 'offer', sdp: 'v=0' } },
  ]);
});

test('lockRoom sends once and resolves from the matching room-locked event', async () => {
  const { client } = createHarness();
  const socket = await openClient(client);
  serverMessage(socket, sessionMessage());

  const first = client.lockRoom({ timeoutMs: 1_000 });
  const duplicate = client.lockRoom({ timeoutMs: 1_000 });
  assert.equal(first, duplicate);
  assert.deepEqual(sentMessages(socket).at(-1), { type: 'lock-room' });
  assert.equal(sentMessages(socket).filter(({ type }) => type === 'lock-room').length, 1);

  serverMessage(socket, {
    type: 'room-locked',
    roomCode: 'ABC234',
    playerId: 'player-a',
    phase: 'racing',
  });

  assert.deepEqual(await first, {
    type: 'room-locked',
    roomCode: 'ABC234',
    playerId: 'player-a',
    phase: 'racing',
  });
  assert.equal(client.state.room.phase, 'racing');
});

test('lockRoom rejects on server error and injected timeout', async () => {
  const { client, timers } = createHarness();
  const socket = await openClient(client);
  serverMessage(socket, sessionMessage());

  const denied = client.lockRoom({ timeoutMs: 1_000 });
  serverMessage(socket, { type: 'error', code: 'NOT_HOST', message: 'Only host may lock' });
  await assert.rejects(denied, /NOT_HOST|Only host/i);

  const timedOut = client.lockRoom({ timeoutMs: 25 });
  timers.advance(25);
  await assert.rejects(timedOut, /timed out/i);
});

test('session messages persist private credentials without exposing the resume token in state', async () => {
  const { client, storage } = createHarness();
  const socket = await openClient(client);
  const session = sessionMessage();
  let sessionDetail;
  client.addEventListener('session', (event) => { sessionDetail = event.detail; });

  serverMessage(socket, session);

  assert.deepEqual(JSON.parse(storage.getItem(SIGNALING_SESSION_KEY)), {
    playerId: session.playerId,
    resumeToken: session.resumeToken,
    roomCode: session.roomCode,
  });
  assert.equal(client.state.playerId, session.playerId);
  assert.equal(client.state.roomCode, session.roomCode);
  assert.deepEqual(client.state.room, session.room);
  assert.equal(JSON.stringify(client.state).includes(session.resumeToken), false);
  assert.equal(Object.isFrozen(client.state.room.members[0]), true);
  assert.equal(Object.isFrozen(sessionDetail), true);
  assert.equal(Object.isFrozen(sessionDetail.iceServers[0]), true);
  assert.throws(() => { sessionDetail.roomCode = 'TAMPERED'; }, TypeError);
});

test('session messages reject malformed and oversized ICE server configurations', async () => {
  const { client, storage } = createHarness();
  const socket = await openClient(client);
  const errors = [];
  client.addEventListener('protocol-error', (event) => errors.push(event.detail));

  serverMessage(socket, sessionMessage({
    iceServers: [{ urls: 'turn:turn.example.test', injected: true }],
  }));
  serverMessage(socket, sessionMessage({
    iceServers: [{ urls: `turn:${'x'.repeat((64 * 1024) + 1)}` }],
  }));

  assert.equal(errors.length, 2);
  assert.equal(storage.getItem(SIGNALING_SESSION_KEY), null);
  assert.deepEqual(client.state.iceServers, []);
});

test('stored credentials automatically send resume whenever a replacement socket opens', async () => {
  const credentials = {
    playerId: 'player-a',
    resumeToken: 'stored-token',
    roomCode: 'ABC234',
  };
  const storage = createStorage({
    [SIGNALING_SESSION_KEY]: JSON.stringify(credentials),
  });
  const { client, timers } = createHarness({ storage });
  let socket = await openClient(client);

  assert.deepEqual(sentMessages(socket), [{ type: 'resume', ...credentials }]);

  socket.serverClose();
  assert.deepEqual(timers.pendingDelays(), [500]);
  timers.advance(500);
  socket = FakeWebSocket.instances.at(-1);
  socket.open();
  assert.deepEqual(sentMessages(socket), [{ type: 'resume', ...credentials }]);
});

test('oversized or malformed stored credentials are deleted before automatic resume', async () => {
  const invalidCredentials = [
    JSON.stringify({ playerId: 'player-a', resumeToken: 'stored-token', roomCode: 'abc234' }),
    JSON.stringify({ playerId: '界'.repeat(43), resumeToken: 'stored-token', roomCode: 'ABC234' }),
    JSON.stringify({ playerId: 'player-a', resumeToken: '界'.repeat(86), roomCode: 'ABC234' }),
    JSON.stringify({
      playerId: 'player-a',
      resumeToken: 'x'.repeat(4_096),
      roomCode: 'ABC234',
    }),
  ];

  for (const raw of invalidCredentials) {
    const storage = createStorage({ [SIGNALING_SESSION_KEY]: raw });
    const { client } = createHarness({ storage });
    const socket = await openClient(client);

    assert.deepEqual(sentMessages(socket), []);
    assert.equal(storage.getItem(SIGNALING_SESSION_KEY), null);
    client.close();
  }
});

for (const terminalCode of [
  'ROOM_NOT_FOUND',
  'PLAYER_NOT_FOUND',
  'INVALID_RESUME_TOKEN',
  'RESUME_EXPIRED',
]) {
  test(`${terminalCode} invalidates a stored resume session without closing the socket`, async () => {
    const credentials = {
      playerId: 'expired-player',
      resumeToken: 'expired-token',
      roomCode: 'ABC234',
    };
    const storage = createStorage({
      [SIGNALING_SESSION_KEY]: JSON.stringify(credentials),
    });
    const { client } = createHarness({ storage });
    const expiredEvents = [];
    const protocolErrors = [];
    client.addEventListener('session-expired', (event) => expiredEvents.push(event.detail));
    client.addEventListener('protocol-error', (event) => protocolErrors.push(event.detail));
    const socket = await openClient(client);

    assert.deepEqual(sentMessages(socket), [{ type: 'resume', ...credentials }]);

    serverMessage(socket, {
      type: 'error',
      code: terminalCode,
      message: `Resume failed with ${terminalCode}`,
    });

    assert.equal(storage.getItem(SIGNALING_SESSION_KEY), null);
    assert.equal(client.state.playerId, null);
    assert.equal(client.state.roomCode, null);
    assert.equal(client.state.room, null);
    assert.equal(client.state.connection, 'open');
    assert.equal(socket.readyState, FakeWebSocket.OPEN);
    assert.deepEqual(protocolErrors, []);
    assert.deepEqual(expiredEvents, [{
      code: terminalCode,
      message: `Resume failed with ${terminalCode}`,
    }]);
    assert.equal(Object.isFrozen(expiredEvents[0]), true);

    assert.doesNotThrow(() => client.createRoom('新船长'));
    assert.doesNotThrow(() => client.joinRoom('NEW234', '新水手'));
    assert.deepEqual(sentMessages(socket).slice(-2), [
      { type: 'create-room', nickname: '新船长' },
      { type: 'join-room', roomCode: 'NEW234', nickname: '新水手' },
    ]);
  });
}

test('non-terminal server errors preserve stored resume credentials', async () => {
  const credentials = {
    playerId: 'player-a',
    resumeToken: 'stored-token',
    roomCode: 'ABC234',
  };
  const storage = createStorage({
    [SIGNALING_SESSION_KEY]: JSON.stringify(credentials),
  });
  const { client } = createHarness({ storage });
  let expiredCount = 0;
  client.addEventListener('session-expired', () => { expiredCount += 1; });
  const socket = await openClient(client);

  serverMessage(socket, {
    type: 'error',
    code: 'ROOM_FULL',
    message: 'Room already has eight reserved seats',
  });

  assert.deepEqual(JSON.parse(storage.getItem(SIGNALING_SESSION_KEY)), credentials);
  assert.equal(client.state.playerId, credentials.playerId);
  assert.equal(client.state.roomCode, credentials.roomCode);
  assert.equal(expiredCount, 0);
  assert.equal(client.state.connection, 'open');
});

test('room views and domain events update local room state', async () => {
  const { client } = createHarness();
  const socket = await openClient(client);
  serverMessage(socket, sessionMessage());

  serverMessage(socket, {
    type: 'ready-changed',
    roomCode: 'ABC234',
    playerId: 'player-b',
    ready: true,
  });
  assert.equal(client.state.room.members[1].ready, true);

  serverMessage(socket, {
    type: 'member-left',
    roomCode: 'ABC234',
    playerId: 'player-b',
    resumeUntil: 31_000,
  });
  assert.equal(client.state.room.members[1].connected, false);

  const replacement = roomView({ hostId: 'player-b', hostEpoch: 2, guestReady: true });
  serverMessage(socket, { type: 'room-view', room: replacement });
  assert.deepEqual(client.state.room, replacement);
});

test('host changes dispatch a typed host-change CustomEvent and update host flags', async () => {
  const { client } = createHarness();
  const socket = await openClient(client);
  serverMessage(socket, sessionMessage());
  let received;
  client.addEventListener('host-change', (event) => { received = event; });

  const hostChange = {
    type: 'host-changed',
    roomCode: 'ABC234',
    previousHostId: 'player-a',
    hostId: 'player-b',
    hostEpoch: 2,
  };
  serverMessage(socket, hostChange);

  assert.ok(received instanceof CustomEvent);
  assert.deepEqual(received.detail, hostChange);
  assert.equal(client.state.room.hostId, 'player-b');
  assert.equal(client.state.room.hostEpoch, 2);
  assert.equal(client.state.room.members[1].isHost, true);
});

test('signal, server error, and pong messages dispatch typed events', async () => {
  const timers = createTimers(7_000);
  const { client } = createHarness({ timers });
  const socket = await openClient(client);
  const received = {};
  for (const type of ['signal', 'error', 'pong']) {
    client.addEventListener(type, (event) => { received[type] = event.detail; });
  }

  serverMessage(socket, {
    type: 'signal',
    sourceId: 'player-b',
    data: { type: 'answer', sdp: 'v=0' },
  });
  serverMessage(socket, { type: 'error', code: 'ROOM_FULL', message: 'Room is full' });
  serverMessage(socket, { type: 'pong' });

  assert.deepEqual(received.signal, {
    sourceId: 'player-b',
    data: { type: 'answer', sdp: 'v=0' },
  });
  assert.deepEqual(received.error, { code: 'ROOM_FULL', message: 'Room is full' });
  assert.deepEqual(received.pong, { at: 7_000 });
  assert.deepEqual(client.state.lastError, received.error);
  assert.equal(client.state.lastPongAt, 7_000);
});

test('signal relay accepts only exact bounded RTC descriptions and ICE candidates', async () => {
  const { client } = createHarness();
  const socket = await openClient(client);
  const signals = [];
  const errors = [];
  client.addEventListener('signal', (event) => signals.push(event.detail));
  client.addEventListener('protocol-error', (event) => errors.push(event.detail));

  serverMessage(socket, {
    type: 'signal',
    sourceId: 'player-b',
    data: { type: 'ice', candidate: 'candidate:ok', sdpMLineIndex: 0 },
  });
  serverMessage(socket, {
    type: 'signal',
    sourceId: 'player-b',
    data: { type: 'answer', sdp: 'v=0', negotiationId: 'epoch-2-attempt-1' },
  });
  for (const data of [
    { type: 'offer', sdp: 'v=0', injected: true },
    { type: 'ice', candidate: 'candidate:bad', sdpMLineIndex: -1 },
    { type: 'offer', sdp: 'x'.repeat((64 * 1024) + 1) },
    { type: 'ice', candidate: null, negotiationId: '界'.repeat(43) },
  ]) {
    serverMessage(socket, { type: 'signal', sourceId: 'player-b', data });
  }

  assert.equal(signals.length, 2);
  assert.deepEqual(signals[0].data, {
    type: 'ice', candidate: 'candidate:ok', sdpMLineIndex: 0,
  });
  assert.equal(signals[1].data.negotiationId, 'epoch-2-attempt-1');
  assert.equal(errors.length, 4);
});

test('events from an old socket generation cannot mutate state or schedule reconnects', async () => {
  const { client, timers } = createHarness();
  const first = await openClient(client);
  serverMessage(first, sessionMessage());
  first.serverClose();
  timers.advance(500);
  const second = FakeWebSocket.instances.at(-1);
  second.open();
  serverMessage(second, sessionMessage({ room: roomView({ hostEpoch: 2 }) }));

  first.receive(JSON.stringify({
    type: 'room-view',
    room: roomView({ roomCode: 'ZZZ999', hostEpoch: 99 }),
  }));
  first.serverClose();

  assert.equal(client.state.roomCode, 'ABC234');
  assert.equal(client.state.room.hostEpoch, 2);
  assert.deepEqual(timers.pendingDelays(), []);
});

test('reconnect failures use injected exponential delays capped at ten seconds', async () => {
  const { client, timers } = createHarness();
  let socket = await openClient(client);
  const expectedDelays = [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000];

  for (const expectedDelay of expectedDelays) {
    socket.serverClose();
    assert.deepEqual(timers.pendingDelays(), [expectedDelay]);
    assert.equal(client.state.connection, 'reconnecting');
    timers.advance(expectedDelay);
    socket = FakeWebSocket.instances.at(-1);
  }
  client.close();
});

test('a successful reconnect resets exponential backoff', async () => {
  const { client, timers } = createHarness();
  let socket = await openClient(client);

  socket.serverClose();
  timers.advance(500);
  socket = FakeWebSocket.instances.at(-1);
  socket.serverClose();
  timers.advance(1_000);
  socket = FakeWebSocket.instances.at(-1);
  socket.open();
  await Promise.resolve();

  assert.equal(client.state.reconnectAttempt, 0);
  socket.serverClose();
  assert.deepEqual(timers.pendingDelays(), [500]);
});

test('all connection lifecycle event details are deeply frozen', async () => {
  const { client } = createHarness();
  const details = new Map();
  for (const type of ['statechange', 'transport-error', 'open', 'reconnecting', 'close']) {
    client.addEventListener(type, (event) => { details.set(type, event.detail); });
  }

  const connecting = client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.dispatchEvent(new Event('error'));
  socket.open();
  await connecting;
  socket.serverClose();

  for (const type of ['statechange', 'transport-error', 'open', 'reconnecting', 'close']) {
    assert.equal(Object.isFrozen(details.get(type)), true, `${type} detail must be frozen`);
  }
});

test('connect called synchronously from close replaces the scheduled reconnect', async () => {
  const { client, timers } = createHarness();
  const first = await openClient(client);
  let replacementConnect;
  client.addEventListener('close', () => {
    replacementConnect = client.connect();
  }, { once: true });

  first.serverClose();
  const replacement = FakeWebSocket.instances.at(-1);

  assert.notEqual(replacement, first);
  assert.deepEqual(timers.pendingDelays(), []);
  replacement.open();
  await within(replacementConnect);
  timers.advance(10_000);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(client.state.connection, 'open');
});

test('connect called synchronously from reconnecting state cancels its timer', async () => {
  const { client, timers } = createHarness();
  const first = await openClient(client);
  let replacementConnect;
  client.addEventListener('statechange', (event) => {
    if (event.detail.connection === 'reconnecting' && !replacementConnect) {
      replacementConnect = client.connect();
    }
  });

  first.serverClose();
  const replacement = FakeWebSocket.instances.at(-1);

  assert.notEqual(replacement, first);
  assert.deepEqual(timers.pendingDelays(), []);
  replacement.open();
  await within(replacementConnect);
  timers.advance(10_000);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(client.state.connection, 'open');
});

test('explicit connect replaces an automatic socket that is still connecting', async () => {
  const { client, timers } = createHarness({ WebSocketImpl: AsyncCloseWebSocket });
  const first = await openClient(client);
  first.serverClose();
  timers.advance(500);
  const automatic = FakeWebSocket.instances.at(-1);

  const explicitConnect = client.connect();
  const explicit = FakeWebSocket.instances.at(-1);

  assert.notEqual(explicit, automatic);
  assert.equal(automatic.readyState, FakeWebSocket.CLOSING);
  automatic.finishClose();
  automatic.open();
  explicit.open();
  await within(explicitConnect);
  assert.equal(client.state.connection, 'open');
  assert.deepEqual(timers.pendingDelays(), []);
});

test('a failed automatic resume rejects connect and schedules exactly one retry', async () => {
  const credentials = {
    playerId: 'player-a', resumeToken: 'stored-token', roomCode: 'ABC234',
  };
  const storage = createStorage({
    [SIGNALING_SESSION_KEY]: JSON.stringify(credentials),
  });
  const { client, timers } = createHarness({
    storage,
    WebSocketImpl: ResumeSendErrorWebSocket,
  });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances[0];

  socket.open();

  await assert.rejects(within(connecting), /resume send failed/i);
  assert.equal(socket.readyState, FakeWebSocket.CLOSING);
  assert.equal(client.state.connection, 'reconnecting');
  assert.deepEqual(timers.pendingDelays(), [500]);
  socket.finishClose();
  assert.deepEqual(timers.pendingDelays(), [500]);
});

test('leave clears room credentials, keeps an open socket reusable, and later reconnects', async () => {
  const { client, storage, timers } = createHarness();
  const socket = await openClient(client);
  serverMessage(socket, sessionMessage());

  client.leave();
  assert.deepEqual(sentMessages(socket).at(-1), { type: 'leave' });
  assert.equal(storage.getItem(SIGNALING_SESSION_KEY), null);
  assert.equal(client.state.room, null);
  assert.equal(client.state.playerId, null);
  assert.equal(client.state.connection, 'open');
  assert.equal(socket.readyState, FakeWebSocket.OPEN);

  await client.connect();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.doesNotThrow(() => client.createRoom('新船长'));
  assert.doesNotThrow(() => client.joinRoom('NEW234', '新水手'));

  socket.serverClose(1000, 'left room');
  assert.deepEqual(timers.pendingDelays(), [500]);
  timers.advance(500);
  const replacement = FakeWebSocket.instances.at(-1);
  replacement.open();
  assert.deepEqual(sentMessages(replacement), []);
  assert.equal(client.state.connection, 'open');
});

test('leave during an in-flight connect clears stale credentials without aborting the connection', async () => {
  const credentials = {
    playerId: 'player-a', resumeToken: 'stored-token', roomCode: 'ABC234',
  };
  const storage = createStorage({
    [SIGNALING_SESSION_KEY]: JSON.stringify(credentials),
  });
  const { client, timers } = createHarness({ storage, WebSocketImpl: AsyncCloseWebSocket });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances[0];

  assert.equal(client.leave(), false);

  assert.equal(socket.readyState, FakeWebSocket.CONNECTING);
  assert.equal(storage.getItem(SIGNALING_SESSION_KEY), null);
  socket.open();
  await within(connecting);
  assert.deepEqual(sentMessages(socket), []);
  assert.equal(client.state.connection, 'open');

  socket.serverClose();
  assert.deepEqual(timers.pendingDelays(), [500]);
});

test('manual close closes the socket, clears credentials, and never reconnects', async () => {
  const { client, storage, timers } = createHarness();
  const socket = await openClient(client);
  serverMessage(socket, sessionMessage());

  client.close();

  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.equal(storage.getItem(SIGNALING_SESSION_KEY), null);
  assert.equal(client.state.connection, 'closed');
  assert.deepEqual(timers.pendingDelays(), []);
});

test('connect from the credential-clearing statechange opens a replacement socket generation', async () => {
  const { client } = createHarness();
  const original = await openClient(client);
  serverMessage(original, sessionMessage());
  let attempted = false;
  let replacementConnect;
  const credentialClearingStates = [];
  client.addEventListener('statechange', (event) => {
    if (event.detail.playerId !== null) return;
    credentialClearingStates.push(event.detail.connection);
    if (attempted) return;
    attempted = true;
    replacementConnect = client.connect();
  });

  client.close();

  assert.equal(attempted, true);
  assert.equal(original.readyState, FakeWebSocket.CLOSED);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(credentialClearingStates[0], 'closed');
  const replacement = FakeWebSocket.instances.at(-1);
  assert.notEqual(replacement, original);
  assert.equal(replacement.readyState, FakeWebSocket.CONNECTING);
  assert.equal(client.state.connection, 'connecting');

  replacement.open();
  await within(replacementConnect);
  assert.equal(client.state.connection, 'open');
});

test('manual close rejects an in-flight connect before an asynchronous socket close event', async () => {
  const { client, timers } = createHarness({ WebSocketImpl: AsyncCloseWebSocket });
  const connecting = client.connect();
  const socket = FakeWebSocket.instances[0];

  client.close();

  assert.equal(socket.readyState, FakeWebSocket.CLOSING);
  await assert.rejects(within(connecting), /closed/i);
  assert.equal(client.state.connection, 'closed');
  assert.deepEqual(timers.pendingDelays(), []);

  socket.finishClose();
  socket.open();
  await Promise.resolve();
  assert.equal(client.state.connection, 'closed');
  assert.deepEqual(timers.pendingDelays(), []);
});

test('malformed and unknown server messages emit protocol-error without breaking the socket', async () => {
  const { client } = createHarness();
  const socket = await openClient(client);
  const errors = [];
  let pongCount = 0;
  client.addEventListener('protocol-error', (event) => errors.push(event.detail));
  client.addEventListener('pong', () => { pongCount += 1; });

  socket.receive('{');
  serverMessage(socket, { type: 'unknown-server-message' });
  serverMessage(socket, { type: 'session', playerId: 'missing-fields' });
  serverMessage(socket, { type: 'pong' });

  assert.equal(errors.length, 3);
  assert.equal(pongCount, 1);
  assert.equal(client.state.connection, 'open');
});
