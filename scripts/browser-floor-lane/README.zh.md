# Chromium 90 浏览器下限通道

[English](README.md) | 中文

该通道用 Chrome DevTools 协议驱动一个便携版 Chromium 90 快照构建，对着已经在运行的 `dsh web` 服务器，把下限的事实从该引擎里读回来，写出截图，并打印一份 JSON 报告。它是[客户端浏览器下限](../../.agents/notes/implemented/architecture/2026-09-30-client-browser-floor.zh.md)的行为一半：与它并列的门禁固定构建输入与出厂字节，而这条通道负责说明服务器提供的客户端在该引擎上仍然渲染。

## 为什么放在这里

`scripts/` 本来就是下限的归属地。[client-browser-floor.ts](../client-browser-floor.ts) 定义脚本目标、API 契约与样式表改写，[verify-client-browser-floor.ts](../verify-client-browser-floor.ts) 是产物门禁。该通道从这份定义里导入 `CLIENT_FLOOR_APIS`，API 清单因此只有一个归属地；它也与其他仅在工作站上运行的通道并列放在 `scripts/` 下，这些通道同样需要仓库不随源码分发的二进制，例如 `libreoffice-engine` 与 `wine-windows-gates.sh`。

`apps/web/tests/` 里的浏览器通道不是这条通道的归属地。那些用例是 vitest 清单，自建进程内的 host，并驱动 lockfile 选定的浏览器；而这条通道指向已在运行的服务器，以及任何 lockfile 都装不出来的引擎。这里没有门禁，因此 [run-gates.ts](../run-gates.ts) 不登记它。

## 获取便携构建

Chromium **90.0.4430.0**，快照 revision **857891**（2021-02-25），Windows x64。

1. 下载 <https://mirrors.huaweicloud.com/chromium-browser-snapshots/Win_x64/857891/chrome-win.zip>（166 MB）。本下限构建所处的网络无法访问 Google 托管的源站 `commondatastorage.googleapis.com`，而 npmmirror 的缓存对该时间窗口只有 Chromium 91 构建。
2. 解压到任意位置。可执行文件是 `<dir>\r857891\chrome-win\chrome.exe`，其 PE ProductVersion 为 `90.0.4430.0`。
3. 用 `--chrome` 指向它。快照是便携的：不需要安装程序，不写注册表，状态保存在通道传入的 `--user-data-dir` 中，默认是 `<shots>/chrome-profile`。

该归档不入库，也没有任何构建步骤依赖它。

## 启动服务器

```sh
pnpm dsh web --no-open
# dsh web: http://127.0.0.1:<port>/?token=<token>
```

带 token 的这条 URL 就是通道唯一需要的凭据。`--url-file <path>` 读取文件里最后一条带 token 的 URL，队友因此可以从后台服务器的日志里取 URL，而不是复制一个可能已经过期的 token；PowerShell 重定向写出的 UTF-16LE 日志同样会被解码。

## 运行该通道

```sh
npx tsx scripts/browser-floor-lane/drive.ts \
  --chrome "<dir>\r857891\chrome-win\chrome.exe" \
  --url "http://127.0.0.1:<port>/?token=<token>"
```

没有服务器时，同一个驱动可以对着通道自带的夹具页运行：

```sh
npx tsx scripts/browser-floor-lane/drive.ts --chrome "<dir>\r857891\chrome-win\chrome.exe" --smoke
```

| 选项 | 环境变量 | 默认值 |
|---|---|---|
| `--chrome <path>` | `DSH_FLOOR_CHROME` | 无；缺失时运行直接报错 |
| `--url <url>` | `DSH_FLOOR_URL` | `http://127.0.0.1:3080/`，即 Web profile 的端口 |
| `--url-file <path>` | `DSH_FLOOR_URL_FILE` | 无 |
| `--token <token>` | `DSH_FLOOR_TOKEN` | 无；当 URL 不带 token 时追加 |
| `--shots <dir>` | `DSH_FLOOR_SHOTS` | `.artifacts/browser-floor-lane` |
| `--profile <dir>` | `DSH_FLOOR_PROFILE` | `<shots>/chrome-profile` |
| `--report <path>` | `DSH_FLOOR_REPORT` | `<shots>/report.json` |
| `--cdp-port <port>` | `DSH_FLOOR_CDP_PORT` | `9333` |
| `--window <WxH>` | `DSH_FLOOR_WINDOW` | `1440x900` |
| `--narrow-width <px>` | `DSH_FLOOR_NARROW_WIDTH` | `520`，每个断点的带标记一侧 |
| `--wide-width <px>` | `DSH_FLOOR_WIDE_WIDTH` | `2400`，不带标记的一侧 |
| `--engine-major <n>` | `DSH_FLOOR_ENGINE_MAJOR` | `90` |
| `--target-timeout <ms>` | `DSH_FLOOR_TARGET_TIMEOUT` | `60000` |
| `--load-settle <ms>` | `DSH_FLOOR_LOAD_SETTLE` | `4000` |
| `--settle <ms>` | `DSH_FLOOR_SETTLE` | `1200` |
| `--session-attempts <n>` | `DSH_FLOOR_SESSION_ATTEMPTS` | `6`；`0` 表示直接读取已打开的 Session |
| `--session-timeout <ms>` | `DSH_FLOOR_SESSION_TIMEOUT` | `6000` |
| `--fail-on-log-errors` | `DSH_FLOOR_FAIL_ON_LOG_ERRORS=1` | 关闭；参见下面的控制台检查 |
| `--smoke` | 无 | 关闭；对着 `smoke/fixture.html` 运行 |

驱动自己挑选 Session：它按顺序点击侧栏的行，直到某一行渲染出至少两个回合标记，因为回合导航轨道只为多回合 Session 渲染；随后它会恢复原先选中的视图标签页。

输出分三处：stdout 上的 JSON 报告、stderr 上的一行摘要，以及 `--report` 与 `--shots` 里的三张截图。退出码为 `0` 表示所有检查通过，`1` 表示某项检查失败或某项事实读不到，`2` 表示用法或启动失败。

## 每项检查的含义

| 检查 | 读取 | 通过条件 |
|---|---|---|
| `floor.engine` | `navigator.userAgent` | 主版本等于 `--engine-major`；换用其他引擎会让其余检查全部失去意义 |
| `floor.apis` | `CLIENT_FLOOR_APIS` 中每个名字在页面里的解析结果 | 每一项都存在，且没有一项是引擎自带的 `[native code]` 实现，说明 shell 的 compat 安装确实执行过 |
| `floor.iterator-statics` | `Iterator.from`、`Iterator.prototype.map` | 该全局已安装，且这两个静态成员仍为 undefined，即本下限记录的唯一缺口 |
| `layout.composer-control-row` | 输入控件行自身的内容盒、它的 `data-narrow`/`data-tight` 标记，以及两组控件的 `column-gap` | 窄视口下该行不超过 560px、带两个标记且间距为 8px；宽视口下该行超过 560px、不带标记且间距为 12px |
| `layout.header-title-row` | `header` 里标题行的内容盒与其标记 | 窄视口下不超过 540px，且带 `data-narrow`（540）与 `data-tight`（480）；宽视口下两个标记都不带 |
| `layout.turn-rail-band` | 声明对话区宽度的轨道带，以及它选中的轨道框 | 窄视口下该带不超过 900px、带标记，且其轨道框计算为 `display: none`；宽视口下不带标记且轨道框正常渲染 |
| `layout.trajectory-pane` | trajectory 面板自身的宽度、它的标记，以及紧凑列所折叠的类型标签 | 窄视口下面板不超过 620px、带标记，且标签为 `opacity: 0`；宽视口下不带标记且为 `opacity: 1` |
| `scroll.conversation-scroller` | 对话滚动区的计算 `overflow-y` 与为滚动条预留的空间 | 计算值为 `scroll`，即本下限对 `scrollbar-gutter` 的替代；预留宽度会被报告出来 |
| `css.no-container-queries` | 每个已挂载的文档级样式表里的每条规则 | 没有任何 `@container` 规则被挂载，这是本下限无法渲染的特性 |
| `console.errors` | 本次运行的控制台错误与异常，以及浏览器记录的错误级日志条目 | 页面没有记录控制台错误、也没有抛异常。错误级日志条目（请求失败）会写进报告，且只有在 `--fail-on-log-errors` 下才判定失败：与下限无关的路由返回 404，说明不了下限的任何事情 |

## 它看不见什么

- 它只在一个 Session 已渲染的 DOM 上、以两种视口宽度读取。工作区列表、设置、对话框与预览 Worker 都不在其中；Worker 是独立 realm，而通道只读页面 realm。
- 它扫描已挂载的文档级样式表，内联与链接的都包括。shadow root 自己的样式表不在遍历范围内，跨源样式表按读不到计数，而不是被读取。
- 输入控件行自身的宽度由字体度量决定，因此 `--narrow-width` 必须留在该区间内：当该行宽到无法带标记时，检查会带着实测宽度失败，而不会悄悄通过。
- Session 没有挂载的界面会报告为 `absent`，而读不到的事实会判定本次运行失败。回合轨道需要至少两个回合，trajectory 面板需要一个带轨迹的 Session。
- 它不校验出厂字节。产物语法与下限之后的 API 调用点归产物门禁，语料处数归棘轮。
- 一次绿色运行说明：上述事实是在这台服务器、这个引擎上读到的。它对更新的引擎不作任何断言，那些引擎已由仓库中其他浏览器通道覆盖。

## 为什么这是手动通道而不是 CI 任务

没有任何 CI 镜像带 Chromium 90，也不可能有：仓库的浏览器任务安装的是 lockfile 选定的 Chromium 与 WebKit，而本下限比那个 Chromium 早了四年。本下限的部署目标也不是 CI，而是浏览器访问的局域网服务器，因此用新引擎跑一个 CI 任务回答的是另一个问题。该通道因此保持为队友手动重跑的工作站通道，把它排除在矩阵之外的决定记录在这里，而不是藏在一个任务名里。

CI 在它的位置上守住三件事，全部无需密钥，且都在产物一侧。产物门禁 [verify-client-browser-floor.ts](../verify-client-browser-floor.ts) 解析每个浏览器产物以及其中以文本内嵌的每一段 JavaScript 载荷，拒绝下限之后的语法与其 `FLOOR_DENIED_APIS` 清单里的每一处调用点。语料棘轮 [client-browser-floor.spec.ts](../client-browser-floor.spec.ts) 固定解析出的目标、`color-mix()` 改写与动态视口单位回退，证明客户端样式表里的每个 mix 都能解析，并把源码语料固定为被整条丢弃的九类特性的记录处数，其中包括不存在任何容器查询、也不存在任何 `scrollbar-gutter` 声明。API 契约 [compat.client.spec.ts](../../packages/client/web/tests/compat.client.spec.ts) 从 realm 中移除每个 API，按顺序固定安装清单，并驱动每个已安装的实现。这些门禁都做不到的是启动那个引擎；这正是本通道的职责，而行为回归靠重跑它来发现。

## 文件

| 文件 | 作用 |
|---|---|
| `drive.ts` | 选项、浏览器生命周期、DevTools 连接、Session 选择与报告 |
| `steps.ts` | 各项检查、两轮视口读取，以及它们需要的页面操作 |
| `probe.js` | 驱动在页面里求值的源码：必须能被下限引擎解析，且不得调用下限所安装的 API |
| `smoke/fixture.html` | 通道自带的夹具页，用于没有服务器的运行 |

