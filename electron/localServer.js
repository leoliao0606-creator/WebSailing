// 桌面端本地服务：复用 server/ 的信令 + 静态文件服务。
//
// 单机与「本机主持」时只在回环监听，端口交给内核分配；玩家在菜单里打开
// 「允许局域网加入」后改为全网卡监听固定端口，同一局域网的其他玩家（桌面版或
// 浏览器打开 http://<地址>:<端口>/）才能连进来。渲染进程的页面来自 app:// 自定义
// 协议，与这里的端口无关，所以端口变化不会丢失 localStorage 里的最佳成绩与幽灵船。

import os from 'node:os';

import { createSignalingServer } from '../server/signalingServer.js';

export const LOOPBACK_HOST = '127.0.0.1';
export const ANY_HOST = '0.0.0.0';
export const DEFAULT_LAN_PORT = 8787;

// 桌面端默认不配置 STUN/TURN：回环与同一局域网靠 host 候选即可直连，
// 跨公网联机仍应使用 README「联机部署」里的自建信令服务。
const DESKTOP_ICE_SERVERS = Object.freeze([]);

/**
 * 把「允许局域网加入」开关翻译成 createSignalingServer 的监听参数。
 */
export function desktopServerConfig({
  publicDir,
  lanHosting = false,
  lanPort = DEFAULT_LAN_PORT,
} = {}) {
  if (typeof publicDir !== 'string' || publicDir === '') {
    throw new TypeError('publicDir must be a non-empty string');
  }
  if (typeof lanHosting !== 'boolean') throw new TypeError('lanHosting must be a boolean');
  if (!Number.isSafeInteger(lanPort) || lanPort < 0 || lanPort > 65_535) {
    throw new TypeError('lanPort must be a port number');
  }
  return {
    host: lanHosting ? ANY_HOST : LOOPBACK_HOST,
    // 回环监听用 0 让内核挑空闲端口，避免和别的程序抢固定端口。
    port: lanHosting ? lanPort : 0,
    publicDir,
    iceServers: DESKTOP_ICE_SERVERS,
    // 桌面版访客的页面来自 app://，主持端浏览器访客来自 http://<局域网地址>，
    // 两者 Origin 都不固定，因此这里不做 Origin 白名单（仅监听回环或局域网）。
    allowedOrigins: [],
  };
}

/**
 * 本机可分享给局域网玩家的 IPv4 地址（跳过回环与未分配地址）。
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      const family = entry.family === 4 || entry.family === 'IPv4' ? 4 : 0;
      if (family !== 4 || entry.internal) continue;
      if (typeof entry.address !== 'string' || entry.address === '') continue;
      if (entry.address.startsWith('169.254.')) continue; // 链路本地：对方多半连不上
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

function bracket(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * 由主机名和端口拼出信令 WebSocket 地址。
 */
export function signalUrlFor(host, port) {
  if (typeof host !== 'string' || host === '') throw new TypeError('host must be a non-empty string');
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError('port must be a port number');
  }
  return `ws://${bracket(host)}:${port}/signal`;
}

/**
 * 把玩家在菜单里输入的主机地址规范成信令 URL。
 * 接受 `192.168.1.20`、`192.168.1.20:8787`、`http://…`、`ws://…/signal` 等写法。
 */
export function normalizeSignalingAddress(input, { defaultPort = DEFAULT_LAN_PORT } = {}) {
  if (typeof input !== 'string') throw new TypeError('address must be a string');
  const trimmed = input.trim();
  if (trimmed === '') throw new TypeError('address must not be empty');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let parsed;
  try {
    parsed = new URL(hasScheme ? trimmed : `ws://${trimmed}`);
  } catch {
    throw new TypeError('address is not a valid URL');
  }
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError('address must use ws, wss, http, or https');
  }
  if (parsed.hostname === '') throw new TypeError('address must include a host');
  if (parsed.port === '' && parsed.protocol === 'ws:') parsed.port = String(defaultPort);
  if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/signal';
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

/**
 * 桌面进程内的信令服务生命周期。start() 可重复调用以切换监听方式。
 */
export class DesktopServer {
  #publicDir;

  #createServer;

  #instance = null;

  #lanHosting = false;

  #lanPort = DEFAULT_LAN_PORT;

  constructor({ publicDir, createServer = createSignalingServer } = {}) {
    if (typeof publicDir !== 'string' || publicDir === '') {
      throw new TypeError('publicDir must be a non-empty string');
    }
    if (typeof createServer !== 'function') throw new TypeError('createServer must be a function');
    this.#publicDir = publicDir;
    this.#createServer = createServer;
  }

  get running() { return this.#instance !== null; }

  get port() { return this.#instance?.port ?? null; }

  get lanHosting() { return this.#lanHosting; }

  /** 渲染进程要连的地址：始终走回环，即使服务监听在 0.0.0.0。 */
  get clientSignalUrl() {
    return this.#instance ? signalUrlFor(LOOPBACK_HOST, this.#instance.port) : null;
  }

  /** 开启局域网主持后可以念给队友的地址；未开启时为空数组。 */
  get shareAddresses() {
    if (!this.#instance || !this.#lanHosting) return [];
    return lanAddresses().map((address) => ({
      host: address,
      port: this.#instance.port,
      pageUrl: `http://${address}:${this.#instance.port}/`,
      signalUrl: signalUrlFor(address, this.#instance.port),
    }));
  }

  async start({ lanHosting = false, lanPort = DEFAULT_LAN_PORT } = {}) {
    const config = desktopServerConfig({ publicDir: this.#publicDir, lanHosting, lanPort });
    await this.close();
    this.#instance = await this.#createServer(config);
    this.#lanHosting = lanHosting;
    this.#lanPort = lanPort;
    return this.#instance;
  }

  /** 局域网监听端口被占用时退回回环，让单机与本机主持仍然可用。 */
  async startWithFallback({ lanHosting = false, lanPort = DEFAULT_LAN_PORT } = {}) {
    try {
      await this.start({ lanHosting, lanPort });
      return { lanHosting: this.#lanHosting, error: null };
    } catch (error) {
      if (!lanHosting) throw error;
      await this.start({ lanHosting: false, lanPort });
      return { lanHosting: false, error };
    }
  }

  async close() {
    const instance = this.#instance;
    this.#instance = null;
    if (instance) await instance.close();
  }
}
