---
description: "通用设置中的只读本地数据占用概览，由 storage-maintenance Remote 提供数据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-storage

[English](README.md) | 中文

## 概述

本插件在通用设置中增加本地数据占用行，显示 Session、附件、缓存、回收站和总占用。它按需刷新，并提示用户用 `dsh clean` 预览可回收数据；GUI 不提供破坏性操作。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

与 `storage-maintenance`、设置、本地化和 Remote 服务一起挂载。通用设置打开后，该行读取当前占用，用户可通过刷新按钮重试。失败时保留说明，不影响其他设置。

<a id="understand-the-implementation"></a>
## 理解实现

该行通过生成的 Remote 命名空间调用 `storageMaintenance.usage`，并在本地格式化字节数。它只持有展示状态：加载、失败和最近一次接受的占用。清理仍由可恢复的 CLI 命令负责。

<a id="model-experience"></a>
## 模型体验

无。占用信息不会进入 prompt 或模型工具。

#### KV Cache effect

无。

## 已知限制

<a id="known-limitations-and-deferred-work"></a>

- **不提供破坏性操作。** 永久删除仍需在终端显式执行。
- **手动刷新。** 设置页打开期间不会轮询文件系统。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文 — 点击展开</summary>

None.

</details>
