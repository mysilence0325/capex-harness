#!/usr/bin/env bash
# 发布覆盖层 → 切换租户 → 验证"跑着的就是这份构建" → 冒烟。
#
# 把原来手工的七步收成一条命令：构建侧只管交出一个 tar.gz，这里负责后面全部。
#
# 用法：
#   bin/publish-and-verify.sh <覆盖层.tar.gz> [--switch] [--mock] [--keep-mock]
#   bin/publish-and-verify.sh <覆盖层.tar.gz> --smoke <端点> <key> <模型id> [--expect <文本>] [--network <模式>]
#
# 各步做什么：
#   publish-image   构建 dsh-web:local-<时间戳>（基础镜像取 .env 的 MT_BASE_IMAGE），
#                   并核对"镜像内 index.html 的 sha256 = 覆盖层清单里的 sha256"，不一致直接失败；
#                   成功后把 .env 的 DSH_IMAGE 指向新镜像。
#   --switch        bin/mt.sh up（重建租户到新镜像）→ doctor（要求 0 失败）→ 再核对一次
#                   **运行中租户容器里**的 index.html 哈希，证明切换真的生效。
#   --mock          起本地假模型（docker-compose.mock.yml，OpenAI 兼容、真流式），用
#                   --network mt-net 跑冒烟并以 MULTITENANT-OK 为断言，跑完删掉假模型。
#   --smoke ...     用给定端点跑冒烟（内网端点用默认的 --network host）。
#
# 任何一步失败就停在那里并打印证据位置；退出码即结论。
set -uo pipefail
cd "$(dirname "$0")/.."

TARBALL=""; SWITCH=no; MOCK=no; KEEP_MOCK=no
S_ENDPOINT=""; S_KEY=""; S_MODEL=""; S_EXPECT=""; S_NETWORK=""
usage() {
  echo "用法: bin/publish-and-verify.sh <覆盖层.tar.gz> [--switch] [--mock] [--keep-mock]" >&2
  echo "       bin/publish-and-verify.sh <覆盖层.tar.gz> --smoke <端点> <key> <模型id> [--expect <文本>] [--network <模式>]" >&2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --switch) SWITCH=yes; shift ;;
    --mock) MOCK=yes; shift ;;
    --keep-mock) MOCK=yes; KEEP_MOCK=yes; shift ;;
    --smoke) S_ENDPOINT="${2:-}"; S_KEY="${3:-}"; S_MODEL="${4:-}"; shift 4 ;;
    --expect) S_EXPECT="${2:-}"; shift 2 ;;
    --network) S_NETWORK="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "未知参数: $1" >&2; usage; exit 2 ;;
    *) [ -z "$TARBALL" ] && TARBALL="$1" || { echo "多余参数: $1" >&2; usage; exit 2; }; shift ;;
  esac
done
[ -n "$TARBALL" ] || { usage; exit 2; }
[ -f "$TARBALL" ] || { echo "找不到覆盖层: $TARBALL" >&2; exit 1; }

FRONTEND_PATH="/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html"

echo "== 1) 发布镜像"
if ! bin/mt.sh publish-image "" "$TARBALL"; then
  echo "!! publish-image 失败（覆盖层或哈希核对没过）；证据：$TARBALL 与上面的输出" >&2
  exit 1
fi
NEW_IMAGE="$(grep -E '^DSH_IMAGE=' .env | tail -1 | cut -d= -f2-)"
HASH_EXPECTED="$(docker run --rm -v "$PWD/image/image-overlay:/o:ro" node:22-bookworm-slim \
  node -e 'console.log(require("/o/manifest.json").frontendIndexSha256)' | tr -d '\r')"
echo "  新镜像: $NEW_IMAGE"
echo "  覆盖层前端 index.html sha256: $HASH_EXPECTED"

if [ "$SWITCH" = yes ]; then
  echo
  echo "== 2) 切换租户到新镜像"
  # 先取输出再看退出码：`cmd | tail` 的退出码是 tail 的，失败会被吞掉。
  UP_OUT="$(bin/mt.sh up 2>&1)"; UP_CODE=$?
  printf '%s\n' "$UP_OUT" | tail -5
  if [ "$UP_CODE" != 0 ]; then
    echo "!! mt.sh up 失败（退出码 $UP_CODE）" >&2
    exit 1
  fi
  echo
  echo "== 3) doctor（要求 0 项失败）"
  DOC_OUT="$(bash bin/doctor.sh 2>&1)"; DOC_CODE=$?
  printf '%s\n' "$DOC_OUT" | sed 's/\x1b\[[0-9;]*m//g' | tail -3
  if [ "$DOC_CODE" != 0 ]; then
    echo "!! doctor 报了失败项（退出码 $DOC_CODE）" >&2
    exit 1
  fi
  echo
  echo "== 4) 核对运行中的租户容器里就是这份前端"
  FIRST="$(docker ps --format '{{.Names}}' | grep -E "^${MT_CONTAINER_NAME_PREFIX:-mt-}dsh-" | head -1)"
  if [ -z "$FIRST" ]; then
    echo "!! 没有找到运行中的租户容器" >&2
    exit 1
  fi
  HASH_RUNNING="$(docker exec "$FIRST" sha256sum "$FRONTEND_PATH" 2>/dev/null | cut -d' ' -f1 | tr -d '\r')"
  echo "  $FIRST 内: ${HASH_RUNNING:-（读不到）}"
  if [ "$HASH_RUNNING" = "$HASH_EXPECTED" ]; then
    echo "  一致 ✓（切换确实生效）"
  else
    echo "!! 不一致：切换没有生效，或镜像里的前端不是这份覆盖层" >&2
    exit 1
  fi
fi

smoke() {  # smoke <端点> <key> <模型> <网络>
  local args=("$NEW_IMAGE" "$1" "$2" "$3" --network "$4")
  [ -n "$S_EXPECT" ] && args+=(--expect "$S_EXPECT")
  bash bin/dsh-smoke.sh "${args[@]}"
}

if [ "$MOCK" = yes ]; then
  echo
  echo "== 5) 假模型冒烟（本地 OpenAI 兼容 + 真流式）"
  # 直接 docker run 起，不走 compose build：BuildKit 会去 Docker Hub 解析基础镜像元数据，
  # 而这台机器拉不到公网（实测 `docker-compose up --build` 就死在这一步）。假模型是单文件、
  # 只用 node 标准库，本地 node 镜像 + 挂载脚本就够了 —— 与告警接收器同一手法。
  docker rm -f mt-mock-model >/dev/null 2>&1 || true
  docker run -d --name mt-mock-model --network mt-net --restart "no" \
    -v "$PWD/mock-model/server.js:/server.js:ro" -e MOCK_MODEL_PORT=8080 \
    --entrypoint node node:22-bookworm-slim /server.js >/dev/null
  READY=no
  for _ in $(seq 1 20); do
    sleep 2
    if docker run --rm --network mt-net node:22-bookworm-slim node -e \
      'fetch("http://mt-mock-model:8080/v1/models").then((r)=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))' >/dev/null 2>&1; then
      READY=yes; break
    fi
  done
  if [ "$READY" != yes ]; then
    echo "!! 假模型没起来（50 秒内 /v1/models 不响应）" >&2
    docker logs mt-mock-model 2>&1 | tail -5 | sed 's/^/    /' >&2
    exit 1
  fi
  S_EXPECT_SAVED="$S_EXPECT"; S_EXPECT="MULTITENANT-OK"
  if ! smoke http://mt-mock-model:8080 placeholder mock-cheap mt-net; then
    echo "!! 假模型冒烟失败" >&2
    exit 1
  fi
  S_EXPECT="$S_EXPECT_SAVED"
  if [ "$KEEP_MOCK" = yes ]; then
    echo "  --keep-mock：保留 mt-mock-model 供排查"
  else
    docker rm -f mt-mock-model >/dev/null 2>&1 || true
    echo "  已删除假模型容器"
  fi
fi

if [ -n "$S_ENDPOINT" ]; then
  echo
  echo "== 6) 真实端点冒烟：$S_ENDPOINT"
  if ! smoke "$S_ENDPOINT" "$S_KEY" "$S_MODEL" "${S_NETWORK:-host}"; then
    echo "!! 端点冒烟失败（端点不可达、协议不符、或模型/密钥不对）" >&2
    exit 1
  fi
fi

echo
echo "== 结论"
echo "  镜像: $NEW_IMAGE"
echo "  覆盖层前端哈希: $HASH_EXPECTED"
[ "$SWITCH" = yes ] && echo "  租户已切到新镜像，doctor 0 失败，运行中的前端与覆盖层一致"
[ "$MOCK" = yes ] && echo "  假模型冒烟通过（断言 MULTITENANT-OK）"
[ -n "$S_ENDPOINT" ] && echo "  端点冒烟通过：$S_ENDPOINT"
exit 0
