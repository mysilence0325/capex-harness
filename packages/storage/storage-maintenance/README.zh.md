---
description: "统计本地 Harness 数据，并把选定 Session、无引用附件和缓存移入可恢复的维护批次。"
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-maintenance

[English](README.md) | 中文

## 概述

本 Host 包统计本地数据，并提供 `dsh clean` 共用的 dry-run、移动、恢复与永久回收操作。Session 移动通过持久化提供者的受控迁移完成；普通执行绝不会直接删除已提交的 Session generation。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

挂载 Host 插件可向设置页暴露 `storageMaintenance.usage`。CLI 使用 JSONL 持久化提供者和本包导出的维护函数。`createMaintenancePlan` 只读。`applyMaintenancePlan` 只把选中的已归档 Session、旧的且无引用的附件对象和可再生的 request-image 缓存移入 `$DSH_HOME/trash/maintenance/<batch>/`。`restoreMaintenanceBatch` 反向恢复整个批次，`purgeMaintenanceTrash` 是唯一下的永久删除步骤。

<a id="understand-the-implementation"></a>
## 理解实现

资格判断使用 Workspace 归档集合与 Session 目录中最新的文件时间。引用发现通过持久化 API 读取所有保留 Session 日志。Session 目录通过 `SessionPersistence.relocate` 在同一文件系统内原子移动；附件与缓存目录也通过 rename 移动。每个批次带有版本化 manifest，记录绝对源路径和目标路径。代码拒绝 Harness home 之外的路径，统计容量时不跟随符号链接。

<a id="model-experience"></a>
## 模型体验

无。存储统计与维护不会创建 Session 事件、prompt 上下文或工具。

#### KV Cache effect

无。

## 已知限制

<a id="known-limitations-and-deferred-work"></a>

- **不直接删除不可恢复的 Session。** 永久删除需要回收已停止维护批次中的 trash。
- **不支持在线维护。** Web Host 运行时不得执行 `--apply`。
- **引用扫描刻意保守。** 保留 Session 不可读时整个计划失败，避免误删附件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文 — 点击展开</summary>

None.

</details>
