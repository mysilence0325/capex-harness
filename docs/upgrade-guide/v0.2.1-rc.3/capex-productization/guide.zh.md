---
kind: upgrade-guide
description: "Debian 产品改为启动 capex profile，并加入本机身份、桌面文件打开、自检和可恢复维护命令。"
---

# Capex 改为启动 `capex` profile

[English](guide.md) | 中文

## 变更

Debian 启动器现在启动 `capex`。它是由 `dsh-base`、`dsh-web-app` 和 `dsh-capex` 组成的离线 Web profile，禁用云端账号消费方，同时保留 `credentials-local` 用于浏览器会话 Cookie。设置壳在没有账号入口时显示 Host 进程所属的本机用户姓名；桌面打开文档时进入空 Session 的文档预览。Client Remote 装配包含 `remote.storageMaintenance`，本地数据设置行可以正常激活。

Debian 启动器使用当前默认浏览器。在 X11 上，不带文档参数的点击会先聚焦当前用户标题为 `Capex Harness` 的窗口，`示例 - Capex Harness` 这类 Session 标题同样匹配；其他操作系统用户的窗口会被忽略。启动器遵循 `DSH_BROWSER`，保留默认浏览器参数，在 Chromium 兼容浏览器中请求 `--app`，随后回退到奇安信和 `xdg-open`。文档标题和应用框标题均为 `Capex Harness`。

`capex` profile 提供 `capexai` OpenAI Chat Completions 路由，地址为 `http://15.11.40.44:3100/v1`，默认模型为 `deepseek-flash`。认证使用 `CAPEXAI_API_KEY`，安装包不含密钥。模型设置按 profile 隔离：旧 `web` 设置保留，但不会出现在 `capex`。

多人共用主机时，每个操作系统账号都有自己的 `$HOME/.dsh`、私有 runtime URL 和 Host 进程，设置壳显示该进程所属账号。多个自然人共用同一个操作系统账号时不会被区分。

ARM64 包恢复了先前同版本产物遗漏的 glibc/musl `system.node` 和 `landlock-run`；Session 持久化依赖该原生文件锁。

`dsh doctor` 检查安装和模型端点。`dsh clean` 预览可恢复的本地数据维护；`--apply` 把符合条件的已归档 Session 和无引用数据移入 `$DSH_HOME/trash/maintenance` 下的批次，`--restore` 可反向恢复。Debian 产物不再附加 revision，文件名为 `capex-harness_<version>_arm64.deb`。

## 迁移

1. 用 `sudo dpkg -i capex-harness_0.2.1~rc.3_arm64.deb` 重装修复后的同版本产物。
2. 自定义启动命令改用 `dsh capex`，不要继续使用 `dsh web`。
3. 如果本地凭据库中还没有 `CAPEXAI_API_KEY`，在“设置 → 模型”中录入一次密钥；不要把它写进 `cordis.patch.yml`。
4. 其他提供方的设置写入 `$DSH_HOME/profiles/capex/cordis.patch.yml`；`profiles/web` 中的设置不会自动迁移。
5. 仅在需要覆盖桌面默认浏览器时设置 `DSH_BROWSER`；随包启动器会保留奇安信安全启动器的参数。
6. 运行 `dsh doctor --quick`，再运行 `dsh doctor --model-url http://15.11.40.44:3100/v1`，并确认一次模型请求成功。
7. 先运行 `dsh clean` 预览，再运行 `dsh clean --apply`；执行前应停止 Web Host。保存输出中的批次名，需要时用 `dsh clean --restore <batch>` 恢复。
8. 如果希望支持的文档默认由 Capex 打开，以桌面用户身份运行 `/usr/bin/dsh-web-register-file-types`。
9. 确认桌面入口为 `Exec=/usr/bin/dsh-web %U`，窗口标题为 `Capex Harness`，X11 上再次点击会聚焦已有窗口而不是新建窗口，设置页显示 `capexai` 和 `DeepSeek Flash`，本地数据加载且没有插件错误。
10. 运行交付的 `verify-on-target.sh`；它会检查原生 payload，并实际获取一次独占文件锁。
