# Agent Note: 客户端浏览器下限

Status: implemented

[English](2026-09-30-client-browser-floor.md) | 中文

## Problem

Web 客户端此前假定运行环境是较新的引擎。客户端产物按 ES2022/ES2024 目标编译，shell 的样式表走 Vite 管线，而该管线既不加厂商前缀也不设目标版本，客户端代码还直接调用 ES2021 之后的 API。Chromium 90 是产品支持的最旧引擎，它既不能解析全部语法，也没有这些 API，而缺口正好落在启动路径上：模块加载器、传输层、Session 存储以及每一条可取消的请求路径都会调用 `Array.prototype.at`、`Object.hasOwn`、`structuredClone`、`Promise.withResolvers`、`Array.prototype.findLast/toSorted/toReversed`、`AbortSignal.any`、`AbortSignal.timeout` 与 `AbortSignal.prototype.throwIfAborted`。缺少的 API 会在调用点抛错，因此一个缺口就是白屏，而不是界面降级；同一个引擎还会把 `color-mix()`、`dvh` 和无前缀的 `mask-image` 当作不存在。

## Decision

**Chromium 90 是客户端的浏览器下限，只声明一处，由两条客户端构建路径共同消费。**[scripts/client-browser-floor.ts](../../../../scripts/client-browser-floor.ts) 导出脚本目标（`chrome90`）与 Lightning CSS 样式目标（同一版本）；Vite 编译 shell 与静态链接的客户端库，[tsdown.client.ts](../../../../packages/client/tsdown.client.ts) 用它们编译动态插件 bundle。

**脚本：**两条路径都按该下限目标产出，[compat.ts](../../../../packages/client/web/src/compat.ts) 补齐该版本缺少的标准 API。它的副作用入口 [compat-install.ts](../../../../packages/client/web/src/compat.ts) 是 shell 入口的第一个 import，因此这次安装先于模块图中的其他所有模块，也先于加载器随后求值的插件 bundle。每个条目都做特性探测，已经自带该 API 的引擎保留其原生实现；每个条目也都有真实调用点：客户端通过 `@deepseek-ai/dsh-util-crypto` 生成标识符，而该包存在的原因正是 `crypto.randomUUID` 仅在安全上下文可用，因此下限不安装它。浏览器 Worker 是独立 realm，不在覆盖范围内。

**编译器运行时辅助函数永不成为兄弟 chunk。**把类字段降到下限目标会让打包器产出一个可由同包的入口与其动态 chunk 共享的辅助函数，Rolldown 会把它发布成独立的 chunk 文件。shell 交给每个 factory 的 `require` 是同步的，只认平台种子词与已注册的 factory，因此这条边会在插件物化时抛错。[tsdown.client.ts](../../../../packages/client/tsdown.client.ts) 把每处兄弟 require 改写为一个内联模块对象，其中带上该辅助函数及它 import 的模块，并删除该 chunk 文件：无论打包器决定共享什么，包内 chunk 图都保持扁平；该表达式渲染成单行，因此不会移动任何其他 sourcemap 映射。Host 的启动就绪尾脚本位于 [injections.ts](../../../../packages/host/webserver/src/injections.ts)，它用 `new Promise` 构建 deferred，原因与 compat 安装相同——这段内联脚本先于任何客户端模块执行。

**样式：**两条路径都用 Lightning CSS 按样式目标编译，由它提供该下限所需的厂商前缀（例如 `-webkit-mask-*` 系列）、展开嵌套并压缩。有两类特性没有编译器降级方案，由 `downlevelClientCss` 直接改写源码：`color-mix()` 按主题自身的 token 表求值，变成一个自定义属性，由样式表给出各主题的字面量，同时在 `@supports` 之后为支持该函数的引擎保留原表达式；token 表或同一样式表内的声明无法解析的 mix 保持原样。每个动态视口单位都会在原始声明之前得到一条静态的 `vh`/`vw` 回退声明。

**依赖组件渲染结果的规则读取组件设置的 data 属性。**组件写出它本就掌握的事实——Checkbox 的 `data-disabled`、compaction 行的 `data-open`、工具条目的 `data-only-code`、代码块的 `data-code-block-banner-wrap`、Markdown 标题的 `data-followed-by-list`、对话 seat 的 `data-chat-followed-by-input`、预览主体的 `data-preview-kind`——对话 shell 则把被选中 view 的 composer 浮层标记镜像到 `[data-conversation-shell]`。两个引擎因此读到同一事实，并由组件测试固定。

**无法降级的选择器与 at-rule 特性保留在源码中，并被该下限整条丢弃：**容器查询、锚点定位、`@starting-style`、`field-sizing`、`scrollbar-gutter`、`accent-color` 与 `:nth-child(An+B of S)`。仍保留十七条 `:has()` 规则，每一条都因为 DOM 是唯一事实来源：渲染器自身的空输出（聊天 flow seat）、子元素的 hover 或键盘焦点（trajectory 与快捷键行、提问气泡、引导卡片）、由 slot 贡献的部件（对话标题栏的 tab、输入座位上的触发器菜单、dockkit 的菜单内容）、其他包发布的 `html` 级状态（Windows 标题栏折叠、dockkit 指针）、两列网格中的相邻卡片，以及紧凑 Markdown 的 KaTeX 溢出。

## Verification

[compat.client.spec.ts](../../../../packages/client/web/tests/compat.client.spec.ts) 从 realm 中移除每个 API，按顺序固定安装清单，固定幂等性与“全部原生”这一遍，并驱动每个已安装的实现。[client-browser-floor.spec.ts](../../../../scripts/client-browser-floor.spec.ts) 固定解析出的字面量、定义块、回退声明、保持原样的形式，以及一条语料不变量：`packages/client/**/*.css` 中每个 `color-mix()` 都能解析。

Chromium 90.0.4430.0 快照构建（revision 857891）实测报告：所有被 polyfill 的 API 均缺失，所有被改写的 CSS 特性均不支持；它能启动服务端提供的客户端，并渲染出侧栏、工作区列表、输入框与设置。

## Alternatives considered

**运行时 `:has()` shim。** 已否决：它必须改写所有注入样式表中的选择器，并在流式对话树的每次变更后重新求值，而这套仓库的浏览器测试通道无法运行该引擎。

**手工改写每一处 `color-mix()` 与 `dvh`。** 已否决：57 个样式表中有 89 处 mix 和 9 处单位，且每次 token 变更都要重新推导字面量。

**在每个 `color-mix()` 旁边手写字面量回退值。** 已否决：这些值归主题所有，逐处字面量会与它对应的 token 表脱节。

**让模块加载器同步抓取兄弟 chunk。**已否决：交给 factory 的 require 按设计就是同步的，而已注册的 chunk 行都以加载器自己的 id 为键；这意味着加载器要长出一条按需抓取路径，而它文档化的契约明确排除这种做法。

**把所有客户端产物继续降到 ES2017。** 已否决：该下限能解析 ES2021 与类实例字段，再降级只会为产品不支持的引擎付出体积与可读性代价。

**把 shell 样式表降级为 PostCSS 加 autoprefixer。** 已否决：Lightning CSS 本来就编译每个插件 bundle 的样式表，一个转换器即可覆盖两条路径的前缀、嵌套与压缩。

## Consequences

Chromium 90 可以启动并渲染客户端；Vite 管线中 shell 的 CSS 类名现在遵循 Lightning CSS 的命名（`<hash>_<local>`），按类名子串选择元素的测试不受影响，因为局部名被保留。

被共享的编译器运行时辅助函数会内联进每个需要它的 chunk，因此这类包会按消费方各带一份。

代价是可见的：容器查询不会生效，窄容器下的列折叠保持基础样式；其余十七条 `:has()` 规则会被丢弃——子元素的 hover 与键盘焦点高亮、对话标题栏的 tab 间距、dockkit 的空菜单抑制、插件网格中的相邻对齐，以及紧凑 Markdown 的 KaTeX 溢出；`field-sizing` 让它的两个 textarea 停在声明的最小高度，相关规则本就把这写成文档化的回退；锚点定位的菜单底层只用于 macOS，会失去对齐；经 polyfill 的 `AbortSignal.any` 合成的信号报告引擎默认的中止原因，因为 Chromium 90 没有 `signal.reason`，而传输层本就把它当作中止处理。
