---
name: windchaser-release-flow
description: WindChaser 发版流程——推 tag 触发三平台打包，但 CI 只出草稿 Release，公开发布由用户手动点
metadata:
  type: project
---

发版方式：推一个 `v*` 开头的 tag 到 `leoliao0606-creator/WebSailing`，
`.github/workflows/release.yml` 会在 macOS / Windows / Linux 三台机器上各打一份包，
上传到 GitHub Releases。

关键点：electron-builder 的 `releaseType` 默认是 `draft`，所以 CI 跑完只生成**草稿**
Release，只有仓库拥有者看得见，玩家进发布页仍然是空的。**必须有人手动点
「Publish release」才算发出去。**

2026-09-05 已推 tag `v0.1.0`，三平台构建全部成功（run 33699103436），草稿里有 20 个文件。
截至当时用户还没点发布。

**Why:** 公开发版不可撤回，这一步归用户决定，不是我该替他按的。

**How to apply:** 打完包只把草稿链接给用户，说明还差他点一下；不要自己去调
`gh release edit --draft=false`。草稿里的 `latest*.yml` 和 `.blockmap` 是自动更新用的，
不要删。相关：[[windchaser-player-guide]]、[[public-contact-uses-github-noreply]]
