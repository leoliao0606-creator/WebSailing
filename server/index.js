import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { createSignalingServer, MAX_HOST_DETECTION_MS } from './signalingServer.js';

function parseInteger(value, fallback, field, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInteger(value, fallback, field) {
  const parsed = parseInteger(value, fallback, field);
  if (parsed === 0) throw new TypeError(`${field} must be a positive integer`);
  return parsed;
}

function parseIceServers(value) {
  if (value === undefined || value.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('ICE_SERVERS_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new TypeError('ICE_SERVERS_JSON must contain an array');
  return parsed;
}

function parseAllowedOrigins(value) {
  if (value === undefined || value.trim() === '') return [];
  return value.split(',').map((origin) => origin.trim()).filter(Boolean);
}

function parseBoolean(value, fallback, field) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`${field} must be true or false`);
}

export function configFromEnv(env = process.env) {
  const config = {
    port: parseInteger(env.PORT, 8787, 'PORT', { maximum: 65_535 }),
    host: env.HOST?.trim() || '0.0.0.0',
    publicDir: env.PUBLIC_DIR?.trim() || path.resolve(process.cwd(), 'dist'),
    iceServers: parseIceServers(env.ICE_SERVERS_JSON),
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    hostLossMs: parseInteger(env.HOST_LOSS_MS, 2_500, 'HOST_LOSS_MS'),
    heartbeatMs: parseInteger(env.HEARTBEAT_MS, 1_000, 'HEARTBEAT_MS'),
    reconnectGraceMs: parseInteger(
      env.RECONNECT_GRACE_MS,
      30_000,
      'RECONNECT_GRACE_MS',
    ),
    maxConnections: parsePositiveInteger(env.MAX_CONNECTIONS, 1_024, 'MAX_CONNECTIONS'),
    maxConnectionsPerIp: parsePositiveInteger(
      env.MAX_CONNECTIONS_PER_IP,
      64,
      'MAX_CONNECTIONS_PER_IP',
    ),
    maxRooms: parsePositiveInteger(env.MAX_ROOMS, 512, 'MAX_ROOMS'),
    addressRateMultiplier: parsePositiveInteger(
      env.SIGNAL_ADDRESS_RATE_MULTIPLIER,
      8,
      'SIGNAL_ADDRESS_RATE_MULTIPLIER',
    ),
    trustProxy: parseBoolean(env.TRUST_PROXY, false, 'TRUST_PROXY'),
    rateLimit: {
      maxMessages: parsePositiveInteger(
        env.SIGNAL_RATE_MAX_MESSAGES,
        120,
        'SIGNAL_RATE_MAX_MESSAGES',
      ),
      maxBytes: parsePositiveInteger(
        env.SIGNAL_RATE_MAX_BYTES,
        256 * 1024,
        'SIGNAL_RATE_MAX_BYTES',
      ),
      windowMs: parsePositiveInteger(
        env.SIGNAL_RATE_WINDOW_MS,
        1_000,
        'SIGNAL_RATE_WINDOW_MS',
      ),
    },
  };
  if ((2 * config.heartbeatMs) + config.hostLossMs > MAX_HOST_DETECTION_MS) {
    throw new TypeError(`heartbeat and host-loss migration budget cannot exceed ${MAX_HOST_DETECTION_MS}ms`);
  }
  return config;
}

export async function main(env = process.env) {
  const instance = await createSignalingServer(configFromEnv(env));
  process.stdout.write(`WindChaser signaling server listening at ${instance.baseUrl}\n`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await instance.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return instance;
}

const isEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
