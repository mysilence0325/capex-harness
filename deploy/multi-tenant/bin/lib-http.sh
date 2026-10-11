#!/usr/bin/env bash
# 宿主机没有 curl 时，用 python3 的 curl 替身顶上（bin/curl-shim.py）。
#
# 为什么需要：目标机在局域网里装不了包，连 curl 都没有，而 doctor / acceptance 的检查
# 全靠 curl（cookie jar、POST、-w 取状态码、-o 落盘）。这里定义一个同名函数按顺序找：
#
#   1. 宿主机的 curl —— 有就用它；
#   2. python3 + bin/curl-shim.py —— python3 是这些脚本本来就依赖的（JSON 解析、凭据文件）；
#   3. 容器里的 curl —— 只在 `MT_CURL_IMAGE` 显式指向一个**确实带 curl** 的镜像时才有意义。
#
# 第 3 条为什么排最后：运行时镜像里根本没有 curl（基础镜像没装），早先"跑进运行时镜像"的
# 做法在目标机上必然是死的。`MT_CURL_SHIM=1` 可以强制走第 2 条——本机有 curl、
# 但要验证替身这条路时用得上（目标机就是这条路）。
#
# 用法：在脚本开头 `. bin/lib-http.sh`。
#
# 容器镜像选择顺序（仅第 3 条用）：`$MT_CURL_IMAGE` → `.env` 的 `DSH_IMAGE` → 本机第一个 `dsh-web:*`。

_MT_SHIM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/curl-shim.py"

if [ "${MT_CURL_SHIM:-}" = "1" ] || ! command -v curl >/dev/null 2>&1; then
  if command -v python3 >/dev/null 2>&1 && [ -f "$_MT_SHIM" ]; then
    curl() { python3 "$_MT_SHIM" "$@"; }
  else
    MT_CURL_IMAGE="${MT_CURL_IMAGE:-}"
    if [ -z "$MT_CURL_IMAGE" ] && [ -f .env ]; then
      MT_CURL_IMAGE="$(grep -E '^DSH_IMAGE=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
    fi
    if [ -z "$MT_CURL_IMAGE" ] && command -v docker >/dev/null 2>&1; then
      MT_CURL_IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^dsh-web:' | head -1 || true)"
    fi
    curl() {
      if [ -z "$MT_CURL_IMAGE" ]; then
        echo "curl 不可用：宿主机没装、也没有 python3+bin/curl-shim.py，也没找到可用镜像 —— 装一个 curl，或设 MT_CURL_IMAGE=<确实带 curl 的镜像>（bin/lib-http.sh）" >&2
        return 127
      fi
      docker run --rm --network host -v /tmp:/tmp -v "$PWD:$PWD:ro" -w "$PWD" \
        --entrypoint curl "$MT_CURL_IMAGE" "$@"
    }
  fi
fi
