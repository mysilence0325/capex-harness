---
description: "Capex 离线 Web 组合，包含本机身份、桌面文件打开和有界数据维护。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-capex

[English](README.md) | 中文

## 概述

本 bundle 针对离线 Capex 安装定制 Web 组合。它移除云端账号消费方，同时保留带认证浏览器会话所需的本地凭据提供者，并挂载本机身份、桌面文件打开和本地数据维护能力。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

选择 `capex` profile。它的 bundle 顺序是 `dsh-base`、`dsh-web-app`、本包。本层禁用云端授权、账号提供者、账号 Remote/UI、账号模型和公网 Web 工具，但刻意保留 `credentials-local`，因为 Web Cookie 签名依赖它。

界面继续提供 API Key 模型配置、工作区和 Session 持久化、Office 预览、私有 registry 或本地 tarball 插件，以及本机用户展示。

<a id="understand-the-implementation"></a>
## 理解实现

这是一个普通 bundle patch，在通用 Web 层之后应用。它不改变 Session 格式或 agent loop。本机用户行发布进程身份；desktop-open 消费启动文件参数；storage-maintenance 向设置壳提供本地占用。清理始终是显式命令，不自动执行。

<a id="model-experience"></a>
## 模型体验

本 bundle 不增加模型可见工具或上下文。它在该离线组合中移除 web-search 和 web-fetch 工具。

#### KV Cache effect

无。

## 已知限制

<a id="known-limitations-and-deferred-work"></a>

- **进程身份。** 同一 Host 的所有浏览器都显示启动它的账号。
- **显式文件关联。** 安装 Debian 包不会覆盖每个用户的默认应用。
- **维护需要显式执行。** Session 移动和 trash 永久回收都不会自动运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文 — 点击展开</summary>

None.

</details>
