// 桌面端偏好：写在 Electron 的 userData 目录，和游戏内 localStorage 的设置分开。
// 只保存窗口几何、局域网主持开关和「加入的主机地址」——这些在渲染进程启动前
// 就要用到，无法放进 localStorage。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 直接取共用的纯字符串模块：从 localServer.js 转手会把 ws、node:http 和整套
// 信令实现拖进启动路径，而这里只用到两个跟服务无关的常量/函数。
import { DEFAULT_SIGNAL_PORT, normalizeSignalingAddress } from '../src/net/inviteCode.js';

export const SETTINGS_FILE = 'desktop-settings.json';

export const DEFAULT_SETTINGS = Object.freeze({
  lanHosting: false,
  lanPort: DEFAULT_SIGNAL_PORT,
  remoteSignalingUrl: null,
  windowBounds: null,
  fullscreen: false,
});

function sanitizeBounds(value) {
  if (value === null || typeof value !== 'object') return null;
  const fields = ['x', 'y', 'width', 'height'];
  const bounds = {};
  for (const field of fields) {
    const entry = value[field];
    if (!Number.isFinite(entry)) return null;
    bounds[field] = Math.round(entry);
  }
  if (bounds.width < 320 || bounds.height < 240) return null;
  return bounds;
}

/**
 * 容忍损坏或被手改过的设置文件：任何非法字段都退回默认值，而不是让应用起不来。
 */
export function sanitizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  let remoteSignalingUrl = null;
  if (typeof source.remoteSignalingUrl === 'string' && source.remoteSignalingUrl !== '') {
    try {
      remoteSignalingUrl = normalizeSignalingAddress(source.remoteSignalingUrl);
    } catch {
      remoteSignalingUrl = null;
    }
  }
  const lanPort = Number.isSafeInteger(source.lanPort)
    && source.lanPort > 0
    && source.lanPort <= 65_535
    ? source.lanPort
    : DEFAULT_SETTINGS.lanPort;
  return {
    lanHosting: source.lanHosting === true,
    lanPort,
    remoteSignalingUrl,
    windowBounds: sanitizeBounds(source.windowBounds ?? null),
    fullscreen: source.fullscreen === true,
  };
}

/**
 * 把存下来的窗口几何裁到「至少有一块看得见」。
 *
 * 位置可能来自一台已经拔掉的外接显示器（x=2560 之类）。窗口开在所有屏幕之外
 * 就等于既看不见也拖不回来，只能手删配置文件；这种情况丢掉坐标、保留尺寸，
 * 交给 Electron 居中。workAreas 由调用方从 screen.getAllDisplays() 取，
 * 这样这段判断不依赖 Electron，能单测。
 */
export function visibleBounds(bounds, workAreas = []) {
  if (bounds === null || typeof bounds !== 'object') return null;
  const fits = workAreas.some((area) => {
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width)
      - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height)
      - Math.max(bounds.y, area.y);
    // 要露出抓得住的一块标题栏，只擦到一个角不算「看得见」。
    return overlapX >= 120 && overlapY >= 40;
  });
  return fits ? bounds : { width: bounds.width, height: bounds.height };
}

export function settingsPath(userDataDir) {
  if (typeof userDataDir !== 'string' || userDataDir === '') {
    throw new TypeError('userDataDir must be a non-empty string');
  }
  return path.join(userDataDir, SETTINGS_FILE);
}

export async function loadDesktopSettings(userDataDir) {
  try {
    const text = await readFile(settingsPath(userDataDir), 'utf8');
    return sanitizeSettings(JSON.parse(text));
  } catch {
    return sanitizeSettings(null);
  }
}

export async function saveDesktopSettings(userDataDir, settings) {
  const file = settingsPath(userDataDir);
  const clean = sanitizeSettings(settings);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
  return clean;
}
