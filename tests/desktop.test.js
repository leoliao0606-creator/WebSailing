import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import {
  DEFAULT_LAN_PORT,
  DesktopServer,
  desktopAllowedOrigins,
  desktopServerConfig,
  lanAddresses,
  normalizeSignalingAddress,
  signalUrlFor,
} from '../electron/localServer.js';
import {
  DEFAULT_SETTINGS,
  loadDesktopSettings,
  sanitizeSettings,
  visibleBounds,
  saveDesktopSettings,
  settingsPath,
} from '../electron/desktopSettings.js';
import { APP_ORIGIN, resolveRendererFile } from '../electron/rendererFiles.js';
import { formatMenuString, menuLanguage, menuStrings } from '../electron/menuStrings.js';
import { createUpdater, detectUpdateContext, updateMode } from '../electron/updater.js';
import { desktopBridge, desktopSignalingUrl } from '../src/net/desktopBridge.js';
import {
  formatInviteCode,
  parseInviteCode,
  shortSignalingAddress,
} from '../src/net/inviteCode.js';

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'windchaser-desktop-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 发一次 WebSocket 握手，只看服务端给的状态码（101 = 放行）。 */
function upgradeStatus(signalUrl, origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(signalUrl, { origin });
    const done = (value) => { try { socket.close(); } catch { /* 已经断了 */ } resolve(value); };
    socket.on('open', () => done(101));
    socket.on('unexpected-response', (_request, response) => done(response.statusCode));
    socket.on('error', reject);
  });
}

test('desktopServerConfig keeps single-player traffic on the loopback interface', () => {
  const config = desktopServerConfig({ publicDir: '/tmp/dist' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 0);
  assert.deepEqual(config.iceServers, []);
  // 单机也必须给出白名单：signalingServer 把空数组当成「不检查 Origin」，
  // 那样随便一个网页都能扫到这个端口并连上来。
  assert.deepEqual(config.allowedOrigins, ['app://windchaser']);
});

test('desktopServerConfig binds every interface once LAN hosting is enabled', () => {
  const config = desktopServerConfig({ publicDir: '/tmp/dist', lanHosting: true });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, DEFAULT_LAN_PORT);
});

test('the origin allowlist covers the desktop page and the LAN pages this server hands out', () => {
  assert.deepEqual(desktopAllowedOrigins(), ['app://windchaser']);
  const lan = desktopAllowedOrigins({ lanHosting: true, lanPort: 8787, addresses: ['192.168.1.20'] });
  // 桌面访客的页面来自 app://，浏览器访客的页面由本服务在局域网地址上发出。
  assert.ok(lan.includes('app://windchaser'));
  assert.ok(lan.includes('http://192.168.1.20:8787'));
  assert.ok(lan.includes('http://localhost:8787'));
  // 端口不对（别的网站）一律不在名单里。
  assert.ok(!lan.some((origin) => origin.endsWith(':443') || origin === 'https://example.com'));
});

test('desktopServerConfig rejects a missing public directory or bad port', () => {
  assert.throws(() => desktopServerConfig({}), TypeError);
  assert.throws(
    () => desktopServerConfig({ publicDir: '/tmp/dist', lanHosting: true, lanPort: 70_000 }),
    TypeError,
  );
});

test('lanAddresses keeps routable IPv4 addresses and drops loopback and link-local ones', () => {
  const addresses = lanAddresses({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    eth1: [{ address: '169.254.10.1', family: 'IPv4', internal: false }],
    eth2: [{ address: '192.168.1.20', family: 4, internal: false }],
  });
  assert.deepEqual(addresses, ['192.168.1.20']);
});

test('signalUrlFor brackets IPv6 hosts', () => {
  assert.equal(signalUrlFor('192.168.1.20', 8787), 'ws://192.168.1.20:8787/signal');
  assert.equal(signalUrlFor('fd00::1', 8787), 'ws://[fd00::1]:8787/signal');
  assert.throws(() => signalUrlFor('192.168.1.20', 0), TypeError);
});

test('normalizeSignalingAddress accepts the shapes a player is likely to type', () => {
  assert.equal(normalizeSignalingAddress('192.168.1.20'), 'ws://192.168.1.20:8787/signal');
  assert.equal(normalizeSignalingAddress(' 192.168.1.20:9000 '), 'ws://192.168.1.20:9000/signal');
  assert.equal(normalizeSignalingAddress('http://192.168.1.20:9000'), 'ws://192.168.1.20:9000/signal');
  assert.equal(normalizeSignalingAddress('https://game.example.cn'), 'wss://game.example.cn/signal');
  assert.equal(normalizeSignalingAddress('ws://192.168.1.20:9000/signal'), 'ws://192.168.1.20:9000/signal');
});

test('normalizeSignalingAddress strips credentials, query and hash', () => {
  assert.equal(
    normalizeSignalingAddress('ws://user:secret@192.168.1.20:9000/signal?a=1#b'),
    'ws://192.168.1.20:9000/signal',
  );
});

test('an explicitly typed port survives, port 80 included', () => {
  // WHATWG URL 会把协议默认端口抹掉，解析完 `:80` 和「没写端口」都是空串；
  // 只看 parsed.port 会把玩家写死的 80 悄悄换成 8787，连到另一个服务上。
  assert.equal(normalizeSignalingAddress('192.168.1.20:80'), 'ws://192.168.1.20/signal');
  assert.equal(normalizeSignalingAddress('http://game.example.cn:80'), 'ws://game.example.cn/signal');
  assert.equal(normalizeSignalingAddress('ws://[fd00::1]:80'), 'ws://[fd00::1]/signal');
  // 没写端口才补默认值。
  assert.equal(normalizeSignalingAddress('192.168.1.20'), 'ws://192.168.1.20:8787/signal');
  // 复制出去的短写法再粘回来，仍然落在同一个端口上。
  for (const typed of ['192.168.1.20:80', '192.168.1.20:8787', 'https://game.example.cn']) {
    const url = normalizeSignalingAddress(typed);
    assert.equal(normalizeSignalingAddress(shortSignalingAddress(url)), url);
  }
});

test('normalizeSignalingAddress rejects empty and non-WebSocket addresses', () => {
  assert.throws(() => normalizeSignalingAddress(''), TypeError);
  assert.throws(() => normalizeSignalingAddress('   '), TypeError);
  assert.throws(() => normalizeSignalingAddress(null), TypeError);
  assert.throws(() => normalizeSignalingAddress('file:///etc/passwd'), TypeError);
});

test('an invite code round-trips through the short address form', () => {
  for (const typed of ['192.168.1.20', '192.168.1.20:9000', 'https://game.example.cn', 'ws://[fd00::1]:8787']) {
    const signalUrl = normalizeSignalingAddress(typed);
    assert.equal(normalizeSignalingAddress(shortSignalingAddress(signalUrl)), signalUrl);
  }
  assert.equal(shortSignalingAddress('ws://192.168.1.20:8787/signal'), '192.168.1.20:8787');
  assert.equal(shortSignalingAddress('wss://game.example.cn/signal'), 'wss://game.example.cn');
  assert.equal(shortSignalingAddress('ws://192.168.1.20:80/signal'), '192.168.1.20:80');
  assert.equal(shortSignalingAddress('ws://[fd00::1]:8787/signal'), '[fd00::1]:8787');
});

test('formatInviteCode pairs the address with the room code', () => {
  assert.equal(
    formatInviteCode({ signalUrl: 'ws://192.168.1.20:8787/signal', roomCode: 'AB2CD9' }),
    '192.168.1.20:8787#AB2CD9',
  );
  assert.equal(
    formatInviteCode({ signalUrl: 'ws://192.168.1.20:8787/signal' }),
    '192.168.1.20:8787',
  );
});

test('parseInviteCode splits on the last separator and tolerates a bare address', () => {
  assert.deepEqual(parseInviteCode('192.168.1.20:8787#AB2CD9'), {
    address: '192.168.1.20:8787', roomCode: 'AB2CD9',
  });
  assert.deepEqual(parseInviteCode('  192.168.1.20  '), { address: '192.168.1.20', roomCode: null });
  assert.deepEqual(parseInviteCode('wss://game.example.cn/signal#AB2CD9'), {
    address: 'wss://game.example.cn/signal', roomCode: 'AB2CD9',
  });
  assert.deepEqual(parseInviteCode('192.168.1.20#'), { address: '192.168.1.20', roomCode: null });
  assert.throws(() => parseInviteCode('#AB2CD9'), TypeError);
  assert.throws(() => parseInviteCode('   '), TypeError);
  assert.throws(() => parseInviteCode(null), TypeError);
});

test('DesktopServer points the renderer at loopback even while hosting on every interface', async () => {
  const created = [];
  const server = new DesktopServer({
    publicDir: '/tmp/dist',
    createServer: (config) => {
      created.push(config);
      return { port: config.port === 0 ? 54_321 : config.port, close: async () => {} };
    },
  });

  await server.start({ lanHosting: true, lanPort: 8787 });
  assert.equal(server.running, true);
  assert.equal(server.lanHosting, true);
  assert.equal(server.clientSignalUrl, 'ws://127.0.0.1:8787/signal');
  assert.equal(created[0].host, '0.0.0.0');

  await server.start({ lanHosting: false });
  assert.equal(server.clientSignalUrl, 'ws://127.0.0.1:54321/signal');
  assert.deepEqual(server.shareAddresses, []);
  await server.close();
  assert.equal(server.running, false);
  assert.equal(server.clientSignalUrl, null);
});

test('DesktopServer falls back to loopback when the LAN port is taken', async () => {
  let attempt = 0;
  const server = new DesktopServer({
    publicDir: '/tmp/dist',
    createServer: (config) => {
      attempt += 1;
      if (config.host === '0.0.0.0') throw Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' });
      return { port: 54_321, close: async () => {} };
    },
  });

  const outcome = await server.startWithFallback({ lanHosting: true, lanPort: 8787 });
  assert.equal(attempt, 2);
  assert.equal(outcome.lanHosting, false);
  assert.equal(outcome.error.code, 'EADDRINUSE');
  assert.equal(server.lanHosting, false);
  assert.equal(server.clientSignalUrl, 'ws://127.0.0.1:54321/signal');
  await server.close();
});

test('the signaling endpoint turns away pages that are not the game', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>WindChaser</title>');
    const server = new DesktopServer({ publicDir: dir });
    await server.start();
    try {
      // 桌面渲染进程的页面来自 app://，握手带的就是这个 Origin。
      assert.equal(await upgradeStatus(server.clientSignalUrl, 'app://windchaser'), 101);
      // 别的网站扫到这个回环端口也连不上——之前白名单是空的，等于不检查，
      // 任意页面都能进来枚举房间或占满连接数。
      assert.equal(await upgradeStatus(server.clientSignalUrl, 'https://example.com'), 403);
    } finally {
      await server.close();
    }
  });
});

test('closing the server also clears the LAN-hosting flag it reports', async () => {
  const server = new DesktopServer({
    publicDir: '/tmp/dist',
    createServer: async () => ({ port: 8787, close: async () => {} }),
  });
  await server.start({ lanHosting: true, lanPort: 8787 });
  assert.equal(server.lanHosting, true);
  await server.close();
  // 关掉之后还报 lanHosting=true 的话，菜单会把「允许局域网加入」画成勾选、
  // bootstrap 也会告诉页面正在主持，而实际上没有任何东西在监听。
  assert.equal(server.lanHosting, false);
  assert.equal(server.running, false);
  assert.deepEqual(server.shareAddresses, []);
});

test('a failed start leaves the server stopped rather than half-hosting', async () => {
  const server = new DesktopServer({
    publicDir: '/tmp/dist',
    createServer: async () => { throw new Error('EADDRINUSE'); },
  });
  await assert.rejects(server.start({ lanHosting: true, lanPort: 8787 }));
  assert.equal(server.running, false);
  assert.equal(server.lanHosting, false);
  assert.equal(server.clientSignalUrl, null);
});

test('DesktopServer serves the built game and its own signaling endpoint', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>WindChaser</title>');
    const server = new DesktopServer({ publicDir: dir });
    await server.start();
    try {
      const url = server.clientSignalUrl.replace('ws://', 'http://').replace('/signal', '/');
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /WindChaser/);
      const health = await fetch(`${url}health`);
      assert.equal(health.status, 200);
    } finally {
      await server.close();
    }
  });
});

test('LAN hosting keeps serving the machine that runs it', async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>WindChaser</title>');
    const server = new DesktopServer({ publicDir: dir });
    // lanPort 0 让内核挑端口，避免测试抢占默认的 8787。
    await server.start({ lanHosting: true, lanPort: 0 });
    try {
      assert.equal(server.lanHosting, true);
      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      assert.equal(health.status, 200);
      for (const entry of server.shareAddresses) {
        assert.equal(entry.port, server.port);
        assert.equal(entry.signalUrl, `ws://${entry.host}:${server.port}/signal`);
      }
    } finally {
      await server.close();
    }
  });
});

test('sanitizeSettings falls back to defaults for missing or corrupt fields', () => {
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(sanitizeSettings({ lanHosting: 'yes', lanPort: -1, remoteSignalingUrl: 'nope://x' }), {
    ...DEFAULT_SETTINGS,
  });
  assert.equal(
    sanitizeSettings({ remoteSignalingUrl: '192.168.1.20' }).remoteSignalingUrl,
    'ws://192.168.1.20:8787/signal',
  );
  assert.equal(sanitizeSettings({ windowBounds: { x: 1, y: 2, width: 10, height: 10 } }).windowBounds, null);
  assert.deepEqual(
    sanitizeSettings({ windowBounds: { x: 1.4, y: 2.6, width: 1280, height: 720 } }).windowBounds,
    { x: 1, y: 3, width: 1280, height: 720 },
  );
});

test('desktop settings survive a save/load round trip and tolerate a broken file', async () => {
  await withTempDir(async (dir) => {
    const saved = await saveDesktopSettings(dir, {
      lanHosting: true,
      remoteSignalingUrl: '192.168.1.20:9000',
      windowBounds: { x: 0, y: 0, width: 1600, height: 900 },
      fullscreen: true,
    });
    assert.equal(saved.remoteSignalingUrl, 'ws://192.168.1.20:9000/signal');
    assert.deepEqual(await loadDesktopSettings(dir), saved);

    await writeFile(settingsPath(dir), '{ not json');
    assert.deepEqual(await loadDesktopSettings(dir), { ...DEFAULT_SETTINGS });
    assert.match(await readFile(settingsPath(dir), 'utf8'), /not json/);
  });
});

test('a window restored onto a monitor that is gone falls back to a centred one', () => {
  const laptop = { x: 0, y: 0, width: 1920, height: 1080 };
  const onLaptop = { x: 100, y: 80, width: 1600, height: 900 };
  assert.deepEqual(visibleBounds(onLaptop, [laptop]), onLaptop);

  // 存的是外接屏上的位置，显示器拔掉后这块坐标不再属于任何屏幕：保留尺寸、
  // 丢掉坐标，否则窗口开在看不见的地方，玩家只能去手删配置文件。
  const onExternal = { x: 2560, y: 200, width: 1600, height: 900 };
  assert.deepEqual(visibleBounds(onExternal, [laptop]), { width: 1600, height: 900 });

  // 只擦到屏幕一个角同样抓不住。
  const corner = { x: 1900, y: 1060, width: 1600, height: 900 };
  assert.deepEqual(visibleBounds(corner, [laptop]), { width: 1600, height: 900 });

  assert.equal(visibleBounds(null, [laptop]), null);
});

test('resolveRendererFile maps app:// requests into the built renderer directory', () => {
  const root = path.resolve('/opt/windchaser/dist');
  assert.equal(resolveRendererFile(root, `${APP_ORIGIN}/`), path.join(root, 'index.html'));
  assert.equal(
    resolveRendererFile(root, `${APP_ORIGIN}/assets/index-abc123.js`),
    path.join(root, 'assets', 'index-abc123.js'),
  );
});

test('resolveRendererFile refuses traversal, foreign hosts and other schemes', () => {
  const root = path.resolve('/opt/windchaser/dist');
  // URL 解析已经吃掉了明文 `..`，结果必须仍落在 dist 内（顶多 404），不能逃出去。
  assert.equal(resolveRendererFile(root, `${APP_ORIGIN}/../../etc/passwd`), path.join(root, 'etc/passwd'));
  // 转义后的 `..` 是 URL 解析看不到的那一类，靠自己的分段检查挡住。
  assert.equal(resolveRendererFile(root, `${APP_ORIGIN}/assets/..%2f..%2fetc/passwd`), null);
  assert.equal(resolveRendererFile(root, `${APP_ORIGIN}/%2e%2e/secret`), path.join(root, 'secret'));
  assert.equal(resolveRendererFile(root, `${APP_ORIGIN}/index%00.html`), null);
  assert.equal(resolveRendererFile(root, 'app://evil/index.html'), null);
  assert.equal(resolveRendererFile(root, 'file:///etc/passwd'), null);
  assert.equal(resolveRendererFile(root, 'not a url'), null);
});

test('menu strings cover the three in-game languages', () => {
  assert.equal(menuLanguage('zh-CN'), 'zh');
  assert.equal(menuLanguage('ja-JP'), 'ja');
  assert.equal(menuLanguage('fr-FR'), 'en');
  const keys = Object.keys(menuStrings('en'));
  for (const locale of ['zh-CN', 'ja-JP']) {
    assert.deepEqual(Object.keys(menuStrings(locale)).sort(), [...keys].sort());
  }
  assert.equal(formatMenuString('port {port} busy', { port: 8787 }), 'port 8787 busy');
  assert.equal(formatMenuString('{missing}', {}), '{missing}');
});

test('desktopBridge only activates for the Electron preload bridge', () => {
  assert.equal(desktopBridge({}), null);
  assert.equal(desktopBridge({ windchaser: { signalingUrl: 'ws://x/signal' } }), null);
  const bridge = { desktop: true, signalingUrl: 'ws://127.0.0.1:8787/signal' };
  assert.equal(desktopBridge({ windchaser: bridge }), bridge);
  assert.equal(desktopSignalingUrl({ windchaser: bridge }), 'ws://127.0.0.1:8787/signal');
  assert.equal(desktopSignalingUrl({}), undefined);
  assert.equal(desktopSignalingUrl({ windchaser: { desktop: true, signalingUrl: '' } }), undefined);
});

test('only self-replacing installs update in place', () => {
  assert.equal(updateMode({ platform: 'win32' }), 'install');
  assert.equal(updateMode({ platform: 'linux', appImage: true }), 'install');
  assert.equal(updateMode({ platform: 'darwin', signed: true }), 'install');
  // deb / tar.gz 装不回自己，未签名的 macOS 包过不了 Squirrel.Mac 校验
  assert.equal(updateMode({ platform: 'linux', appImage: false }), 'notify');
  assert.equal(updateMode({ platform: 'darwin', signed: false }), 'notify');
  // 开发模式没有已发布版本可比
  assert.equal(updateMode({ platform: 'win32', packaged: false }), 'off');
});

test('detectUpdateContext reads the install shape out of the environment', () => {
  assert.deepEqual(
    detectUpdateContext({ app: { isPackaged: true }, env: { APPIMAGE: '/tmp/a.AppImage' }, platform: 'linux' }),
    { platform: 'linux', packaged: true, appImage: true, signed: true },
  );
  assert.deepEqual(
    detectUpdateContext({ app: { isPackaged: true }, env: {}, platform: 'darwin' }),
    { platform: 'darwin', packaged: true, appImage: false, signed: false },
  );
  assert.equal(
    detectUpdateContext({ app: { isPackaged: true }, env: { WINDCHASER_MAC_SIGNED: '1' }, platform: 'darwin' }).signed,
    true,
  );
  assert.equal(detectUpdateContext({ app: {}, env: {}, platform: 'win32' }).packaged, false);
});

class FakeAutoUpdater {
  handlers = new Map();

  autoDownload = null;

  autoInstallOnAppQuit = null;

  installs = 0;

  result = { isUpdateAvailable: false, updateInfo: { version: '0.1.0' } };

  error = null;

  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, payload) { return this.handlers.get(event)?.(payload); }
  checkForUpdates() {
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve(this.result);
  }

  quitAndInstall() { this.installs += 1; }
}

function updaterHarness(mode, { response = 0 } = {}) {
  const boxes = [];
  const opened = [];
  const autoUpdater = new FakeAutoUpdater();
  const updater = createUpdater({
    autoUpdater,
    mode,
    strings: menuStrings('en'),
    format: formatMenuString,
    dialog: { showMessageBox: (options) => { boxes.push(options); return Promise.resolve({ response }); } },
    openExternal: (url) => { opened.push(url); return Promise.resolve(); },
    currentVersion: '0.1.0',
  });
  return { autoUpdater, boxes, opened, updater };
}

test('install mode downloads in the background and offers a restart', async () => {
  const { autoUpdater, boxes, updater } = updaterHarness('install');
  assert.equal(autoUpdater.autoDownload, true);
  await autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(boxes.length, 1);
  assert.match(boxes[0].message, /0\.2\.0/);
  // 默认停在「稍后」，别把人从比赛里踢出去
  assert.equal(boxes[0].defaultId, 1);
  assert.equal(autoUpdater.installs, 1);
  assert.equal(updater.mode, 'install');
});

test('notify mode never downloads and sends the player to the releases page', async () => {
  const { autoUpdater, boxes, opened } = updaterHarness('notify');
  assert.equal(autoUpdater.autoDownload, false);
  await autoUpdater.emit('update-available', { version: '0.2.0' });
  assert.equal(boxes.length, 1);
  assert.equal(autoUpdater.installs, 0);
  assert.deepEqual(opened, ['https://github.com/leoliao0606-creator/WebSailing/releases/latest']);
});

test('the same version is announced once, but a manual check can ask again', async () => {
  const { autoUpdater, boxes, updater } = updaterHarness('notify', { response: 1 });
  await autoUpdater.emit('update-available', { version: '0.2.0' });
  await autoUpdater.emit('update-available', { version: '0.2.0' });
  assert.equal(boxes.length, 1);
  autoUpdater.result = { isUpdateAvailable: true, updateInfo: { version: '0.2.0' } };
  assert.equal(await updater.check({ manual: true }), '0.2.0');
  await autoUpdater.emit('update-available', { version: '0.2.0' });
  assert.equal(boxes.length, 2);
});

test('a manual check reports being up to date, and failures only surface when manual', async () => {
  const { autoUpdater, boxes, updater } = updaterHarness('install');
  assert.equal(await updater.check({ manual: true }), null);
  assert.equal(boxes.at(-1).title, menuStrings('en').updateNoneTitle);

  autoUpdater.error = new Error('offline');
  assert.equal(await updater.check({ manual: true }), null);
  assert.equal(boxes.at(-1).title, menuStrings('en').updateFailedTitle);

  const quiet = boxes.length;
  assert.equal(await updater.check(), null);
  assert.equal(boxes.length, quiet);
});

test('a manual check in install mode says the download started, and reports its failure', async () => {
  const { autoUpdater, boxes, updater } = updaterHarness('install');
  autoUpdater.result = { isUpdateAvailable: true, updateInfo: { version: '0.2.0' } };
  assert.equal(await updater.check({ manual: true }), '0.2.0');
  // 下载在后台跑，重启提示要等 update-downloaded。中间一声不吭的话，玩家会
  // 以为「检查更新」这个菜单项根本没反应。
  assert.equal(boxes.length, 1);
  assert.match(boxes[0].detail, /0\.2\.0/);

  // 那次手动检查启动的下载失败了，必须有个交代。
  await autoUpdater.emit('error', new Error('connection reset'));
  assert.equal(boxes.at(-1).title, menuStrings('en').updateFailedTitle);
  assert.match(boxes.at(-1).detail, /connection reset/);

  // 之后的后台错误照旧咽掉，不打断航行。
  const quiet = boxes.length;
  await autoUpdater.emit('error', new Error('offline'));
  assert.equal(boxes.length, quiet);
});

test('an off-mode updater is inert', async () => {
  const updater = createUpdater({ mode: 'off' });
  assert.equal(updater.mode, 'off');
  assert.equal(await updater.check({ manual: true }), null);
});
