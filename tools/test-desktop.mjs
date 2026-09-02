#!/usr/bin/env node
// 桌面壳冒烟检查：起一次真正的 Electron 进程，确认
//   1. app:// 能加载 Vite 构建产物，渲染进程拿到 WebGL 上下文；
//   2. preload 注入的桥接地址指向本机信令服务，且该服务确实在监听；
//   3. localStorage 可写 —— 页面来源固定，最佳成绩与幽灵船不会因换端口丢失。
// 无显示环境自动套 xvfb-run；先执行 npm run build。

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 90_000;

async function exists(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  process.stderr.write(`desktop smoke: ${message}\n`);
  process.exitCode = 1;
}

// --bin=<路径> 让同一套检查也能跑打包产物（如 release/linux-unpacked/windchaser）,
// 这样「开发能跑、装完打不开」这类漏文件的问题会被挡在发布之前。
const binArg = process.argv.find((arg) => arg.startsWith('--bin='))?.slice('--bin='.length);
const electronBin = binArg
  ? path.resolve(ROOT, binArg)
  : path.join(ROOT, 'node_modules', '.bin', 'electron');
if (!await exists(electronBin)) {
  fail(binArg ? `${electronBin} is not executable` : 'electron is not installed; run npm install first');
  process.exit(1);
}
if (!await exists(path.join(ROOT, 'dist', 'index.html')).catch(() => false)
  && !await exists(path.join(ROOT, 'dist'))) {
  fail('dist/ is missing; run npm run build first');
  process.exit(1);
}

// --lan：额外验证 app:// 页面能连上监听在局域网网卡上的 ws://（主持模式的关键路径）。
const lanMode = process.argv.includes('--lan');

const headless = process.platform === 'linux' && !process.env.DISPLAY;
const useXvfb = headless || process.env.WINDCHASER_XVFB === '1';
const command = useXvfb ? 'xvfb-run' : electronBin;
const baseArgs = [
  // 打包产物自带 app.asar，不需要（也不能）再传项目目录。
  ...(binArg ? [] : ['.']),
  // 无 GPU 的 CI/容器里退回软件光栅，否则拿不到 WebGL2 上下文。
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--no-sandbox',
];
const args = useXvfb ? ['-a', electronBin, ...baseArgs] : baseArgs;

const child = spawn(command, args, {
  cwd: ROOT,
  env: {
    ...process.env,
    WINDCHASER_SMOKE: lanMode ? 'lan' : '1',
    // 独立的用户数据目录：不污染玩家存档，也跳过单实例锁。
    WINDCHASER_USER_DATA: path.join(ROOT, 'node_modules', '.cache', 'windchaser-smoke'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });

const timer = setTimeout(() => {
  child.kill('SIGKILL');
  fail(`timed out after ${TIMEOUT_MS}ms`);
}, TIMEOUT_MS);

child.on('close', async () => {
  clearTimeout(timer);
  const line = stdout.split('\n').find((entry) => entry.startsWith('WINDCHASER_SMOKE '));
  if (!line) {
    fail(`no smoke report on stdout\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
    return;
  }
  const report = JSON.parse(line.slice('WINDCHASER_SMOKE '.length));
  const checks = [
    ['renderer loaded from the app scheme', report.origin === 'app://windchaser'],
    ['renderer runs in a secure context', report.secureContext === true],
    ['game bootstrapped', report.game === true],
    ['WebGL context created', report.webgl === true],
    ['RTCPeerConnection available', report.rtc === true],
    ['preload exposed the local signaling url', report.bridge === `ws://127.0.0.1:${report.port}/signal`],
    ['localStorage is writable', report.storage === 'ok'],
    lanMode
      ? ['LAN hosting binds a shareable address', typeof report.lanSignalUrl === 'string']
      : ['signaling server listens on loopback only', report.lanHosting === false],
  ];
  if (lanMode) checks.push(['page reaches the LAN signaling socket', report.lan === 'open']);
  for (const [label, ok] of checks) {
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
    if (!ok) process.exitCode = 1;
  }
  if (report.error) fail(report.error);

  if (process.exitCode) {
    process.stderr.write(`--- report ---\n${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`--- stderr ---\n${stderr}\n`);
  }
});
