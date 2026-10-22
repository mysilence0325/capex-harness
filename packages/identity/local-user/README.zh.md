---
description: "解析运行 Harness 进程的操作系统账号，并把显示姓名发布给设置壳。"
kind: "package-reference"
---

# @deepseek-ai/dsh-local-user

[English](README.md) | 中文

## 概述

本 Host 插件识别运行 Harness 进程的操作系统账号。没有账号入口时，它通过带版本号的 `__DSH_IDENTITY__` 全局值向设置壳提供显示姓名。浏览器不会收到可修改的凭据或账号数据。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

在需要本机用户标签的 Web bundle 中挂载本插件。它只通过 `webserver/index-inject` 注入一条 `global` 行，不新增路由、Remote、设置项或模型工具。`lookupTimeoutMs` 限制 NSS 查询时间，默认 2000 毫秒。

显示姓名依次取 `getent passwd <login>` 的 GECOS 第一段、`USER_FULLNAME`、登录名。最后的登录名退化保证极简镜像没有 `getent` 时仍有可见标签。

<a id="understand-the-implementation"></a>
## 理解实现

插件在 Host 激活时解析一次。同步解析与同步的 index 注入回调一致，避免首个请求竞态；`getent` 走 NSS，因此本地账号、LDAP 和域账号使用同一路径。来源字段只用于诊断，不进入模型请求。

<a id="model-experience"></a>
## 模型体验

无。身份只用于浏览器展示，不进入 prompt 组装或 provider 请求。

#### KV Cache effect

无。

## 已知限制

<a id="known-limitations-and-deferred-work"></a>

- **进程身份而非浏览器身份。** 同一 Host 的所有浏览器都看到启动该 Host 的账号。
- **不支持账号切换。** 多用户 Host 隔离需要按 principal 注入身份，不属于本包范围。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文 — 点击展开</summary>

None.

</details>
