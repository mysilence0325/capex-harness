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
# 控制面只对"住在本机"的租户检查容器与 home；其余租户的运行时在别的节点上，
# 由本机的节点代理创建，控制面能查的只有它的注册与可达性（下一节）。
NODE_OF() { grep -A6 "\"id\": \"$1\"" tenants.json 2>/dev/null | grep -o '"node": *"[^"]*"' | head -1 | cut -d'"' -f4; }
LOCAL_TENANTS=""
REMOTE_TENANTS=""
for t in $TENANTS; do
  case "$(NODE_OF "$t")" in
    ""|local) LOCAL_TENANTS="$LOCAL_TENANTS $t" ;;
    *)        REMOTE_TENANTS="$REMOTE_TENANTS $t" ;;
  esac
done
if [ -n "$REMOTE_TENANTS" ]; then
  ok "远端租户（运行时在别的节点，由节点代理创建）:$REMOTE_TENANTS"
fi

head_ "租户运行时"
for t in $LOCAL_TENANTS; do
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
head_ "运行时注册"
# 控制面不再看 Docker，只代理注册进来的地址。没有注册 = 该租户登录后必然 503。
REGISTRY="$(curl -fsS "$GW_BASE/__mt/registry" 2>/dev/null || true)"
if [ -z "$REGISTRY" ]; then
  bad "注册表接口无响应（$GW_BASE/__mt/registry）"
else
  REG_COUNT="$(printf '%s' "$REGISTRY" | tr -d ' \n' | grep -o '"endpoint":"' | wc -l)"
  TENANT_COUNT="$(printf '%s\n' "$TENANTS" | grep -c . || true)"
  if [ "${REG_COUNT:-0}" = "${TENANT_COUNT:-0}" ]; then
    ok "${REG_COUNT}/${TENANT_COUNT} 个租户都已注册运行时"
  else
    bad "只有 ${REG_COUNT}/${TENANT_COUNT} 个租户注册了运行时：bin/mt.sh runtimes 查看；本机租户用 bin/mt.sh register，远端租户看该节点的代理日志"
  fi
  # 逐个核对：注册了但要连不上，同样是故障。
  for t in $TENANTS; do
    ENTRY="$(printf '%s' "$REGISTRY" | tr -d ' \n' | grep -o "\"${t}\":{[^}]*}" || true)"
    if [ -z "$ENTRY" ]; then
      bad "  $t 未注册"
      continue
    fi
    EP="$(printf '%s' "$ENTRY" | grep -o '"endpoint":"[^"]*"' | cut -d'"' -f4)"
    NODE="$(printf '%s' "$ENTRY" | grep -o '"node":"[^"]*"' | cut -d'"' -f4)"
    CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 "$EP/" 2>/dev/null || true)"
    if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
      ok "  $t -> $EP （节点 $NODE，HTTP $CODE）"
    else
      bad "  $t -> $EP 连不上（节点 $NODE）"
    fi
  done
fi
# 控制面不该再需要 Docker：一旦挂上了 socket，"攻破网关 = 拿到宿主" 就回来了。
if docker inspect mt-gateway --format '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null | grep -q 'docker.sock'; then
  bad "网关仍挂载 Docker socket（等于宿主 root 等价物）"
else
  ok "网关未挂载 Docker socket"
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
# 与 bin/isolate.sh 用同一套解析：优先渲染时固定的网桥名，否则退回 br-<网络id>。
# 两边必须一致，否则 doctor 会在规则完全正常时报"网桥不对"。
BRIDGE="$(docker network inspect mt-net --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null | tr -d '\r')"
if [ -z "$BRIDGE" ] || [ "$BRIDGE" = "<no value>" ]; then
  BRIDGE="br-$(docker network inspect mt-net --format '{{.Id}}' 2>/dev/null | cut -c1-12)"
fi
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

head_ "日志上限"
# json-file 驱动默认不封顶：容器一直写就把磁盘写满。逐个容器核实，并报出实际占用。
UNBOUNDED=""
LOG_TOTAL=0
for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^(mt-|mock-model)' | sort); do
  MAXSIZE="$(docker inspect "$c" --format '{{index .HostConfig.LogConfig.Config "max-size"}}' 2>/dev/null)"
  LOGPATH="$(docker inspect "$c" --format '{{.LogPath}}' 2>/dev/null)"
  if [ -n "$LOGPATH" ] && [ -f "$LOGPATH" ]; then
    SIZE="$(stat -c%s "$LOGPATH" 2>/dev/null || echo 0)"
    LOG_TOTAL=$((LOG_TOTAL + SIZE))
  fi
  if [ -z "$MAXSIZE" ] || [ "$MAXSIZE" = "<no value>" ]; then
    UNBOUNDED="$UNBOUNDED $c"
  fi
done
if [ -z "$UNBOUNDED" ]; then
  ok "本部署的容器都有日志上限（${MT_LOG_MAX_SIZE:-10m} × ${MT_LOG_MAX_FILE:-3}）"
else
  bad "以下容器日志无上限，磁盘可能被写满：$UNBOUNDED"
fi
ok "  本部署容器日志当前合计 $(echo "scale=1; $LOG_TOTAL/1048576" | bc) MB"
AVAIL_KB="$(df -k / | tail -1 | awk '{print $4}')"
if [ "${AVAIL_KB:-0}" -lt 5242880 ]; then
  warn "  根分区可用不足 5 GB，先清理再排查其它问题"
fi
if ! grep -q 'max-size' /etc/docker/daemon.json 2>/dev/null; then
  ok "  备注：宿主 daemon.json 未设全局 log-opts，其它系统的容器仍无上限（不属于本部署）"
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

# 备份打的是本机的 tenants/，别节点上的租户不在里面。这是警告而不是失败：
# 多节点部署本来就该在每台机器上各备一次，但操作者必须知道"这份备份不完整"。
# 否则出了事照它恢复，会以为那个租户本来就没数据。
THIS_NODE_NAME="${MT_NODE_NAME:-local}"
OFF_NODE=""
for t in $TENANTS; do
  n="$(NODE_OF "$t")"
  [ -n "$n" ] && [ "$n" != "$THIS_NODE_NAME" ] && OFF_NODE="$OFF_NODE $t($n)"
done
if [ -n "$OFF_NODE" ]; then
  warn "这些租户不在本机备份内（数据在别的节点上，需到那台机器执行 bin/mt.sh backup）:$OFF_NODE"
else
  ok "全部租户都由本机备份覆盖"
fi

# 会话保留策略：设了就会自动清理，没设就一直长。两种都行，但操作者要知道是哪种。
RETENTION="$(grep '^MT_SESSION_RETENTION_DAYS=' .env 2>/dev/null | cut -d= -f2- | tr -d '"')"
if [ -n "$RETENTION" ]; then
  # 说清楚是"打算保留多少"，而不是"系统会替你清理"——清理目前仍要手工执行。
  ok "会话保留策略记为 ${RETENTION} 天（清理目前需手工执行 bin/mt.sh disk prune-sessions）"
else
  warn "没有设置 MT_SESSION_RETENTION_DAYS，也没有自动清理：会话会一直增长，磁盘会慢慢满"
fi

# 节点代理的控制面地址。留空时代理只提供运维能力、不做租户发现与注册，而且这是静默的：
# 界面上一切正常，直到某个租户重启（启动 token 会轮换）之后，统一入口才开始一直返回 303。
# 这一项曾经丢掉过一次（restore 用归档里的 .env 覆盖了当前配置），排查了一整轮，所以它是失败项。
if [ -n "$(grep '^MT_CONTROL_PLANE=' .env 2>/dev/null | cut -d= -f2-)" ]; then
  if [ -n "$(grep '^MT_CONTROL_PLANE_CA=' .env 2>/dev/null | cut -d= -f2-)" ]; then
    ok "节点代理已配置控制面地址与 CA（会注册租户）"
  else
    warn "节点代理有控制面地址但没有 MT_CONTROL_PLANE_CA：HTTPS 自签证书下注册会失败"
  fi
else
  bad "MT_CONTROL_PLANE 为空：节点代理不会注册租户，租户重启后统一入口会一直返回 303"
fi

# .env 里已删租户的残留键。
#
# 不能简单地看 MT_<前缀>_：MT_CONTROL_PLANE、MT_BACKUP_KEEP、MT_EDGE_PORT 这些功能键
# 都会命中那个形状。实测过：天真写法把 13 个功能键误报成"残留租户"，
# 而一个每次都喊狼来了的检查，结局是被忽略。
#
# 所以后缀是【推导】出来的：当前租户的键用过哪些后缀，那些后缀就是租户后缀。
# render 以后加了新字段，这里自动跟上，不用改。
STALE_TMP="$(mktemp -d)"
python3 - "$STALE_TMP" <<'PY' >/dev/null 2>&1 || true
import json, re, sys
out = sys.argv[1]
ids = {t['id'] for t in json.load(open('tenants.json'))['tenants']}
entries = []
for line in open('.env', encoding='utf-8'):
    m = re.match(r'^MT_([A-Z0-9_]+?)_([A-Z0-9_]+)=', line)
    if m:
        entries.append((m.group(1).lower().replace('_', '-'), m.group(2), line.split('=')[0]))
# 当前租户用过的后缀，才算法租户后缀
suffixes = {suf for prefix, suf, _ in entries if prefix in ids}
stale = sorted({prefix for prefix, suf, _ in entries if suf in suffixes and prefix not in ids})
keys = sorted(k for prefix, suf, k in entries if suf in suffixes and prefix not in ids)
open(f'{out}/stale.txt', 'w').write(' '.join(stale))
open(f'{out}/keys.txt', 'w').write('\n'.join(keys))
open(f'{out}/suffixes.txt', 'w').write(' '.join(sorted(suffixes)))
PY
STALE="$(cat "$STALE_TMP/stale.txt" 2>/dev/null)"
SUFFIXES="$(cat "$STALE_TMP/suffixes.txt" 2>/dev/null)"
if [ -n "${STALE// /}" ]; then
  bad ".env 里有已删租户的残留键 → $STALE（租户后缀: $SUFFIXES；删掉这些行，然后 render 一次）"
else
  ok ".env 里没有已删租户的残留键（租户后缀: ${SUFFIXES:-推导不出}）"
fi
rm -rf "$STALE_TMP"

# 配置漂移：拿最近一次备份里记下的 .env 键清单，和当前 .env 比对。
# restore 会用归档里的 .env 覆盖当前配置，而且不提示——真正咬人的是键整个消失
# （MT_CONTROL_PLANE 丢过一次，表现为节点代理静默降级、租户重启后入口一直 303）。
LATEST_ARCHIVE="$(ls -t backups/dsh-mt-*.tar.gz 2>/dev/null | head -1)"
if [ -n "$LATEST_ARCHIVE" ]; then
  DRIFT_TMP="$(mktemp -d)"
  if tar -xzf "$LATEST_ARCHIVE" -C "$DRIFT_TMP" MANIFEST.txt 2>/dev/null; then
    # 备份时的键（MANIFEST 里 "  - KEY" 形式）
    sed -n '/^环境键清单  :/,/^[^ ]/p' "$DRIFT_TMP/MANIFEST.txt" 2>/dev/null \
      | grep -oE '^  - [A-Za-z_][A-Za-z0-9_]*' | sed 's/^  - //' | sort -u > "$DRIFT_TMP/then.txt"
    grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env 2>/dev/null | sed 's/=$//' | sort -u > "$DRIFT_TMP/now.txt"
    MISSING="$(comm -23 "$DRIFT_TMP/then.txt" "$DRIFT_TMP/now.txt" | tr '\n' ' ')"
    ADDED="$(comm -13 "$DRIFT_TMP/then.txt" "$DRIFT_TMP/now.txt" | tr '\n' ' ')"
    if [ -n "${MISSING// /}" ]; then
      bad "配置漂移：$(basename "$LATEST_ARCHIVE") 里有的这些键现在没了 → $MISSING（多半是 restore 用归档覆盖了 .env，恢复后要补回并 render）"
    elif [ -n "${ADDED// /}" ]; then
      warn "备份之后新增的配置键: $ADDED（记得在下一次备份前确认它们是对的）"
    else
      ok "配置键与最近一次备份一致（$(wc -l < "$DRIFT_TMP/now.txt" | tr -d ' ') 个）"
    fi
    # 没有清单的老归档：说清楚，而不是假装检查过
    [ -s "$DRIFT_TMP/then.txt" ] || warn "最近一次备份的 MANIFEST 里没有键清单（老版本备份），无法比对配置漂移"
  else
    warn "读不出最近一次备份的 MANIFEST，跳过配置漂移检查"
  fi
  rm -rf "$DRIFT_TMP"
else
  warn "还没有备份，无法比对配置漂移"
fi

printf '\n\033[36m== 结论 ==\033[0m\n  %s 项通过, %s 项警告, %s 项失败\n' "$OK" "$WARN" "$BAD"
[ "$BAD" -eq 0 ] || exit 1
