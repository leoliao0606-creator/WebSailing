import { realpath, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';

import { WebSocket, WebSocketServer } from 'ws';

import { MAX_PLAYERS, validateSignalMessage } from '../src/net/protocol.js';
import { RoomRegistry, RoomRegistryError } from './roomRegistry.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_RATE_LIMIT = Object.freeze({
  maxMessages: 120,
  maxBytes: 256 * 1024,
  windowMs: 1_000,
});
const DEFAULT_MAX_CONNECTIONS = 1_024;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 64;
const DEFAULT_MAX_ROOMS = 512;
export const MAX_HOST_MIGRATION_MS = 5_000;
export const MIGRATION_READY_RESERVE_MS = 500;
export const MAX_HOST_DETECTION_MS = MAX_HOST_MIGRATION_MS - MIGRATION_READY_RESERVE_MS;

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
]);

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative));
}

function sendHttp(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  const bytes = Buffer.from(body);
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': bytes.length,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(bytes);
}

function rejectUpgrade(socket, statusCode, reason) {
  const body = `${statusCode} ${reason}\n`;
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
      + body,
  );
  socket.destroy();
}

function normalizeRateLimit(value) {
  const rateLimit = value ?? DEFAULT_RATE_LIMIT;
  if (!Number.isSafeInteger(rateLimit.maxMessages) || rateLimit.maxMessages < 1) {
    throw new TypeError('rateLimit.maxMessages must be a positive safe integer');
  }
  if (!Number.isFinite(rateLimit.windowMs) || rateLimit.windowMs <= 0) {
    throw new TypeError('rateLimit.windowMs must be a positive finite number');
  }
  const maxBytes = rateLimit.maxBytes ?? DEFAULT_RATE_LIMIT.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('rateLimit.maxBytes must be a positive safe integer');
  }
  return Object.freeze({
    maxMessages: rateLimit.maxMessages,
    maxBytes,
    windowMs: rateLimit.windowMs,
  });
}

function positiveCapacity(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function normalizeAllowedOrigins(value) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((origin) => typeof origin !== 'string' || !origin)) {
    throw new TypeError('allowedOrigins must be an array of non-empty strings');
  }
  return new Set(value);
}

function normalizeIceServers(value) {
  if (!Array.isArray(value)) throw new TypeError('iceServers must be an array');
  return Object.freeze(value.map((server) => {
    if (server === null || typeof server !== 'object' || Array.isArray(server)) {
      throw new TypeError('each ICE server must be an object');
    }
    const urls = typeof server.urls === 'string'
      ? server.urls
      : Array.isArray(server.urls) && server.urls.every((url) => typeof url === 'string')
        ? Object.freeze([...server.urls])
        : null;
    if (urls === null) throw new TypeError('each ICE server needs string urls');

    const normalized = { urls };
    for (const field of ['username', 'credential', 'credentialType']) {
      if (!Object.hasOwn(server, field)) continue;
      if (typeof server[field] !== 'string') {
        throw new TypeError(`ICE server ${field} must be a string`);
      }
      normalized[field] = server[field];
    }
    return Object.freeze(normalized);
  }));
}

function forwardedIp(value) {
  if (isIP(value)) return value;

  const bracketed = /^\[([^\]]+)]:(\d{1,5})$/.exec(value);
  if (bracketed && isIP(bracketed[1]) === 6) {
    const port = Number(bracketed[2]);
    if (port >= 1 && port <= 65_535) return bracketed[1];
  }

  const ipv4WithPort = /^([^:[\]]+):(\d{1,5})$/.exec(value);
  if (ipv4WithPort && isIP(ipv4WithPort[1]) === 4) {
    const port = Number(ipv4WithPort[2]);
    if (port >= 1 && port <= 65_535) return ipv4WithPort[1];
  }
  return null;
}

function clientAddress(request, trustProxy) {
  const directAddress = request.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return directAddress;

  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return directAddress;
  const candidate = forwarded.split(',', 1)[0].trim();
  return forwardedIp(candidate) ?? directAddress;
}

export async function createSignalingServer({
  port = 8787,
  host = '127.0.0.1',
  publicDir,
  reconnectGraceMs = 30_000,
  hostLossMs = 2_500,
  iceServers = [],
  allowedOrigins,
  rateLimit,
  heartbeatMs = 1_000,
  maxBufferedAmount = 1024 * 1024,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  maxConnectionsPerIp = DEFAULT_MAX_CONNECTIONS_PER_IP,
  maxRooms = DEFAULT_MAX_ROOMS,
  addressRateMultiplier = MAX_PLAYERS,
  trustProxy = false,
  randomBytes,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('port must be an integer from 0 through 65535');
  }
  if (typeof host !== 'string' || host.length === 0) {
    throw new TypeError('host must be a non-empty string');
  }
  if (!Number.isFinite(hostLossMs) || hostLossMs < 0) {
    throw new TypeError('hostLossMs must be a non-negative finite number');
  }
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    throw new TypeError('heartbeatMs must be a positive finite number');
  }
  if (!Number.isFinite(maxBufferedAmount) || maxBufferedAmount < 0) {
    throw new TypeError('maxBufferedAmount must be a non-negative finite number');
  }
  if ((2 * heartbeatMs) + hostLossMs > MAX_HOST_DETECTION_MS) {
    throw new TypeError(`heartbeat and host-loss migration budget cannot exceed ${MAX_HOST_DETECTION_MS}ms`);
  }
  positiveCapacity(maxConnections, 'maxConnections');
  positiveCapacity(maxConnectionsPerIp, 'maxConnectionsPerIp');
  positiveCapacity(maxRooms, 'maxRooms');
  positiveCapacity(addressRateMultiplier, 'addressRateMultiplier');
  if (typeof trustProxy !== 'boolean') {
    throw new TypeError('trustProxy must be a Boolean');
  }

  const origins = normalizeAllowedOrigins(allowedOrigins);
  const clientIceServers = normalizeIceServers(iceServers);
  const messageRateLimit = normalizeRateLimit(rateLimit);
  const addressRateLimit = Object.freeze({
    maxMessages: messageRateLimit.maxMessages * addressRateMultiplier,
    maxBytes: messageRateLimit.maxBytes * addressRateMultiplier,
    windowMs: messageRateLimit.windowMs,
  });
  if (!Number.isSafeInteger(addressRateLimit.maxMessages)
    || !Number.isSafeInteger(addressRateLimit.maxBytes)) {
    throw new TypeError('addressRateMultiplier produces an unsafe rate limit');
  }
  const registryOptions = { reconnectGraceMs };
  if (randomBytes !== undefined) registryOptions.randomBytes = randomBytes;
  const registry = new RoomRegistry(registryOptions);
  const publicRoot = publicDir === undefined ? null : path.resolve(publicDir);
  const realPublicRoot = publicRoot === null
    ? null
    : await realpath(publicRoot).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });

  let shuttingDown = false;
  let closePromise = null;
  let cleanupTimer = null;
  let heartbeatTimer = null;
  let nextBindingGeneration = 1;
  const socketSessions = new Map();
  const playerBindings = new Map();
  const socketRates = new WeakMap();
  const ingressRates = new Map();
  const socketHealth = new WeakMap();
  const socketAddresses = new WeakMap();
  const addressConnections = new Map();
  const pendingHostLosses = new Map();

  async function serveStatic(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendHttp(response, 405, 'Method Not Allowed\n');
      return;
    }
    if (realPublicRoot === null) {
      sendHttp(response, 404, 'Not Found\n');
      return;
    }

    const rawPath = (request.url ?? '/').split('?', 1)[0];
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(rawPath).replaceAll('\\', '/');
    } catch {
      sendHttp(response, 400, 'Bad Request\n');
      return;
    }
    if (decodedPath.includes('\0') || decodedPath.split('/').includes('..')) {
      sendHttp(response, 403, 'Forbidden\n');
      return;
    }

    const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
    let candidate = path.resolve(realPublicRoot, relativePath);
    if (!isInside(realPublicRoot, candidate)) {
      sendHttp(response, 403, 'Forbidden\n');
      return;
    }

    let fileStats;
    try {
      fileStats = await stat(candidate);
      if (fileStats.isDirectory()) {
        candidate = path.join(candidate, 'index.html');
        fileStats = await stat(candidate);
      }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        sendHttp(response, 404, 'Not Found\n');
        return;
      }
      throw error;
    }
    if (!fileStats.isFile()) {
      sendHttp(response, 404, 'Not Found\n');
      return;
    }

    const realCandidate = await realpath(candidate);
    if (!isInside(realPublicRoot, realCandidate)) {
      sendHttp(response, 403, 'Forbidden\n');
      return;
    }

    const body = await readFile(realCandidate);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES.get(path.extname(realCandidate).toLowerCase())
        ?? 'application/octet-stream',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  }

  const httpServer = http.createServer((request, response) => {
    if (request.url?.split('?', 1)[0] === '/health') {
      sendHttp(response, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
      return;
    }
    void serveStatic(request, response).catch(() => {
      if (!response.headersSent) sendHttp(response, 500, 'Internal Server Error\n');
      else response.destroy();
    });
  });

  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  function sendJson(socket, message, onFlushed) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > maxBufferedAmount) {
      socket.terminate();
      return false;
    }
    try {
      socket.send(JSON.stringify(message), (error) => {
        if (error) socket.terminate();
        onFlushed?.(error);
      });
    } catch {
      socket.terminate();
      return false;
    }
    return true;
  }

  function sendError(socket, code, message) {
    sendJson(socket, { type: 'error', code, message });
  }

  function broadcastRoom(roomCode, message) {
    const room = registry.roomView(roomCode);
    if (!room) return;
    for (const member of room.members) {
      const binding = playerBindings.get(member.playerId);
      if (binding) sendJson(binding.socket, message);
    }
  }

  function publishResult(result) {
    const roomCodes = new Set();
    for (const event of result.events ?? []) {
      if (!event.roomCode) continue;
      roomCodes.add(event.roomCode);
      broadcastRoom(event.roomCode, event);
    }
    if (result.room?.roomCode) roomCodes.add(result.room.roomCode);
    for (const roomCode of roomCodes) {
      const room = registry.roomView(roomCode);
      if (room) broadcastRoom(roomCode, { type: 'room-view', room });
    }
  }

  function bindSocket(socket, playerId, roomCode) {
    const previous = playerBindings.get(playerId);
    const generation = nextBindingGeneration;
    nextBindingGeneration += 1;
    const binding = { socket, generation };
    socketSessions.set(socket, { playerId, roomCode, generation });
    playerBindings.set(playerId, binding);
    if (previous && previous.socket !== socket) previous.socket.terminate();
    return binding;
  }

  function unbindSocket(socket) {
    const session = socketSessions.get(socket);
    if (!session) return null;
    socketSessions.delete(socket);
    const current = playerBindings.get(session.playerId);
    const isCurrent = current?.socket === socket && current.generation === session.generation;
    if (isCurrent) playerBindings.delete(session.playerId);
    return { ...session, isCurrent };
  }

  function clearPendingHostLoss(playerId) {
    const pending = pendingHostLosses.get(playerId);
    if (!pending) return;
    clearTimeout(pending);
    pendingHostLosses.delete(playerId);
  }

  function disconnectPlayer(playerId) {
    clearPendingHostLoss(playerId);
    publishResult(registry.disconnect(playerId));
  }

  function sendSession(socket, playerId, resumeToken, room) {
    sendJson(socket, {
      type: 'session',
      playerId,
      resumeToken,
      roomCode: room.roomCode,
      iceServers: clientIceServers,
      room,
    });
  }

  function requireUnauthenticated(socket) {
    if (!socketSessions.has(socket)) return true;
    sendError(socket, 'ALREADY_AUTHENTICATED', 'This connection already has a room session');
    return false;
  }

  function requireSession(socket) {
    const session = socketSessions.get(socket);
    if (!session) {
      sendError(socket, 'NOT_AUTHENTICATED', 'Create, join, or resume a room first');
      return null;
    }
    const current = playerBindings.get(session.playerId);
    if (current?.socket !== socket || current.generation !== session.generation) {
      sendError(socket, 'STALE_CONNECTION', 'This player session was replaced');
      socket.terminate();
      return null;
    }
    const room = registry.roomView(session.roomCode);
    const member = room?.members.find((item) => item.playerId === session.playerId);
    if (!member?.connected) {
      sendError(socket, 'PLAYER_DISCONNECTED', 'This player no longer has a connected seat');
      socket.terminate();
      return null;
    }
    return session;
  }

  function handleCommand(socket, message) {
    if (message.type === 'ping') {
      sendJson(socket, { type: 'pong' });
      return;
    }

    if (message.type === 'create-room') {
      if (!requireUnauthenticated(socket)) return;
      if (registry.roomCount >= maxRooms) {
        throw new RoomRegistryError('SERVER_CAPACITY', 'The signaling server is at room capacity');
      }
      const player = registry.createPlayer(message.nickname);
      const result = registry.createRoom(player);
      bindSocket(socket, player.playerId, result.roomCode);
      sendSession(socket, player.playerId, player.resumeToken, result.room);
      publishResult(result);
      return;
    }

    if (message.type === 'join-room') {
      if (!requireUnauthenticated(socket)) return;
      const room = registry.roomView(message.roomCode);
      if (!room) throw new RoomRegistryError('ROOM_NOT_FOUND', 'Room does not exist');
      if (room.phase !== 'lobby') {
        throw new RoomRegistryError('ROOM_IN_PROGRESS', 'Room race is already in progress');
      }
      if (room.members.length >= MAX_PLAYERS) {
        throw new RoomRegistryError('ROOM_FULL', 'Room already has eight reserved seats');
      }
      const player = registry.createPlayer(message.nickname);
      const result = registry.joinRoom(message.roomCode, player);
      bindSocket(socket, player.playerId, result.room.roomCode);
      sendSession(socket, player.playerId, player.resumeToken, result.room);
      publishResult(result);
      return;
    }

    if (message.type === 'resume') {
      if (!requireUnauthenticated(socket)) return;
      const result = registry.resume(message);
      clearPendingHostLoss(message.playerId);
      bindSocket(socket, message.playerId, result.room.roomCode);
      sendSession(socket, message.playerId, message.resumeToken, result.room);
      publishResult({ ...result, room: registry.roomView(result.room.roomCode) });
      if ((result.events ?? []).length === 0) {
        broadcastRoom(result.room.roomCode, {
          type: 'room-view',
          room: registry.roomView(result.room.roomCode),
        });
      }
      return;
    }

    if (message.type === 'set-ready') {
      const session = requireSession(socket);
      if (!session) return;
      publishResult(registry.setReady(session.playerId, message.ready));
      return;
    }

    if (message.type === 'lock-room') {
      const session = requireSession(socket);
      if (!session) return;
      publishResult(registry.lockRoom(session.playerId, message.start));
      return;
    }

    if (message.type === 'signal') {
      const session = requireSession(socket);
      if (!session) return;
      const room = registry.roomView(session.roomCode);
      const targetMember = room?.members.find((member) => member.playerId === message.targetId);
      if (!targetMember) {
        sendError(socket, 'TARGET_NOT_IN_ROOM', 'Signal target is not connected in this room');
        return;
      }
      const targetBinding = playerBindings.get(message.targetId);
      if (
        !targetMember.connected
        || !targetBinding
        || targetBinding.socket.readyState !== WebSocket.OPEN
      ) {
        sendError(socket, 'TARGET_UNAVAILABLE', 'Signal target is currently unavailable');
        return;
      }
      const sent = sendJson(targetBinding.socket, {
        type: 'signal',
        sourceId: session.playerId,
        data: message.data,
      });
      if (!sent) sendError(socket, 'TARGET_UNAVAILABLE', 'Signal target is currently unavailable');
      return;
    }

    const session = requireSession(socket);
    if (!session) return;
    unbindSocket(socket);
    disconnectPlayer(session.playerId);
    socket.close(1000, 'left room');
  }

  function consumeIngress(key, byteLength, limit, now) {
    let ingress = ingressRates.get(key);
    if (!ingress || now - ingress.windowStart >= limit.windowMs) {
      ingress = { windowStart: now, count: 0, bytes: 0, lastSeen: now };
      ingressRates.set(key, ingress);
    }
    ingress.lastSeen = now;
    ingress.bytes += byteLength;
    ingress.count += 1;
    return ingress.bytes <= limit.maxBytes && ingress.count <= limit.maxMessages;
  }

  function consumeRateLimit(socket, byteLength) {
    const now = Date.now();
    let state = socketRates.get(socket);
    if (!state || now - state.windowStart >= messageRateLimit.windowMs) {
      state = { windowStart: now, count: 0 };
      socketRates.set(socket, state);
    }
    state.count += 1;
    if (state.count > messageRateLimit.maxMessages) return false;

    const session = socketSessions.get(socket);
    const address = socketAddresses.get(socket) ?? 'unknown';
    if (!consumeIngress(`address:${address}`, byteLength, addressRateLimit, now)) return false;
    const sourceKey = session
      ? `player:${session.playerId}`
      : `unauthenticated-address:${address}`;
    return consumeIngress(sourceKey, byteLength, messageRateLimit, now);
  }

  function releaseAddress(socket) {
    const address = socketAddresses.get(socket);
    if (address === undefined) return;
    socketAddresses.delete(socket);
    const remaining = (addressConnections.get(address) ?? 1) - 1;
    if (remaining > 0) addressConnections.set(address, remaining);
    else addressConnections.delete(address);
  }

  webSocketServer.on('connection', (socket) => {
    socketHealth.set(socket, {
      awaitingPong: false,
      lastAliveAt: Date.now(),
      lastPingAt: 0,
    });
    socket.on('pong', () => {
      const health = socketHealth.get(socket);
      if (!health) return;
      health.awaitingPong = false;
      health.lastAliveAt = Date.now();
    });
    socket.on('error', () => {});
    socket.on('message', (data, isBinary) => {
      const rateState = socketRates.get(socket);
      if (rateState?.limited) return;
      const byteLength = typeof data === 'string'
        ? Buffer.byteLength(data)
        : (data?.byteLength ?? Buffer.byteLength(data.toString()));
      if (!consumeRateLimit(socket, byteLength)) {
        const limitedState = socketRates.get(socket);
        limitedState.limited = true;
        const sent = sendJson(
          socket,
          { type: 'error', code: 'RATE_LIMIT', message: 'Too much signaling traffic from this source' },
          () => socket.terminate(),
        );
        if (!sent) socket.terminate();
        return;
      }
      if (isBinary) {
        sendError(socket, 'INVALID_MESSAGE', 'Binary signaling messages are not supported');
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        sendError(socket, 'INVALID_JSON', 'Signaling message must be valid JSON');
        return;
      }

      const validated = validateSignalMessage(parsed);
      if (!validated.ok) {
        sendError(socket, 'INVALID_MESSAGE', validated.error);
        return;
      }

      try {
        handleCommand(socket, validated.value);
      } catch (error) {
        if (error instanceof RoomRegistryError) {
          sendError(socket, error.code, error.message);
          return;
        }
        sendError(socket, 'INTERNAL_ERROR', 'The signaling operation failed');
      }
    });

    socket.on('close', () => {
      releaseAddress(socket);
      const session = unbindSocket(socket);
      if (!session || !session.isCurrent || shuttingDown) return;
      const room = registry.roomView(session.roomCode);
      if (room?.hostId === session.playerId && hostLossMs > 0) {
        clearPendingHostLoss(session.playerId);
        const timeout = setTimeout(() => disconnectPlayer(session.playerId), hostLossMs);
        timeout.unref?.();
        pendingHostLosses.set(session.playerId, timeout);
        return;
      }
      disconnectPlayer(session.playerId);
    });
  });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (pathname !== '/signal') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (origins.size > 0 && !origins.has(request.headers.origin)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (webSocketServer.clients.size >= maxConnections) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    const address = clientAddress(request, trustProxy);
    if ((addressConnections.get(address) ?? 0) >= maxConnectionsPerIp) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      socketAddresses.set(webSocket, address);
      addressConnections.set(address, (addressConnections.get(address) ?? 0) + 1);
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(port, host);
    });
  } catch (error) {
    shuttingDown = true;
    for (const socket of webSocketServer.clients) socket.terminate();
    webSocketServer.removeAllListeners();
    httpServer.removeAllListeners();
    throw error;
  }

  const cleanupIntervalMs = Math.max(10, Math.min(1_000, reconnectGraceMs || 10));
  cleanupTimer = setInterval(() => {
    publishResult(registry.removeExpired());
    const now = Date.now();
    for (const [key, rate] of ingressRates) {
      if (now - rate.lastSeen >= messageRateLimit.windowMs * 2) ingressRates.delete(key);
    }
  }, cleanupIntervalMs);
  cleanupTimer.unref?.();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const socket of webSocketServer.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const health = socketHealth.get(socket);
      if (!health) continue;
      if (health.awaitingPong && now - health.lastAliveAt >= heartbeatMs) {
        socket.terminate();
        continue;
      }
      health.awaitingPong = true;
      health.lastPingAt = now;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  const boundAddress = httpServer.address();
  const address = Object.freeze({
    host: boundAddress.address,
    port: boundAddress.port,
  });
  const urlHost = boundAddress.family === 'IPv6' ? `[${boundAddress.address}]` : boundAddress.address;
  const baseUrl = `http://${urlHost}:${boundAddress.port}`;

  async function close() {
    if (closePromise) return closePromise;
    shuttingDown = true;
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const timeout of pendingHostLosses.values()) clearTimeout(timeout);
    pendingHostLosses.clear();

    closePromise = (async () => {
      for (const socket of webSocketServer.clients) socket.terminate();
      await Promise.all([
        new Promise((resolve) => {
          webSocketServer.close(() => resolve());
        }),
        new Promise((resolve) => {
          if (!httpServer.listening) {
            resolve();
            return;
          }
          httpServer.close(() => resolve());
          httpServer.closeAllConnections?.();
        }),
      ]);
    })();
    return closePromise;
  }

  const signalUrl = `${baseUrl.replace('http:', 'ws:')}/signal`;
  return Object.freeze({
    address,
    baseUrl,
    signalUrl,
    url: signalUrl,
    port: boundAddress.port,
    close,
  });
}
