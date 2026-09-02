import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_LAN_PORT,
  DesktopServer,
  desktopServerConfig,
  lanAddresses,
  normalizeSignalingAddress,
  signalUrlFor,
} from '../electron/localServer.js';
import {
  DEFAULT_SETTINGS,
  loadDesktopSettings,
  sanitizeSettings,
  saveDesktopSettings,
  settingsPath,
} from '../electron/desktopSettings.js';
import { APP_ORIGIN, resolveRendererFile } from '../electron/rendererFiles.js';
import { formatMenuString, menuLanguage, menuStrings } from '../electron/menuStrings.js';
import { desktopBridge, desktopSignalingUrl } from '../src/net/desktopBridge.js';

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'windchaser-desktop-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('desktopServerConfig keeps single-player traffic on the loopback interface', () => {
  const config = desktopServerConfig({ publicDir: '/tmp/dist' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 0);
  assert.deepEqual(config.iceServers, []);
  assert.deepEqual(config.allowedOrigins, []);
});

test('desktopServerConfig binds every interface once LAN hosting is enabled', () => {
  const config = desktopServerConfig({ publicDir: '/tmp/dist', lanHosting: true });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, DEFAULT_LAN_PORT);
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

test('normalizeSignalingAddress rejects empty and non-WebSocket addresses', () => {
  assert.throws(() => normalizeSignalingAddress(''), TypeError);
  assert.throws(() => normalizeSignalingAddress('   '), TypeError);
  assert.throws(() => normalizeSignalingAddress(null), TypeError);
  assert.throws(() => normalizeSignalingAddress('file:///etc/passwd'), TypeError);
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
