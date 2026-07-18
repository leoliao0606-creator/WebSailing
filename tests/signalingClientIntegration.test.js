import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { createSignalingServer } from '../server/signalingServer.js';
import {
  SIGNALING_SESSION_KEY,
  SignalingClient,
} from '../src/net/signalingClient.js';

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
  };
}

function waitForEvent(target, type, predicate = () => true, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      target.removeEventListener(type, onEvent);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const onEvent = (event) => {
      if (!predicate(event.detail)) return;
      clearTimeout(timeout);
      target.removeEventListener(type, onEvent);
      resolve(event.detail);
    };
    target.addEventListener(type, onEvent);
  });
}

async function createServerAndClient(t, { storage = createStorage() } = {}) {
  const server = await createSignalingServer({
    port: 0,
    host: '127.0.0.1',
    hostLossMs: 0,
    reconnectGraceMs: 500,
  });
  const rootWebSocketUrl = server.baseUrl.replace(/^http/, 'ws');
  const client = new SignalingClient({
    url: rootWebSocketUrl,
    WebSocketImpl: WebSocket,
    storage,
    random: () => 0.5,
  });
  t.after(async () => {
    client.close();
    await server.close();
  });
  return { client, server, storage };
}

test('a real server rejection of stale resume credentials leaves the client reusable', async (t) => {
  const staleCredentials = {
    playerId: 'missing-player',
    resumeToken: 'stale-token',
    roomCode: 'ABC234',
  };
  const storage = createStorage({
    [SIGNALING_SESSION_KEY]: JSON.stringify(staleCredentials),
  });
  const { client } = await createServerAndClient(t, { storage });
  const expired = waitForEvent(client, 'session-expired');

  await client.connect();
  const expiredDetail = await expired;

  assert.equal(expiredDetail.code, 'ROOM_NOT_FOUND');
  assert.equal(storage.getItem(SIGNALING_SESSION_KEY), null);
  assert.equal(client.state.playerId, null);
  assert.equal(client.state.roomCode, null);
  assert.equal(client.state.connection, 'open');

  const freshSession = waitForEvent(client, 'session');
  client.createRoom('Fresh host');
  const session = await freshSession;

  assert.equal(client.state.connection, 'open');
  assert.equal(client.state.playerId, session.playerId);
  assert.equal(client.state.roomCode, session.roomCode);
});

test('a real server close after leave is followed by an unauthenticated reconnect', async (t) => {
  const { client, storage } = await createServerAndClient(t);
  await client.connect();
  const firstSessionEvent = waitForEvent(client, 'session');
  client.createRoom('First host');
  const firstSession = await firstSessionEvent;
  const reopened = waitForEvent(client, 'open', ({ generation }) => generation > 1);

  client.leave();

  assert.equal(storage.getItem(SIGNALING_SESSION_KEY), null);
  assert.equal(client.state.playerId, null);
  await reopened;
  assert.equal(client.state.connection, 'open');
  assert.equal(client.state.playerId, null);

  const secondSessionEvent = waitForEvent(client, 'session');
  client.createRoom('Second host');
  const secondSession = await secondSessionEvent;

  assert.notEqual(secondSession.playerId, firstSession.playerId);
  assert.equal(client.state.playerId, secondSession.playerId);
});
