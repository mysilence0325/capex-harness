# Chromium 90 浏览器下限通道

[English](README.md) | 中文

该通道用 Chrome DevTools 协议驱动一个便携版 Chromium 90 快照构建，对着已经在运行的 `dsh web` 服务器，把下限的事实从该引擎里读回来，写出截图，并打印一份 JSON 报告。它是[客户端浏览器下限](../../.agents/notes/implemented/architecture/2026-09-30-client-browser-floor.zh.md)的行为一半：与它并列的门禁固定构建输入与出厂字节，而这条通道负责说明服务器提供的客户端在该引擎上仍然渲染。它的三项检查需要服务器后面有一个真实模型，第四项需要服务器按本仓库的 agent-team 叠加层启动；其余检查对任何服务器都成立。

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

有三项检查会往输入框里打字、让真实模型作答，因此它们所对的服务器必须在自己进程的环境里持有密钥：

```sh
$env:DEEPSEEK_API_KEY='<key>'
pnpm dsh web --no-open --port 3081
```

密钥只属于那个服务器进程；本通道既不读取它，也不写入或打印它。

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

带密钥的检查是显式开启的，因为其余每一项检查都对没有模型在背后的服务器成立：

```sh
npx tsx scripts/browser-floor-lane/drive.ts \
  --chrome "<dir>\r857891\chrome-win\chrome.exe" \
  --url-file .artifacts/floor-lane-server.log --model-checks
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
| `--engine-native <a,b>` | `DSH_FLOOR_ENGINE_NATIVE` | 无；目标引擎自带的那些下限 API，它们由引擎自己提供，而不该被读成安装被跳过 |
| `--target-timeout <ms>` | `DSH_FLOOR_TARGET_TIMEOUT` | `60000` |
| `--load-settle <ms>` | `DSH_FLOOR_LOAD_SETTLE` | `4000` |
| `--settle <ms>` | `DSH_FLOOR_SETTLE` | `1200` |
| `--session-attempts <n>` | `DSH_FLOOR_SESSION_ATTEMPTS` | `6`；`0` 表示直接读取已打开的 Session |
| `--session-timeout <ms>` | `DSH_FLOOR_SESSION_TIMEOUT` | `6000` |
| `--model-checks` | `DSH_FLOOR_MODEL_CHECKS=1` | 关闭；对着以 `DEEPSEEK_API_KEY` 启动的服务器运行带密钥的真实模型检查 |
| `--pdf-preview <file>` | `DSH_FLOOR_PDF_PREVIEW` | 无；打开工作区里已有的某个 PDF 并对它运行 `preview.pdf`，无需模型 |
| `--gesture-timeout <ms>` | `DSH_FLOOR_GESTURE_TIMEOUT` | `45000`；模型检查中一次页面手势的等待上限 |
| `--reply-timeout <ms>` | `DSH_FLOOR_REPLY_TIMEOUT` | `240000`；一个真实模型回合的等待上限 |
| `--fail-on-log-errors` | `DSH_FLOOR_FAIL_ON_LOG_ERRORS=1` | 关闭；参见下面的控制台检查 |
| `--smoke` | 无 | 关闭；对着 `smoke/fixture.html` 运行 |

驱动自己挑选 Session：它按顺序点击侧栏的行，直到某一行渲染出至少两个回合标记，因为回合导航轨道只为多回合 Session 渲染；随后它会恢复原先选中的视图标签页。两轮视口读取之后，它会打开右侧边栏、选择工作区文件入口并打开 `AGENTS.md`，这正是预览检查所读取的手势。

输出分三处：stdout 上的 JSON 报告、stderr 上的一行摘要，以及 `--report` 与 `--shots` 里的三张截图，`--pdf-preview` 下是四张，`--model-checks` 下是五张。退出码为 `0` 表示所有检查通过，`1` 表示某项检查失败或某项事实读不到，`2` 表示用法或启动失败。

### 对更高的内核运行

`--engine-major` 与 `--engine-native` 让一次运行读取一个高于下限的内核，这正是部署在加固过的厂商浏览器上所需要的。下限版本自带契约里一个 API 都没有，所以下限运行一个都不声明；更高的内核自带其中一部分，而 shell 会恰好跳过这些安装。

先不带 `--engine-native` 跑一次：失败的 `floor.apis` 读数会列出它读到的引擎自带 API，这份清单就是该选项要传的值。声明里出现 `CLIENT_FLOOR_APIS` 之外的名字，或出现该引擎并不自带的 API，都会让检查失败，而不是悄悄通过。

```sh
npx tsx scripts/browser-floor-lane/drive.ts \
  --chrome "/usr/bin/qaxbrowser-safe-stable" \
  --url "https://<host>:8090/?token=<token>" \
  --engine-major 102 \
  --engine-native "<the list the run without the flag read back>"
```

对更高内核的运行陈述的是该引擎上的事实，它并不移动下限。客户端仍然按 `chrome90` 构建；而拒绝远程调试端口的厂商构建会在第一项检查之前失败，这是该构建的属性，而不是客户端的属性。声明 API 清单只解决 `floor.apis` 一项：断言以下限自身版本为准的那些检查仍会报告该引擎的不同之处——更高的 `Iterator` 全局带有下限记录为缺失的那些静态成员，于是 `floor.iterator-statics` 会指名它们。

## 每项检查的含义

| 检查 | 读取 | 通过条件 |
|---|---|---|
| `floor.engine` | `navigator.userAgent` | 主版本等于 `--engine-major`；换用其他引擎会让其余检查全部失去意义 |
| `floor.apis` | `CLIENT_FLOOR_APIS` 中每个名字在页面里的解析结果 | 每一项都存在；除 `--engine-native` 声明的那些之外，没有一项是引擎自带的 `[native code]` 实现，说明引擎缺少的每一项都由 shell 的 compat 安装补齐 |
| `floor.iterator-statics` | `Iterator.from`、`Iterator.prototype.map` | 该全局已安装，且这两个静态成员仍为 undefined，即本下限记录的唯一缺口 |
| `layout.composer-control-row` | 输入控件行自身的内容盒、它的 `data-narrow`/`data-tight` 标记，以及两组控件的 `column-gap` | 窄视口下该行不超过 560px、带两个标记且间距为 8px；宽视口下该行超过 560px、不带标记且间距为 12px |
| `layout.header-title-row` | `header` 里标题行的内容盒与其标记 | 窄视口下不超过 540px，且带 `data-narrow`（540）与 `data-tight`（480）；宽视口下两个标记都不带 |
| `layout.agent-team-trigger` | 实验性 agent-team 头部动作的标签，以及标题行发布的标记 | 在未组合 `@deepseek-ai/dsh-experimental-client-ui-agent-team` 的服务器上报告为不适用；在组合了该包的服务器上，带标记的标题行只保留触发器的图标、把标签计算为 `display: none`，不带标记时则显示标签 |
| `layout.turn-rail-band` | 声明对话区宽度的轨道带，以及它选中的轨道框 | 窄视口下该带不超过 900px、带标记，且其轨道框计算为 `display: none`；宽视口下不带标记且轨道框正常渲染 |
| `layout.trajectory-pane` | trajectory 面板自身的宽度、它的标记，以及紧凑列所折叠的类型标签 | 窄视口下面板不超过 620px、带标记，且标签为 `opacity: 0`；宽视口下不带标记且为 `opacity: 1` |
| `scroll.conversation-scroller` | 对话滚动区的计算 `overflow-y` 与为滚动条预留的空间 | 计算值为 `scroll`，即本下限对 `scrollbar-gutter` 的替代；预留宽度会被报告出来 |
| `css.no-container-queries` | 每个已挂载的文档级样式表里的每条规则 | 没有任何 `@container` 规则被挂载，这是本下限无法渲染的特性 |
| `preview.workspace-file` | 工作区文件面板打开的 `AGENTS.md` 文档容器 | 其 `data-textpreview-state` 为 `text`，且渲染文本带有该文档自己的开篇文字，说明文件资源服务应答了这个地址 |
| `model.streaming-round-trip` | 通道自己的提示词所产生的助手步骤，由发送前安装的页面观察器采样 | 输入框发出了提示词，助手步骤进入流式状态且其文本在流式过程中增长，最终落在带有提示词所要求区间两端的回复上，且没有错误提示 |
| `layout.deliverables-card` | 收尾回合的改动文件卡片与它旁边的已声明交付网格，在两种视口下读取 | 改动文件卡片列出该回合被要求写入的文件；窄视口下网格容器带 `data-narrow` 且计算为一列，宽视口下不带标记且计算为两列 |
| `preview.pdf` | 模型写出的 PDF，或 `--pdf-preview` 指名的文件，经工作区文件面板打开 | 预览选中了 PDF 渲染器、页面表面离开渲染状态，且画布带有文档的墨迹。拒绝这些字节的正文会渲染它自己的失败行；仍停留在渲染状态的页面表面、或没有墨迹的画布，都不算渲染出的文档——检查会报告它读到的那一种 |
| `console.errors` | 本次运行的控制台错误与异常，以及浏览器记录的错误级日志条目 | 页面没有记录控制台错误、也没有抛异常。错误级日志条目（请求失败）会写进报告，且只有在 `--fail-on-log-errors` 下才判定失败：与下限无关的路由返回 404，说明不了下限的任何事情 |

### 工作区文件预览

该检查打开某个 Session 的右侧边栏、工作区文件面板，并在其中打开 `AGENTS.md`，然后读取预览容器自身的状态。它之所以在这里，是因为没有任何 Node 端用例能证明这个事实：预览的地址是 `dsh-resource://file/…` URL，其协议键从地址字符串读出，而 Chromium 90 的 URL 解析器对非特殊 scheme 读不出 host——`hostname` 保持为空，其余部分落进 opaque path——而当前 Chromium、Node 与 Electron 引擎读到的是 `file`。该推导的归属地是 [resources.ts](../../packages/client/resources/src/client/resources.ts)；本通道就是下限引擎回答它的地方。

检查所要求的文字是检出目录里 `AGENTS.md` 的开篇行，在运行通道时读取，而不是固定在旁边，因此对文档的修改不会留下过期的期望；通道指向的服务器提供的正是同一个工作区。面板通过客户端为自身行为渲染的标记抵达——头部的展开控件、引导页的 `files` 入口、文件行的路径——因此同一套手势适用于任何语言。

### 改动文件卡片的 404

当某个 Session 的轮次早于录制进程的活跃窗口时，一次运行会记录若干条错误级日志条目：`GET /api/changes.summary?sessionId=…&seq=…` 回答 `404`。所有者已按设计接受这些条目：改动文件卡片是只在活跃轮次存在的产物，因此 Host 一旦不再持有该轮次的摘要，就会以 `404` 回答 `Change summary unavailable.`；读取更早的 Session 就是在请求已经不存在的摘要。该路由已挂载，这个回答来自它注册的处理器，即 [present-open.ts](../../packages/client/ui-deliverables/src/present-open.ts) 里的 `handleChangesSummary`；产品行为没有变化，其归属说明见[交付物包 README](../../packages/client/ui-deliverables/README.zh.md)。

三种回答共用这个状态码，只有正文能区分它们：`not found` 是分发器回答没有匹配到路由，`Change summary unavailable.`（`/api/changes.diff` 为 `Change comparison unavailable.`）是该处理器拒绝一份它已不再持有的摘要，而正文为空且没有 `content-type` 则是 SPA 回退。控制台日志条目只带状态码和 URL、不带正文，因此通道仅凭日志无法区分这三者。

报告会给它认出的条目加上标注。`events.logErrorLabels` 为每条路径以 `/api/changes.` 开头、且日志文本写明 `404` 的错误级日志条目保存一条记录：它在 `events.logErrors` 中的下标、路径、状态码、标注 `handler's own expired-summary answer`，以及一条说明，指出这个读法依据的是 URL 家族与状态码，而不是对响应的查看。`events.logErrors` 中其他条目保持原样，标注也不决定任何判定：控制台错误与异常仍然判定运行失败，错误级日志条目仍然只在 `--fail-on-log-errors` 下判定失败。

### 带密钥的真实模型检查

有三项检查需要以 `DEEPSEEK_API_KEY` 启动的服务器，驱动只在 `--model-checks` 下运行它们。它们会另开一个 Session，因此它们输入的提示词不会落进其他检查所读的那个 Session；它们排在最后运行，因为那个 Session 并不是前面各项读数所测量的对象。

它们的提示词是固定的，这样一次失败的运行与一次通过的运行指名的是同一个事实：

| 检查 | 提示词 |
|---|---|
| `model.streaming-round-trip` | `Count from 1 to 40, one number per line.` |
| `layout.deliverables-card` | `Use the write tool to create two files in the working directory: floor-lane-probe.txt and floor-lane-probe-b.txt, each containing exactly the single word ok. Then call the present tool with both files as deliverables, and reply with one short sentence.` |
| `preview.pdf` | `Use the write tool to create a file named floor-lane-probe.pdf whose entire content is exactly these lines, byte for byte and with no code fence:`，随后是一页 PDF 的 445 字节，再是 `Do not change, reorder, or add any character. Then reply with one short sentence.` |

这两个提示词的写法由界面本身决定，而不是出于偏好。流式检查要求四十行，是因为单 token 的回答会让助手步骤一挂载就已经结束——在这个客户端上实测，`ok` 根本不会渲染出流式状态——基于这种回答的检查只能读到最终文本；它的观察器除定时采样外还监听 DOM 变更，因为短回答可以在两次定时采样之间加上又移除流式属性。交付检查要求两个文件，是因为单个已声明文件会让交付网格在任何宽度下都收成一列；它要求模型调用 `present`，是因为那个网格属于已声明的交付，而不是它旁边的改动文件卡片。

运行写出什么，就读什么：这三个文件落在该 Session 的工作区里，服务器从本检出目录启动时，那就是本检出目录。它们带 `floor-lane-probe` 前缀，便于查找与删除；重跑会覆盖它们。

回答是模型自己的。检查失败时会指名缺失的那个事实——回复没带上区间、该回合没有渲染出改动文件卡片、模型没有调用 `present`——因此一次红色的运行可能意味着模型答得不一样，而不是客户端坏了；通道宁可显式失败，也不把这样的回答读成通过。

### PDF 预览的墨迹读数

`preview.pdf` 会读取画布自身的像素，因为页面表面可以在一个从未被绘制过的画布上报出就绪。当阅读器收到的算子列表为空时，它的一次渲染仍然会成功结束：显示层把这份被截断的列表标为最后一块并据此运行渲染任务，而给该任务放行的能力早在页面的起始消息里就已兑现，因此随空列表一起到来的拒绝已经无处可拒。面板因此可以进入就绪状态、不渲染任何失败行，却显示一张白页。Chromium 90 在下限缺少 `ArrayBuffer.prototype.transferToFixedLength` 时正是如此：Worker 的字体导出抛错，显示层画完页面底色就停下，而检查记录到的是一块 400x213 的画布、表面就绪、没有失败行、也没有墨迹。

由模型驱动的那一步是更完整的读数，因为它还证明模型自己的字节确实抵达了阅读器。当文档已经在 Session 工作区里——重跑，或有人用那份 445 字节的探针文档铺过工作区——同一项检查无需模型即可运行：

```sh
cp scripts/browser-floor-lane/smoke/floor-lane-probe.pdf .
npx tsx scripts/browser-floor-lane/drive.ts \
  --chrome "<dir>\r857891\chrome-win\chrome.exe" \
  --url-file .artifacts/floor-lane-server.log --pdf-preview floor-lane-probe.pdf
```

`--pdf-preview <file>` 用同一套工作区文件手势打开该文件、等待同样长的静默窗口来读取正文的决定，并报告同一项 `preview.pdf` 检查，因此一份报告里这样的检查只有一项：只有当 `--model-checks` 关闭时，驱动才会提供这个无需密钥的步骤。它读的是磁盘上的字节，因此它对模型能否写出这些字节不作断言；那仍然是带密钥那一步的职责。

### agent-team 触发器

`layout.agent-team-trigger` 在未组合实验性 agent-team 客户端包的服务器上报告为不适用，而普通的每一次运行都是这种情况，通道在那里保持绿色。要读到它，就用仓库自带的叠加层再起一台服务器，并把一次运行指向它：

```sh
pnpm dsh web --patch apps/web/tests/agent-team-panel.overlay.yml --no-open --port 3082
```

`--patch` 属于启动器，它会从第一个自己不认识的选项起，把后面的参数原样交给被启动的应用，因此叠加层要写在 `--no-open` 前面。

## 它看不见什么

- 它只在一个 Session 已渲染的 DOM 上、以两种视口宽度读取，外加工作区文件面板打开的那一个文档预览。工作区列表、设置、对话框与预览 Worker 都不在其中；Worker 是独立 realm，而通道只读页面 realm。
- 它扫描已挂载的文档级样式表，内联与链接的都包括。shadow root 自己的样式表不在遍历范围内，跨源样式表按读不到计数，而不是被读取。
- 输入控件行自身的宽度由字体度量决定，因此 `--narrow-width` 必须留在该区间内：当该行宽到无法带标记时，检查会带着实测宽度失败，而不会悄悄通过。
- Session 没有挂载的界面会报告为 `absent`，而读不到的事实会判定本次运行失败。回合轨道需要至少两个回合，trajectory 面板需要一个带轨迹的 Session。
- 它不校验出厂字节。产物语法与下限之后的 API 调用点归产物门禁，语料处数归棘轮。
- 不带 `--model-checks` 时，这三项带密钥的检查不会出现；而该选项只对以 `DEEPSEEK_API_KEY` 启动的服务器有意义：没有密钥的服务器会在第一句提示词上失败，而不是读到任何东西。
- 这些检查读的是真实模型自己的工作，因此它们既在测量客户端，也在测量模型。每次失败都会指名缺失的事实，同一棵树上重跑也可能由红转绿。
- `preview.pdf` 会抵达 PDF 阅读器自己的 Worker realm，而不只是页面：阅读器只用 `pdf.worker.min.mjs` 构建它的 Worker（[runtime.ts](../../packages/client/ui-sidebar-documentpreview/src/client/pdf/runtime.ts)），因此只覆盖页面 realm 的安装会让文档渲染不出来，检查会报告正文自己的失败行。它还会读取画布自身的像素，因为页面表面可以在一个从未被绘制过的画布上报出就绪——这正是本检查在 Chromium 90 上记录到的读数：一块 400x213 的画布、表面就绪、没有失败行，也没有墨迹。
- `--pdf-preview` 读的是一份并非通道自己创建的文档。它证明阅读器在这个引擎上能画出这些字节，而不证明模型能写出它们；后者仍是带密钥那一步的读数。
- 一次带密钥的运行结束后，`floor-lane-probe.txt`、`floor-lane-probe-b.txt` 与 `floor-lane-probe.pdf` 会留在工作区里。通道不会删除它们。
- 一次绿色运行说明：上述事实是在这台服务器、这个引擎上读到的。它对任何其他引擎都不作断言：一次运行只读 `--engine-major` 指名的那个引擎，而更高内核自带的 API 必须先由 `--engine-native` 声明，它的 `floor.apis` 读数才有意义。

## 为什么这是手动通道而不是 CI 任务

没有任何 CI 镜像带 Chromium 90，也不可能有：仓库的浏览器任务安装的是 lockfile 选定的 Chromium 与 WebKit，而本下限比那个 Chromium 早了四年。本下限的部署目标也不是 CI，而是浏览器访问的局域网服务器，因此用新引擎跑一个 CI 任务回答的是另一个问题。该通道因此保持为队友手动重跑的工作站通道，把它排除在矩阵之外的决定记录在这里，而不是藏在一个任务名里。

CI 在它的位置上守住三件事，全部无需密钥，且都在产物一侧。产物门禁 [verify-client-browser-floor.ts](../verify-client-browser-floor.ts) 解析每个浏览器产物以及其中以文本内嵌的每一段 JavaScript 载荷，拒绝下限之后的语法与其 `FLOOR_DENIED_APIS` 清单里的每一处调用点。语料棘轮 [client-browser-floor.spec.ts](../client-browser-floor.spec.ts) 固定解析出的目标、`color-mix()` 改写与动态视口单位回退，证明客户端样式表里的每个 mix 都能解析，并把源码语料固定为被整条丢弃的九类特性的记录处数，其中包括不存在任何容器查询、也不存在任何 `scrollbar-gutter` 声明。API 契约 [compat.client.spec.ts](../../packages/client/web/tests/compat.client.spec.ts) 从 realm 中移除每个 API，按顺序固定安装清单，并驱动每个已安装的实现。这些门禁都做不到的是启动那个引擎；这正是本通道的职责，而行为回归靠重跑它来发现。

## 文件

| 文件 | 作用 |
|---|---|
| `drive.ts` | 选项、浏览器生命周期、DevTools 连接、Session 选择与报告 |
| `steps.ts` | 各项检查、两轮视口读取、工作区文件手势，以及它们需要的页面操作 |
| `model-steps.ts` | PDF 预览检查，以及围绕它的带密钥真实模型步骤：它们打开的 Session、输入的提示词，以及读回来的事实 |
| `probe.js` | 驱动在页面里求值的源码：必须能被下限引擎解析，且不得调用下限所安装的 API |
| `smoke/fixture.html` | 通道自带的夹具页，用于没有服务器的运行 |

