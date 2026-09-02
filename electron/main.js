// 桌面版主进程：拉起窗口、在进程内跑信令服务、用 app:// 提供已构建的渲染产物。
//
// 结构上和网页版是同一份代码：src/ 经 Vite 构建成 dist/，server/ 原样复用；
// 桌面版只是把「静态站点 + 信令进程 + 浏览器」三件事装进一个可执行文件。

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  screen,
  shell,
} from 'electron';

import { DesktopServer, normalizeSignalingAddress } from './localServer.js';
import { loadDesktopSettings, saveDesktopSettings, visibleBounds } from './desktopSettings.js';
import {
  APP_INDEX_URL,
  APP_ORIGIN,
  APP_SCHEME,
  resolveRendererFile,
} from './rendererFiles.js';
import { formatMenuString, menuStrings } from './menuStrings.js';
import { createUpdater, detectUpdateContext, updateMode } from './updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

// 打包后 dist/ 由 electron-builder 的 extraResources 放在 resources/dist，
// 不进 asar，静态服务与 app:// 都按普通目录读取。
const RENDERER_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'dist')
  : path.join(PROJECT_ROOT, 'dist');

// 同机开两个客户端做联机自测时，用它指定独立的用户数据目录并跳过单实例锁。
const USER_DATA_OVERRIDE = process.env.WINDCHASER_USER_DATA?.trim() || '';
if (USER_DATA_OVERRIDE) {
  const overrideDir = path.resolve(USER_DATA_OVERRIDE);
  app.setPath('userData', overrideDir);
  // sessionData 才是 Chromium 存 localStorage 的地方，两个都改才算真正隔离。
  app.setPath('sessionData', overrideDir);
}

if (!USER_DATA_OVERRIDE && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// 同一局域网内两个 Chromium 之间建 DataChannel 时，mDNS 混淆的候选地址在部分
// 家庭路由/Linux 环境解析不出来；桌面版本来就只在局域网里用，直接暴露内网 IP。
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    codeCache: true,
  },
}]);

const server = new DesktopServer({ publicDir: RENDERER_ROOT });
let settings = null;
let strings = menuStrings('en');
let mainWindow = null;
let updaterMode = 'off';
let updaterPromise = null;

function bootstrapPayload() {
  return {
    desktop: true,
    signalingUrl: settings.remoteSignalingUrl ?? server.clientSignalUrl,
    remoteAddress: settings.remoteSignalingUrl,
    shareAddresses: server.shareAddresses,
  };
}

async function applyServerSettings() {
  const outcome = await server.startWithFallback({
    lanHosting: settings.lanHosting,
    lanPort: settings.lanPort,
  });
  if (outcome.error) {
    await persist({ lanHosting: false });
    dialog.showMessageBox({
      type: 'warning',
      title: strings.lanFailedTitle,
      message: strings.lanFailedTitle,
      detail: formatMenuString(strings.lanFailedBody, { port: settings.lanPort }),
    }).catch(() => {});
  }
}

// 写盘串行化：读-改-写中间隔着 await，并发调用（拖窗口的同时切全屏、或者
// 局域网监听失败要回滚开关）会互相覆盖——后完成的那次会把更早的快照写回去。
let persistQueue = Promise.resolve();

function persist(patch) {
  persistQueue = persistQueue.then(async () => {
    // 合并放在队列里做，保证每次都基于最新的 settings。
    settings = await saveDesktopSettings(app.getPath('userData'), { ...settings, ...patch });
  }).catch(() => {});
  return persistQueue;
}

/** 改动监听方式或信令地址后重新载入窗口，让渲染进程拿到新的 bootstrap。 */
async function reloadRenderer() {
  buildMenu();
  mainWindow?.webContents.reload();
}

async function setLanHosting(enabled) {
  await persist({ lanHosting: enabled === true });
  await applyServerSettings();
  await reloadRenderer();
  return bootstrapPayload();
}

async function setServerAddress(address) {
  const trimmed = typeof address === 'string' ? address.trim() : '';
  if (trimmed === '') {
    await persist({ remoteSignalingUrl: null });
  } else {
    // 非法输入直接抛回渲染进程，由联机页面显示错误提示。
    await persist({ remoteSignalingUrl: normalizeSignalingAddress(trimmed) });
  }
  await reloadRenderer();
  return bootstrapPayload();
}

function showLanAddresses() {
  const addresses = server.shareAddresses;
  const detail = addresses.length === 0
    ? (server.lanHosting ? strings.addressesEmpty : strings.lanOffBody)
    : `${strings.addressesBody}\n\n${addresses
      .map((entry) => `${entry.host}:${entry.port}\n  ${entry.pageUrl}`)
      .join('\n\n')}`;
  dialog.showMessageBox({
    type: addresses.length === 0 ? 'info' : 'none',
    title: server.lanHosting ? strings.addressesTitle : strings.lanOffTitle,
    message: server.lanHosting ? strings.addressesTitle : strings.lanOffTitle,
    detail,
  }).catch(() => {});
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: strings.game,
      submenu: [
        {
          label: strings.fullscreen,
          accelerator: isMac ? 'Control+Command+F' : 'F11',
          click: () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()),
        },
        { label: strings.reload, accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: strings.quit, accelerator: 'CmdOrCtrl+Q', role: 'quit' }]),
      ],
    },
    {
      label: strings.network,
      submenu: [
        {
          label: strings.lanHosting,
          type: 'checkbox',
          checked: server.lanHosting,
          click: (item) => { void setLanHosting(item.checked); },
        },
        { label: strings.showAddresses, click: showLanAddresses },
        { type: 'separator' },
        {
          label: strings.useLocal,
          enabled: settings?.remoteSignalingUrl !== null,
          click: () => { void setServerAddress(''); },
        },
      ],
    },
    {
      label: strings.view,
      submenu: [
        { label: strings.zoomReset, role: 'resetZoom' },
        { label: strings.zoomIn, role: 'zoomIn' },
        { label: strings.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: strings.devTools, accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I', role: 'toggleDevTools' },
      ],
    },
    {
      label: strings.help,
      submenu: [
        {
          label: strings.checkUpdates,
          enabled: updaterMode !== 'off',
          click: () => { void checkForUpdates({ manual: true }); },
        },
        { type: 'separator' },
        {
          label: strings.about,
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: strings.about,
              message: 'WindChaser',
              detail: formatMenuString(strings.aboutBody, {
                version: app.getVersion(),
                electron: process.versions.electron,
                chrome: process.versions.chrome,
              }),
            }).catch(() => {});
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveRendererFile(RENDERER_ROOT, request.url);
    if (file === null) return new Response('Not Found', { status: 404 });
    try {
      return await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function createWindow() {
  const bounds = visibleBounds(
    settings.windowBounds,
    screen.getAllDisplays().map((display) => display.workArea),
  );
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1600,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b1d2c',
    title: 'WindChaser',
    show: false,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 窗口失焦时不要降频：航行是连续物理仿真，掉到 1fps 会让联机状态跑飞。
      backgroundThrottling: false,
    },
  });

  if (settings.fullscreen) mainWindow.setFullScreen(true);
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 游戏本身不开新窗口，也不需要站内跳转；外链一律交给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    } catch { /* 畸形 URL：什么都不做，照样拒绝开窗 */ }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  });

  // 'resized'/'moved' 只在 macOS 与 Windows 触发（Electron 文档里标着
  // @platform darwin,win32），Linux 上一个都收不到，窗口几何就永远存不下来。
  // 通用的 'resize'/'move' 三个平台都有，但拖动时每帧都发，所以做个防抖。
  let boundsTimer = null;
  const rememberBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (!mainWindow || mainWindow.isFullScreen() || mainWindow.isMinimized()) return;
      void persist({ windowBounds: mainWindow.getNormalBounds() });
    }, 400);
    boundsTimer.unref?.();
  };
  mainWindow.on('resize', rememberBounds);
  mainWindow.on('move', rememberBounds);
  // 在进入/退出全屏时就写盘；等到 'close' 再写，异步落盘可能赶不上进程退出。
  mainWindow.on('enter-full-screen', () => { void persist({ fullscreen: true }); });
  mainWindow.on('leave-full-screen', () => { void persist({ fullscreen: false }); });
  mainWindow.on('closed', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = null;
    mainWindow = null;
  });

  void mainWindow.loadURL(APP_INDEX_URL);
}

function registerIpc() {
  // 同步取 bootstrap：preload 在页面脚本之前执行，异步拿不到就来不及注入。
  ipcMain.on('windchaser:bootstrap', (event) => {
    event.returnValue = bootstrapPayload();
  });
  ipcMain.handle('windchaser:set-server-address', (_event, address) => setServerAddress(address));
}

/**
 * 接上自动更新。electron-updater 只在打包后有意义，开发模式与冒烟自检里
 * 直接跳过（也避免自检进程去连 GitHub）。
 *
 * 模式是同步算出来的（菜单项要用），但 electron-updater 本体懒加载：它是可选
 * 功能，不该占着启动路径，更不该因为它加载不出来（asar 里漏文件、文件损坏）
 * 就让整个游戏打不开——之前那样会走到 whenReady 的 catch 里弹错误框然后退出。
 */
function updaterEnabled() {
  return process.env.WINDCHASER_SMOKE ? 'off' : updateMode(detectUpdateContext({ app }));
}

function ensureUpdater() {
  if (updaterMode === 'off') return Promise.resolve(null);
  updaterPromise ??= import('electron-updater').then(({ autoUpdater }) => createUpdater({
    autoUpdater,
    mode: updaterMode,
    strings,
    format: formatMenuString,
    dialog,
    openExternal: (url) => shell.openExternal(url),
    currentVersion: app.getVersion(),
  })).catch(() => null);
  return updaterPromise;
}

async function checkForUpdates({ manual = false } = {}) {
  const instance = await ensureUpdater();
  await instance?.check({ manual });
}

/**
 * 冒烟自检：tools/test-desktop.mjs 用它确认桌面壳能起窗口、渲染进程能拿到
 * WebGL 上下文与桥接地址、localStorage 可写（存档不会因端口变化丢失）；
 * WINDCHASER_SMOKE=lan 时再验证 app:// 页面能连上监听在局域网网卡上的 ws://，
 * 也就是「一台主持、其他人加入」这条路没有被混合内容策略挡掉。
 */
function smokeScript(lanSignalUrl) {
  return `(async () => {
    const report = {
      origin: location.origin,
      secureContext: isSecureContext,
      game: Boolean(globalThis.__game),
      webgl: Boolean(globalThis.__game?.renderer?.getContext?.()),
      rtc: typeof globalThis.RTCPeerConnection === 'function',
      bridge: globalThis.windchaser?.signalingUrl ?? null,
      storage: (() => {
        try {
          localStorage.setItem('windchaser.smoke', 'ok');
          return localStorage.getItem('windchaser.smoke');
        } catch { return null; }
      })(),
      lan: null,
    };
    const lanUrl = ${JSON.stringify(lanSignalUrl)};
    if (lanUrl) {
      report.lan = await new Promise((resolve) => {
        let socket = null;
        const finish = (value) => {
          clearTimeout(timer);
          try { socket?.close(); } catch {}
          resolve(value);
        };
        const timer = setTimeout(() => finish('timeout'), 5000);
        try { socket = new WebSocket(lanUrl); } catch (error) { finish('throw:' + error.name); return; }
        socket.onopen = () => finish('open');
        socket.onerror = () => finish('error');
      });
    }
    return JSON.stringify(report);
  })()`;
}

async function runSmokeCheck() {
  const contents = mainWindow.webContents;
  try {
    await new Promise((resolve, reject) => {
      if (!contents.isLoading()) { resolve(); return; }
      contents.once('did-finish-load', resolve);
      contents.once('did-fail-load', (_event, code, description) => {
        reject(new Error(`did-fail-load ${code} ${description}`));
      });
    });
    const lanSignalUrl = server.shareAddresses[0]?.signalUrl ?? null;
    const rendererReport = await contents.executeJavaScript(smokeScript(lanSignalUrl));
    process.stdout.write(`WINDCHASER_SMOKE ${JSON.stringify({
      ...JSON.parse(rendererReport),
      port: server.port,
      lanHosting: server.lanHosting,
      lanSignalUrl,
    })}\n`);
  } catch (error) {
    process.stdout.write(`WINDCHASER_SMOKE ${JSON.stringify({ error: String(error) })}\n`);
  } finally {
    app.exit(0);
  }
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => { void server.close(); });

app.whenReady().then(async () => {
  settings = await loadDesktopSettings(app.getPath('userData'));
  if (process.env.WINDCHASER_SMOKE === 'lan') {
    // 自检用临时端口，免得和玩家真在跑的房间抢 8787。
    settings = { ...settings, lanHosting: true, lanPort: 18_787 };
  }
  strings = menuStrings(app.getLocale());
  registerAppProtocol();
  registerIpc();
  await applyServerSettings();
  updaterMode = updaterEnabled();
  buildMenu();
  createWindow();
  // 启动即查会和首屏加载抢带宽，等玩家进到菜单再说。
  setTimeout(() => { void checkForUpdates(); }, 20_000).unref?.();
  if (process.env.WINDCHASER_SMOKE) void runSmokeCheck();
}).catch((error) => {
  dialog.showErrorBox('WindChaser', error.stack ?? String(error));
  app.exit(1);
});
