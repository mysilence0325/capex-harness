#!/usr/bin/env bash
# 部署自检：把"能不能用、哪里不对"一次性列清楚。
#
#   bin/doctor.sh
#
# 只读，不改任何状态；退出码 0 表示没有致命问题（警告不算）。
set -uo pipefail
cd "$(dirname "$0")/.."

OK=0; WARN=0; BAD=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; OK=$((OK + 1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARN=$((WARN + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; BAD=$((BAD + 1)); }
head_() { printf '\n\033[36m== %s ==\033[0m\n' "$1"; }

head_ "前置条件"
command -v docker >/dev/null 2>&1 && ok "docker 可用 ($(docker --version | cut -d, -f1))" || bad "找不到 docker"
docker info >/dev/null 2>&1 && ok "docker 守护进程在运行" || bad "docker 守护进程不可用"
if command -v docker-compose >/dev/null 2>&1; then ok "docker-compose $(docker-compose version --short 2>/dev/null)"
elif docker compose version >/dev/null 2>&1; then ok "docker compose 插件"
else bad "既没有 docker-compose 也没有 compose 插件"; fi

head_ "配置"
[ -f .env ] && ok ".env 存在" || bad "缺 .env（cp .env.example .env）"
IMAGE="$(grep -E '^DSH_IMAGE=' .env 2>/dev/null | tail -1 | cut -d= -f2)"
if [ -n "$IMAGE" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
  ok "运行时镜像存在: $IMAGE"
  if docker run --rm --entrypoint sh "$IMAGE" -c 'test -f /opt/dsh-local-build/SOURCE' >/dev/null 2>&1; then
    ok "  该镜像是本地源码构建的"
    docker run --rm --entrypoint cat "$IMAGE" /opt/dsh-local-build/manifest.json 2>/dev/null \
      | grep -E '"(builtAt|packages|frontendIndexSha256)"' | sed 's/^/      /' || true
  else
    warn "  该镜像是 npm 发行版，不是本地源码构建（bin/publish-image.sh 可换成本地构建）"
  fi
elif [ -n "$IMAGE" ]; then
  bad "镜像不存在: $IMAGE"
else
  bad ".env 里没有 DSH_IMAGE"
fi

[ -f tenants.json ] && ok "tenants.json 存在" || bad "缺 tenants.json（bin/mt.sh add <租户> 创建）"
TENANTS="$(grep -o '"id": *"[^"]*"' tenants.json 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$TENANTS" ] && ok "注册了 $(echo "$TENANTS" | wc -l) 个租户: $(echo $TENANTS | tr '\n' ' ')" || bad "tenants.json 里没有租户"
[ -f docker-compose.yml ] && ok "docker-compose.yml 已生成" || warn "docker-compose.yml 未生成（bin/mt.sh render）"

head_ "租户运行时"
for t in $TENANTS; do
  state="$(docker inspect "mt-dsh-$t" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  case "$state" in
    running) ok "$t 容器运行中（镜像 $(docker inspect "mt-dsh-$t" --format '{{.Config.Image}}')）" ;;
    missing) bad "$t 容器不存在" ;;
    *)       bad "$t 容器状态: $state" ;;
  esac
  [ -d "tenants/$t/home" ] && ok "  $t home 存在（$(du -sh "tenants/$t/home" 2>/dev/null | cut -f1)，会话 $(find "tenants/$t/home/sessions" -name 'session*.jsonl*' 2>/dev/null | wc -l) 个）" \
    || bad "  $t home 缺失"
  patch="tenants/$t/home/profiles/web/cordis.patch.yml"
  want_port="$(grep -A4 "\"id\": \"$t\"" tenants.json | grep -o '"internalPort": *[0-9]*' | grep -o '[0-9]*' | head -1)"
  if [ -f "$patch" ]; then
    have_port="$(grep -A3 'id: webserver' "$patch" | grep -o 'port: *[0-9]*' | grep -o '[0-9]*' | head -1)"
    if [ -z "$have_port" ]; then
      bad "  $t 的 patch 缺少 webserver.port（会退到默认 3080，网关将无法代理）"
    elif [ "$have_port" != "$want_port" ]; then
      bad "  $t 的 patch 端口 $have_port 与注册表 $want_port 不一致"
    else
      ok "  $t patch 端口 $have_port 与注册表一致"
    fi
  else
    warn "  $t 没有 profile patch（bin/mt.sh render 会补）"
  fi
done

head_ "控制面"
gstate="$(docker inspect mt-gateway --format '{{.State.Status}}' 2>/dev/null || echo missing)"
[ "$gstate" = running ] && ok "网关容器运行中" || bad "网关容器状态: $gstate"
# 监听表只取一次：`ss | grep -q` 在 pipefail 下会因 SIGPIPE 被误判为没有监听。
LISTEN="$(ss -ltn 2>/dev/null)"
GW_BASE="http://127.0.0.1:${MT_EDGE_PORT:-8090}"
if [ -f state/tls/server.crt ]; then GW_BASE="http://127.0.0.1:${MT_HTTP_PORT:-8099}"; fi
HEALTH="$(curl -fsS "$GW_BASE/__mt/health" 2>/dev/null || true)"
if [ -n "$HEALTH" ]; then
  READY="$(printf '%s' "$HEALTH" | tr -d ' \n' | grep -o '"ready":true' | wc -l)"
  TOTAL="$(printf '%s' "$HEALTH" | tr -d ' \n' | grep -o '"id":"' | wc -l)"
  [ "$READY" = "$TOTAL" ] && ok "全部租户就绪 ($READY/$TOTAL)" || bad "仅 $READY/$TOTAL 个租户就绪"
else
  bad "健康接口无响应（本机 curl $GW_BASE/__mt/health）"
fi
for p in 8090 8091 8092 8093; do
  if printf '%s\n' "$LISTEN" | grep -q ":$p "; then ok "端口 $p 在监听"; else warn "端口 $p 未监听"; fi
done

head_ "防火墙与网络"
PORTS="$(firewall-cmd --list-ports 2>/dev/null || true)"
if [ -n "$PORTS" ]; then
  for p in 8090 8091 8092 8093; do
    echo "$PORTS" | grep -q "$p/tcp" && ok "防火墙放行 $p/tcp" || warn "防火墙未放行 $p/tcp"
  done
else
  warn "没有 firewalld（或未运行），跳过端口检查"
fi
if [ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = "0" ]; then
  warn "宿主 ip_forward=0：bridge 网络的端口映射对外不通，控制面因此用 host 网络（这是本部署的既定做法）"
else
  ok "宿主 ip_forward 已开启"
fi

head_ "租户出网"
EGRESS_STATE="$(docker inspect mt-egress-proxy --format '{{.State.Status}}' 2>/dev/null || echo missing)"
if [ "$EGRESS_STATE" = running ]; then
  ok "出口代理容器运行中（端口 ${MT_EGRESS_PORT:-3128}，宿主的公网出口）"
else
  bad "出口代理容器状态: $EGRESS_STATE"
fi
if [ -n "${MT_EGRESS_PROXY:-}" ]; then
  ok "MT_EGRESS_PROXY=${MT_EGRESS_PROXY}"
else
  warn "MT_EGRESS_PROXY 未设置：bridge 容器没有外网路由，租户将无法调用模型（bin/mt.sh up 会自动补）"
fi
FIRST_TENANT="$(printf '%s\n' "$TENANTS" | head -1)"
# 用出口代理自己的宿主地址当"内网目标"：它必然是私网地址，且不必写死任何 IP。
PROBE_INTERNAL="$(printf '%s' "${MT_EGRESS_PROXY:-}" | sed 's|^http[s]*://||; s|:.*$||')"
if [ -n "$FIRST_TENANT" ] && [ "$EGRESS_STATE" = running ] && [ -n "$PROBE_INTERNAL" ]; then
  PROBE="$(docker exec -e PROBE_INTERNAL="$PROBE_INTERNAL" "mt-dsh-${FIRST_TENANT}" node -e '
    const proxy = process.env.HTTPS_PROXY
    const internal = process.env.PROBE_INTERNAL
    if (!proxy) { console.log("no-proxy-in-container"); process.exit(0) }
    const net = require("node:net")
    const [phost, pport] = proxy.replace("http://", "").split(":")
    const ask = (host, port) => new Promise((resolve) => {
      const socket = net.connect(Number(pport), phost, () => {
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
      })
      socket.once("data", (chunk) => { socket.destroy(); resolve(String(chunk).split("\r\n")[0]) })
      socket.on("error", () => resolve("error"))
      setTimeout(() => { socket.destroy(); resolve("timeout") }, 10000)
    })
    ;(async () => {
      const publicResult = await ask("api.deepseek.com", 443)
      const internalResult = await ask(internal, 8090)
      console.log(`${publicResult.includes("200") ? "public-ok" : "public-fail"} ${internalResult.includes("403") ? "internal-blocked" : "internal-ALLOWED"}`)
    })()
  ' 2>/dev/null | tr -d '\r')"
  case "$PROBE" in
    "public-ok internal-blocked") ok "  实测 ${FIRST_TENANT}: 可经代理访问公网，且内网地址被拒" ;;
    "no-proxy-in-container") warn "  ${FIRST_TENANT} 容器里没有 HTTPS_PROXY（执行 bin/mt.sh up）" ;;
    *) bad "  ${FIRST_TENANT} 出口实测异常: ${PROBE:-无响应}" ;;
  esac
fi

head_ "租户对宿主的访问"
BRIDGE="br-$(docker network inspect mt-net --format '{{.Id}}' 2>/dev/null | cut -c1-12)"
DIRECT_RULES="$(firewall-cmd --permanent --direct --get-all-rules 2>/dev/null | grep -c 'mt-tenant-isolation' || true)"
if [ "${DIRECT_RULES:-0}" -ge 2 ]; then
  if firewall-cmd --permanent --direct --get-all-rules 2>/dev/null | grep 'mt-tenant-isolation' | grep -q -- "-i ${BRIDGE} "; then
    ok "隔离规则已生效，作用于当前网桥 ${BRIDGE}"
    # `iptables -L -n` 不显示 in 接口列，要用 -S 才能看到 -i 参数。
    if iptables -S INPUT_direct 2>/dev/null | grep -q -- "-i ${BRIDGE}"; then
      ok "  规则已在运行时加载"
    else
      bad "  规则未加载到运行时：firewall-cmd --reload"
    fi
  else
    bad "隔离规则指向的网桥不是当前的 ${BRIDGE}：bin/mt.sh isolate apply"
  fi
else
  bad "未限制租户对宿主端口的访问：容器可直达 Harbor/Nacos/Prometheus 等（bin/mt.sh isolate apply）"
fi
# 实测一次：从第一个租户容器访问宿主的一个端口，应当连不上。
# 目标地址运行时推导（宿主自己的局域网 IP），不写死任何 IP。
LAN_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1)"
if [ -n "${FIRST_TENANT:-}" ] && [ -n "$LAN_IP" ]; then
  REACHED="$(docker exec -e PROBE_HOST="$LAN_IP" -e PROBE_PORT="${MT_EGRESS_PORT:-3128}" "mt-dsh-${FIRST_TENANT}" node -e '
    const net = require("node:net")
    // 探一个宿主上公开但不属于本部署的端口：既有单租户部署的 3080。
    const s = net.connect(3080, process.env.PROBE_HOST, () => { console.log("reached"); s.destroy() })
    s.on("error", () => console.log("blocked"))
    setTimeout(() => { s.destroy(); console.log("blocked") }, 3000)
  ' 2>/dev/null | tr -d '\r')"
  if [ "$REACHED" = blocked ]; then
    ok "  实测 ${FIRST_TENANT}: 访问宿主其它端口被拒"
  else
    bad "  实测 ${FIRST_TENANT}: 仍能访问宿主端口（结果 ${REACHED:-无响应}）"
  fi
fi

head_ "传输加密"
CERT="state/tls/server.crt"
if [ -f "$CERT" ] && [ -f state/tls/server.key ]; then
  if openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null 2>&1; then
    ok "证书有效，到期 $(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2)"
  else
    bad "证书已过期：$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2)"
  fi
  if docker inspect mt-gateway --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^MT_TLS_CERT='; then
    ok "  网关以 HTTPS 提供公开端口"
    if printf '%s\n' "$LISTEN" | grep -q ":${MT_HTTP_PORT:-8099} "; then
      ok "  运维明文端口 ${MT_HTTP_PORT:-8099} 在监听（仅 loopback，供本机脚本用）"
    else
      warn "  运维端口 ${MT_HTTP_PORT:-8099} 未监听（本机脚本会连不上）"
    fi
  else
    warn "  证书已存在但网关仍走明文：执行 bin/mt.sh up 让它生效"
  fi
else
  warn "未配置 TLS，公开端口为明文 HTTP；bin/mt.sh cert 可生成自签证书"
fi

head_ "模型接入"
MG_STATE="$(docker inspect mt-model-gateway --format '{{.State.Status}}' 2>/dev/null || echo missing)"
if [ "$MG_STATE" = running ]; then
  ok "模型网关容器运行中"
  UP_LEN="$(docker exec mt-model-gateway sh -c 'printf %s "${#MT_UPSTREAM_KEY}"' 2>/dev/null || echo 0)"
  if [ "${UP_LEN:-0}" -gt 0 ]; then
    ok "  网关持有真凭据（长度 ${UP_LEN}）"
  else
    bad "  网关没有上游凭据：在 .env 设置 MT_UPSTREAM_API_KEY 后 bin/mt.sh up"
  fi
  # 伪造 key 必须被拒——否则网关成了任何人可用的中转。
  FORGED="$(docker exec "$(docker ps --filter name=mt-dsh- --format '{{.Names}}' | head -1)" node -e '
    fetch("http://mt-model-gateway:8080/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-mt-forged" },
      body: "{}",
    }).then((r) => console.log(String(r.status))).catch(() => console.log("unreachable"))
  ' 2>/dev/null | tr -d '\r')"
  if [ "$FORGED" = "401" ]; then
    ok "  未知 key 被拒（401）"
  else
    bad "  未知 key 未被拒绝：${FORGED:-无响应}"
  fi
else
  bad "模型网关容器状态: $MG_STATE（bin/mt.sh up）"
fi

# 真凭据绝不能出现在租户容器里：环境变量、容器配置、容器文件三者都查。
REAL_KEY="$(grep -E '^MT_UPSTREAM_API_KEY=.+' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
if [ -n "$REAL_KEY" ]; then
  REAL_TAIL="${REAL_KEY: -8}"
  LEAKED=""
  for t in $TENANTS; do
    if docker exec "mt-dsh-$t" sh -c 'env' 2>/dev/null | grep -q "$REAL_TAIL" \
      || docker inspect "mt-dsh-$t" 2>/dev/null | grep -q "$REAL_TAIL"; then
      LEAKED="$LEAKED $t"
    fi
  done
  if [ -z "$LEAKED" ]; then
    ok "  真凭据未出现在任何租户容器里"
  else
    bad "  真凭据泄漏到租户容器:$LEAKED"
  fi
else
  warn "  .env 里没有 MT_UPSTREAM_API_KEY（模型调用会失败）"
fi

# 每个租户应持有占位 key，且 base URL 指向网关。
KEY_OK=0; KEY_BAD=0; KEY_MISSING=0
for t in $TENANTS; do
  KEY_HEAD="$(docker exec "mt-dsh-$t" sh -c 'printf %s "${DEEPSEEK_API_KEY:-}"' 2>/dev/null | cut -c1-6)"
  BASE="$(docker exec "mt-dsh-$t" sh -c 'printf %s "${DEEPSEEK_BASE_URL:-}"' 2>/dev/null)"
  case "$KEY_HEAD" in
    sk-mt-) KEY_OK=$((KEY_OK + 1)) ;;
    "") KEY_MISSING=$((KEY_MISSING + 1)); warn "  $t 没有 DEEPSEEK_API_KEY：bin/mt.sh up 会补发占位 key" ;;
    *) KEY_BAD=$((KEY_BAD + 1)); bad "  $t 的 DEEPSEEK_API_KEY 不是占位 key" ;;
  esac
  case "$BASE" in
    http://mt-model-gateway:*|"") ;;
    *) KEY_BAD=$((KEY_BAD + 1)); bad "  $t 的 DEEPSEEK_BASE_URL 未指向模型网关：$BASE" ;;
  esac
done
if [ "$KEY_BAD" = 0 ] && [ "$KEY_MISSING" = 0 ]; then
  ok "  ${KEY_OK} 个租户都持有占位 key，模型请求都经网关"
fi

if grep -q 'CHANGE-ME' model.patch.yml 2>/dev/null; then
  warn "model.patch.yml 仍是模板：租户只能用内置 DeepSeek 卡片（已由网关代理）"
else
  ok "model.patch.yml 已填写"
  grep -oE '^ +[a-z0-9-]+:' model.patch.yml 2>/dev/null | sed 's/^/      路由 /' || true
fi
# `grep -c` 无匹配时打印 0 且退出码为 1，这里按行取值，避免把 "0" 与默认值拼在一起。
KEYS="$(grep -cE '^[A-Z_]+=.+' model.env 2>/dev/null)"
KEYS="${KEYS:-0}"
[ "$KEYS" -gt 0 ] && ok "model.env 里有 $KEYS 个非空变量" || warn "model.env 里没有非空变量"
if grep -qE '^DEEPSEEK_API_KEY=.+' model.env 2>/dev/null; then
  warn "model.env 里仍有 DEEPSEEK_API_KEY：真凭据会被注入所有租户容器，请删掉并放到 .env 的 MT_UPSTREAM_API_KEY"
fi
# 用量记录：网关每次请求都会追加一行，用来回答"哪个租户花了多少"。
if [ -f logs/model-usage.jsonl ]; then
  USAGE_LINES="$(wc -l < logs/model-usage.jsonl 2>/dev/null | tr -d ' ')"
  ok "模型用量记录 logs/model-usage.jsonl（${USAGE_LINES:-0} 条）"
else
  warn "还没有模型用量记录（租户尚未发起过模型请求）"
fi

head_ "资源与备份"
AVAIL="$(df -h / | awk 'NR==2{print $4}')"
USEDP="$(df -h / | awk 'NR==2{print $5}' | tr -d '%')"
[ "$USEDP" -lt 85 ] && ok "磁盘剩余 $AVAIL（已用 ${USEDP}%）" || warn "磁盘已用 ${USEDP}%，剩余 $AVAIL"
MEM="$(free -m | awk '/Mem:/{print $7}')"
[ "${MEM:-0}" -gt 512 ] && ok "可用内存 ${MEM} MB" || warn "可用内存仅 ${MEM} MB"
LAST="$(ls -1t backups/dsh-mt-*.tar.gz 2>/dev/null | head -1 || true)"
if [ -z "$LAST" ]; then
  warn "还没有任何备份（bin/backup.sh）"
else
  AGE_H=$(( ($(date +%s) - $(stat -c %Y "$LAST")) / 3600 ))
  [ "$AGE_H" -lt 48 ] && ok "最近备份 $(basename "$LAST")（${AGE_H} 小时前）" \
    || warn "最近备份是 ${AGE_H} 小时前的 $(basename "$LAST")"
fi

printf '\n\033[36m== 结论 ==\033[0m\n  %s 项通过, %s 项警告, %s 项失败\n' "$OK" "$WARN" "$BAD"
[ "$BAD" -eq 0 ] || exit 1
