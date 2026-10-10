#!/usr/bin/env bash
# 部署自检：把"能不能用、哪里不对"一次性列清楚。
#
#   bin/doctor.sh
#
# 只读，不改任何状态；退出码 0 表示没有致命问题（警告不算）。
set -uo pipefail
cd "$(dirname "$0")/.."

# 自己读 .env。以前这里只看环境变量，于是 `bin/mt.sh doctor`（mt.sh 已经 source 过
# .env）与直接跑 `bash bin/doctor.sh` 会给出不同结论 —— 同一份配置，两种答案。
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# 宿主机没有 curl 时用容器里的顶（局域网装不了包的情况）；有 curl 时这个文件什么都不做。
# shellcheck disable=SC1091
. bin/lib-http.sh

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

# 这套部署的模型是【一个租户 = 一个账号 = 一个独占空间】。注册表结构允许一个租户挂
# 多个用户，但那不是这里的模型：多出来的账号会和原账号共用同一个容器、同一份 home 与
# workspace，也就是共用同一个空间，而"谁做的"只能靠用户名去猜。手工编辑过的注册表
# 不会报错，只会悄悄变成那个样子，所以这里点名。
ODD_USERS="$(python3 - tenants.json <<'PY' 2>/dev/null || true
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
odd = [f"{t['id']}({len(t.get('users') or [])})" for t in doc.get('tenants', []) if len(t.get('users') or []) != 1]
print(' '.join(odd))
PY
)"
if [ -n "${ODD_USERS// /}" ]; then
  warn "有租户的账号数不是 1：$ODD_USERS（本部署是一个租户一个账号；要再加一个隔离空间就新增租户）"
else
  ok "每个租户恰好一个账号（一租户＝一账号＝一个独占空间）"
fi
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

# 控制台页面能不能用，不看状态码也不看页面里有没有那些控件：整页脚本一旦有语法
# 错误，浏览器里表格永远停在"加载中"、所有按钮都不响应，而接口、状态码、页面
# 内容全都是好的。这里解析服务端【真正会送出】的那段脚本，不需要登录。
head_ "控制台页面"
if [ "$gstate" = running ]; then
  SERVED_ERR="$(docker exec mt-gateway node -e '
const vm = require("node:vm")
const html = require("/app/admin-page.js").consolePage("/__mt/admin", { user: "doctor", role: "admin" })
const open = html.indexOf("<script>")
const close = html.lastIndexOf("</script>")
if (open < 0 || close < 0) { console.log("页面里没有 script 块"); } else {
  try { new vm.Script(html.slice(open + 8, close)); console.log("") } catch (error) { console.log(error.message) }
}
' 2>&1 | tr -d '\r')"
  if [ -z "$SERVED_ERR" ]; then
    ok "服务端送出的控制台脚本能解析（页面上的按钮才会响应）"
  else
    bad "控制台脚本有语法错误，页面在浏览器里不会工作: $SERVED_ERR"
  fi
else
  warn "网关没在运行，跳过控制台页面检查"
fi

# 租户网络本身：MAC 撞车与孤儿网络。
#
# Docker 按容器在某网络上的 IP 生成 MAC（02:42:<ip>）并一直保留。IP 会随重建变化，
# 留下的旧 MAC 让网桥分不清两台容器。实测：mt-dsh-alpha 与模型网关在 mt-net-alpha 上
# 都是 02:42:0a:62:8e:02，alpha 连不上模型网关（EHOSTUNREACH），另外三个租户却正常。
head_ "租户网络"
NET_PREFIX="${MT_NETWORK:-mt-net}"
# 注册表里的租户是换行分隔的，拼成"两端带空格"的一行才好做子串匹配（多租户时
# 用空格拼模式会一个都匹配不上，把正常网络全报成孤儿）。
TENANTS_SPACE=" $(printf '%s' "$TENANTS" | tr '\n' ' ') "
COLLIDE=""
ORPHAN=""
for n in $(docker network ls --format '{{.Name}}' 2>/dev/null | grep -E "^${NET_PREFIX}(-|$)" | sort); do
  PAIRS=""
  for c in $(docker network inspect "$n" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null); do
    mac="$(docker inspect "$c" --format "{{with index .NetworkSettings.Networks \"$n\"}}{{.MacAddress}}{{end}}" 2>/dev/null)"
    [ -n "$mac" ] && PAIRS="${PAIRS}${mac} ${c}"$'\n'
  done
  for m in $(printf '%s' "$PAIRS" | awk 'NF{print $1}' | sort | uniq -d); do
    WHO="$(printf '%s' "$PAIRS" | awk -v m="$m" 'NF && $1 == m {printf "%s ", $2}')"
    COLLIDE="${COLLIDE}"$'\n'"    ${n}: ${m} 同时属于 ${WHO}"
  done
  if [ "$n" != "$NET_PREFIX" ]; then
    # 用 sed 取后缀：`${n#"$PREFIX"-}` 这种嵌套引号在 CentOS 7 的 bash 4.2 上不成立，
    # 会把所有租户网络都当成孤儿。
    SUFFIX="$(printf '%s' "$n" | sed "s/^${NET_PREFIX}-//")"
    case "$TENANTS_SPACE" in
      *" $SUFFIX "*) : ;;
      *) ORPHAN="$ORPHAN $n" ;;
    esac
  fi
done
if [ -n "$COLLIDE" ]; then
  bad "同一张网络上有容器 MAC 相同（网桥分不清它们，会随机连不上）：$COLLIDE
   修法：重建其中一个容器（bin/mt.sh restart 不会换 MAC，需要 docker-compose up -d --force-recreate <service>）"
else
  ok "租户网络上没有 MAC 冲突"
fi
if [ -n "${ORPHAN// /}" ]; then
  warn "注册表里没有对应租户的网络还在:$ORPHAN（删租户现在会连带删除；历史残留可 docker network rm）"
else
  ok "没有多余的租户网络"
fi

# 限速是**运行时**规则（tc 落在容器的 netns 里）：机器重启或容器重建都会把它清掉，而
# 意图文件 state/bandwidth.json 还在 —— 于是"以为限着、其实没限"。这里逐租户核对意图与
# 现状，不一致就点名（重放：bin/mt.sh up 或 bin/bandwidth.sh apply）。
if [ -s state/bandwidth.json ]; then
  BW_INTENT="$(python3 - state/bandwidth.json <<'PY' 2>/dev/null || true
import json, sys
try:
    print(' '.join(json.load(open(sys.argv[1], encoding='utf-8')).keys()))
except Exception:
    pass
PY
)"
  BW_MISSING=""
  for t in ${BW_INTENT:-}; do
    # 先取输出再匹配，不要写成 `cmd | grep -q`：doctor 开了 pipefail，而 bandwidth.sh
    # 的退出码在"该租户没规则"等路径上可能是非零，管道整体就会失败，把"已限速"也判成没限速
    # （这个假警报我自己踩过：同一时刻手工 show 显示已限速，doctor 却说没落下）。
    BW_OUT="$(bash bin/bandwidth.sh show "$t" 2>/dev/null || true)"
    case "$BW_OUT" in *已限速*) : ;; *) BW_MISSING="$BW_MISSING $t" ;; esac
  done
  # 增删租户会重建容器：那一刻运行时规则被清掉，随后由同一次操作重放（可能几十秒）。
  # 只在缺规则时才轮询等待，避免把"正在重放"报成"没限速"。
  for _ in 1 2 3; do
    [ -z "${BW_MISSING// /}" ] && break
    sleep 5
    BW_MISSING=""
    for t in ${BW_INTENT:-}; do
      BW_OUT="$(bash bin/bandwidth.sh show "$t" 2>/dev/null || true)"
      case "$BW_OUT" in *已限速*) : ;; *) BW_MISSING="$BW_MISSING $t" ;; esac
    done
  done
  if [ -n "${BW_MISSING// /}" ]; then
    warn "限速规则没落下:$BW_MISSING（重启/重建会清掉运行时规则，跑 bin/bandwidth.sh apply 重放）"
  else
    ok "限速意图与现状一致（${BW_INTENT}）"
  fi
fi

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
  #
  # 探测容器按注册表顺序挑一个【在跑的】租户，而不是 docker ps 的第一行：
  # 新增/删除租户时会有容器正在建或正在删，挑到它就得到 "unreachable"，
  # 那不是拦截失败，是探针自己踩空了。另外新增租户会重建模型网关（它要接入
  # 新租户的网络），这几秒里连真请求也会失败，所以失败等 5 秒再判一次。
  PROBE_CONTAINER=""
  for t in $TENANTS; do
    if [ "$(docker inspect "mt-dsh-$t" --format '{{.State.Status}}' 2>/dev/null)" = running ]; then
      PROBE_CONTAINER="mt-dsh-$t"
      break
    fi
  done
  FORGED=""
  for _ in 1 2; do
    [ -n "$PROBE_CONTAINER" ] || break
    FORGED="$(docker exec "$PROBE_CONTAINER" node -e '
    fetch("http://mt-model-gateway:8080/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-mt-forged" },
      body: "{}",
    }).then((r) => console.log(String(r.status))).catch(() => console.log("unreachable"))
  ' 2>/dev/null | tr -d '\r')"
    [ "$FORGED" = "401" ] && break
    sleep 5
  done
  if [ "$FORGED" = "401" ]; then
    ok "  未知 key 被拒（401）"
  else
    bad "  未知 key 未被拒绝：${FORGED:-无响应}（刚新增过租户时会重建模型网关，那几秒里请求本就不通）"
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

# 离线升级要先有镜像：有内网仓库时走 registry-push，没有时只能 docker save/load。
# 仓库挂了不会影响正在跑的租户，所以这里不当作致命错误，但必须看得见。
head_ "内网仓库（离线升级用）"
REG_HOST="$(grep -E '^MT_REGISTRY_HOST=' .env 2>/dev/null | tail -1 | cut -d= -f2)"
REG_PLAIN="$(grep -E '^MT_REGISTRY_PLAIN_HTTP=' .env 2>/dev/null | tail -1 | cut -d= -f2)"
if [ -z "$REG_HOST" ]; then
  warn "未配 MT_REGISTRY_HOST：registry-push 不可用，离线升级只能 docker save/load 搬镜像"
else
  REG_SCHEME=https
  [ "$REG_PLAIN" = "1" ] && REG_SCHEME=http
  REG_CODE="$(curl -sSk -o /dev/null -w '%{http_code}' --max-time 8 "$REG_SCHEME://$REG_HOST/v2/" 2>/dev/null)"
  case "$REG_CODE" in
    200|401) ok "内网仓库可达: $REG_SCHEME://$REG_HOST（HTTP $REG_CODE）" ;;
    000|"")  bad "内网仓库 $REG_SCHEME://$REG_HOST 连不上 —— registry-push 会失败" ;;
    *)       warn "内网仓库返回 HTTP $REG_CODE（可能不是 registry v2 端点）" ;;
  esac
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
