#!/usr/bin/env bash
# Isolation smoke test for the DSH multi-tenant deployment.
#
# Verifies, against the running stack:
#   1. the unified entry serves a login page to an unauthenticated browser
#   2. a valid login yields a gateway session cookie
#   3. the gateway activates DSH's own browser cookie transparently, so the
#      workspace loads without the user ever seeing a launch token
#   4. an authenticated API call succeeds through the gateway
#   5. a session for one tenant is refused when it addresses another tenant
#   6. a tenant's DSH cookie is rejected by another tenant's runtime
#   7. each tenant keeps its own DSH_HOME and its own browser-session secret
#
# Usage:
#   bin/smoke.sh --tenant alpha --user alice --password <pw> [--peer beta]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

IMAGE="${DSH_IMAGE:-dsh-web:0.2.0-rc.2}"
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
  echo "用法: bin/smoke.sh --tenant <id> --user <name> --password <pw> [--peer <id>]" >&2
  exit 2
fi

# Read the registry once, in the same image the deployment uses.
REG="$(docker run --rm -v "$ROOT:/w" -w /w "$IMAGE" node -e '
  const r = require("/w/tenants.json")
  const want = process.argv[1]
  const peer = process.argv[2] || (r.tenants.find((t) => t.id !== want) ?? {}).id || ""
  const find = (id) => r.tenants.find((t) => t.id === id) ?? {}
  const t = find(want), p = find(peer)
  console.log(`TENANT_PORT=${t.internalPort ?? ""}`)
  console.log(`TENANT_EDGE=${t.edgePort ?? ""}`)
  console.log(`PEER=${p.id ?? ""}`)
  console.log(`PEER_PORT=${p.internalPort ?? ""}`)
  console.log(`PEER_EDGE=${p.edgePort ?? ""}`)
' "$TENANT" "$PEER" 2>/dev/null)"
eval "$REG"
PORT="${MT_EDGE_PORT:-8090}"
# TLS 开着时公开端口是 HTTPS，本机脚本走 loopback 明文运维端口
if [ -f state/tls/server.crt ]; then PORT="${MT_HTTP_PORT:-8099}"; fi
BASE="http://127.0.0.1:${PORT}"

# 专属入口端口不经运维端口，它自己就是公开端口：TLS 开着时按 HTTPS 访问，
# 并用部署自己的证书校验（因此冒烟测试同时验证了证书链）。
EDGE_SCHEME="http"
TLS_CURL=()
if [ -f state/tls/server.crt ]; then
  EDGE_SCHEME="https"
  TLS_CURL=(--cacert state/tls/ca.crt)
fi
JAR="$(mktemp)"
PASS=0; FAIL=0

check() { # check <description> <actual> <expected>
  if [ "$2" = "$3" ]; then
    printf '  \033[32mPASS\033[0m %s (%s)\n' "$1" "$2"; PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m %s (期望 %s，实际 %s)\n' "$1" "$3" "$2"; FAIL=$((FAIL + 1))
  fi
}

echo "== 1. 未登录访问统一入口 =="
CODE="$(curl -sS -o /tmp/mt-login.html -w '%{http_code}' "$BASE/")"
check "统一入口返回登录页" "$CODE" "200"
check "登录页不包含 DSH cookie 名" "$(grep -c 'dsh-auth' /tmp/mt-login.html)" "0"

echo "== 2. 登录租户 ${TENANT}/${USER} =="
CODE="$(curl -sS -o /dev/null -w '%{http_code}' -c "$JAR" \
  -d "tenant=${TENANT}&user=${USER}&password=${PASSWORD}" "$BASE/__mt/login")"
check "登录返回 303" "$CODE" "303"
check "拿到网关会话 cookie" "$(grep -c 'mt_session' "$JAR")" "1"

echo "== 3. 网关内部完成 DSH 激活（浏览器不需要跳转）=="
CODE="$(curl -sS -o /tmp/mt-app.html -w '%{http_code}' -b "$JAR" -c "$JAR" "$BASE/")"
check "首次访问直接返回工作区" "$CODE" "200"
check "页面是 DSH 前端" "$(grep -c -i '<!doctype html>' /tmp/mt-app.html)" "1"
check "浏览器持有 DSH cookie" "$(grep -c 'dsh-auth' "$JAR")" "1"
check "整个过程零重定向" "$(curl -sS -o /dev/null -w '%{num_redirects}' -b "$JAR" -c "$JAR" "$BASE/")" "0"

echo "== 4. 通过网关调用 API =="
RPC="$(curl -sS -b "$JAR" -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"smoke-1","method":"account/getState","payload":{"args":{}}}' \
  "$BASE/api/account/getState")"
check "RPC 返回服务端响应" "$(printf '%s' "$RPC" | grep -c '"type":"server-response"')" "1"
check "RPC 调用成功" "$(printf '%s' "$RPC" | grep -c '"ok":true')" "1"

echo "== 5. 跨租户访问被拒 =="
if [ -n "$PEER" ] && [ -n "$PEER_EDGE" ]; then
  # 专属端口在启用 TLS 后是 HTTPS；顺带用部署自己的证书做一次校验。
  CODE="$(curl -sS -o /tmp/mt-403.html -w '%{http_code}' -b "$JAR" "${EDGE_SCHEME}://127.0.0.1:${PEER_EDGE}/" "${TLS_CURL[@]}")"
  check "以 ${TENANT} 身份访问 ${PEER} 的专属入口" "$CODE" "403"
elif [ -n "$PEER" ]; then
  echo "  (${PEER} 没有专属入口端口，跳过)"
else
  echo "  (只有一个租户，跳过)"
fi

echo "== 6. 租户 DSH cookie 不可跨运行时复用 =="
DSH_COOKIE="$(awk '/dsh-auth/ { print $6"="$7 }' "$JAR" | tail -1)"
if [ -n "$DSH_COOKIE" ] && [ -n "$PEER_PORT" ]; then
  # 探针要放进本租户自己的网络里：租户被单独隔离时（MT_TENANT_NETWORKS），
  # 从 mt-net 出发根本到不了它，测出来会是"探针自己不通"而不是隔离。
  PROBE_NET="mt-net-${TENANT}"
  docker network inspect "$PROBE_NET" >/dev/null 2>&1 || PROBE_NET="mt-net"
  OUT="$(docker run --rm --network "$PROBE_NET" \
    -e "COOKIE=$DSH_COOKIE" -e "OWN=dsh-${TENANT}:${TENANT_PORT}:dsh-${TENANT}.internal" \
    -e "OTHER=dsh-${PEER}:${PEER_PORT}:dsh-${PEER}.internal" \
    "$IMAGE" node -e '
      // node:http (not fetch) because fetch drops an explicit Host header.
      const http = require("node:http")
      // Each runtime is addressed with the authority the control plane uses;
      // DSH derives its cookie name from that string, so probing with any other
      // Host would just report a name mismatch instead of testing isolation.
      const ask = (target) => new Promise((resolve) => {
        const [host, port, authority] = target.split(":")
        const request = http.request(
          { host, port, path: "/", method: "GET", headers: { host: authority, cookie: process.env.COOKIE } },
          (response) => { response.resume(); resolve(response.statusCode) },
        )
        request.on("error", () => resolve("unreachable"))
        request.end()
      })
      Promise.all([ask(process.env.OWN), ask(process.env.OTHER)]).then(([a, b]) => console.log(`${a} ${b}`))
    ' 2>/dev/null)"
  OWN_RESULT="${OUT%% *}"
  OTHER_RESULT="${OUT##* }"
  check "同一 cookie：本租户返回 200" "$OWN_RESULT" "200"
  # 两种结果都算通过，且第二种更强：对端在别的网桥上时连不到（网络层隔离），
  # 在同一个网桥上时连得上但 cookie 一定被 401 拒。
  case "$OTHER_RESULT" in
    401) ok "  他租户拒绝该 cookie（401）" ;;
    unreachable) ok "  他租户在网络层就不可达（比 401 更强）" ;;
    *) bad "  他租户的响应既不是 401 也不是不可达：${OTHER_RESULT}" ;;
  esac
else
  echo "  (缺少 cookie 或对端租户，跳过)"
fi

echo "== 7. 每个租户独立 DSH_HOME 与独立会话密钥 =="
ALPHA_CRED="tenants/${TENANT}/home/.credentials.yaml"
check "${TENANT} 有独立凭据文件" "$([ -f "$ALPHA_CRED" ] && echo yes || echo no)" "yes"
if [ -n "$PEER" ]; then
  PEER_CRED="tenants/${PEER}/home/.credentials.yaml"
  check "${PEER} 有独立凭据文件" "$([ -f "$PEER_CRED" ] && echo yes || echo no)" "yes"
  check "两个租户的签名密钥不同" "$(cmp -s "$ALPHA_CRED" "$PEER_CRED" && echo same || echo differ)" "differ"
fi

rm -f "$JAR" /tmp/mt-login.html /tmp/mt-app.html
echo
echo "结果：${PASS} 通过，${FAIL} 失败"
[ "$FAIL" -eq 0 ]
