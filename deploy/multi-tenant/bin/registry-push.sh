#!/usr/bin/env bash
# 把本部署用到的镜像推进内网镜像仓库，供离线环境下的其它机器拉取。
#
# 离线环境没有 Docker Hub，**一台新机器要跑起来，镜像必须先在这里**。推送哪些：
#   - 租户运行时镜像（DSH_IMAGE）
#   - 控制面与节点侧四个镜像：mt-gateway / mt-egress-proxy / mt-model-gateway / mt-node-agent
#
# 凭据优先级：命令行 --user/--password > .env 里的 MT_REGISTRY_USER/MT_REGISTRY_PASSWORD
# > 已登录的 docker 凭据（~/.docker/config.json）。都不行就明确报错，不静默失败。
#
# 用法：
#   bin/registry-push.sh                      # 推到 .env 里配置的仓库
#   bin/registry-push.sh --tag 20261003       # 指定标签（默认取 DSH_IMAGE 的标签）
#   bin/registry-push.sh --runtime-only       # 只推运行时镜像
#   bin/registry-push.sh --host harbor.lan --project dsh --plain-http
set -uo pipefail
cd "$(dirname "$0")/.."

HOST_OPT=""
PROJECT=""
TAG=""
RUNTIME_ONLY=no
PLAIN_HTTP=""
USERNAME=""
PASSWORD=""

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

HOST_OPT="${MT_REGISTRY_HOST:-}"
PROJECT="${MT_REGISTRY_PROJECT:-dsh}"
USERNAME="${MT_REGISTRY_USER:-}"
PASSWORD="${MT_REGISTRY_PASSWORD:-}"
PLAIN_HTTP="${MT_REGISTRY_PLAIN_HTTP:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST_OPT="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --user) USERNAME="${2:-}"; shift 2 ;;
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --plain-http) PLAIN_HTTP=1; shift ;;
    --runtime-only) RUNTIME_ONLY=yes; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$HOST_OPT" ]; then
  echo "没有配置镜像仓库。在 .env 里写 MT_REGISTRY_HOST=<仓库地址:端口>，或用 --host 指定。" >&2
  echo "本机的 Harbor 通常在 127.0.0.1:18083（先确认它是 http 还是 https）。" >&2
  exit 2
fi

RUNTIME_IMAGE="${DSH_IMAGE:-}"
[ -n "$RUNTIME_IMAGE" ] || { echo "读不到 DSH_IMAGE（.env），先执行 bin/mt.sh up" >&2; exit 1; }
[ -n "$TAG" ] || TAG="${RUNTIME_IMAGE##*:}"

echo "==> 目标仓库 ${HOST_OPT}/${PROJECT}，标签 ${TAG}"

# 仓库是明文 http 时必须显式声明，否则 docker 会当成 https 去连然后失败。
if [ -n "$PLAIN_HTTP" ]; then
  case "$HOST_OPT" in
    */*) ;;
    *)
      INSECURE="$(docker info --format '{{range .RegistryConfig.InsecureRegistryCIDRs}}{{.}} {{end}}' 2>/dev/null)"
      case " $INSECURE " in
        *" $HOST_OPT "*) ;;
        *) echo "注意：${HOST_OPT} 不在 docker 的 insecure-registries 里，明文推送会失败。" >&2
           echo "      在 /etc/docker/daemon.json 里加 \"insecure-registries\": [\"${HOST_OPT}\"] 后重启 docker。" >&2 ;;
      esac ;;
  esac
fi

if [ -n "$USERNAME" ]; then
  echo "==> 登录 ${HOST_OPT}（用户 ${USERNAME}）"
  if ! printf '%s' "$PASSWORD" | docker login "$HOST_OPT" --username "$USERNAME" --password-stdin >/dev/null 2>&1; then
    echo "登录失败：检查 .env 里的 MT_REGISTRY_USER / MT_REGISTRY_PASSWORD" >&2
    exit 1
  fi
else
  echo "==> 未提供账号，使用 docker 已有的登录凭据"
fi

push_one() {
  local source="$1" name="$2" target
  target="${HOST_OPT}/${PROJECT}/${name}:${TAG}"
  echo "  ${source} -> ${target}"
  docker tag "$source" "$target" || return 1
  if docker push "$target" >/dev/null 2>&1; then
    echo "    已推送"
    return 0
  fi
  echo "    !! 推送失败" >&2
  return 1
}

echo
echo "==> 租户运行时镜像"
push_one "$RUNTIME_IMAGE" dsh-web || exit 1

if [ "$RUNTIME_ONLY" = no ]; then
  echo
  echo "==> 控制面与节点侧镜像"
  for pair in "mt-gateway:local:mt-gateway" "mt-egress-proxy:local:mt-egress-proxy" "mt-model-gateway:local:mt-model-gateway" "mt-node-agent:local:mt-node-agent"; do
    image="${pair%%:*}"; rest="${pair#*:}"; name="${rest##*:}"
    if docker image inspect "${image}:local" >/dev/null 2>&1; then
      push_one "${image}:local" "$name" || exit 1
    else
      echo "  ${image}:local 不存在，跳过（先执行 bin/mt.sh up 构建它）"
    fi
  done
fi

echo
echo "==> 完成。在一台没有互联网的机器上："
echo "    docker login ${HOST_OPT}"
echo "    docker pull ${HOST_OPT}/${PROJECT}/dsh-web:${TAG}"
echo "    然后在 .env 里写 DSH_IMAGE=${HOST_OPT}/${PROJECT}/dsh-web:${TAG}"
