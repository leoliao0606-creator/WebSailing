---
name: multiplayer-e2e-runs-locally
description: npm run test:multiplayer 本机能跑通，前提是先装过 Playwright 的 Chromium
metadata:
  type: project
---

`npm run test:multiplayer`（Playwright 开三个浏览器上下文的联机端到端测试）在这台机器上
能稳定通过。2026-09-14 连续跑三次都过，主机迁移耗时 1159~1357 毫秒。

跑它之前必须装浏览器：`npx playwright install chromium`。
`~/.cache/ms-playwright` 是空目录就说明没装过，这时报的是 Playwright 找不到浏览器可执行
文件，跟产品代码无关。

这条取代了之前「本机跑不过、是既有问题、跳过它」的旧结论，那个结论是错的。当时失败有两个
互相独立的原因：一是浏览器根本没装；二是一个真实的界面缺陷——赛前大厅的聊天面板压住非房主
的「准备」按钮，窗口宽 721~1010 像素时必现，2026-09-14 由提交 36d5b0b 修复。同日 CI 上的
`multiplayer` job 也第一次转绿。

**Why:** 旧结论把这条测试当成噪声跳过了两个月，而它这两个月一直在报一个玩家真会撞上的缺陷。

**How to apply:** 改动涉及联机、大厅界面或聊天面板时，跑 `npm run test:multiplayer` 验证，
不要跳过；它失败就按真失败去查。只动物理或渲染时，仍可只跑 `npm run test:unit`。
