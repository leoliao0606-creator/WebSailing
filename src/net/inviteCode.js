// 邀请码：把「联机服务器地址 + 六位房间码」合成一串可复制的文本，队友粘进
// 「联机服务器」一栏就直接落到同一个房间，省掉念 IP 再念房间码这两步。
//
// 形如 `192.168.1.20:8787#ABC123` 或 `wss://game.example.cn#ABC123`：
// 井号前是「联机服务器」本来就接受的地址写法，井号后是六位房间码。
// 纯字符串处理，桌面主进程与渲染进程共用，不依赖 Node 或浏览器 API。

export const DEFAULT_SIGNAL_PORT = 8787;
export const INVITE_SEPARATOR = '#';

function bracketed(hostname) {
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}

/**
 * 输入里有没有显式写端口。
 * WHATWG URL 会把「协议默认端口」抹掉（ws: 的默认端口正是 80），解析完
 * `192.168.1.20:80` 和 `192.168.1.20` 的 parsed.port 都是空串，分不出来；
 * 只看 parsed.port 会把玩家写死的 :80 悄悄改成 8787。
 */
function hasExplicitPort(address) {
  const authority = address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/, 1)[0];
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  // IPv6 字面量自带冒号，端口只可能跟在方括号后面。
  const tail = host.startsWith('[') ? host.slice(host.indexOf(']') + 1) : host;
  return /^[^:]*:\d+$/.test(tail);
}

/**
 * 把玩家输入的主机地址规范成信令 URL。
 * 接受 `192.168.1.20`、`192.168.1.20:8787`、`http://…`、`ws://…/signal` 等写法。
 */
export function normalizeSignalingAddress(input, { defaultPort = DEFAULT_SIGNAL_PORT } = {}) {
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
  if (parsed.port === '' && parsed.protocol === 'ws:' && !hasExplicitPort(trimmed)) {
    parsed.port = String(defaultPort);
  }
  if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/signal';
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

/**
 * 反过来：把信令 URL 压回适合念出来或粘贴的短写法。
 * 明文端口始终保留，保证 normalizeSignalingAddress() 能原样还原。
 */
export function shortSignalingAddress(signalUrl) {
  const parsed = new URL(signalUrl);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError('signalUrl must use ws or wss');
  }
  const secure = parsed.protocol === 'wss:';
  const port = parsed.port || (secure ? '443' : '80');
  const suffix = parsed.pathname === '/signal' ? '' : parsed.pathname;
  if (secure) {
    const host = port === '443' ? bracketed(parsed.hostname) : `${bracketed(parsed.hostname)}:${port}`;
    return `wss://${host}${suffix}`;
  }
  return `${bracketed(parsed.hostname)}:${port}${suffix}`;
}

/**
 * 拆邀请码。没有井号时按纯地址处理，roomCode 为 null。
 */
export function parseInviteCode(text) {
  if (typeof text !== 'string') throw new TypeError('invite must be a string');
  const trimmed = text.trim();
  if (trimmed === '') throw new TypeError('invite must not be empty');
  const index = trimmed.lastIndexOf(INVITE_SEPARATOR);
  if (index === -1) return { address: trimmed, roomCode: null };
  const address = trimmed.slice(0, index).trim();
  const roomCode = trimmed.slice(index + 1).trim();
  if (address === '') throw new TypeError('invite must include a server address');
  return { address, roomCode: roomCode === '' ? null : roomCode };
}

/**
 * 由信令 URL 与房间码合成邀请码；没有房间码时退化成纯地址。
 */
export function formatInviteCode({ signalUrl, roomCode = null } = {}) {
  const address = shortSignalingAddress(signalUrl);
  if (typeof roomCode !== 'string' || roomCode === '') return address;
  return `${address}${INVITE_SEPARATOR}${roomCode}`;
}
