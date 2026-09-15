---
name: public-contact-uses-github-noreply
description: 需要在公开文件里写联系邮箱时，用 GitHub noreply 地址，不要用私人 Gmail
metadata:
  type: feedback
---

任何会公开发布的文件里需要填联系邮箱时，用 `leoliao0606-creator@users.noreply.github.com`，
不要用私人 Gmail。2026-09-05 打 `.deb` 包时 `electron-builder.yml` 的 `linux.maintainer`
字段必须填真实地址，我问过用户，用户选了 noreply。

**Why:** `.deb` 的 maintainer 字段会写进包的 control 文件，随发布包公开到互联网上；
私人邮箱一旦这样公开就收不回来。

**How to apply:** 遇到 package.json 的 author、LICENSE、新的打包配置、README 的联系方式
等场景，直接用 noreply 地址，不用再问；只有用户明确要求写别的地址时才改。
相关：[[windchaser-release-flow]]
