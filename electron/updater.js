// 自动更新：从 GitHub Releases 拉新版本。
//
// 只有能就地替换自身的安装形态才做「后台下载完，重启装上」：Windows 安装包
// 与 Linux 的 AppImage。其余情况降级成「查到新版就提示，点一下去下载页」：
//   - macOS：Squirrel.Mac 要求应用已签名，未签名的包下载完也装不上；
//   - Linux 的 deb / tar.gz：electron-updater 本来就不支持就地更新。
// 判断逻辑独立成纯函数，方便在没有 Electron 的环境里测。

export const RELEASES_URL = 'https://github.com/leoliao0606-creator/WebSailing/releases/latest';

/**
 * 决定这次安装该走哪种更新方式。
 * @returns {'install'|'notify'|'off'}
 */
export function updateMode({
  platform,
  packaged = true,
  appImage = false,
  signed = false,
} = {}) {
  if (!packaged) return 'off';           // 开发模式下没有已发布版本可比
  if (platform === 'win32') return 'install';
  if (platform === 'darwin') return signed ? 'install' : 'notify';
  if (platform === 'linux') return appImage ? 'install' : 'notify';
  return 'notify';
}

/**
 * 从运行环境读出 updateMode() 需要的事实。
 */
export function detectUpdateContext({ app, env = process.env, platform = process.platform } = {}) {
  return {
    platform,
    packaged: app?.isPackaged === true,
    // AppImage 运行时会把自身路径写进 APPIMAGE，electron-updater 也认这个变量
    appImage: typeof env.APPIMAGE === 'string' && env.APPIMAGE !== '',
    // 未签名的 macOS 包过不了 Squirrel.Mac 校验；打包流水线配好签名后置 1
    signed: platform !== 'darwin' || env.WINDCHASER_MAC_SIGNED === '1',
  };
}

/**
 * 接上 electron-updater。返回 { mode, check }，check 供菜单手动触发；
 * mode 为 'off' 时 check 是空操作。
 */
export function createUpdater({
  autoUpdater,
  mode,
  strings,
  format,
  dialog,
  openExternal,
  currentVersion = '',
  releasesUrl = RELEASES_URL,
} = {}) {
  if (mode === 'off' || !autoUpdater) return { mode: 'off', check: async () => null };

  autoUpdater.autoDownload = mode === 'install';
  autoUpdater.autoInstallOnAppQuit = mode === 'install';
  // 更新出错不该打断航行；只有玩家手动检查时才把失败说出来。
  autoUpdater.on('error', () => {});

  let announcedVersion = null;

  async function announce(version) {
    if (announcedVersion === version) return;
    announcedVersion = version;
    const notifyOnly = mode === 'notify';
    const answer = await dialog.showMessageBox({
      type: 'info',
      title: notifyOnly ? strings.updateFoundTitle : strings.updateReadyTitle,
      message: format(notifyOnly ? strings.updateFoundTitle : strings.updateReadyTitle, { version }),
      detail: format(notifyOnly ? strings.updateNotifyBody : strings.updateReadyBody, { version }),
      buttons: [notifyOnly ? strings.updateOpenPage : strings.updateRestart, strings.updateLater],
      // 就地更新会重启应用，默认停在「稍后」，别把人从比赛里踢出去
      defaultId: 1,
      cancelId: 1,
    });
    if (answer.response !== 0) return;
    if (notifyOnly) await openExternal(releasesUrl);
    else autoUpdater.quitAndInstall();
  }

  const announceEvent = mode === 'install' ? 'update-downloaded' : 'update-available';
  autoUpdater.on(announceEvent, (info) => {
    void announce(info?.version ?? '').catch(() => {});
  });

  async function check({ manual = false } = {}) {
    // 手动检查时清掉去重记号，让同一个版本能再提示一次
    if (manual) announcedVersion = null;
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result?.isUpdateAvailable === true) return result?.updateInfo?.version ?? null;
      if (manual) {
        dialog.showMessageBox({
          type: 'info',
          title: strings.updateNoneTitle,
          message: strings.updateNoneTitle,
          detail: format(strings.updateNoneBody, { version: currentVersion }),
        }).catch(() => {});
      }
      return null;
    } catch (error) {
      if (manual) {
        dialog.showMessageBox({
          type: 'warning',
          title: strings.updateFailedTitle,
          message: strings.updateFailedTitle,
          detail: String(error?.message ?? error),
        }).catch(() => {});
      }
      return null;
    }
  }

  return { mode, check };
}
