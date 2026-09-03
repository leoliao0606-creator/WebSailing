# 逐风 WindChaser · 3D 稳向板帆船模拟

一款硬核拟真的稳向板帆船（ILCA/Laser 级）游戏，可以**在浏览器里跑，也可以装成 macOS / Windows / Linux 的本地桌面程序**。
纯 Three.js + 自研帆船动力学，无任何外部美术/音频素材 —— 船体、帆、水面、岛屿、音效全部程序化生成。

![模式] 自由航行 · 绕标计时赛（含幽灵船） · AI 对手竞速 · 2–8 人私人联机绕标赛 · 交互式新手教学（10 课）

界面支持 **中文 / English / 日本語**（设置中即时切换，首次启动按浏览器语言自动选择）。

## 运行与检查

推荐 Node.js 22。首次运行先安装依赖：

```bash
npm install
```

网页版需要支持 WebGL2 的现代浏览器（Chrome / Edge / Firefox / Safari 16+）；
桌面版自带 Chromium，不依赖系统浏览器，详见 [桌面版（macOS / Windows / Linux）](#桌面版macos--windows--linux)。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | Vite 开发服务器，默认 `http://localhost:5173`，并代理 `/signal` |
| `npm run build` | 构建 `dist/` 静态站点 |
| `npm run preview` | 仅预览构建产物，默认 `http://localhost:4173` |
| `npm run desktop` | 构建后用 Electron 打开桌面版（本机开发用） |
| `npm run dist` | 为当前系统打包桌面安装包，产物在 `release/` |
| `npm run dist:mac` / `dist:win` / `dist:linux` | 为指定平台打包 |
| `npm run test:desktop` | 桌面壳冒烟检查（起真实 Electron 进程） |
| `npm run signal` | 启动信令及静态文件服务，默认 `http://localhost:8787` |
| `npm run serve` | `npm run signal` 的部署别名 |
| `npm test` / `npm run test:unit` | 运行 Node 单元及集成测试 |
| `npm run test:multiplayer` | 运行 Playwright 三浏览器联机与迁移回归 |
| `npm run polar` | 输出极曲线并做物理自检；可传风速，如 `npm run polar -- 18` |

首次运行浏览器回归前还需安装 Playwright Chromium：

```bash
npx playwright install chromium
```

`npm run test:multiplayer` 会自行启动临时 Vite/信令服务和三个隔离的浏览器上下文，无需先手动启动服务。测试会关闭原房主，并验证新房主与另一名幸存访客在 5 秒内继续同步。CI 若使用系统 Chromium，可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定其可执行文件。

详细覆盖范围、实测结果和仍未验证的边界见 [私人多人绕标赛验证记录](docs/multiplayer-verification.md)。

## 桌面版（macOS / Windows / Linux）

桌面版和网页版是同一份代码，不存在第二套实现：`src/` 仍由 Vite 构建成 `dist/`，`server/` 的信令服务原样复用，Electron 只是把「静态站点 + 信令进程 + 浏览器」装进一个可执行文件。

```bash
npm install
npm run desktop      # 构建 dist/ 并直接打开桌面版
npm run dist         # 为当前系统打包安装包到 release/
```

`npm run dist` 的默认产物：

| 平台 | 产物 |
| --- | --- |
| macOS | `.dmg` 与 `.zip`（arm64 + x64） |
| Windows | NSIS 安装包（x64 + arm64）与免安装 `.exe`（x64） |
| Linux | `.AppImage`（x64 + arm64）、`.deb`（x64）、`.tar.gz`（x64 + arm64） |

打包配置在 `electron-builder.yml`。electron-builder 只能在对应平台上产出该平台的安装包（macOS 包需要 macOS 机器），交叉打包请用各平台的 CI runner。默认**不做代码签名**：本机安装可用，但 macOS 首次打开需右键「打开」绕过 Gatekeeper，Windows 会弹 SmartScreen 提示。对外分发时通过 `CSC_LINK` / `CSC_KEY_PASSWORD`（以及 macOS 的 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`）配置签名与公证。

### 桌面版的三点结构差异

- **页面来源固定为 `app://windchaser`**，由自定义协议直接读取打包进去的 `dist/`。这样 `localStorage` 里的最佳成绩、幽灵船和画质设置不会因为本机端口变化而丢失 —— 若改用 `http://127.0.0.1:<随机端口>`，每次换端口都相当于换了一个站点，存档全部清零。
- **信令服务跑在主进程内**，单机时只监听回环、端口交给内核分配；页面地址由 preload 注入的 `window.windchaser.signalingUrl` 提供，而不是网页版的同源 `/signal`。
- **窗口失焦不降频**（`backgroundThrottling: false`）：航行是连续物理仿真，浏览器默认的后台降频会让联机状态跑飞。

渲染进程仍按 Electron 推荐姿势收紧：`contextIsolation` + `sandbox` 打开、`nodeIntegration` 关闭，preload 只暴露信令地址与切换主机这几个动作，外链一律交给系统浏览器。

### 局域网联机

桌面版之间不需要任何公网服务，同一个 Wi‑Fi/局域网就能开房：

1. **房主**：菜单栏 →「联机」→ 勾选「允许局域网加入」。服务改为监听所有网卡的 `8787` 端口；再点「显示本机局域网地址」拿到形如 `192.168.1.20:8787` 的地址。
2. **房主建好房间后**，在大厅点「复制邀请码」，得到一串 `192.168.1.20:8787#AB2CD9` —— 井号前是服务器地址，井号后是六位房间码。
3. **其他玩家**：进入「多人联机」页面，把整串邀请码粘进「联机服务器」，点「连接」。窗口重载后房间码已经替他们填好，填个昵称点「加入房间」就行。
4. 想改回单机，点「用本机」或菜单里的「使用本机服务」。

只念地址不发邀请码也行：「联机服务器」同样接受 `192.168.1.20`、`192.168.1.20:8787`、`wss://game.example.cn` 这些写法，房间码照旧手填。邀请码里的地址如果和当前正在用的一致，就只填房间码，不重载窗口。

没装桌面版的队友也可以直接用浏览器打开 `http://192.168.1.20:8787/` —— 房主的进程同时提供构建好的静态站点。

局域网内 WebRTC 靠 host 候选直连，因此桌面版默认不配置 STUN/TURN。**跨公网联机仍然要用 README「联机部署」里的自建信令服务**：把地址填进「联机服务器」即可（`wss://game.example.cn` 这类写法会被识别为 `wss://game.example.cn/signal`）。

信令服务只接受它自己发出去的那些页面：桌面版的 `app://windchaser`，以及主持时的 `http://<本机局域网地址>:8787`、`http://localhost:8787` 和本机主机名。**用别的别名访问会被 403**（比如自己在 hosts 里加的名字），改用「显示本机局域网地址」里列出的地址即可。这条白名单同时挡住了「随便一个网页扫到本机端口就连上来」——所以单机模式下也是开着的。

开启局域网主持等于把游戏静态站点和信令服务暴露给同网段的所有人；房间码之外没有额外鉴权，公共 Wi‑Fi 下用完请关掉。若 `8787` 已被占用，启动时会提示并退回仅本机可用。

### 自动更新

打包后的桌面版启动约 20 秒后会静默检查 GitHub Releases，也可以从「帮助 → 检查更新」手动触发。**能不能就地更新取决于安装形态**：

| 形态 | 行为 |
| --- | --- |
| Windows 安装包 | 后台下载，提示「重启并安装」 |
| Linux AppImage | 同上（AppImage 能替换自身） |
| macOS（已签名） | 同上 |
| macOS（未签名） | 只提示有新版并打开发布页 —— Squirrel.Mac 要求应用已签名，未签名的包下载完也装不上 |
| Linux `.deb` / `.tar.gz` | 只提示并打开发布页 —— electron-updater 不支持这两种形态的就地更新 |

提示框默认停在「稍后」，不会在比赛中途把人踢出去；检查失败只有手动触发时才会报错，后台检查一律静默。开发模式（`npm run desktop`）不检查更新。给 macOS 配好签名后，在打包环境设 `WINDCHASER_MAC_SIGNED=1` 即可切到就地更新。

### 发布流程

推一个 `v*` 标签（或手动触发 `Release` 工作流）会在 macOS / Windows / Ubuntu 三个 runner 上并行打包，产物汇进同一个 GitHub Release 草稿，同时带上 electron-updater 需要的 `latest*.yml`：

```bash
npm version patch      # 或 minor / major
git push --follow-tags
```

工作流在打包前会先跑 `npm run test:unit`。目前**不签名**（`CSC_IDENTITY_AUTO_DISCOVERY: false`）；配好 `CSC_LINK` / `CSC_KEY_PASSWORD`（macOS 再加 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`）这些 secrets 后，把 `.github/workflows/release.yml` 里那一行删掉即可。发布目标写死在 `electron-builder.yml` 的 `publish` 段。

### 存档与配置位置

游戏内设置、最佳成绩和幽灵船仍走 `localStorage`，随 Electron 的用户数据目录走：

| 平台 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/windchaser/` |
| Windows | `%APPDATA%\windchaser\` |
| Linux | `~/.config/windchaser/` |

窗口大小、局域网主持开关和已填写的服务器地址另存在同一目录下的 `desktop-settings.json`（这些在渲染进程启动前就要用到，放不进 `localStorage`）。文件损坏时会静默退回默认值，不会导致启动失败。

想在同一台机器上开两个客户端自测联机，用 `WINDCHASER_USER_DATA` 指定各自独立的数据目录，它同时会跳过单实例锁：

```bash
WINDCHASER_USER_DATA=/tmp/wc-a npm run desktop:run
WINDCHASER_USER_DATA=/tmp/wc-b npm run desktop:run
```

### 桌面壳回归

```bash
npm run test:desktop            # 起真实 Electron 进程做冒烟检查
node tools/test-desktop.mjs --lan               # 额外验证局域网监听这条路
node tools/test-desktop.mjs --bin=release/linux-unpacked/windchaser   # 对打包产物跑同一套检查
```

检查项：`app://` 能加载构建产物、渲染进程拿到 WebGL2 上下文与 `RTCPeerConnection`、preload 注入的地址指向真正在监听的本机信令服务、`localStorage` 可写。无显示环境会自动套 `xvfb-run` 并退回 SwiftShader 软件光栅。`--bin` 那条尤其重要：它挡住「开发模式能跑、装完打不开」这类打包漏文件的问题。

## 本地 2–8 人私人联机

当前联机切片包含六位房间码、临时昵称、准备/开赛、AI 补位和掉线接管、自由文本聊天、比赛作废式异常检测，以及房主迁移后继续比赛。至少两个已连接真人且全员准备后，当前房主才能开赛。

浏览器会连接页面同源的 `/signal`。Vite 开发服务器把这个 WebSocket 路径代理到本地信令服务，因此不需要为了联调反复构建。

终端 1：

```bash
npm run signal
```

终端 2：

```bash
npm run dev
```

然后在两个相互隔离的浏览器配置文件或隐私窗口中打开 `http://localhost:5173`：第一位玩家创建房间并复制六位房间码，第二位玩家输入房间码加入；双方准备后由房主开赛。不要复制已有标签页来模拟第二位玩家，以免同时复制 `sessionStorage` 中的恢复凭据。

开发代理默认目标是 `ws://127.0.0.1:8787`。只有信令服务监听在其他地址时，才需要把 `SIGNALING_TARGET` 注入 **Vite 进程**，例如 `SIGNALING_TARGET=ws://127.0.0.1:9876 npm run dev`；它不是服务端配置，也不会改变生产客户端的同源 `/signal`。

`.env` 不会被 `npm run signal` 自动加载。要试用示例配置，可执行 `cp .env.example .env` 后用 `node --env-file=.env server/index.js` 代替终端 1 的命令；生产环境通常由 shell、容器或进程管理器注入变量。`npm run preview` 只提供静态文件，不能单独完成联机。

## 联机部署

### 构建和进程

生产环境建议分两个阶段：构建阶段执行 `npm ci && npm run build`；运行阶段保留 `dist/`、`server/`、`src/net/protocol.js`、`package.json`/锁文件和生产依赖，再用 `npm ci --omit=dev` 与 `npm run serve` 启动。房间和恢复租约只存在进程内存中，滚动重启会中断当前房间。

服务入口读取以下环境变量；默认值以 `server/index.js` 为准：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | Node HTTP/WebSocket 监听端口，范围 0–65535 |
| `HOST` | `0.0.0.0` | 监听地址；反向代理同机部署可改为 `127.0.0.1` |
| `PUBLIC_DIR` | `<工作目录>/dist` | 要提供的静态文件目录；相对路径按进程工作目录解析 |
| `RECONNECT_GRACE_MS` | `30000` | 普通玩家断线后保留座位和恢复令牌的时间 |
| `HOST_LOSS_MS` | `2500` | 房主连接丢失后、正式迁移权威前的短暂恢复窗口 |
| `HEARTBEAT_MS` | `1000` | 服务端 WebSocket ping 周期，必须大于 0 |
| `MAX_CONNECTIONS` | `1024` | 同一信令进程允许的 WebSocket 连接总数 |
| `MAX_CONNECTIONS_PER_IP` | `64` | 同一客户端地址允许的 WebSocket 连接数；仍应在边缘再做一层限流 |
| `MAX_ROOMS` | `512` | 单进程内存房间数上限 |
| `TRUST_PROXY` | `false` | 是否使用 `X-Forwarded-For` 最左侧地址；仅在 Node 只接受可信代理流量且代理覆盖该头时启用 |
| `SIGNAL_RATE_MAX_MESSAGES` | `120` | 每个信令来源在窗口内允许的消息数 |
| `SIGNAL_RATE_MAX_BYTES` | `262144` | 每个信令来源在窗口内允许的入站字节数；已认证玩家跨重连共享额度 |
| `SIGNAL_RATE_WINDOW_MS` | `1000` | 信令消息数/字节限流窗口 |
| `SIGNAL_ADDRESS_RATE_MULTIPLIER` | `8` | 同一来源地址的粗粒度总额度倍数；身份轮换仍受总额度约束，同时允许一场最多 8 人共享 NAT。中国 CGNAT 误限流时可谨慎调高，但会同步放大单地址攻击预算 |
| `ICE_SERVERS_JSON` | `[]` | 发送给浏览器的 `RTCIceServer[]` JSON；生产必须配置可达 STUN/TURN |
| `ALLOWED_ORIGINS` | 空（不限制） | 逗号分隔的精确 Web Origin，例如 `https://game.example.cn` |

迁移检测预算会在启动时强制检查：

```text
2 * HEARTBEAT_MS + HOST_LOSS_MS <= 4500
```

默认值的最坏检测预算为 4500 ms，客户端再保留最多 500 ms 等待可靠通道；在正常事件循环和信令可达时，迁移暂停的设计预算不超过 5 秒。`RECONNECT_GRACE_MS` 决定座位能否稍后恢复，不延迟新房主的选举。房主若在 `HOST_LOSS_MS` 内恢复会取消迁移；否则信令服务提升下一位在线玩家、递增权威 epoch，并由幸存客户端最近的可靠检查点恢复比赛。检查点频率把正常回滚限制在约 0.5 秒内；刚开赛尚未产生检查点的前 0.5 秒，可用信令服务保存的不可变开赛描述恢复。

### ICE、TURN 与中国区域

`ICE_SERVERS_JSON` 必须是单行 JSON 数组。例如：

```dotenv
ICE_SERVERS_JSON='[{"urls":"stun:stun.game.example.cn:3478"},{"urls":["turn:turn.game.example.cn:3478?transport=udp","turns:turn.game.example.cn:5349?transport=tcp"],"username":"SHORT_LIVED_USERNAME","credential":"SHORT_LIVED_CREDENTIAL","credentialType":"password"}]'
```

中国大陆用户不能依赖境外公共 STUN 的可达性。上线前至少部署或采购一个从目标网络稳定可达的 STUN/TURN，并分别从中国移动、中国联通、中国电信网络实测 UDP 直连、TURN/UDP 和 TURN/TLS 或 TURN/TCP 回退。TURN 还必须放通其配置的中继端口范围。

当前服务会把 `ICE_SERVERS_JSON` 原样发给每个房间客户端，并且只在进程启动时读取一次；浏览器拿到的 TURN 凭据不是秘密。`.env.example` 因此只提供无凭据的本地默认值。公开部署应使用 TURN REST/shared-secret 机制签发短期凭据，并在信令层接入按会话签发；在完成该接入前，至少使用受限、频繁轮换且有配额的服务凭据，绝不要提交真实凭据。

未来扩展多区域时，不能只在多个信令进程前做随机负载均衡：房间注册表、恢复令牌和 host epoch 当前都是单进程状态。需要把既有房间固定到原区域，或引入共享协调存储；同时按玩家位置返回区域 TURN 列表，并保留跨区域及协议版本监控。

### HTTPS/WSS、反向代理和端口

生产必须由反向代理或负载均衡器终止 TLS，以 `https://` 提供页面并把同源 `/signal` 升级为 `wss://`。内置 Node 服务只监听明文 HTTP/WS；不要把它直接暴露到公网。默认客户端不读取独立的信令 URL 环境变量，所以静态页面与 `/signal` 应位于同一公开 Origin。

反向代理需要：

- 将 `/signal` 转发至 Node，并保留 HTTP/1.1 `Upgrade`、`Connection`、`Host` 和客户端地址头；不要对 WebSocket 做响应缓冲。
- Node 只允许被可信代理访问、且代理会覆盖而不是追加外部传入的 `X-Forwarded-For` 时，设置 `TRUST_PROXY=true`；否则保持 `false` 以免客户端伪造来源地址。Node 直连单层 Nginx 时可用 `proxy_set_header X-Forwarded-For $remote_addr;` 覆盖该头；不要直接使用会保留客户端自带链条的 append 配置。保持 `false` 时，代理后的所有客户端会共享代理的 TCP 来源地址额度。
- 多层 CDN/负载均衡链必须先在最外层清除不可信的客户端地址头，再由最后一层可信代理向 Node 输出经过验证的最左侧客户端 IP。无法保证这一点时不要开启 `TRUST_PROXY`，应在边缘按真实客户端地址执行容量限制。
- 将其余路径转发至 Node 的静态服务，或由代理直接提供同一份 `dist/`。
- 用 `GET /health`（返回 `{"status":"ok"}`）做存活检查，并让 WebSocket 空闲超时明显大于恢复宽限期。
- 在生产显式设置 `ALLOWED_ORIGINS`；匹配的是浏览器发送的精确 Origin，不含路径，也不要添加尾斜杠。

| 边界 | 常用端口/协议 |
| --- | --- |
| 浏览器 → 反向代理 | `443/TCP`：HTTPS + WSS |
| 反向代理 → Node | 内网 `8787/TCP`：HTTP + WS |
| 浏览器 → STUN/TURN | 通常 `3478/UDP,TCP`；TURN/TLS 通常 `5349/TCP` 或运营方提供的 `443/TCP` |
| TURN → WebRTC 对端 | TURN 服务配置的 UDP/TCP 中继端口范围 |

### 安全、隐私和当前限制

- 这是房主权威 P2P 星型拓扑：访客只提交控制意图，不能直接提交位置、速度、进度或结果；开赛阵容/种子、epoch、快照和检查点会做一致性与异常检查。检测到异常的客户端会把比赛标记作废，但当前没有服务端或全房作废共识；恶意房主仍可能伪造、压制或分叉权威状态，不能绝对防止。
- 自动迁移通常依赖至少一位幸存访客缓存了上一 epoch 的有效检查点；刚开赛的前 0.5 秒可由服务端开赛描述恢复。所有浏览器同时离线、唯一玩家离线或进程重启时，仍无法凭空继续世界状态；迁移期间会短暂停赛。当前房主在比赛中整页刷新会丢失仅存于内存的权威检查点，若它在迁移前恢复为原房主，比赛可能因状态倒退而作废；关闭标签页、进程崩溃或超过恢复窗口的断线会走正常房主迁移。
- WebRTC 直连会向通信对端暴露网络候选信息。TURN 能帮助穿透和中继，但当前客户端未强制 `relay` 模式，不能承诺隐藏玩家 IP；有更强隐私要求时需增加 relay-only 选项。
- 临时昵称不是身份认证。聊天不做内容过滤，支持任意 Unicode，最多 500 个 Unicode 字符，并以每位玩家每 5 秒最多 5 条限流；玩家可在本地静音。没有举报、审核或持久化聊天记录，其他玩家仍可自行保存内容。信令连接默认每秒 120 条/256 KiB，且 SDP/ICE 分别限制为 48 KiB/4 KiB；每个 WebRTC 对端默认每秒 120 条/512 KiB。超限只断开违规端，连接、来源地址和房间另有硬容量上限。
- 恢复令牌存入当前标签页的 `sessionStorage`。只在 HTTPS/WSS 下部署、限制脚本来源并避免把令牌写入日志。
- 当前只实现 2–8 人私人绕标赛。公开匹配、联机自由巡航、排位和可验证的专用权威服务器不在这一版中。
- 桌面版开启「允许局域网加入」后，静态站点和信令服务会暴露给同网段的所有人，除房间码外没有额外鉴权。邀请码只是「地址 + 房间码」的明文拼接，不含任何凭据，也不构成鉴权。上面这些浏览器侧的限制（房主权威、迁移边界、IP 暴露、聊天无审核）在桌面版同样成立。
- 桌面版默认不做代码签名，因此 macOS 与 Linux 的 `.deb`/`.tar.gz` 只能「提示新版 + 打开发布页」，无法就地更新；详见[自动更新](#自动更新)。

## 操作

| 按键 | 功能 |
| --- | --- |
| A / D 或 ← → | 舵 |
| W / S 或 ↑ ↓ | 收帆 / 放帆（缭绳） |
| Q / E | 压舷向外 / 收回（开自动压舷时为偏置） |
| R / F | 稳向板收起 / 放下 |
| 空格（按住） | 翻船后扶正 |
| C | 切换镜头：追尾 / 舱内 / 高空 |
| V（按住） | 回头看 |
| 鼠标拖拽 / 滚轮 | 环视 / 缩放 |
| T | 救援复位 |
| H / Esc | 操作说明 / 暂停 |

## 航行入门（游戏内教学更详细）

- **死区**：风向两侧各约 45° 无法直接航行，硬顶会失速倒漂。
- **调帆**：放帆到帆前缘刚开始抖，再收回一点点，就是最佳攻角。
- **去上风**：以约 45° 真风角走之字，用抢风调向（tack）换舷。
- **顺风**：帆全放出当阻力伞用；收起一半稳向板减阻；小心换舷（gybe）时帆杠横扫。
- **大风**：靠压舷和及时松帆控制横倾；超过 ~50° 就离翻船不远了。
- **读风**：水面深色斑块 = 阵风将至；观察桅顶风向标和风表罗盘。
- **追浪**：顺风时顺着浪面下坡加速（HUD 出现"冲浪!"），借浪跃上滑行。
- **抢风**：别待在对手的正下风 —— 风影里视风骤减（HUD 出现"乱流"）；
  反过来，压住对手的上风位就能把它盖死。

## 物理模型（`src/sim/`）

4 自由度（前进/横漂/艏摇/横摇）体轴动力学，120Hz 定步长积分：

- **帆**：软翼对称升阻力曲线（换舷拱度翻面），失速后过渡到平板阻力特性；
  帆杠受缭绳约束自然摆向下风，正顺风带换舷滞回（可以背风行驶）。
- **水下附体**：稳向板/舵叶为有限展弦比对称翼，失速角 ~16-24°——
  低速大侧滑时板失速，出弯横漂、舵满舵失效都是涌现行为。
  死区顶死时船会倒漂，来流从艉打来使**舵效自然反打**（脱困要满舵保持一侧）。
- **船体阻力**：黏性 + Froude≈0.44 兴波阻力峰（排水航行的"墙"）+ 滑行减阻，
  强风横风可破墙滑行（>10 节）。
- **横摇**：帆侧力 × 力臂 vs 船员压舷 + 船型稳性（大角度崩溃 → 翻船，按住空格扶正）；
  浪面横向坡度产生浮力回复力矩，大浪横浪真实摇船，叠加阵风横倾可致翻船。
  **横倾诱导艏摇**：有速度时右倾产生左转力矩（反之亦然），抢风舵/broach 由此涌现。
  **正顺风上风微倾**：自动压舷在正顺风把船摆向上风侧（帆的反侧），平衡舵感、减小横摇。
- **风场**：基础风 + 顺风漂移的阵风团（与水面暗斑渲染逐位同源，所见即所得）+ 慢速风向摆动。
- **风影**：上风船的帆向下风投出 ~7 倍桅高的乱流带（风速最多 -42%），
  盖风/抢清风的竞速战术由此涌现。
- **波浪**：6 分量 Gerstner，物理采样与 GPU 顶点位移共用同一组参数（含水平位移反解）。
  波浪真实推船 —— 水质点轨道流速进入所有水动力项，浪面坡度产生冲浪推力，
  冲浪时船体卸载（兴波阻力下降）使追浪跃上滑行成为核心顺风技巧。
- **水流**：整片水体可平移（环境潮流），水动力以动水为参照系，船会随流漂移、
  表观风仍以对地速度计（空气不随水动）。离线模式启用轻柔潮流（HUD 显示流速/流向），
  联机保持静水以确保各端物理逐位一致。

`tools/polar.js` 对模型做符号自检（横倾/侧滑/舵效方向、左右舷对称性、
调向掉速、死区失速）并输出各风速极曲线，调参时先跑它。

## 目录结构

```
src/
  sim/        波浪场 / 风场 / 船间风影 / 翼型系数 / 船体动力学 / 舵手辅助
  render/     场景与天空 / 水面着色器 / 岛屿地形 / 程序化船模 / 尾流浪花
  game/       输入 / 相机 / HUD / 船实体 / AI / 离线与联机比赛 / 大厅 / 聊天 / 菜单
  net/        严格消息协议 / 信令客户端 / WebRTC 传输 / 权威会话 / 快照与完整性检查 / 邀请码
  i18n.js     中/英/日 三语词典与 t() 查询
  main.js     模式状态机与主循环
server/
  index.js              环境配置与服务入口
  signalingServer.js    静态文件、健康检查、WebSocket 信令与房主迁移协调
  roomRegistry.js       进程内房间、座位租约与 host epoch
electron/
  main.js               桌面版主进程：窗口、原生菜单、app:// 协议、IPC
  localServer.js        进程内信令服务的监听策略与局域网地址规范化
  desktopSettings.js    窗口几何 / 局域网开关 / 服务器地址的持久化
  rendererFiles.js      app:// 到 dist/ 的路径解析（含越权防护）
  menuStrings.js        原生菜单与更新提示的中/英/日文案
  updater.js            按安装形态决定就地更新还是只提示
  preload.cjs           向页面暴露 window.windchaser 的最小桥接
tools/
  polar.js    极曲线与物理自检（node）
  make-icon.mjs          程序化生成应用图标 assets/icon.png
  test-multiplayer.mjs   Playwright 三浏览器联机与房主迁移回归
  test-desktop.mjs       桌面壳冒烟检查（真实 Electron 进程）
```

## 画质与性能

设置中提供 低 / 中 / 高 / 超高 四档预设，也可分别调整（改动细项后预设显示"自定义"）：

- **渲染分辨率** 50%–150%（× 设备像素比）
- **阴影质量** 关 / 中(1024) / 高(2048) / 超高(4096)
- **水面细节** 低 / 中 / 高（Gerstner 网格 96/160/256 分段）
- **浪花与尾流特效** 开关
- **云层** 开关（程序化公告板云穹，低画质预设默认关）
- **时段/天气**：黄昏 / 正午 / 暮色 / 阴天（纯本地视觉，联机不同步）
- **动态分辨率**：掉帧时自动降低渲染分辨率保持流畅（恢复后自动升回），
  阈值自适应屏幕刷新率；可关闭
- **FPS 显示**

## 航行规则与处罚

赛中接入简化版 RRS 路权判罚（规则 10/11/12 对港、上下风、前后关系）与触标（规则 31）：

- **处罚模式**（设置可切）：**回转处罚**（默认，RRS 44）—— 碰撞责任船罚 2 圈、
  触标罚 1 圈 360° 回转，按连续净转向角累计，未完成回转不得完赛；
  或**减速处罚** —— 判责后帆效率降低数秒。
- **标与委员会船可实体碰撞**：浮标为圆桩、委员会船为线段，撞上会被弹开并吃触标罚。
- **绕标方向校验**：须按正确一侧真正绕过标（捕获区扫掠角判定），错边穿圈不计，需回头重绕。
- **终点方向**：只接受自下风向上风的正向冲线。
- **联机**：房主权威跑规则引擎，处罚状态随快照下发访客；房主迁移后新房主继续判罚。

## 幽灵船

比赛（计时赛或 AI 竞速）刷新个人最佳时自动录制全程轨迹，下一场同风速、同模式的
比赛中以半透明"影号"回放。轨迹存在赛道坐标系里 —— 每场风向随机、赛道整体旋转，
幽灵照样对得上标。可在设置中关闭。

## 已知简化

- 浪致纵摇仅作用于视觉姿态（横摇已进动力学，见物理模型）；无护航/障碍物权利（RRS 19-20）、
  起航抢线权利（RRS 15-16）、抗议流程；处罚为回转或减速，非真实记分。
- AI 已能利用风影（脏风逃逸）、顺风追浪、起航偏向有利端并执行回转处罚；
  但仍不做船队相对战术（盖风覆盖、贴身缠斗）与主动避让（靠物理碰撞解算兜底）。
- 教学第 1 课的相机检测在触屏上不可用（当前仅支持键鼠）；移动端触屏操控尚未实现。
- 访客本地预测仅本船 + 岛屿/障碍位置修正，船间碰撞与判罚等待房主快照（无输入回放）。
