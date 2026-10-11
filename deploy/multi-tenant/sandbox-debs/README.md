# bubblewrap 的离线安装包

运行时镜像的基础层里没有 bubblewrap（`node:22-bookworm-slim` 不装它），而 DSH 的沙箱链首选
就是 bwrap（`bwrap → Landlock`，见 `packages/sandbox/sandbox-local`）。目标机在隔离网络里
装不了包，所以这里随包带一份。

| 文件 | 来源 | 说明 |
|---|---|---|
| `bubblewrap_0.8.0-2+deb12u1_amd64.deb` | Debian bookworm（`deb.debian.org`，2026-10-11 取得） | 47 320 字节，sha256 `3cc9134a3286ad01a323dcd924ba123eb634cefaeec82d774257e06308aeaadb`；依赖 `libc6`、`libcap2`、`libselinux1` 镜像里都已有，单独 `dpkg -i` 即可 |

`bin/install-offline.sh` 会在导入镜像之后，从运行时镜像派生一层（`<标签>-sandbox`）把
这个包装进去，并把 `DSH_IMAGE` 指向派生镜像。**DSH 默认仍然自己选沙箱**：容器里那条
自带探针用的是"不建用户命名空间"的 bwrap 参数，容器里通常起不来，于是落到 Landlock。
要用 bwrap 那条路，先用 `bin/sandbox-check.sh` 确认这台机器上行不行，再加
`MT_SANDBOX_BWRAP=1`（`bin/render.js` 会给每个租户的 profile patch 拼上
`sandbox-local.runnerCommand: ['bwrap','--unshare-user']`）。
