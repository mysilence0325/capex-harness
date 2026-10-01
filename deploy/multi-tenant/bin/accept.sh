#!/usr/bin/env bash
# End-to-end acceptance: admin-provided model catalog → tenant picks a model →
# a real turn runs → the reply lands in that tenant's own session log.
#
# A stand-in OpenAI-compatible model (mock-model) is started for the duration of
# the run, temporarily spliced into the tested tenant's profile patch, and then
# removed again — tenant settings outside the managed block are never touched.
#
# Usage: bin/accept.sh --tenant alpha --user alice --password <pw> [--peer beta]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

IMAGE="${DSH_IMAGE:-dsh-web:0.2.0-rc.2}"
NODE_IMAGE="${MT_NODE_IMAGE:-node:22-bookworm-slim}"
MARKER="MULTITENANT-OK"
MODEL_ID="mock-strong"
EDGE_PORT="${MT_EDGE_PORT:-8090}"
# TLS 开着时公开端口是 HTTPS，本机脚本走 loopback 明文运维端口
if [ -f state/tls/server.crt ]; then EDGE_PORT="${MT_HTTP_PORT:-8099}"; fi
BASE="http://127.0.0.1:${EDGE_PORT}"

if command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else COMPOSE=(docker compose); fi

TENANT=""; USER=""; PASSWORD=""; PEER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --user) USER="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --peer) PEER="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$TENANT" ] || [ -z "$USER" ] || [ -z "$PASSWORD" ]; then
  echo "用法: bin/accept.sh --tenant <id> --user <name> --password <pw> [--peer <id>]" >&2
  exit 2
fi

REG="$(docker run --rm -v "$ROOT:/w" -w /w "$IMAGE" node -e '
  const r = require("/w/tenants.json")
  const want = process.argv[1]
  const peer = process.argv[2] || (r.tenants.find((t) => t.id !== want) ?? {}).id || ""
  const find = (id) => r.tenants.find((t) => t.id === id) ?? {}
  console.log(`PEER=${find(peer).id ?? ""}`)
' "$TENANT" "$PEER" 2>/dev/null)"
eval "$REG"

JAR="$(mktemp)"
PASS=0; FAIL=0
check() {
  if [ "$2" = "$3" ]; then
    printf '  \033[32mPASS\033[0m %s (%s)\n' "$1" "$2"; PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m %s (期望 %s，实际 %s)\n' "$1" "$3" "$2"; FAIL=$((FAIL + 1))
  fi
}
# rpc.js runs inside a container on the host network. Remote methods with a
# single object parameter expect it nested as `request` in the wire args.
rpc() { docker run --rm --network host -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/rpc.js --base "http://127.0.0.1:${EDGE_PORT}" --jar /w/.accept-jar "$@"; }

restore() {
  echo "==> 恢复 ${TENANT} 的模型配置"
  docker run --rm -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/render.js --only "$TENANT" >/dev/null 2>&1
  docker restart "mt-dsh-${TENANT}" >/dev/null 2>&1
  # 验收用的假模型不留在生产栈里运行。
  docker rm -f mt-mock-model >/dev/null 2>&1 || true
}
trap restore EXIT

health() { curl -fsS "http://127.0.0.1:${EDGE_PORT}/__mt/health" 2>/dev/null; }

# 只认被测租户自己的就绪状态：别的租户先就绪不代表它已经起来了。
# 模式允许 id 与 ready 之间存在其它字段（例如 container）。
wait_tenant_ready() {
  local id="$1" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    if health | tr -d ' \n' | grep -qE "\"id\":\"${id}\"[^}]*\"ready\":true"; then return 0; fi
    sleep 2
  done
  return 1
}

echo "== 0. 准备：让 model.env 生效并启动验收用假模型 =="
# model.env 的内容参与 compose 的服务哈希，改了它必须让 compose 重建租户容器，
# 否则 MOCK_MODEL_KEY 不会出现在容器环境里，模型调用会以 MISSING_CREDENTIAL 失败。
"${COMPOSE[@]}" up -d >/dev/null 2>&1
DOCKER_BUILDKIT=0 "${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.mock.yml up -d --build mock-model >/dev/null 2>&1
for _ in $(seq 1 30); do
  if docker run --rm --network mt-net "$NODE_IMAGE" node -e '
      fetch("http://mock-model:8080/v1/models").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))
    ' >/dev/null 2>&1; then break; fi
  sleep 2
done
echo "  假模型就绪: $(docker run --rm --network mt-net "$NODE_IMAGE" node -e 'fetch("http://mock-model:8080/v1/models").then((r) => r.json()).then((j) => console.log(j.data.map((m) => m.id).join(", ")))' 2>/dev/null)"

echo "== 1. 把管理员模型目录装配给 ${TENANT} =="
docker run --rm -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/render.js --only "$TENANT" --model-block mock-model/model.patch.yml
docker restart "mt-dsh-${TENANT}" >/dev/null
# 控制面只认注册进来的地址，重启后必须重新注册，否则这里会测出假故障。
bash bin/mt.sh register "$TENANT" >/dev/null 2>&1 || true
if wait_tenant_ready "$TENANT" 60; then
  check "重启后 ${TENANT} 恢复就绪" "yes" "yes"
else
  check "重启后 ${TENANT} 恢复就绪" "no" "yes"
  docker logs --tail 20 "mt-dsh-${TENANT}" 2>&1
  exit 1
fi
# 让网关的启动 token 缓存（10 秒）过期，避免用到重启前的旧 token。
sleep 11

echo "== 2. 租户登录 =="
curl -sS -o /dev/null -c "$JAR" -d "tenant=${TENANT}&user=${USER}&password=${PASSWORD}" "$BASE/__mt/login"
curl -sSL -o /dev/null -b "$JAR" -c "$JAR" "$BASE/"
check "登录并激活成功" "$(grep -c 'dsh-auth' "$JAR")" "1"
# rpc.js runs inside a container on the host network; hand it the cookie jar.
cp "$JAR" "$ROOT/.accept-jar"

echo "== 3. 租户看到的模型目录（管理员提供，租户可选）=="
CATALOG="$(rpc --method session/modelCatalog)"
check "模型目录可读" "$(printf '%s' "$CATALOG" | grep -c 'accept-mock')" "1"
check "提供两个可选模型" "$(printf '%s' "$CATALOG" | grep -o 'mock-[a-z]*' | sort -u | wc -l | tr -d ' ')" "2"

echo "== 4. 创建会话并选择模型 =="
SESSION="$(rpc --method session/create --args '{"request":{}}' | sed 's/.*"sessionId":"//; s/".*//')"
check "创建会话" "$([ -n "$SESSION" ] && echo yes || echo no)" "yes"
SELECTED="$(rpc --method session/selectModel \
  --args "{\"request\":{\"sessionId\":\"${SESSION}\",\"provider\":\"accept-mock\",\"model\":\"${MODEL_ID}\"}}")"
check "选择模型 ${MODEL_ID}" "$(printf '%s' "$SELECTED" | grep -c "$MODEL_ID")" "1"

echo "== 5. 发一条消息并等待模型回复 =="
PROMPTED="$(rpc --method session/prompt \
  --args "{\"request\":{\"requestId\":\"accept-${SESSION}\",\"sessionId\":\"${SESSION}\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"验收：请回复标记\"}]}}")"
check "消息被接受" "$(printf '%s' "$PROMPTED" | grep -c '"accepted":true')" "1"

FOUND=""
for _ in $(seq 1 30); do
  LOG="$(find "tenants/${TENANT}/home/sessions" -type f -name 'session*.jsonl*' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)"
  if [ -n "$LOG" ]; then
    if docker run --rm -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/session-text.js "/w/${LOG}" 2>/dev/null | grep -q "$MARKER"; then
      FOUND="$LOG"; break
    fi
  fi
  sleep 2
done
check "模型回复进入该租户的会话日志" "$([ -n "$FOUND" ] && echo yes || echo no)" "yes"
if [ -n "$FOUND" ]; then
  check "回复文本带验收标记与所选模型" \
    "$(docker run --rm -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/session-text.js "/w/${FOUND}" 2>/dev/null \
      | grep -c "模型 ${MODEL_ID}" | awk '{ print ($1 > 0) ? "yes" : "no" }')" "yes"
  echo "      日志: ${FOUND}"
fi
check "假模型确实收到了所选模型的请求" \
  "$(docker logs mt-mock-model 2>&1 | grep -c "model=${MODEL_ID}" | awk '{ print ($1 > 0) ? "yes" : "no" }')" "yes"

echo "== 6. 另一个租户拿不到这次会话 =="
if [ -n "$PEER" ] && [ -n "$SESSION" ]; then
  check "${PEER} 的 home 里没有该会话" \
    "$(find "tenants/${PEER}/home" -name "*${SESSION}*" 2>/dev/null | wc -l | tr -d ' ')" "0"
fi

rm -f "$JAR" "$ROOT/.accept-jar"
echo
echo "结果：${PASS} 通过，${FAIL} 失败"
[ "$FAIL" -eq 0 ]
