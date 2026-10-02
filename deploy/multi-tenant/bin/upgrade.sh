#!/usr/bin/env bash
# 滚动升级：一次换一个租户的运行时镜像，每个验证通过再换下一个。
#
# 为什么不是一次全换：镜像有问题时要能立刻停住，而且只影响已经换过的那几个租户。
# 任何一个租户升级后起不来，脚本把它换回旧镜像并停止，剩下的租户仍在旧镜像上正常服务。
#
# 用法：
#   bin/upgrade.sh --image <镜像引用>                 # 逐个租户升级（默认全部）
#   bin/upgrade.sh --image <ref> --tenants alpha,beta # 只升指定的
#   bin/upgrade.sh --image <ref> --dry-run            # 只显示会做什么
#   bin/upgrade.sh --image <ref> --verify-model <租户>:<用户>:<密码>
#                                                     # 额外做一次真实模型调用验证
#   bin/upgrade.sh --status                           # 看各租户当前用的是哪个镜像
set -uo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
IMAGE=""
TENANTS="all"
DRY_RUN=no
VERIFY=""
STATUS=no

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a
CURRENT_IMAGE="${DSH_IMAGE:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2 ;;
    --tenants) TENANTS="${2:-}"; shift 2 ;;
    --verify-model) VERIFY="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=yes; shift ;;
    --status) STATUS=yes; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else COMPOSE=(docker compose); fi
COMPOSE+=(-f docker-compose.yml)

all_tenants() {
  grep -o '"id": *"[^"]*"' tenants.json 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/'
}

tenant_image() {
  docker inspect "mt-dsh-$1" --format '{{.Config.Image}}' 2>/dev/null || echo "（没有容器）"
}

if [ "$STATUS" = yes ]; then
  echo "==> 各租户当前镜像（.env 里的 DSH_IMAGE: ${CURRENT_IMAGE:-未设置}）"
  for t in $(all_tenants); do
    printf "  %-8s %s\n" "$t" "$(tenant_image "$t")"
  done
  exit 0
fi

[ -n "$IMAGE" ] || { echo "用法: bin/upgrade.sh --image <镜像引用>" >&2; exit 2; }
[ -n "$CURRENT_IMAGE" ] || { echo "读不到当前 DSH_IMAGE，先执行 bin/mt.sh up" >&2; exit 1; }

# 镜像必须先在本机：离线环境里 docker pull 到不了外网，早报错比中途失败好。
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "本机没有镜像 ${IMAGE}，尝试拉取…"
  if ! docker pull "$IMAGE" >/dev/null 2>&1; then
    echo "拉取失败。离线环境下请先在本机导入：docker load -i <归档> 或用 registry-push.sh 推到内网仓库" >&2
    exit 1
  fi
fi

if [ "$TENANTS" = all ]; then
  TARGETS="$(all_tenants)"
else
  TARGETS="$(printf '%s' "$TENANTS" | tr ',' ' ')"
fi
[ -n "$TARGETS" ] || { echo "没有要升级的租户" >&2; exit 1; }

echo "==> 滚动升级"
echo "    从: ${CURRENT_IMAGE}"
echo "    到: ${IMAGE}"
echo "    租户: $(printf '%s' "$TARGETS" | tr '\n' ' ')"
if [ "$DRY_RUN" = yes ]; then
  echo
  echo "    （--dry-run，不做改动）"
  exit 0
fi
echo

health() { curl -sS --max-time 10 "http://127.0.0.1:${MT_HTTP_PORT:-8099}/__mt/health" 2>/dev/null; }

# 等某个租户被控制面判定为 ready（ready = 网关实测连得上且持有启动 token）。
wait_ready() {
  local id="$1" limit="${2:-90}" waited=0 body
  while [ "$waited" -lt "$limit" ]; do
    body="$(health)"
    if printf '%s' "$body" | tr -d ' \n' | grep -q "\"id\":\"${id}\",\"node\":[^}]*\"ready\":true"; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

upgraded=""
rollback_one() {
  local id="$1" image="$2"
  echo "      回滚 ${id} 到 ${image}"
  DSH_IMAGE="$image" "${COMPOSE[@]}" up -d "dsh-${id}" >/dev/null 2>&1 || true
  # 容器重建会换地址与启动 token，必须重新注册，否则控制面拿着旧地址。
  bash bin/mt.sh register "$id" >/dev/null 2>&1 || true
  wait_ready "$id" 60 || echo "      回滚后仍不 ready，请手工检查 docker logs mt-dsh-${id}" >&2
}

for t in $TARGETS; do
  echo "  --- ${t} ---"
  if ! docker inspect "mt-dsh-${t}" >/dev/null 2>&1; then
    echo "      没有这个租户的容器，跳过"
    continue
  fi
  before="$(tenant_image "$t")"
  echo "      当前: ${before}"
  # Output kept and shown on failure: "启动失败" with no reason costs a debugging
  # round every time, and the reason is usually one line of compose's.
  if ! DSH_IMAGE="$IMAGE" "${COMPOSE[@]}" up -d "dsh-${t}" >/tmp/upgrade-up.log 2>&1; then
    echo "      启动失败，回滚" >&2
    tail -6 /tmp/upgrade-up.log | sed 's/^/        /' >&2
    rollback_one "$t" "$CURRENT_IMAGE"
    exit 1
  fi
  bash bin/mt.sh register "$t" >/dev/null 2>&1 || true
  if wait_ready "$t" 120; then
    echo "      升级后 ready ✓"
    upgraded="${upgraded} ${t}"
  else
    echo "      升级后未就绪，回滚该租户并停止" >&2
    docker logs --tail 15 "mt-dsh-${t}" 2>&1 | sed 's/^/        /'
    rollback_one "$t" "$CURRENT_IMAGE"
    echo
    echo "==> 已停止：${t} 回滚完成，其余租户仍是 ${CURRENT_IMAGE}" >&2
    echo "    已升级并通过的租户：${upgraded:-（无）}" >&2
    exit 1
  fi
  if [ -n "$VERIFY" ]; then
    vtenant="${VERIFY%%:*}"; rest="${VERIFY#*:}"; vuser="${rest%%:*}"; vpass="${rest##*:}"
    if [ "$vtenant" = "$t" ]; then
      echo "      真实模型调用验证…"
      if bin/model-check.sh --tenant "$t" --user "$vuser" --password "$vpass" --prompt "reply with one word: ok" >/tmp/upgrade-verify.log 2>&1; then
        echo "      $(grep -o '实际使用的模型: [a-z0-9.-]*' /tmp/upgrade-verify.log | head -1) ✓"
      else
        echo "      模型验证失败，回滚该租户并停止" >&2
        tail -5 /tmp/upgrade-verify.log | sed 's/^/        /'
        rollback_one "$t" "$CURRENT_IMAGE"
        exit 1
      fi
      rm -f /tmp/upgrade-verify.log
    fi
  fi
done

echo
echo "==> 全部升级完成，把新镜像写进 .env（下次 up/重建也用它）"
if grep -q '^DSH_IMAGE=' .env; then
  sed -i "s|^DSH_IMAGE=.*|DSH_IMAGE=${IMAGE}|" .env
else
  printf '\nDSH_IMAGE=%s\n' "$IMAGE" >> .env
fi
grep '^DSH_IMAGE=' .env | sed 's/^/    /'
echo "    已升级：${upgraded:-（无）}"
