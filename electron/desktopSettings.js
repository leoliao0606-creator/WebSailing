// 桌面端偏好：写在 Electron 的 userData 目录，和游戏内 localStorage 的设置分开。
// 只保存窗口几何、局域网主持开关和「加入的主机地址」——这些在渲染进程启动前
// 就要用到，无法放进 localStorage。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_LAN_PORT, normalizeSignalingAddress } from './localServer.js';

export const SETTINGS_FILE = 'desktop-settings.json';

export const DEFAULT_SETTINGS = Object.freeze({
  lanHosting: false,
  lanPort: DEFAULT_LAN_PORT,
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
