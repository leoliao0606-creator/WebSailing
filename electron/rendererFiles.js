// app:// 协议的路径解析。渲染进程从固定来源 app://windchaser 加载，
// 使 localStorage（最佳成绩、幽灵船、设置）跨版本与跨启动保持稳定；
// 若改用 http://127.0.0.1:<随机端口>，每次换端口都会换来源并清空存档。

import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'windchaser';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 把一次 app:// 请求映射到 dist 内的绝对路径；越界、异常主机或畸形转义返回 null。
 */
export function resolveRendererFile(root, requestUrl) {
  if (typeof root !== 'string' || root === '') throw new TypeError('root must be a non-empty string');
  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  decoded = decoded.replaceAll('\\', '/');
  if (decoded.includes('\0') || decoded.split('/').includes('..')) return null;

  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relative);
  return isInside(resolvedRoot, candidate) ? candidate : null;
}
