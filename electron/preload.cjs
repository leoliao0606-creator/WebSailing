// 预加载脚本：沙箱模式下只能 require electron 内置模块，因此保持自包含。
// 只暴露渲染进程真正用到的东西——本机信令地址与切换服务器的动作。局域网开关、
// 全屏切换都由原生菜单在主进程里直接做，没必要在页面里留一个能绑 0.0.0.0 的入口。
const { contextBridge, ipcRenderer } = require('electron');

const bootstrap = ipcRenderer.sendSync('windchaser:bootstrap');

contextBridge.exposeInMainWorld('windchaser', {
  desktop: true,
  signalingUrl: bootstrap.signalingUrl,
  remoteAddress: bootstrap.remoteAddress,
  shareAddresses: bootstrap.shareAddresses,
  setServerAddress: (address) => ipcRenderer.invoke('windchaser:set-server-address', address),
});
