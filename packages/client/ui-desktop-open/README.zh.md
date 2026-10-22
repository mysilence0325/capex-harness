---
description: "在 Session 范围的文档预览中打开 Capex 桌面启动器移交的文件，不提交模型请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop-open

[English](README.md) | 中文

## 概述

本客户端插件消费 `/usr/bin/dsh-web` 写入的 `open` 与 `workspace` 查询参数。它把文件所在目录注册为 Workspace，打开或创建空 Session，并在右侧 Sidebar 的文档预览中显示文件。它不发送用户消息，也不启动模型回合。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

仅在 Capex bundle 中挂载本插件，并确保组合包含 Workspace、Sidebar、文档预览和设置服务。启动器必须提供绝对规范化路径。插件只消费一次启动请求，并从浏览器历史中移除两个参数。

路径无效或不可访问时，现有应用仍可使用，并显示本地化的瞬时错误。

<a id="understand-the-implementation"></a>
## 理解实现

插件等待 Workspace 和 Session 快照就绪，再调用普通 Workspace Controller 与 `uiWorkspace.openWorkspace`。Session 通过现有导航语义创建或复用；其 `beforeOpen` 回调通过右侧 Sidebar 资源控制器打开 `fileAddressFor(sessionId, workspace, file)`，文件授权仍由现有 Workspace 和文档服务负责。

<a id="model-experience"></a>
## 模型体验

无。打开文档只创建展示状态和空 Session，模型不会收到文件内容或指令。

#### KV Cache effect

无。

## 已知限制

<a id="known-limitations-and-deferred-work"></a>

- **一次只处理一个启动请求。** 激活前的新 URL 导航会替换前一个请求；多文件启动不在本接口范围。
- **损坏的源文件仍是损坏状态。** 已删除或不可读的路径使用现有文档预览失败报告。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文 — 点击展开</summary>

None.

</details>
