# WindChaser 项目说明

## 用户偏好
- 用简体中文沟通，说明实际改动及验证结果。
- 修改前说明将修改哪些部分及原因；视觉修改应在浏览器检查实际画面。

## 从 Claude Code 同步的项目记忆

2026-09-14 从本机 Claude Code 的此项目记忆目录复制，原文保存在
[docs/claude-memory/MEMORY.md](docs/claude-memory/MEMORY.md)，后续工作请按需读取：

- [公开联系方式](docs/claude-memory/public-contact-uses-github-noreply.md)：公开文件使用 `leoliao0606-creator@users.noreply.github.com`，不写私人 Gmail。
- [发版流程](docs/claude-memory/windchaser-release-flow.md)：`v*` tag 触发三平台打包，CI 生成草稿 Release；公开发布由用户决定。历史发布状态只代表记忆记录当时。
- [玩家指南](docs/claude-memory/windchaser-player-guide.md)：更新已有指南时沿用原 Artifact URL，避免产生新链接。
- [联机测试](docs/claude-memory/multiplayer-e2e-runs-locally.md)：本机能通过，先确认 Playwright Chromium 已安装。涉及联机、大厅或聊天面板时运行 `npm run test:multiplayer`；只改渲染或物理可运行 `npm run test:unit`。

## 项目与验证
- 原生 JavaScript + Three.js + Vite，Electron 提供桌面打包；`src/main.js` 是入口。
- `src/render/` 为画面实现；`src/game/menu.js` 管理本地设置；`src/sim/` 为航行物理。
- 渲染分档只改变视觉开销，保持 CPU 波场、风场、碰撞及联机确定性一致。
- 常用验证：`npm run test:unit`、`npm run build`；浏览器自动化可通过 `window.__game` 检查状态。
