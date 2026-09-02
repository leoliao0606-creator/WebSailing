// 原生菜单文案。语种与游戏内一致（中文 / English / 日本語），
// 首次启动按系统区域挑选；游戏内切换语言不改原生菜单，避免重建窗口。

const zh = {
  game: '游戏',
  fullscreen: '切换全屏',
  reload: '重新载入',
  quit: '退出',
  network: '联机',
  lanHosting: '允许局域网加入',
  showAddresses: '显示本机局域网地址',
  useLocal: '使用本机服务',
  view: '视图',
  zoomIn: '放大',
  zoomOut: '缩小',
  zoomReset: '实际大小',
  devTools: '开发者工具',
  help: '帮助',
  about: '关于逐风',
  addressesTitle: '局域网地址',
  addressesBody: '同一局域网的队友可以在「多人联机」页面填写下面任意一个地址，'
    + '或直接用浏览器打开对应网址游玩：',
  addressesEmpty: '没有检测到可用的局域网地址。请确认已连接 Wi‑Fi 或有线网络，'
    + '并已在「联机」菜单里打开「允许局域网加入」。',
  lanOffTitle: '尚未开启局域网主持',
  lanOffBody: '请先在「联机」菜单里勾选「允许局域网加入」。',
  lanFailedTitle: '局域网主持启动失败',
  lanFailedBody: '端口 {port} 可能已被占用，已退回仅本机可用。',
  aboutBody: '逐风 WindChaser · 稳向板帆船模拟\n版本 {version}\nElectron {electron} · Chromium {chrome}',
  checkUpdates: '检查更新',
  updateFoundTitle: '有新版本 {version}',
  updateReadyTitle: '新版本 {version} 已就绪',
  updateNotifyBody: '当前安装形态不支持就地更新，请到发布页下载 {version} 覆盖安装。',
  updateDownloadingBody: '正在后台下载 {version}，完成后会提示重启。',
  updateReadyBody: '{version} 已下载完成，重启后生效。比赛进行中可以先选「稍后」。',
  updateOpenPage: '打开下载页',
  updateRestart: '重启并安装',
  updateLater: '稍后',
  updateNoneTitle: '已是最新版本',
  updateNoneBody: '当前版本 {version}。',
  updateFailedTitle: '检查更新失败',
};

const en = {
  game: 'Game',
  fullscreen: 'Toggle Full Screen',
  reload: 'Reload',
  quit: 'Quit',
  network: 'Multiplayer',
  lanHosting: 'Allow LAN players to join',
  showAddresses: 'Show this machine’s LAN address',
  useLocal: 'Use the built-in server',
  view: 'View',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  zoomReset: 'Actual Size',
  devTools: 'Developer Tools',
  help: 'Help',
  about: 'About WindChaser',
  addressesTitle: 'LAN addresses',
  addressesBody: 'Crew on the same network can enter one of these in the Multiplayer screen, '
    + 'or open the matching URL in a browser:',
  addressesEmpty: 'No usable LAN address was found. Check that Wi‑Fi or Ethernet is connected '
    + 'and that “Allow LAN players to join” is enabled in the Multiplayer menu.',
  lanOffTitle: 'LAN hosting is off',
  lanOffBody: 'Enable “Allow LAN players to join” in the Multiplayer menu first.',
  lanFailedTitle: 'LAN hosting failed to start',
  lanFailedBody: 'Port {port} is probably in use; the server fell back to this machine only.',
  aboutBody: 'WindChaser · dinghy sailing simulator\nVersion {version}\n'
    + 'Electron {electron} · Chromium {chrome}',
  checkUpdates: 'Check for Updates',
  updateFoundTitle: 'Version {version} is available',
  updateReadyTitle: 'Version {version} is ready',
  updateNotifyBody: 'This install cannot update itself; download {version} from the releases page.',
  updateDownloadingBody: 'Downloading {version} in the background; you will be asked to restart when it is ready.',
  updateReadyBody: '{version} has been downloaded and applies on restart. Pick “Later” if a race is running.',
  updateOpenPage: 'Open releases page',
  updateRestart: 'Restart and install',
  updateLater: 'Later',
  updateNoneTitle: 'Already up to date',
  updateNoneBody: 'Running version {version}.',
  updateFailedTitle: 'Update check failed',
};

const ja = {
  game: 'ゲーム',
  fullscreen: 'フルスクリーン切替',
  reload: '再読み込み',
  quit: '終了',
  network: 'マルチプレイ',
  lanHosting: 'LAN からの参加を許可',
  showAddresses: 'この端末の LAN アドレスを表示',
  useLocal: '内蔵サーバーを使う',
  view: '表示',
  zoomIn: '拡大',
  zoomOut: '縮小',
  zoomReset: '実際のサイズ',
  devTools: '開発者ツール',
  help: 'ヘルプ',
  about: 'WindChaser について',
  addressesTitle: 'LAN アドレス',
  addressesBody: '同じネットワークの仲間は「マルチプレイ」画面で次のいずれかを入力するか、'
    + '対応する URL をブラウザーで開いてください：',
  addressesEmpty: '利用できる LAN アドレスが見つかりません。Wi‑Fi または有線接続を確認し、'
    + '「マルチプレイ」メニューで「LAN からの参加を許可」を有効にしてください。',
  lanOffTitle: 'LAN ホストが無効です',
  lanOffBody: '先に「マルチプレイ」メニューで「LAN からの参加を許可」を有効にしてください。',
  lanFailedTitle: 'LAN ホストを開始できません',
  lanFailedBody: 'ポート {port} が使用中の可能性があります。この端末のみに切り替えました。',
  aboutBody: 'WindChaser · ディンギー航海シミュレーター\nバージョン {version}\n'
    + 'Electron {electron} · Chromium {chrome}',
  checkUpdates: '更新を確認',
  updateFoundTitle: '新しいバージョン {version} があります',
  updateReadyTitle: 'バージョン {version} の準備ができました',
  updateNotifyBody: 'このインストール形式は自動更新に対応していません。リリースページから {version} を入手してください。',
  updateDownloadingBody: '{version} をバックグラウンドでダウンロードしています。完了後に再起動を確認します。',
  updateReadyBody: '{version} のダウンロードが完了しました。再起動で適用されます。レース中は「後で」を選んでください。',
  updateOpenPage: 'リリースページを開く',
  updateRestart: '再起動してインストール',
  updateLater: '後で',
  updateNoneTitle: '最新バージョンです',
  updateNoneBody: '現在のバージョンは {version} です。',
  updateFailedTitle: '更新の確認に失敗しました',
};

const DICTIONARIES = { zh, en, ja };

export function menuLanguage(locale) {
  const tag = typeof locale === 'string' ? locale.toLowerCase() : '';
  if (tag.startsWith('zh')) return 'zh';
  if (tag.startsWith('ja')) return 'ja';
  return 'en';
}

export function menuStrings(locale) {
  return DICTIONARIES[menuLanguage(locale)];
}

export function formatMenuString(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    Object.hasOwn(vars, key) ? String(vars[key]) : match
  ));
}
