// 桌面端本地服务：复用 server/ 的信令 + 静态文件服务。
//
// 单机与「本机主持」时只在回环监听，端口交给内核分配；玩家在菜单里打开
// 「允许局域网加入」后改为全网卡监听固定端口，同一局域网的其他玩家（桌面版或
// 浏览器打开 http://<地址>:<端口>/）才能连进来。渲染进程的页面来自 app:// 自定义
// 协议，与这里的端口无关，所以端口变化不会丢失 localStorage 里的最佳成绩与幽灵船。

import os from 'node:os';

import { DEFAULT_SIGNAL_PORT, normalizeSignalingAddress } from '../src/net/inviteCode.js';
import { APP_ORIGIN } from './rendererFiles.js';
import { createSignalingServer } from '../server/signalingServer.js';

export const LOOPBACK_HOST = '127.0.0.1';
export const ANY_HOST = '0.0.0.0';
export const DEFAULT_LAN_PORT = DEFAULT_SIGNAL_PORT;

// 地址规范化与渲染进程共用一份实现，避免「菜单里能连、页面里连不上」这种分叉。
export { normalizeSignalingAddress };

// 桌面端默认不配置 STUN/TURN：回环与同一局域网靠 host 候选即可直连，
// 跨公网联机仍应使用 README「联机部署」里的自建信令服务。
const DESKTOP_ICE_SERVERS = Object.freeze([]);

/**
 * 信令服务的 Origin 白名单。
 *
 * 必须给出非空列表：signalingServer 把空数组当成「不检查 Origin」，那样任何
 * 网页都能对本机这个端口发起 WebSocket 握手（端口是内核随机分的，但可以扫），
 * 进而枚举房间或占满连接数。桌面渲染进程的页面来自 app://，握手会带上
 * `app://windchaser`；开局域网主持时，浏览器访客的页面由本服务自己发出，
 * Origin 就是 `http://<主机地址>:<端口>`，这里把局域网 IP、回环和本机主机名
 * 都列上。用别的别名（自定义 hosts 之类）访问会被 403，改用分享出去的地址即可。
 */
export function desktopAllowedOrigins({
  lanHosting = false,
  lanPort = DEFAULT_LAN_PORT,
  addresses = undefined,
} = {}) {
  const origins = [APP_ORIGIN];
  if (!lanHosting) return origins;
  const hostname = safeHostname();
  const hosts = [
    ...(addresses ?? lanAddresses()),
    LOOPBACK_HOST,
    'localhost',
    ...(hostname ? [hostname, `${hostname}.local`] : []),
  ];
  for (const host of hosts) {
    const origin = `http://${bracket(host)}:${lanPort}`;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

function safeHostname() {
  try {
    const name = os.hostname();
    return typeof name === 'string' && name !== '' ? name.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * 把「允许局域网加入」开关翻译成 createSignalingServer 的监听参数。
 */
export function desktopServerConfig({
  publicDir,
  lanHosting = false,
  lanPort = DEFAULT_LAN_PORT,
  addresses = undefined,
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
    allowedOrigins: desktopAllowedOrigins({ lanHosting, lanPort, addresses }),
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
    // close() 会把 lanHosting 归位，createServer 抛出时状态停在「没在跑」，
    // 不会留下「服务已关闭但 lanHosting 仍报 true」这种自相矛盾的组合。
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
    this.#lanHosting = false;
    if (instance) await instance.close();
  }
}
