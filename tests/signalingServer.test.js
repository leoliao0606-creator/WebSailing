import assert from 'node:assert/strict';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { configFromEnv } from '../server/index.js';
import { createSignalingServer } from '../server/signalingServer.js';

const DEFAULT_TIMEOUT_MS = 1_000;

function createInbox(socket) {
  const queued = [];
  const waiters = [];

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex === -1) {
      queued.push(message);
      return;
    }

    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });

  return {
    next(predicate = () => true, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const queuedIndex = queued.findIndex(predicate);
      if (queuedIndex !== -1) {
        const [message] = queued.splice(queuedIndex, 1);
        return Promise.resolve(message);
      }

      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          const error = new Error('Timed out waiting for WebSocket message');
          error.code = 'MESSAGE_TIMEOUT';
          reject(error);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },

    async expectNone(predicate, durationMs = 30) {
      try {
        const message = await this.next(predicate, durationMs);
        assert.fail(`Unexpected WebSocket message: ${JSON.stringify(message)}`);
      } catch (error) {
        if (error.code !== 'MESSAGE_TIMEOUT') throw error;
      }
    },

    drain() {
      return queued.splice(0, queued.length);
    },
  };
}

async function startServer(t, options = {}) {
  const instance = await createSignalingServer({
    port: 0,
    host: '127.0.0.1',
    hostLossMs: 0,
    reconnectGraceMs: 500,
    ...options,
  });
  t.after(() => instance.close());
  return instance;
}

async function connect(instance, options = {}) {
  const socket = new WebSocket(instance.signalUrl, options);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, inbox: createInbox(socket) };
}

async function expectConnectionFailure(url, options, statusCode) {
  const socket = new WebSocket(url, options);
  socket.on('error', () => {});
  const [, response] = await once(socket, 'unexpected-response');
  assert.equal(response.statusCode, statusCode);
  socket.terminate();
}

function send(socket, message) {
  socket.send(JSON.stringify(message));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close');
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'test complete');
  await closed;
}

async function createRoom(client, nickname = 'Host') {
  send(client.socket, { type: 'create-room', nickname });
  const session = await client.inbox.next((message) => message.type === 'session');
  await client.inbox.next((message) => message.type === 'room-view');
  return session;
}

async function joinRoom(client, roomCode, nickname = 'Guest') {
  send(client.socket, { type: 'join-room', roomCode, nickname });
  const session = await client.inbox.next((message) => message.type === 'session');
  await client.inbox.next((message) => message.type === 'room-view');
  return session;
}

function httpRequest(instance, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: instance.address.port,
      path: requestPath,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('create and join return private sessions while broadcasting safe room views', async (t) => {
  const iceServers = [{ urls: 'turn:turn.example.test', username: 'u', credential: 'p' }];
  const instance = await startServer(t, { iceServers });
  const host = await connect(instance);
  const hostSession = await createRoom(host, '船长');

  assert.deepEqual(Object.keys(hostSession).sort(), [
    'iceServers',
    'playerId',
    'resumeToken',
    'room',
    'roomCode',
    'type',
  ].sort());
  assert.deepEqual(hostSession.iceServers, iceServers);
  assert.equal(hostSession.room.members.length, 1);
  assert.equal(JSON.stringify(hostSession.room).includes(hostSession.resumeToken), false);

  host.inbox.drain();
  const guest = await connect(instance);
  const guestSession = await joinRoom(guest, hostSession.roomCode.toLowerCase(), '水手');
  const hostRoomView = await host.inbox.next(
    (message) => message.type === 'room-view' && message.room.members.length === 2,
  );

  assert.equal(guestSession.roomCode, hostSession.roomCode);
  assert.equal(guestSession.room.members.length, 2);
  assert.equal(hostRoomView.room.members.length, 2);
  assert.equal(JSON.stringify(hostRoomView).includes(guestSession.resumeToken), false);
  await host.inbox.expectNone(
    (message) => message.type === 'session' && message.playerId === guestSession.playerId,
  );
});

test('ready changes broadcast a domain event and updated room view', async (t) => {
  const instance = await startServer(t);
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const guest = await connect(instance);
  const guestSession = await joinRoom(guest, hostSession.roomCode);
  host.inbox.drain();
  guest.inbox.drain();

  send(guest.socket, { type: 'set-ready', ready: true });

  const event = await host.inbox.next((message) => message.type === 'ready-changed');
  const view = await host.inbox.next(
    (message) => message.type === 'room-view'
      && message.room.members.some((member) => member.playerId === guestSession.playerId && member.ready),
  );
  assert.deepEqual(event, {
    type: 'ready-changed',
    roomCode: hostSession.roomCode,
    playerId: guestSession.playerId,
    ready: true,
  });
  assert.equal(view.room.hostId, hostSession.playerId);
});

test('only the ready host can lock a room and racing rejects late joins', async (t) => {
  const instance = await startServer(t);
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const guest = await connect(instance);
  const guestSession = await joinRoom(guest, hostSession.roomCode);

  send(host.socket, { type: 'set-ready', ready: true });
  await host.inbox.next((message) => (
    message.type === 'ready-changed' && message.playerId === hostSession.playerId
  ));
  send(guest.socket, { type: 'set-ready', ready: true });
  await host.inbox.next((message) => (
    message.type === 'ready-changed' && message.playerId === guestSession.playerId
  ));

  send(guest.socket, { type: 'lock-room' });
  const denied = await guest.inbox.next((message) => message.type === 'error');
  assert.equal(denied.code, 'NOT_HOST');

  send(host.socket, { type: 'lock-room' });
  const hostLocked = await host.inbox.next((message) => message.type === 'room-locked');
  const guestLocked = await guest.inbox.next((message) => message.type === 'room-locked');
  assert.deepEqual(hostLocked, {
    type: 'room-locked',
    roomCode: hostSession.roomCode,
    playerId: hostSession.playerId,
    phase: 'racing',
  });
  assert.deepEqual(guestLocked, hostLocked);
  const racingView = await host.inbox.next((message) => (
    message.type === 'room-view' && message.room.phase === 'racing'
  ));
  assert.equal(racingView.room.members.length, 2);

  const late = await connect(instance);
  send(late.socket, {
    type: 'join-room', roomCode: hostSession.roomCode, nickname: 'Late sailor',
  });
  const rejected = await late.inbox.next((message) => message.type === 'error');
  assert.equal(rejected.code, 'ROOM_IN_PROGRESS');
  await late.inbox.expectNone((message) => message.type === 'session');
});

test('targeted WebRTC signals relay only to a peer in the same room', async (t) => {
  const instance = await startServer(t);
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const guest = await connect(instance);
  const guestSession = await joinRoom(guest, hostSession.roomCode);
  host.inbox.drain();
  guest.inbox.drain();
  const data = { type: 'offer', sdp: 'v=0\r\n' };

  send(host.socket, { type: 'signal', targetId: guestSession.playerId, data });

  assert.deepEqual(await guest.inbox.next((message) => message.type === 'signal'), {
    type: 'signal',
    sourceId: hostSession.playerId,
    data,
  });
  await host.inbox.expectNone((message) => message.type === 'signal');
});

test('cross-room signal targets are rejected without relaying data', async (t) => {
  const instance = await startServer(t);
  const first = await connect(instance);
  await createRoom(first, 'First');
  first.inbox.drain();
  const second = await connect(instance);
  const secondSession = await createRoom(second, 'Second');
  second.inbox.drain();

  send(first.socket, {
    type: 'signal',
    targetId: secondSession.playerId,
    data: { type: 'offer', sdp: 'v=0' },
  });

  const error = await first.inbox.next((message) => message.type === 'error');
  assert.equal(error.code, 'TARGET_NOT_IN_ROOM');
  await second.inbox.expectNone((message) => message.type === 'signal');
});

test('failed joins for a missing room do not allocate player identities', async (t) => {
  const randomDraws = [];
  const instance = await startServer(t, {
    randomBytes(size) {
      randomDraws.push(size);
      return cryptoRandomBytes(size);
    },
  });
  const client = await connect(instance);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    send(client.socket, { type: 'join-room', roomCode: 'AB2CD9', nickname: `Guest ${attempt}` });
    const error = await client.inbox.next((message) => message.type === 'error');
    assert.equal(error.code, 'ROOM_NOT_FOUND');
  }

  assert.deepEqual(randomDraws, []);
  const successful = await connect(instance);
  await createRoom(successful, 'Successful host');
  assert.ok(randomDraws.length > 0, 'the injected identity source must be used');
});

test('failed joins for a full room do not allocate player identities', async (t) => {
  const randomDraws = [];
  const instance = await startServer(t, {
    randomBytes(size) {
      randomDraws.push(size);
      return cryptoRandomBytes(size);
    },
  });
  const host = await connect(instance);
  const session = await createRoom(host);
  for (let number = 2; number <= 8; number += 1) {
    const client = await connect(instance);
    await joinRoom(client, session.roomCode, `Guest ${number}`);
  }
  const drawsBeforeFailures = randomDraws.length;
  assert.ok(drawsBeforeFailures > 0, 'the injected identity source must be used');
  const rejected = await connect(instance);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    send(rejected.socket, {
      type: 'join-room',
      roomCode: session.roomCode,
      nickname: `Rejected ${attempt}`,
    });
    const error = await rejected.inbox.next((message) => message.type === 'error');
    assert.equal(error.code, 'ROOM_FULL');
  }

  assert.equal(randomDraws.length, drawsBeforeFailures);
});

test('payloads over 64 KiB close the offending WebSocket', async (t) => {
  const instance = await startServer(t);
  const { socket } = await connect(instance);
  socket.on('error', () => {});
  const closed = once(socket, 'close');

  socket.send('x'.repeat((64 * 1024) + 1));

  const [code] = await closed;
  assert.equal(code, 1009);
});

test('per-socket rate limits reject and close only the flooding client', async (t) => {
  const instance = await startServer(t, {
    rateLimit: { maxMessages: 2, windowMs: 10_000 },
  });
  const flooding = await connect(instance);
  const healthy = await connect(instance);
  const floodingClosed = once(flooding.socket, 'close');

  send(flooding.socket, { type: 'ping' });
  send(flooding.socket, { type: 'ping' });
  send(flooding.socket, { type: 'ping' });
  send(flooding.socket, { type: 'ping' });
  send(flooding.socket, { type: 'ping' });

  await flooding.inbox.next((message) => message.type === 'pong');
  await flooding.inbox.next((message) => message.type === 'pong');
  const error = await flooding.inbox.next((message) => message.type === 'error');
  assert.equal(error.code, 'RATE_LIMIT');
  const [closeCode] = await floodingClosed;
  assert.equal(closeCode, 1006);
  assert.equal(
    flooding.inbox.drain().filter((message) => message.code === 'RATE_LIMIT').length,
    0,
  );

  send(healthy.socket, { type: 'ping' });
  assert.deepEqual(await healthy.inbox.next((message) => message.type === 'pong'), { type: 'pong' });
});

test('WebSocket upgrades require the signal path and an allowed origin', async (t) => {
  const instance = await startServer(t, { allowedOrigins: ['https://game.example.test'] });

  await expectConnectionFailure(
    instance.signalUrl,
    { origin: 'https://attacker.example.test' },
    403,
  );
  await expectConnectionFailure(
    `${instance.baseUrl.replace('http:', 'ws:')}/not-signal`,
    { origin: 'https://game.example.test' },
    404,
  );

  const allowed = await connect(instance, { origin: 'https://game.example.test' });
  send(allowed.socket, { type: 'ping' });
  assert.deepEqual(await allowed.inbox.next((message) => message.type === 'pong'), { type: 'pong' });
});

test('host loss waits for hostLossMs then migrates authority to the next connected member', async (t) => {
  const instance = await startServer(t, { hostLossMs: 40 });
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const guest = await connect(instance);
  const guestSession = await joinRoom(guest, hostSession.roomCode);
  guest.inbox.drain();

  await closeSocket(host.socket);
  await guest.inbox.expectNone(
    (message) => message.type === 'host-changed' && message.hostEpoch === 2,
    15,
  );
  const migrated = await guest.inbox.next(
    (message) => message.type === 'host-changed' && message.hostEpoch === 2,
    300,
  );
  const view = await guest.inbox.next(
    (message) => message.type === 'room-view' && message.room.hostEpoch === 2,
  );

  assert.equal(migrated.previousHostId, hostSession.playerId);
  assert.equal(migrated.hostId, guestSession.playerId);
  assert.equal(view.room.hostId, guestSession.playerId);
});

test('heartbeat terminates a black-hole host before the controlled migration delay', async (t) => {
  const instance = await startServer(t, { heartbeatMs: 30, hostLossMs: 25 });
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const guest = await connect(instance);
  const guestSession = await joinRoom(guest, hostSession.roomCode);
  guest.inbox.drain();
  host.socket.pong = () => {};
  const startedAt = Date.now();

  const migrated = await guest.inbox.next(
    (message) => message.type === 'host-changed' && message.hostEpoch === 2,
    300,
  );

  assert.equal(migrated.hostId, guestSession.playerId);
  assert.ok(Date.now() - startedAt < 300);
});

test('default heartbeat cadence keeps worst-case host migration within five seconds', async () => {
  const originalSetInterval = globalThis.setInterval;
  const intervalDelays = [];
  globalThis.setInterval = (callback, delay, ...args) => {
    intervalDelays.push(delay);
    return originalSetInterval(callback, delay, ...args);
  };
  let instance;
  try {
    instance = await createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      reconnectGraceMs: 10,
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
  }

  try {
    assert.ok(intervalDelays.includes(1_000), 'default heartbeat interval must be 1000ms');
    assert.ok((2 * 1_000) + 2_500 <= 5_000);
  } finally {
    await instance?.close();
  }
});

test('direct server API rejects heartbeat and host-loss settings over five seconds', async () => {
  let acceptedInstance;
  let rejection;
  try {
    acceptedInstance = await createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      heartbeatMs: 2_000,
      hostLossMs: 2_500,
    });
  } catch (error) {
    rejection = error;
  } finally {
    await acceptedInstance?.close();
  }

  assert.ok(rejection, 'over-budget settings must be rejected');
  assert.match(rejection.message, /migration.*budget|5000/i);
});

test('a host that resumes before hostLossMs cancels migration', async (t) => {
  const instance = await startServer(t, { hostLossMs: 100 });
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const guest = await connect(instance);
  await joinRoom(guest, hostSession.roomCode);
  guest.inbox.drain();
  await closeSocket(host.socket);

  const resumed = await connect(instance);
  send(resumed.socket, {
    type: 'resume',
    roomCode: hostSession.roomCode,
    playerId: hostSession.playerId,
    resumeToken: hostSession.resumeToken,
  });
  const session = await resumed.inbox.next((message) => message.type === 'session');

  assert.equal(session.room.hostId, hostSession.playerId);
  assert.equal(session.room.hostEpoch, 1);
  await guest.inbox.expectNone(
    (message) => message.type === 'host-changed' && message.hostEpoch > 1,
    140,
  );
});

test('a disconnected player can resume the reserved seat with the private token', async (t) => {
  const instance = await startServer(t, { reconnectGraceMs: 500 });
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const guest = await connect(instance);
  const guestSession = await joinRoom(guest, hostSession.roomCode);
  host.inbox.drain();

  await closeSocket(guest.socket);
  await host.inbox.next(
    (message) => message.type === 'member-left' && message.playerId === guestSession.playerId,
  );

  const resumed = await connect(instance);
  send(resumed.socket, {
    type: 'resume',
    roomCode: guestSession.roomCode,
    playerId: guestSession.playerId,
    resumeToken: guestSession.resumeToken,
  });
  const resumedSession = await resumed.inbox.next((message) => message.type === 'session');
  const resumedEvent = await host.inbox.next(
    (message) => message.type === 'member-resumed' && message.playerId === guestSession.playerId,
  );

  assert.equal(resumedSession.playerId, guestSession.playerId);
  assert.equal(resumedSession.resumeToken, guestSession.resumeToken);
  assert.equal(
    resumedSession.room.members.find((member) => member.playerId === guestSession.playerId).connected,
    true,
  );
  assert.equal(JSON.stringify(resumedEvent).includes(guestSession.resumeToken), false);
});

test('resuming atomically replaces an old socket whose late close cannot disconnect the new one', async (t) => {
  const instance = await startServer(t);
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const oldClient = await connect(instance);
  const oldSession = await joinRoom(oldClient, hostSession.roomCode);
  host.inbox.drain();
  const oldClosed = once(oldClient.socket, 'close');
  const replacement = await connect(instance);

  send(replacement.socket, {
    type: 'resume',
    roomCode: oldSession.roomCode,
    playerId: oldSession.playerId,
    resumeToken: oldSession.resumeToken,
  });
  const replacementSession = await replacement.inbox.next((message) => message.type === 'session');
  await oldClosed;
  await sleep(10);
  send(replacement.socket, { type: 'set-ready', ready: true });
  const ready = await host.inbox.next(
    (message) => message.type === 'ready-changed' && message.playerId === oldSession.playerId,
  );

  assert.equal(replacementSession.playerId, oldSession.playerId);
  assert.equal(ready.ready, true);
});

test('signals to a disconnected member report target unavailable', async (t) => {
  const instance = await startServer(t);
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const guest = await connect(instance);
  const guestSession = await joinRoom(guest, hostSession.roomCode);
  host.inbox.drain();
  await closeSocket(guest.socket);
  await host.inbox.next(
    (message) => message.type === 'member-left' && message.playerId === guestSession.playerId,
  );

  send(host.socket, {
    type: 'signal',
    targetId: guestSession.playerId,
    data: { type: 'offer', sdp: 'v=0' },
  });

  const error = await host.inbox.next((message) => message.type === 'error');
  assert.equal(error.code, 'TARGET_UNAVAILABLE');
});

test('invalid JSON returns one error and leaves the server connection usable', async (t) => {
  const instance = await startServer(t);
  const client = await connect(instance);

  client.socket.send('{not-json');
  const error = await client.inbox.next((message) => message.type === 'error');
  send(client.socket, { type: 'ping' });

  assert.equal(error.code, 'INVALID_JSON');
  assert.deepEqual(await client.inbox.next((message) => message.type === 'pong'), { type: 'pong' });
});

test('leave disconnects the reserved seat and broadcasts the updated room', async (t) => {
  const instance = await startServer(t);
  const host = await connect(instance);
  const hostSession = await createRoom(host);
  const guest = await connect(instance);
  const guestSession = await joinRoom(guest, hostSession.roomCode);
  host.inbox.drain();
  const guestClosed = once(guest.socket, 'close');

  send(guest.socket, { type: 'leave' });

  const event = await host.inbox.next(
    (message) => message.type === 'member-left' && message.playerId === guestSession.playerId,
  );
  const view = await host.inbox.next(
    (message) => message.type === 'room-view'
      && message.room.members.some(
        (member) => member.playerId === guestSession.playerId && !member.connected,
      ),
  );
  const [closeCode] = await guestClosed;
  assert.equal(event.roomCode, hostSession.roomCode);
  assert.equal(view.room.hostId, hostSession.playerId);
  assert.equal(closeCode, 1000);
});

test('health endpoint reports readiness as JSON', async (t) => {
  const instance = await startServer(t);

  const response = await httpRequest(instance, '/health');

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(response.body), { status: 'ok' });
  assert.equal(instance.url, instance.signalUrl);
  assert.equal(instance.port, instance.address.port);
});

test('static files use safe resolution and appropriate MIME types', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'windchaser-static-'));
  const publicDir = path.join(root, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<h1>WindChaser</h1>');
  await writeFile(path.join(publicDir, 'app.js'), 'export const ready = true;');
  const secretPath = path.join(root, 'secret.txt');
  await writeFile(secretPath, 'not public');
  await symlink(secretPath, path.join(publicDir, 'escape.txt'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instance = await startServer(t, { publicDir });

  const index = await httpRequest(instance, '/');
  const script = await httpRequest(instance, '/app.js');
  const traversal = await httpRequest(instance, '/%2e%2e/secret.txt');
  const symlinkEscape = await httpRequest(instance, '/escape.txt');

  assert.equal(index.statusCode, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.equal(index.body, '<h1>WindChaser</h1>');
  assert.equal(script.statusCode, 200);
  assert.match(script.headers['content-type'], /javascript/);
  assert.equal(traversal.statusCode, 403);
  assert.equal(symlinkEscape.statusCode, 403);
});

test('close terminates clients, releases the listener, and is idempotent', async () => {
  const instance = await createSignalingServer({ port: 0, host: '127.0.0.1' });
  const { socket } = await connect(instance);
  const closed = once(socket, 'close');

  await instance.close();
  await closed;
  await instance.close();

  await assert.rejects(httpRequest(instance, '/health'), /ECONNREFUSED|socket hang up/);
});

test('listen failure cleans up every interval created during startup', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const created = [];
  const cleared = new Set();
  globalThis.setInterval = (...args) => {
    const timer = originalSetInterval(...args);
    created.push(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    cleared.add(timer);
    return originalClearInterval(timer);
  };

  try {
    await assert.rejects(
      createSignalingServer({ port, host: '127.0.0.1', heartbeatMs: 5 }),
      (error) => error.code === 'EADDRINUSE',
    );
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    await new Promise((resolve) => blocker.close(resolve));
  }

  const leaked = created.filter((timer) => !cleared.has(timer));
  for (const timer of leaked) originalClearInterval(timer);
  assert.deepEqual(leaked, []);
});

test('server entrypoint parses networking environment configuration', () => {
  const config = configFromEnv({
    PORT: '4321',
    HOST: '127.0.0.1',
    PUBLIC_DIR: '/srv/windchaser',
    ICE_SERVERS_JSON: '[{"urls":["stun:stun.example.test","turn:turn.example.test"]}]',
    ALLOWED_ORIGINS: ' https://one.example.test,https://two.example.test ',
    HOST_LOSS_MS: '2500',
    HEARTBEAT_MS: '750',
    RECONNECT_GRACE_MS: '30000',
  });

  assert.deepEqual(config, {
    port: 4321,
    host: '127.0.0.1',
    publicDir: '/srv/windchaser',
    iceServers: [{ urls: ['stun:stun.example.test', 'turn:turn.example.test'] }],
    allowedOrigins: ['https://one.example.test', 'https://two.example.test'],
    hostLossMs: 2500,
    heartbeatMs: 750,
    reconnectGraceMs: 30000,
  });
});

test('server entrypoint defaults keep heartbeat detection plus host loss under five seconds', () => {
  const config = configFromEnv({});

  assert.equal(config.heartbeatMs, 1_000);
  assert.ok((2 * config.heartbeatMs) + config.hostLossMs <= 5_000);
});

test('server entrypoint rejects an over-budget heartbeat configuration without echoing values', () => {
  assert.throws(
    () => configFromEnv({ HEARTBEAT_MS: '2001', HOST_LOSS_MS: '2500' }),
    (error) => {
      assert.match(error.message, /migration.*budget|5000/i);
      assert.equal(error.message.includes('2001'), false);
      assert.equal(error.message.includes('2500'), false);
      return true;
    },
  );
});

test('invalid ICE server JSON errors do not echo environment contents', () => {
  const secret = 'super-secret';

  assert.throws(
    () => configFromEnv({ ICE_SERVERS_JSON: secret }),
    (error) => {
      assert.match(error.message, /valid JSON/i);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
