#!/usr/bin/env bash
# 用真实模型跑一次对话，确认某个租户的模型接入确实可用。
#
# 与 bin/accept.sh 的区别：那个用假模型验证多租户链路，这个走真实 provider，
# 用来回答"这个租户现在能不能真的对话"。
#
# 用法：bin/model-check.sh --tenant alpha --user alice --password <pw> [--prompt "..." ]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a
# 宿主机没有 curl 时用容器里的顶（局域网装不了包的情况）。
# shellcheck disable=SC1091
. bin/lib-http.sh

IMAGE="${DSH_IMAGE:-dsh-web:0.2.0-rc.2}"
NODE_IMAGE="${MT_NODE_IMAGE:-node:22-bookworm-slim}"
PORT="${MT_EDGE_PORT:-8090}"
# TLS 开着时公开端口是 HTTPS，本机脚本走 loopback 明文运维端口
if [ -f state/tls/server.crt ]; then PORT="${MT_HTTP_PORT:-8099}"; fi
BASE="http://127.0.0.1:${PORT}"

TENANT=""; USER=""; PASSWORD=""; PROMPT="回答两个字：可用"
PROVIDER="deepseek-official"
# 测试固定用 DeepSeek-V41-Flash：显式选择而不是依赖会话默认值，
# 既不会把测试打到更贵的 v4-pro 上，也让每次验证的成本可预期。
MODEL="deepseek-flash"
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --user) USER="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TENANT" ] && [ -n "$USER" ] && [ -n "$PASSWORD" ] || {
  echo "用法: bin/model-check.sh --tenant <id> --user <name> --password <pw> [--prompt '...']" >&2; exit 2
}

JAR="$ROOT/.model-check-jar"
rm -f "$JAR"
rpc() { docker run --rm --network host -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/rpc.js \
  --base "http://127.0.0.1:${PORT}" --jar /w/.model-check-jar "$@"; }

echo "== 1. 登录 $TENANT/$USER =="
curl -sS -o /dev/null -c "$JAR" --data-urlencode "user=$USER" --data-urlencode "password=$PASSWORD" "$BASE/__mt/login"
curl -sS -o /dev/null -b "$JAR" -c "$JAR" "$BASE/"
[ -s "$JAR" ] || { echo "  登录失败" >&2; exit 1; }
echo "  ok"

echo
echo "== 2. 该租户可用的模型 =="
CATALOG="$(rpc --method session/modelCatalog 2>/dev/null)"
printf '%s\n' "$CATALOG" | tr ',' '\n' | grep -oE '"(provider|model)":"[^"]*"' | sed 's/"//g; s/^/  /' | head -12
echo "$CATALOG" | grep -q '"failures":\[\]' && echo "  （无 provider 失败）" || echo "  !! 有 provider 加载失败：$(printf '%s' "$CATALOG" | grep -o '"failures":\[[^]]*\]' | head -c 200)"

echo
echo "== 3. 建会话并显式选定模型 =="
SESSION="$(rpc --method session/create --args '{"request":{}}' 2>/dev/null | sed 's/.*"sessionId":"//; s/".*//')"
[ -n "$SESSION" ] || { echo "  建会话失败" >&2; rm -f "$JAR"; exit 1; }
echo "  session: $SESSION"
SELECTED="$(rpc --method session/selectModel \
  --args "{\"request\":{\"sessionId\":\"${SESSION}\",\"provider\":\"${PROVIDER}\",\"model\":\"${MODEL}\"}}" 2>/dev/null)"
if printf '%s' "$SELECTED" | grep -q "\"model\":\"${MODEL}\""; then
  echo "  已选定: ${PROVIDER} / ${MODEL}"
else
  echo "  !! 选定模型失败（provider=${PROVIDER} model=${MODEL}）" >&2
  printf '%s\n' "$SELECTED" | head -c 300 | sed 's/^/     /'
  echo
  rm -f "$JAR"
  exit 1
fi
echo "  提示词: $PROMPT"
rpc --method session/prompt \
  --args "{\"request\":{\"requestId\":\"mc-${SESSION}\",\"sessionId\":\"${SESSION}\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"${PROMPT}\"}]}}" \
  >/dev/null 2>&1

echo
echo "== 4. 等模型回复（最多 90 秒）=="
FOUND=""; ERROR=""
for _ in $(seq 1 45); do
  LOG="$(find "tenants/${TENANT}/home/sessions" -type f -name 'session*.jsonl*' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)"
  if [ -n "$LOG" ]; then
    TEXT="$(docker run --rm -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/session-text.js "/w/${LOG}" 2>/dev/null)"
    if printf '%s' "$TEXT" | grep -q '"type":"assistant/message"'; then FOUND="$LOG"; break; fi
    ERR="$(printf '%s' "$TEXT" | grep -o '"code":"[A-Z_]*"' | tail -1)"
    [ -n "$ERR" ] && ERROR="$ERR"
  fi
  sleep 2
done

if [ -n "$FOUND" ]; then
  echo "  ✓ 收到模型回复"
  echo "  日志: $FOUND"
  REPLY="$(docker run --rm -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/session-text.js "/w/${FOUND}" 2>/dev/null)"
  if printf '%s' "$REPLY" | grep '"type":"assistant/message"' | grep -q "\"model\":\"${MODEL}\""; then
    echo "  实际使用的模型: ${MODEL} ✓（与测试选定的一致）"
  else
    echo "  !! 回复不是来自选定的模型 ${MODEL}："
    printf '%s' "$REPLY" | grep -o '"provider":"[^"]*","model":"[^"]*"' | tail -2 | sed 's/^/     /'
  fi
  echo "  回复节选:"
  printf '%s' "$REPLY" | grep '"type":"assistant/message"' | head -c 600 | sed 's/^/    /'
  echo
  rm -f "$JAR"
  exit 0
fi

echo "  ✗ 90 秒内没有 assistant/message"
[ -n "$ERROR" ] && echo "  会话日志里的错误码: $ERROR"
echo "  排查顺序："
echo "    1) .env 里 DSH_IMAGE 指向的镜像是否含可用 provider"
echo "    2) model.env 里是否有 DEEPSEEK_API_KEY / GATEWAY_API_KEY（env_file 注入）"
echo "    3) 租户能否出网：bin/mt.sh doctor 会检查出口代理"
echo "    4) 容器内环境: docker exec mt-dsh-${TENANT} env | grep -iE 'key|proxy'"
rm -f "$JAR"
exit 1
