#!/usr/bin/env bash
# 宿主机没有 curl 时，用运行时镜像里的 curl 顶上。
#
# 为什么需要：目标机在局域网里装不了包，连 curl 都没有，而 doctor / acceptance 的检查
# 全靠 curl（cookie jar、POST、-w 取状态码、-o 落盘）。这里定义一个同名函数：宿主机有
# curl 就用宿主机那份；没有就让 curl 在容器里跑 —— `--network host` 保证 127.0.0.1 仍是
# 宿主自己，`-v /tmp:/tmp` 保证 -o / -c / -b 写的临时文件宿主与容器看到的是同一份，
# 再把项目目录按同一路径只读挂进去、并把容器的工作目录设成它：脚本里有用**相对路径**传给
# curl 的（例如 `--cacert state/tls/ca.crt`），不挂就会得到 `error setting certificate
# file`（实测过，冒烟测试因此少通过一条）。
#
# 前提：所用镜像里装了 curl（基础镜像构建时 `apt-get install -y curl`）。
# 用法：在脚本开头 `. bin/lib-http.sh`。
#
# 镜像选择顺序：`$MT_CURL_IMAGE` → `.env` 的 `DSH_IMAGE` → 本机第一个 `dsh-web:*`。

if ! command -v curl >/dev/null 2>&1; then
  MT_CURL_IMAGE="${MT_CURL_IMAGE:-}"
  if [ -z "$MT_CURL_IMAGE" ] && [ -f .env ]; then
    MT_CURL_IMAGE="$(grep -E '^DSH_IMAGE=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  fi
  if [ -z "$MT_CURL_IMAGE" ] && command -v docker >/dev/null 2>&1; then
    MT_CURL_IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^dsh-web:' | head -1 || true)"
  fi
  curl() {
    if [ -z "$MT_CURL_IMAGE" ]; then
      echo "curl 不可用：宿主机没装，也没找到可用镜像 —— 设 MT_CURL_IMAGE=<带 curl 的镜像>（bin/lib-http.sh）" >&2
      return 127
    fi
    docker run --rm --network host -v /tmp:/tmp -v "$PWD:$PWD:ro" -w "$PWD" \
      --entrypoint curl "$MT_CURL_IMAGE" "$@"
  }
fi
