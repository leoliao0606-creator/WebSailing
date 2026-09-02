// 桌面版（Electron）通过 preload 注入的 window.windchaser。
// 网页版没有这个对象，下面的函数返回 null/undefined，联机页面的桌面控件自动隐藏，
// 信令地址也回落到同源 /signal —— 两个形态共用同一份渲染代码。

export function desktopBridge(scope = globalThis) {
  const bridge = scope?.windchaser;
  if (!bridge || bridge.desktop !== true) return null;
  return bridge;
}

/**
 * 桌面版要连的信令地址：本机内置服务，或玩家填写的局域网房主地址。
 * 网页版返回 undefined，让 SignalingClient 继续用页面同源的 /signal。
 */
export function desktopSignalingUrl(scope = globalThis) {
  const url = desktopBridge(scope)?.signalingUrl;
  return typeof url === 'string' && url !== '' ? url : undefined;
}
