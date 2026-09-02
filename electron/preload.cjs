// 预加载脚本：沙箱模式下只能 require electron 内置模块，因此保持自包含。
// 只向页面暴露桌面版必需的最小接口——本机信令地址与切换主机的动作。
const { contextBridge, ipcRenderer } = require('electron');

const bootstrap = ipcRenderer.sendSync('windchaser:bootstrap');

contextBridge.exposeInMainWorld('windchaser', {
  desktop: true,
  platform: bootstrap.platform,
  version: bootstrap.version,
  signalingUrl: bootstrap.signalingUrl,
  serverMode: bootstrap.serverMode,
  remoteAddress: bootstrap.remoteAddress,
  lanHosting: bootstrap.lanHosting,
  lanPort: bootstrap.lanPort,
  shareAddresses: bootstrap.shareAddresses,
  setServerAddress: (address) => ipcRenderer.invoke('windchaser:set-server-address', address),
  setLanHosting: (enabled) => ipcRenderer.invoke('windchaser:set-lan-hosting', enabled),
  lanAddresses: () => ipcRenderer.invoke('windchaser:lan-addresses'),
  toggleFullscreen: () => ipcRenderer.invoke('windchaser:toggle-fullscreen'),
});
