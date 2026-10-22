---
kind: upgrade-guide
description: "Debian 产品改为启动 capex profile，并加入本机身份、桌面文件打开、自检和可恢复维护命令。"
---

# Capex 改为启动 `capex` profile

[English](guide.md) | 中文

## 变更

Debian 启动器现在启动 `capex`。它是由 `dsh-base`、`dsh-web-app` 和 `dsh-capex` 组成的离线 Web profile，禁用云端账号消费方，同时保留 `credentials-local` 用于浏览器会话 Cookie。设置壳在没有账号入口时显示 Host 进程所属的本机用户姓名；桌面打开文档时进入空 Session 的文档预览。

`dsh doctor` 检查安装和模型端点。`dsh clean` 预览可恢复的本地数据维护；`--apply` 把符合条件的已归档 Session 和无引用数据移入 `$DSH_HOME/trash/maintenance` 下的批次，`--restore` 可反向恢复。Debian 产物不再附加 revision，文件名为 `capex-harness_<version>_arm64.deb`。

## 迁移

1. 自定义启动命令改用 `dsh capex`，不要继续使用 `dsh web`。
2. 现场模型端点继续放在设置中，或通过 `dsh doctor --model-url` 传入；安装包不会写入该地址。
3. 安装后运行 `dsh doctor --quick`，再用 `dsh doctor --model-url <base-url>` 检查实际模型。
4. 先运行 `dsh clean` 预览，再运行 `dsh clean --apply`；执行前应停止 Web Host。保存输出中的批次名，需要时用 `dsh clean --restore <batch>` 恢复。
5. 如果希望支持的文档默认由 Capex 打开，以桌面用户身份运行 `/usr/bin/dsh-web-register-file-types`。
6. 确认桌面入口为 `Exec=/usr/bin/dsh-web %U`，`gio open` 能打开预览，侧栏显示本机用户姓名。
