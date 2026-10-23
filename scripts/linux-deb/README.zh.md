# Linux arm64 Debian 包

[English](README.md) | 中文

`pnpm run deb:build` 在只需要 Docker 和网络连接的构建主机上生成 dsh 的 arm64 `.deb`。
所有工具链、解释器、wheel 和资源归档都在模拟的 linux/arm64 容器中物化，因此交付包可以安装在没有系统 Node.js 或 CPython 的离线 arm64 机器上。

## 构建主机要求

- 可达的 Docker daemon，以及访问 npm、PyPI、nodejs.org、GitHub release 资源和容器镜像仓库的网络。
- 能够运行 linux/arm64 容器。
  在 arm64 主机上是原生运行；在其他主机上，内核必须把 arm64 二进制分派给模拟器，构建器会用 `--emulator` 把它挂载到每个容器。
- 模拟构建所需的磁盘与内存：预计约 15 GB 构建状态和数小时实际耗时；原生 arm64 主机通常少于一小时。

如果 daemon 对 arm64 镜像报告 `exec format error`，先注册一次模拟器：

```sh
docker create --name dsh-binfmt tonistiigi/binfmt:latest
docker cp dsh-binfmt:/usr/bin/qemu-aarch64 /usr/bin/qemu-aarch64-static
docker rm -f dsh-binfmt
printf '%s' ':qemu-aarch64:M::\x7f\x45\x4c\x46\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\xb7\x00:\xff\xff\xff\xff\xff\xff\xff\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/usr/bin/qemu-aarch64-static:POC' > /proc/sys/fs/binfmt_misc/register
```

`POC` 注册适用于拒绝 `F` 标志的内核；构建器随后会把 `--emulator` 挂载到每个容器，使解释器路径在容器内可解析。

## 用法

```sh
pnpm run deb:build                                  # dist/deb/capex-harness_<version>_arm64.deb
pnpm run deb:build -- --glibc-floor 2.28            # rebuild the glibc-linked addons on manylinux 2.28
pnpm run deb:build -- --python-only                 # skip the Node.js CLI payload
pnpm run deb:build -- --stage package               # rerun one stage against the existing work tree
pnpm run deb:build -- --dry-run                     # print the container commands only
```

选项：`--repo`、`--out`、`--work`、`--cache`、`--clean`、`--stage <all|prepare|natives|package|reports>`、`--base-image`、`--js-image`、`--natives-image`、`--emulator`、`--network`、`--glibc-floor`、`--maintainer`、`--revision`、`--python-only`、`--skip-smoke`、`--dry-run`。
`--network host` 把宿主机网络命名空间和解析器交给每个阶段容器；当 Docker bridge 无法解析名称或访问互联网时使用它，否则会在第一次 apt 或 registry 下载时失败。
`--maintainer` 设置 Debian `Maintainer` 字段，默认是本地占位值；包要离开本机时应显式设置。
`--revision` 默认为空，因此产物直接使用产品版本，不附加 Debian revision 后缀。只有下游仓库需要时才显式传入。

下载的依赖保存在 `--cache`（默认 `<work>/cache`），并挂载到每个阶段：apt 归档与索引、work tree 内的 pnpm store、PyPI wheel、打包器的运行时缓存，以及 pip、npm 和 uv 缓存。因此重建会复用它们；只有强制重新下载时才删除缓存，重跑阶段不要删除。

下载默认跟随锁定 URL；网络较慢时可以把构建指向更快的镜像，而校验内容不变：`--npm-registry <url>`（workspace 安装使用的 npm registry，失败后会自动重试 lockfile 记录的 registry）、`--pip-index <url>`、`--apt-mirror <origin+path>`（改写容器的 Ubuntu port 源）、`--js-apt-mirror <origin+path>`（JavaScript 阶段的原生架构源，默认使用 `--apt-mirror`）、`--node-url <url>` 和 `--python-url <url>`（两者仍按锁文件 SHA-256 校验）。
apt 镜像必须通过明文 HTTP 提供，因为构建会先安装 `ca-certificates` 才能进行 TLS 下载；每个镜像还必须提供对应镜像的 Ubuntu 发行版：`--apt-mirror` 指向 arm64 port 归档，`--js-apt-mirror` 指向旁边的原生归档。

## 离线部署

该包面向内网机器：不能访问公网，模型部署在 OpenAI 或 Anthropic 兼容端点之后。随包 profile 与该形态一致。

- 会话遥测和 DeepSeek 会话日志 contributor 关闭，`/usr/bin/dsh` 与 `/usr/bin/dsh-sdk` 设置 `DSH_TELEMETRY_DISABLED=1`；显式环境值仍然优先。
- 网页搜索与抓取工具未挂载，模型不会看到只能访问公网的工具。
- 插件安装只询问一个 registry：pnpm 配置指定的那个（`npm_config_registry`，或 `~/.npmrc`、`/etc/npmrc` 中的 `registry=`），或安装对话框中输入的 URL。公网回退关闭；私有 registry 不需要重建包，机器生成后指向它即可。

首次配置模型：设置 → 模型，填写自定义模型 API 卡片（provider id、显示名称、Base URL、协议、模型 id、API key），然后在输入框的模型选择器中选择一个模型。该选择会成为后续会话的默认值。

## 浏览器基线

随包 UI 面向部署镜像自带的 Chromium 102 shell（Qaxbrowser 1.0.45966.7 报告 Chromium 102.0.5005.200）。

- `pnpm run compat:audit` 扫描构建产物并写入 `dist/compat/chromium102.md`；存在未处理的调用时失败时，`--fail-on=hard` 以非零状态退出。
- Client bundle 按 `chrome102` 编译（`packages/client/tsdown.client.ts`、`apps/web/vite.config.ts`），因此 bundler 不会生成该 shell 丢弃的语法或 range media query。
- `packages/client/web/src/compat.ts` 的 `installBrowserCompat()` 安装 shell 缺少的标准库成员（`Promise.withResolvers`、`AbortSignal.any`/`timeout`、Array copy 方法、Set composition 方法）。缺少它时，模型设置面板会在渲染阶段抛错并保持空白。
- PDF 与电子表格引擎在各自 worker 中运行；`worker-compat.ts` 给两个 blob 源前置相同 shim，Excel 预览用显式 selector 限定 vendor sheet，而不是 scoped at-rule。
- 菜单和 overlay 使用不透明填充，`--dsw-menu-backdrop-filter` 解析为 `none`：该 shell 会把半透明 `backdrop-filter` 合成到空背景上，导致卡片变灰并用漏出的色带覆盖行。
- `color-mix()`、container query 与 `scrollbar-width` 在构建时编译为预计算等价物（`scripts/compat/`），因此 tint、断点和隐藏滚动条仍能工作。
- 仍使用 `:has()` 的规则只会在该 shell 上失去 hover 细节与 overlay padding；启动和设置路径都不依赖它们。

`DSH_CLIENT_TARGET` 可为本地检查覆盖 bundle target，例如 `DSH_CLIENT_TARGET=chrome90 pnpm run build:artifacts` 用来在本地较旧的 shell 中验证。

## 阶段

每个阶段在 `<work>/state` 下记录标记，可以安全重跑：`prepare`（工具链、Node.js、pnpm、workspace 安装、artifacts、原生 addon、打包运行时可执行文件、wheel、随包 CPython、SDK 安装、资源 seed、Python extras 与 wheelhouse）、`natives`（仅当 `--glibc-floor` 低于基础镜像的 2.31）、`package`（重定位、control 文件、ELF 符号采集、`dpkg-deb`、安装后 smoke）和 `reports`（glibc 强制检查以及 `manifest.json`、`DEPENDENCIES.md`）。
删除 work tree 可强制干净构建，或传入 `--clean`。

`prepare` 会针对同一个 work tree 运行两个容器。JavaScript 阶段在 daemon 自身架构上运行，并在 `build:artifacts` 后停止；bundler 会加载模拟环境无法执行的原生绑定，因此该阶段不能放进 arm64 容器。payload 阶段随后在 arm64 容器中运行，为 arm64 重新安装 workspace，并组装其余内容。`--js-image` 指定第一阶段的镜像，默认使用基础镜像。

## 构建性能

首次全量构建主要耗时在 qemu 运行 arm64、安装 workspace、生成 SDK/runtime，以及压缩约 1.1 GB 的 payload。当前 VM 只有 4 个 vCPU，这是主要瓶颈。

- 迭代构建复用同一个 `--work` 和 `--cache`。源码依赖、工具链、原生模块、资源或生成运行时输入变化时运行 `prepare`；其他情况只运行 `package` 和 `reports`。
- `--skip-smoke` 只用于缩短中间迭代；交付构建始终执行已安装包 smoke。
- 常规重构建不要删除依赖缓存；删除后会强制重新下载和生成。
- 增加 VM vCPU 是最直接的硬件加速。qemu 仍会限制单个 arm64 进程，但独立编译、打包和运行时任务可以使用额外核心。
- `--cache` 目录不替代 work store 或已安装的 workspace 闭包。复用 work tree 时保留 `work/store`、`work/.pnpm-store` 和现有依赖树，或者先通过一次联网 prepare 填充。
- 修改静态 bundle 文件后不要盲目复用 state 标记。要刷新产品树或同步对应打包文件，否则测试可能读取源码，而 artifact 仍携带旧 profile。
- 原生二进制不保证存在于源码树。打包前必须生成并检查 `bin/glibc/system.node`、`bin/musl/system.node`、`bin/landlock-run` 和 `node-pty`；只加载模块而不实际加锁不足以证明可用。
- ELF 扫描在 qemu 下非常耗时。产品未变化时缓存 version-info 结果，后续实现可先过滤非 ELF 文件。
- 默认 xz 压缩在这台 VM 上可能需要数十分钟。rc.3 构建使用较低 xz 等级，仍保持 dpkg 广泛兼容，并把压缩阶段降到约 17 分钟，产出 1.13 GB deb。
- registry/CDN 超时优先按缓存缺陷处理：挂载 npm 与 pnpm 元数据缓存，复用锁定 store，最终 artifact 仍执行完整 smoke。
- 运行时验收必须执行包内启动器而不是 grep 文本；覆盖重启后的陈旧 URL、完整浏览器参数、真实 native 锁和插件激活。

## 输出

- `capex-harness_<version>_arm64.deb` — 安装包。它安装 `/usr/bin/dsh`（基于随包 Node.js 的源码构建闭包）、`/usr/bin/dsh-sdk`（随包 Python runtime wheel 的 console script，带默认 `DSH_HOME`）、`/usr/bin/dsh-python`（随包 CPython）、`/usr/bin/dsh-pip`（使用随包 wheelhouse 的离线 pip）、`/usr/bin/dsh-office-convert`（可感知 WPS 的 Office 转换），以及 `/usr/lib/capex-harness` 下的 payload。
- 桌面集成：应用菜单项（`Capex Harness`）和启动器（`/usr/bin/dsh-web`）启动 `capex` profile，等待带认证的 URL，并在当前默认浏览器中打开。启动器优先使用 `DSH_BROWSER`，保留默认浏览器桌面条目中的参数，在 Chromium 兼容浏览器中请求 `--app`，随后回退到已安装的奇安信启动器，最后使用 `xdg-open`。打包 Web 的文档标题和应用框标题都使用 `Capex Harness`。入口通过 `%U` 接收文件 URI；`/usr/bin/dsh-web-register-file-types` 让当前用户选择支持文档的默认关联。以桌面用户（不要 sudo）运行桌面图标辅助命令。`--python-only` 不提供快捷方式，因为启动器运行随包 Node.js CLI。
- 每个操作系统用户使用自己的 `$HOME/.dsh` 和 `$XDG_RUNTIME_DIR` 下的私有 runtime URL（或 `/tmp/capex-harness-<uid>`），共用主机时不会复用其他用户的 Host。设置壳显示 Host 进程所属账号。
- `capex` profile 默认使用 `capexai` OpenAI Chat Completions 路由，地址为 `http://15.11.40.44:3100/v1`，默认模型为 `deepseek-flash`。凭据引用是 `CAPEXAI_API_KEY`，安装包不含密钥；用户可在设置页继续添加提供方。
- ARM64 payload 包含 glibc 与 musl 的 `system.node`、静态 `landlock-run` 启动器和 `node-pty` addon。包内 smoke 会加载 `system.node` 并实际获取一次独占文件锁。
- `DEPENDENCIES.md` — 构建解析出的每个 apt 包、npm tarball、PyPI 分发包、锁定归档、镜像和本地构建产物，包含版本、来源、摘要以及字节是否随包交付。
- `manifest.json` — 同一清单的机器可读形式，包含源码 revision 与 payload 的 glibc 符号上限。
- `verify-on-target.sh` — 安装后在目标机运行：检查架构、glibc、已安装命令，以及 seed 的资源缓存能在禁用下载时服务运行时。
- `build-report/` — 容器证据：渲染后的 control 文件、`dpkg-deb` 检查与内容列表、smoke 输出和 ELF 符号采集。

## 离线 Python extras 与 WPS 转换

ARM64 payload 会把 [`python-extras.requirements.txt`](python-extras.requirements.txt) 中的分发包安装到两个随包 CPython 环境，并把每个解析出的 wheel 复制到 `/usr/lib/capex-harness/wheelhouse`。构建只接受 binary wheel；`record-runtime-extras.py` 把实际安装的版本写入 primary runtime 的 `runtime.json`，`record-wheelhouse.py` 把每个 wheel 的名称、版本和 SHA-256 加入 `DEPENDENCIES.md`。它还会根据 wheel 自身元数据写出 `share/python-wheelhouse-NOTICES.md`，并拒绝 GPL/AGPL 条款。

`dsh-python` 默认把 `PIP_NO_INDEX` 和 `PIP_FIND_LINKS` 指向该 wheelhouse。`dsh-pip` 在 `VIRTUAL_ENV` 指向活跃虚拟环境时使用该环境，否则安装到随包 Python。两个变量都可由操作者覆盖以使用私有源。

Web profile 从 SDK profile 使用的同一 `DSH_PRIMARY_RUNTIME` 或 `DSH_BUNDLED_PRIMARY_RUNTIME` 路径挂载 `workspace-dependencies` 与 `skill-office`。`dsh` 和 `dsh-sdk` 把 `DSH_BUNDLED_OFFICE_CONVERT` 导出给该 profile。

`dsh-office-convert` 接受 `--input`、`--output` 和 `--engine auto|wps|libreoffice`。`auto` 只在系统 WPS 的帮助声明同时包含 `--headless` 与 `--convert-to` 时使用 WPS；探测失败、超时、非零退出或输出无效都会回退 LibreOffice Kit。当 `wps`、`et`、`wpp` 不在 PATH 或 `/opt/kingsoft/wps-office/office6` 时，设置 `DSH_WPS_DIR`。

## 验证与限制

`package` 阶段会在容器中安装生成的 `.deb`，运行 `dsh --version`、`dsh web --help`、`dsh-sdk --help`、`import deepseek_harness`、随包扩展导入、离线虚拟环境安装和 LibreOffice 转换回退；只在迭代打包时使用 `--skip-smoke`。`--python-only` 省略依赖 Node 的 `dsh` 与 `dsh-office-convert`，但保留 `dsh-pip` 和 Python extras。
构建器随后会拒绝 payload 需要高于 `--glibc-floor` 的 glibc 的包，并列出每个违规文件。

已知限制：payload 仅支持 arm64；glibc floor 是基础镜像的 2.31，除非 `--glibc-floor` 触发 manylinux 重建；`--python-only` 会移除 Node.js CLI、其运行时和桌面快捷方式；构建器不会联系目标机，因此 `verify-on-target.sh` 是唯一在目标机运行的检查。
