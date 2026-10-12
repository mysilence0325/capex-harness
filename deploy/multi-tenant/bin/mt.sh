#!/usr/bin/env bash
# DSH multi-tenant deployment operations.
#
#   bin/mt.sh up                 render + build + start the control plane and every tenant
#   bin/mt.sh down               stop everything (tenant data stays on disk)
#   bin/mt.sh restart [tenant]   restart all, or one tenant runtime
#   bin/mt.sh ps                 container status
#   bin/mt.sh status             container status + gateway readiness
#   bin/mt.sh logs [tenant]      follow logs (gateway when no tenant is named)
#   bin/mt.sh url                print every entry URL
#   bin/mt.sh smoke              run the isolation smoke test
#   bin/mt.sh accept <args>      run the end-to-end acceptance (model catalog → prompt → reply)
#   bin/mt.sh doctor             preflight and health check of this deployment
#   bin/mt.sh mount-check [URL]  check one entry URL the way a browser uses it (front proxy sub-paths)
#   bin/mt.sh cert [额外SAN]     generate a self-signed certificate; then bin/mt.sh up serves HTTPS
#   bin/mt.sh backup [args]      back up every tenant's data + control-plane state
#   bin/mt.sh restore <archive>  restore a backup (current data is moved aside, not deleted)
#   bin/mt.sh publish-image      build the runtime image from an uploaded local-source overlay
#   bin/mt.sh list               list tenants from the registry
#   bin/mt.sh add <id> [...]     add a tenant (see bin/registry.js)
#   bin/mt.sh add-batch <清单.csv>  批量建租户（每行 id,用户名[,标题[,口令]]）
#   bin/mt.sh passwd <id> <user> set a tenant password (and end that user's sessions)
#   bin/mt.sh kick <id> [user]   end a tenant's or one user's sessions without changing the password
#   bin/mt.sh limit <id> [--rpm n] [--daily-tokens n] [--clear]   model ceilings for one tenant
#   bin/mt.sh registry-push      push the images to an internal registry (for offline machines)
#   bin/mt.sh upgrade --image <ref>   rolling upgrade of the tenant runtime image
#   bin/mt.sh remove <id>        remove a tenant from the registry
#   bin/mt.sh key <id> <value>   set a tenant's model key in .env
#   bin/mt.sh model              apply model.patch.yml + model.env to every tenant and restart them
#   bin/mt.sh render             re-render docker-compose.yml from tenants.json
#   bin/mt.sh admin-passwd       set the administrator console password (revokes sessions)
#   bin/mt.sh admin-kick         revoke every admin session, keep the password
#   bin/mt.sh admin-users        list | add | passwd | remove administrators and roles
#   bin/mt.sh alert-sink        alert receiver: up | wire | test | status
#   bin/mt.sh bandwidth         per-tenant network rate limit (show/set/clear)
#   bin/mt.sh keys              generate the per-purpose keys (metrics/register/ops)
#   bin/mt.sh alert-sink        alert receiver: up | wire | test | status
#   bin/mt.sh bandwidth         per-tenant network rate limit (show/set/clear)
#   bin/mt.sh keys              generate the per-purpose keys (metrics/register/ops)
#   bin/mt.sh usage [--days N] [--csv|--json]   per-tenant model usage, no rates
#   bin/mt.sh export <tenant>    write a portable archive of one tenant
#   bin/mt.sh import <archive> --as <id>   bring one in with fresh ports and names
#   bin/mt.sh admin-add <name> --role viewer   add a read-only administrator
#   bin/mt.sh wire-prometheus    wire the alert rules into this host's Prometheus
#   bin/mt.sh register <id>      register a tenant runtime with the control plane
#   bin/mt.sh unregister <id>    make the control plane forget a tenant runtime
#   bin/mt.sh runtimes           list the runtimes the control plane knows about
#   bin/mt.sh agent up|down|status     节点代理（节点与控制面共用一条命令）
#   bin/mt.sh agent allow <网关地址>    放行网关访问本机代理端口（换网关/加备用网关后要跑）
#   bin/mt.sh ha-sync --from <主网关>   控制面 HA：从主网关单向同步状态（--install-timer 装定时器）
#   bin/mt.sh move <租户> --to <节点>   把一个租户搬到另一台节点（数据+注册表+目标机 up）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_IMAGE="${MT_NODE_IMAGE:-node:22-bookworm-slim}"
if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
elif docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  echo "找不到 docker-compose 或 docker compose" >&2
  exit 1
fi

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

node_run() {
  # MT_HOST_PROJECT_DIR：渲染器在容器里看到的是 /w，而宿主（以及解析挂载源的 Docker
  # 守护进程）看到的是真实路径。节点代理要挂载项目、容器里的 compose 要创建容器，都必须
  # 用宿主路径，而只有这个在宿主上跑的脚本知道它。
  # MT_NODE_NAME / MT_NETWORK must reach the render container: without them it
  # renders the control plane's own tenant set on a worker node, which then tries
  # to create containers that already exist elsewhere.
  docker run --rm \
    -e "MT_NODE_NAME=${MT_NODE_NAME:-local}" \
    -e "MT_NETWORK=${MT_NETWORK:-mt-net}" \
    -e "MT_NETWORK_EXTERNAL=${MT_NETWORK_EXTERNAL:-}" \
    -e "MT_CONTAINER_NAME_PREFIX=${MT_CONTAINER_NAME_PREFIX:-mt-}" \
    -e "MT_BASE_PATH=${MT_BASE_PATH:-}" \
    -e "MT_HOST_PROJECT_DIR=${ROOT}" \
    -v "$ROOT:/w" -w /w "$NODE_IMAGE" node "$@"
}
# 发 HTTP 请求。
# 不依赖 curl：节点代理的容器里没有 curl，也装不上（无外网）；而宿主 curl 通常是动态链接的，
# 直接挂进 Debian 容器也跑不起来。node 一定在——本脚本的注册表与渲染步骤本来就靠它。
# 回退到容器时必须用宿主网络：运维端口只监听 loopback，默认 bridge 容器里的 127.0.0.1
# 是容器自己，连不到控制面。
http() {
  if command -v node >/dev/null 2>&1; then
    node bin/http.js "$@"
  else
    docker run --rm -i --network host -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/http.js "$@"
  fi
}

# 需要从 stdin 读数据的场合：docker run 不挂 -i 时，容器里读到的是空输入。
node_run_stdin() {
  docker run --rm -i \
    -e "MT_NODE_NAME=${MT_NODE_NAME:-local}" \
    -e "MT_NETWORK=${MT_NETWORK:-mt-net}" \
    -e "MT_NETWORK_EXTERNAL=${MT_NETWORK_EXTERNAL:-}" \
    -e "MT_CONTAINER_NAME_PREFIX=${MT_CONTAINER_NAME_PREFIX:-mt-}" \
    -e "MT_HOST_PROJECT_DIR=${ROOT}" \
    -v "$ROOT:/w" -w /w "$NODE_IMAGE" node "$@"
}

require_render() {
  if [ ! -f docker-compose.yml ]; then
    echo "==> 首次运行，先渲染 docker-compose.yml"
    node_run bin/render.js
  fi
}

cmd_up() {
  local this_node="${MT_NODE_NAME:-local}"
  # 节点先刷新注册表副本，再渲染：控制面刚建的远端租户要这一份才出现在 compose 里。
  if [ "$this_node" != local ]; then
    sync_registry_from_control_plane | sed 's/^/    /'
  fi
  # MT_NODE_ADDRESS 是"控制面该来哪儿找我"。从别的机器抄来的 .env 里常常还是那一台的
  # 地址，而按它注册出来的端点（http://<地址>:3199/proxy/<租户>）只有那台可达——本机
  # 自己的网关连不上，表现是 doctor 里每个租户都"连不上"、登录 503，而容器全在跑。
  # 这里提前点名（NAT 之后的节点有意用外部地址时会看到这条提示，那是对的，忽略即可）。
  if [ -n "${MT_NODE_ADDRESS:-}" ] && command -v ip >/dev/null 2>&1 \
     && ! ip -4 -o addr show scope global 2>/dev/null | grep -qw "${MT_NODE_ADDRESS}"; then
    echo "    !! MT_NODE_ADDRESS=${MT_NODE_ADDRESS} 不是本机地址（本机探测到 $(lan_ip)）："
    echo "       注册出去的端点会指向别的机器，登录会连不上。改成本机地址，或删掉这行让脚本自动探测。"
  fi
  # 老租户可能还没有占位 key；先补发，否则渲染出来的租户没有模型凭据。
  node_run bin/registry.js ensure-model-keys | sed "s/^/    /"
  node_run bin/render.js "${1:-}"
  echo "==> 构建镜像并启动（本机节点名: ${this_node}）"
  # 经典构建器：本机 Docker Hub 不可达，buildkit 会去远端解析基础镜像元数据而失败，
  # 经典构建器直接使用本地已有的 node:22-bookworm-slim。
  # 网关只在控制面上有；worker 节点的 compose 里没有这个 service，构建它会失败。
  # 备用网关也要构建网关镜像（它渲染的 compose 里有 gateway 这个 service）；
  # 有租户的节点只有 egress-proxy / model-gateway / node-agent。
  #
  # 逐个 service 先显式构建（用经典构建器），再 up：让 compose 自己在 up 里构建
  # 会走 BuildKit，于是每台新机器都要去 Docker Hub 解析基础镜像元数据然后失败。
  local build_services=(egress-proxy model-gateway)
  if [ "$this_node" = local ] || [ "${MT_CONTROL_PLANE_STANDBY:-}" = "1" ]; then
    build_services=(gateway "${build_services[@]}")
  fi
  # node-agent 只在非备用主机的 compose 里出现（备用网关不持有租户，不需要它）。
  if grep -q '^  node-agent:' docker-compose.yml 2>/dev/null; then
    build_services+=("node-agent")
  fi
  DOCKER_BUILDKIT=0 "${COMPOSE[@]}" build "${build_services[@]}"
  "${COMPOSE[@]}" up -d
  # 网络建立后才能探测到网关地址；首次运行或网段变化时补上租户出口代理。
  ensure_egress_proxy
  # 收紧租户容器对宿主端口的访问；失败只提示，不让 up 半途而废（doctor 会报出来）。
  # MT_SKIP_ISOLATE=1 时不碰宿主防火墙：共享机器上的第二套部署（测试、演练）不该
  # 覆盖别人的规则——isolate 是"先删本部署的旧规则再加新的"，跑一次就会把另一套的删掉。
  if [ "${MT_SKIP_ISOLATE:-}" = "1" ]; then
    echo "    MT_SKIP_ISOLATE=1：未改动宿主防火墙规则（需要时手工执行 bin/isolate.sh apply）"
  else
    bash bin/isolate.sh apply || echo "    !! 租户隔离规则未应用，执行 bin/isolate.sh status 查看"
  fi
  if [ "$this_node" = local ]; then
    # 控制面：注册本机租户（网关只认注册表里的地址，容器重建后必须重报）。
    wait_gateway || true
    register_all_tenants
  elif [ "${MT_CONTROL_PLANE_STANDBY:-}" = "1" ]; then
    echo "==> 本机是备用网关：只服务共享入口（MT_EDGE_LISTEN=0），不持有租户、不注册"
  else
    # 节点：不自己注册，交给本机节点代理——它随容器变化持续重报，而 up 只跑一次。
    echo "==> 本节点是 ${this_node}：运行时由节点代理上报（在控制面用 bin/mt.sh runtimes 查看）"
  fi
  cmd_wait
  # 限速是运行时状态，容器一重建就没了 —— 切镜像的 up 正是这种情况，而重放原先只写在
  # cmd_add 里，于是每次 up 之后限速都静默消失（doctor 的限速检查抓到过）。放在"等就绪"
  # 之后：这时容器的 netns 才存在，nsenter/tc 才进得去。失败只提示，不让 up 半途而废。
  bash bin/bandwidth.sh apply || echo "    !! 网络限速未恢复，执行 bin/mt.sh bandwidth apply 查看"
  cmd_url
}

# 脚本自己访问网关用的地址。
#   - TLS 开着时公开端口是 HTTPS，本机脚本走 loopback 明文运维端口；
#   - 远端节点用 MT_GATEWAY_URL 指向控制面（它没有本机的运维端口）。
gw_base() {
  if [ -n "${MT_GATEWAY_URL:-}" ]; then
    echo "${MT_GATEWAY_URL%/}"
    return 0
  fi
  if [ -f state/tls/server.crt ] || [ -n "${MT_TLS_CERT:-}" ]; then
    echo "http://127.0.0.1:${MT_HTTP_PORT:-8099}"
  else
    echo "http://127.0.0.1:${MT_EDGE_PORT:-8090}"
  fi
  return 0
}

# 注册密钥：本机控制面用 state/registry.key，远端节点用 MT_REGISTRY_KEY_FILE 指过去。
registry_key() {
  local file="${MT_REGISTRY_KEY_FILE:-state/registry.key}"
  if [ -f "$file" ]; then
    tr -d '\r\n' < "$file" || true
  fi
  return 0
}

# 节点：把控制面的租户注册表拉一份到本机。节点渲染的是这份副本（render.js 按
# MT_NODE_NAME 过滤），所以"控制面新建了分配给本机的租户"要先刷新副本才看得见。
#
# 控制面自己不走这里：它手上就是权威注册表，而 /__mt/registry/tenants 发出来的是
# 面向节点的副本（口令哈希被剥掉），拉回来会把权威文件覆盖掉。
#
# 拉不到不算错：控制面暂时不可达时，节点不该连自己原有的租户都起不来。
sync_registry_from_control_plane() {
  local control="${MT_CONTROL_PLANE:-}"
  [ -n "$control" ] || return 0
  [ -f state/register.key ] || return 0
  local key tmp=".tenants.json.new"
  key="$(tr -d '\r\n' < state/register.key)"
  http GET "${control%/}/__mt/registry/tenants" \
    --header "x-mt-registry-key: ${key}" --insecure --max-time 20 > "$tmp" 2>/dev/null || true
  if [ -s "$tmp" ] && grep -q '"tenants"' "$tmp"; then
    mv "$tmp" tenants.json
    echo "    已从控制面刷新租户注册表"
  else
    rm -f "$tmp"
    echo "    !! 拉取租户注册表失败（控制面不可达或密钥不对）：用本机现有副本继续"
  fi
  return 0
}

# 租户容器的名字（注册表里优先，取不到就按约定）。
tenant_container() {
  local id="$1" name
  name="$(node_run -e 'const r=require("/w/tenants.json");const t=r.tenants.find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.container ?? ("mt-dsh-"+t.id)))' "$id" 2>/dev/null | tr -d '\r')"
  if [ -n "$name" ]; then echo "$name"; else echo "${MT_CONTAINER_NAME_PREFIX:-mt-}dsh-$id"; fi
}

# 从容器日志里取 DSH 打印的启动 token。
#
# 只取"本次启动之后"的日志：容器重启后 docker logs 仍保留上一次的 token 行，
# 直接取最后一条会在 DSH 打印新 token 之前抓到旧值，注册上去就是过期凭据。
#
# 结尾的 `|| true` 是必须的：DSH 还没打出那行时 grep 无匹配、管道在 pipefail 下返回 1，
# 而"还没打印"正是这里的常态。没有它，调用处（cmd_add / cmd_restart 是普通调用，
# 处在 set -e 之下）会静默中断整个脚本。
tenant_token() {
  local container="$1" started
  started="$(docker inspect "$container" --format '{{.State.StartedAt}}' 2>/dev/null | tr -d '\r' || true)"
  if [ -n "$started" ]; then
    docker logs --since "$started" "$container" 2>&1 | grep -oE 'dsh web: *\S+' | tail -1 | sed 's/.*token=//' | tr -d '\r' || true
  else
    docker logs "$container" 2>&1 | grep -oE 'dsh web: *\S+' | tail -1 | sed 's/.*token=//' | tr -d '\r' || true
  fi
  return 0
}

tenant_port() {
  node_run -e 'const r=require("/w/tenants.json");const t=r.tenants.find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.internalPort ?? ""))' "$1" 2>/dev/null | tr -d '\r'
}

# 向控制面注册一个租户的运行时：地址 + 启动 token。
#
# 这一步是控制面与运行时解耦的关键：网关不再自己找容器，只代理注册进来的地址。
# 因此任何能创建容器的地方（本机现在、节点代理或 Swarm 以后）只要会调这个接口就能接入。
register_tenant() {
  local id="$1" endpoint="${2:-}" token="${3:-}" node="${4:-${MT_NODE:-local}}"
  local container key port body response
  container="$(tenant_container "$id")"
  if [ -z "$endpoint" ]; then
    local ip attempt=0
    # 容器刚创建时 Docker 还没把地址写进 inspect，直接读会读到空。等一会儿再放弃，
    # 比直接报"没有网络地址"有用——磁盘慢的机器上重建时确实会撞上。
    while [ "$attempt" -lt 20 ]; do
      ip="$(docker inspect "$container" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null | tr -d '\r' || true)"
      [ -n "$ip" ] && break
      sleep 1
      attempt=$((attempt + 1))
    done
    if [ -z "$ip" ]; then
      echo "    !! ${id}: 容器 ${container} 没有网络地址（还没启动？）" >&2
      return 1
    fi
    port="$(tenant_port "$id")"
    if [ -z "$port" ]; then
      echo "    !! ${id}: 注册表里没有 internalPort" >&2
      return 1
    fi
    # 端点优先走本机节点代理（http://<本机地址>:3199/proxy/<租户>），而不是容器在
    # mt-net 上的 bridge 地址。bridge 地址只有本机可达，于是控制面高可用切换之后，
    # 备用网关（另一台机器）连不上这些租户——"网关坏了切过去"就只保住住在其它节点上
    # 的租户，而控制面自己这台上跑的那些全 502。走代理之后任何能连到本机 3199 的
    # 网关都能代理它们，和节点上的租户是同一条路径、同一套配置。
    local agent_ep="" node_addr=""
    node_addr="${MT_NODE_ADDRESS:-}"
    [ -n "$node_addr" ] || node_addr="$(lan_ip)"
    if [ -n "$node_addr" ] && [ "$(docker inspect "$(agent_container)" --format '{{.State.Status}}' 2>/dev/null || true)" = running ]; then
      agent_ep="http://${node_addr}:${MT_AGENT_PORT:-3199}/proxy/${id}"
    fi
    endpoint="${agent_ep:-http://${ip}:${port}}"
    # 本机注册：等 DSH 打印出启动 token 再上报，否则激活会失败。
    # 拿不到 token 就不上报——控制面会拒绝没有 token 的注册（它没法用）。
    # （远端节点用节点代理，或显式传 --endpoint/--token。）
    if [ -z "$token" ]; then
      local waited=0
      token="$(tenant_token "$container")"
      while [ -z "$token" ] && [ "$waited" -lt "${MT_REGISTER_WAIT:-90}" ]; do
        sleep 3
        waited=$((waited + 3))
        token="$(tenant_token "$container")"
      done
    fi
    if [ -z "$token" ]; then
      echo "    !! ${id}: ${MT_REGISTER_WAIT:-90} 秒内没等到启动 token，本次不注册（bin/mt.sh register ${id} 可重试）" >&2
      return 1
    fi
  fi
  key="$(registry_key)"
  if [ -z "$key" ]; then
    echo "    !! 读不到注册密钥 ${MT_REGISTRY_KEY_FILE:-state/registry.key}：控制面未启动，或本机不是控制面（远端节点请用节点代理）" >&2
    return 1
  fi
  body="$(printf '{"tenant":"%s","endpoint":"%s","token":"%s","node":"%s"}' "$id" "$endpoint" "$token" "$node")"
  response="$(http POST "$(gw_base)/__mt/registry/register" \
    --header "x-mt-registry-key: ${key}" --header 'content-type: application/json' \
    --data "$body" --max-time 10 2>&1 || true)"
  case "$response" in
    *'"ok":true'*) return 0 ;;
    *) echo "    !! ${id}: 注册失败 -> ${response}" >&2; return 1 ;;
  esac
}

# 注册本机上所有已就绪的租户。容器重建会换掉 bridge 地址，所以每次 up 都要重来一遍。
register_all_tenants() {
  echo "==> 注册运行时地址到控制面"
  local ids id ok=0 failed=0
  # 只注册**本机**的租户。远端租户由它那台的节点代理上报；在这里也去注册，只会因为
  # 本地没有对应容器而逐个报失败——多机时每次 up 都刷一排红字，把真正的错误淹掉。
  ids="$(node_run -e 'const r=require("/w/tenants.json");const me=process.argv[1];process.stdout.write((r.tenants??[]).filter(t=>(t.node??"local")===me).map(t=>t.id).join(" "))' "${MT_NODE_NAME:-local}" 2>/dev/null | tr -d '\r')"
  for id in $ids; do
    if register_tenant "$id"; then
      ok=$((ok + 1))
    else
      failed=$((failed + 1))
    fi
  done
  echo "    已注册 ${ok} 个租户$([ "$failed" -gt 0 ] && echo "，${failed} 个失败" || true)"
  return 0
}

# 等控制面开始答话。
#
# 注册必须在网关监听之后：全新部署（离线包在目标机上的第一次 up）时网关是刚创建的，
# 注册会直接 ECONNREFUSED，于是"0 个租户注册成功"，而 up 表面上跑完了——
# 接着每个用户登录都会看到 503。现网那台是增量重建，所以这条只在第一台机器上暴露。
wait_gateway() {
  local attempt=0
  while [ "$attempt" -lt 60 ]; do
    if [ -n "$(health 2>/dev/null || true)" ]; then return 0; fi
    sleep 1
    attempt=$((attempt + 1))
  done
  echo "    !! 控制面 60 秒内没有答话（$(gw_base)/__mt/health）：bin/mt.sh logs gateway 看日志" >&2
  return 1
}

# 本机节点代理的容器名（与 render.js 的 node-agent service 一致）。
agent_container() { echo "${MT_CONTAINER_NAME_PREFIX:-mt-}node-agent"; }

# 本机的局域网地址：节点代理用它拼"控制面该来哪儿找我"的端点，控制面自己注册租户时
# 也用它（端点走代理而不是容器 bridge 地址）。排除 docker/virbr/lo，与 node-install.sh
# 的探测口径一致。
lan_ip() {
  { command -v ip >/dev/null 2>&1 &&
    ip -4 -o addr show scope global 2>/dev/null \
      | awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1 ; } || true
}

# 节点代理：up / down / status。
#
# 控制面与「有租户的节点」的 compose 里都有 node-agent 这个 service，优先用 compose 起它
# （配置在 compose 里，一处维护）；纯网关主机（备用）没有这个 service，就按同样的配置
# docker run 一个——省得现场再手抄一遍 README §1.1 里那段 docker run。
cmd_agent() {
  local action="${1:-status}"
  local name; name="$(agent_container)"
  case "$action" in
    allow)
      # 放行某个地址访问本机节点代理端口。为什么需要：浏览器的租户请求是**网关**转发到
      # http://<本机>:3199/proxy/<租户> 的，而 CentOS 的 firewalld 默认只放行 ssh。
      # 单机部署时网关与本机是同一台，连的是回环；控制面高可用之后，备用网关在另一台
      # 机器上，不提前放行它，切换过去就是 502 connect EHOSTUNREACH（实测过）。
      shift
      [ "$#" -gt 0 ] || { echo "用法: bin/mt.sh agent allow <网关地址[,网关地址...]>" >&2; return 2; }
      if ! command -v firewall-cmd >/dev/null 2>&1 || ! firewall-cmd --state >/dev/null 2>&1; then
        echo "本机没在跑 firewalld：请自行放行 $* → 本机 ${MT_AGENT_PORT:-3199}/tcp"
        return 0
      fi
      local list="$1" ip
      for ip in $(printf '%s' "$list" | tr ',' ' '); do
        firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${ip} port port=${MT_AGENT_PORT:-3199} protocol=tcp accept" >/dev/null 2>&1 || true
        echo "    放行 ${ip} -> ${MT_AGENT_PORT:-3199}/tcp"
      done
      firewall-cmd --reload >/dev/null 2>&1 || echo "    !! reload 失败，规则要等下次 reload 才生效" >&2
      ;;
    up)
      if [ -f docker-compose.yml ] && "${COMPOSE[@]}" config --services 2>/dev/null | grep -qx node-agent; then
        echo "==> 用 compose 启动节点代理（service node-agent）"
        "${COMPOSE[@]}" up -d node-agent
      else
        echo "==> 这个 hosts 的 compose 里没有 node-agent，按同样的配置 docker run"
        DOCKER_BUILDKIT=0 "${COMPOSE[@]}" build node-agent >/dev/null 2>&1 || true
        docker rm -f "$name" >/dev/null 2>&1 || true
        docker run -d --name "$name" --restart unless-stopped --network host --pid host --privileged \
          -v /var/run/docker.sock:/var/run/docker.sock:ro \
          -v "$ROOT/state:/key:ro" -v "$ROOT:$ROOT" \
          -v /usr/bin/docker:/usr/bin/docker:ro \
          -e "MT_NODE_NAME=${MT_NODE_NAME:-local}" -e "MT_NODE_ADDRESS=${MT_NODE_ADDRESS:-}" \
          -e "MT_CONTROL_PLANE=${MT_CONTROL_PLANE:-}" -e "MT_CONTROL_PLANE_CA=${MT_CONTROL_PLANE_CA:-}" \
          -e MT_REGISTRY_KEY_FILE=/key/registry.key -e MT_OPS_KEY_FILE=/key/ops.key \
          -e MT_REGISTER_KEY_FILE=/key/register.key \
          -e "MT_REGISTRY_SYNC=$([ "${MT_NODE_NAME:-local}" = local ] && echo 0 || echo 1)" \
          -e "MT_NETWORK=${MT_NETWORK:-mt-net}" \
          -e "MT_CONTAINER_NAME_PREFIX=${MT_CONTAINER_NAME_PREFIX:-mt-}" \
          -e "MT_PROJECT_DIR=$ROOT" -e "MT_DATA_ROOT=$ROOT" \
          -e "MT_AGENT_PORT=${MT_AGENT_PORT:-3199}" -e "TZ=${TZ:-Asia/Shanghai}" \
          mt-node-agent:local
      fi
      ;;
    down)   docker rm -f "$name" ;;
    status|*) docker ps -a --filter "name=^${name}$" --format '{{.Names}}\t{{.Status}}' ;;
  esac
}

# 控制面 HA 的状态集合：会话签名密钥、分用途密钥、注册表、运行时表、限速/配额意图、证书。
# 不含 logs/：两台网关各自写自己的审计，切换后历史分成两段（这是刻意的，写在文档里）。
HA_FILES=(tenants.json state/session.key state/keys.json state/registry.key state/register.key
          state/ops.key state/admin.json state/admin.key state/runtimes.json state/bandwidth.json
          state/quota.json state/tls)

# 从主网关单向拉一份状态到本机（备网关）。角色互换时把 --from 换成新的主网关即可。
cmd_ha_sync() {
  local from="" install_timer=no
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --from)          from="${2:-}"; shift 2 ;;
      --install-timer) install_timer=yes; shift ;;
      *)               shift ;;
    esac
  done
  [ -n "$from" ] || { echo "用法: bin/mt.sh ha-sync --from <主网关地址> [--install-timer]" >&2; return 2; }
  [ "$from" != "$(hostname)" ] || { echo "不能从自己同步" >&2; return 2; }

  # 用 tar 过 ssh，不用 rsync（目标机不一定装了它）；--ignore-failed-read 让"某个文件
  # 还没生成"（比如全新备用机还没有 runtimes.json）不致命。
  ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${from}" \
    "cd '${MT_HA_REMOTE_ROOT:-$ROOT}' && tar --ignore-failed-read -cf - ${HA_FILES[*]} 2>/dev/null" \
    | tar -xf - -C "$ROOT" || { echo "!! 从 ${from} 同步失败（免密 ssh 通吗？）" >&2; return 1; }
  echo "已从 ${from} 同步：${HA_FILES[*]}"

  if [ "$install_timer" = yes ]; then
    cat > /etc/systemd/system/dsh-mt-ha-sync.service <<UNIT
[Unit]
Description=DSH multi-tenant: pull control-plane state from the active gateway
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$ROOT/bin/mt.sh ha-sync --from $from
UNIT
    cat > /etc/systemd/system/dsh-mt-ha-sync.timer <<UNIT
[Unit]
Description=DSH multi-tenant: periodic control-plane state pull

[Timer]
OnBootSec=60
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
UNIT
    systemctl daemon-reload && systemctl enable --now dsh-mt-ha-sync.timer \
      && echo "已安装并启用 dsh-mt-ha-sync.timer（每 60 秒）" \
      || echo "!! systemd 单元没装上（容器里跑？这两条要在宿主机上执行）" >&2
  fi
}

# 从控制面的注册表接口取"某个节点的运行时 endpoint"（用来定位那台机器）。
node_endpoint() {
  local node="$1"
  http GET "$(gw_base)/__mt/registry" --max-time 10 2>/dev/null > "$ROOT/.ha-runtimes.json" || true
  node_run -e '
    const step = process.argv[1]
    // /__mt/registry 的应答是 {"runtimes": {<租户>: {...}}}；少解一层就会
    // 把整个表当成一条记录，于是"找不到这个节点的运行时"永远成立。
    let rows = {}
    try {
      const doc = require("/w/.ha-runtimes.json")
      rows = doc.runtimes ?? doc
    } catch { rows = {} }
    const out = []
    for (const entry of Object.values(rows)) {
      if (String(entry?.node ?? "local") !== step) continue
      if (typeof entry?.endpoint === "string") out.push(entry.endpoint)
    }
    process.stdout.write(out.join(" "))
  ' "$node" 2>/dev/null | tr -d '\r'
  rm -f "$ROOT/.ha-runtimes.json"
}

# 某个节点上代理的地址（`bin/mt.sh add` 用它开通远端租户）。
#
# 注册表里只有"租户 → 运行时 endpoint"，没有节点级的代理表，所以只能从同节点已注册
# 的运行时反推：代理固定监听 3199，endpoint 是 http://<节点地址>:3199/proxy/<租户>，
# 去掉 /proxy/… 就是代理自己。节点上一个租户都还没上报过时回答为空——那台机器要么
# 还没装代理，要么还没跑过 up，这时只能去它上面开通（新节点的第一次就是这种情况）。
node_agent_url() {
  local node="$1" endpoint
  endpoint="$(node_endpoint "$node" | tr ' ' '\n' | grep -m1 . || true)"
  [ -n "$endpoint" ] || return 0
  printf '%s' "$endpoint" | sed -E 's#/proxy/.*$##'
}

# 把一个租户从一台节点搬到另一台：停源端容器 → 搬数据 → 改注册表的 node → 目标节点 up。
#
# 为什么要脚本：手工做这四步时最常错的是"忘了改注册表"（于是控制面一直把用户往旧机器上转）
# 与"忘了在目标机上 up"（于是数据到了但没人跑它）。前置检查也在这里：目标节点必须已知
# （注册表里有它的运行记录）除非 --force；数据目录用 --remote-root 指明（两台同路径可省）。
cmd_move() {
  local tenant="" to="" to_host="" force=no remote_root="" keep_source=no
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --to)           to="${2:-}"; shift 2 ;;
      --to-host)      to_host="${2:-}"; shift 2 ;;
      --remote-root)  remote_root="${2:-}"; shift 2 ;;
      --force)        force=yes; shift ;;
      --keep-source)  keep_source=yes; shift ;;
      *)              [ -z "$tenant" ] && tenant="$1"; shift ;;
    esac
  done
  remote_root="${remote_root:-$ROOT}"
  [ -n "$tenant" ] && [ -n "$to" ] || {
    echo "用法: bin/mt.sh move <租户> --to <节点名> [--to-host <IP>] [--remote-root <路径>] [--keep-source] [--force]" >&2
    return 2
  }

  local from_node
  from_node="$(node_run -e 'const r=require("/w/tenants.json");const t=(r.tenants??[]).find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.node??"local"))' "$tenant" 2>/dev/null | tr -d '\r')"
  [ -n "$from_node" ] || { echo "注册表里没有租户 $tenant" >&2; return 1; }
  [ "$from_node" != "$to" ] || { echo "$tenant 已经在 $to 上了" >&2; return 1; }

  if [ -z "$to_host" ]; then
    to_host="$(node_endpoint "$to" | tr ' ' '\n' | head -1 | sed -E 's#^https?://([^:/]+).*#\1#')"
  fi
  [ -n "$to_host" ] || {
    echo "注册表里没有节点 $to 的运行记录（它还没上报过任何租户）：用 --to-host <IP> 指定，或先在它上面建一个租户让代理上报" >&2
    return 1
  }
  local from_host="$to_host"
  if [ "$from_node" != local ]; then
    from_host="$(node_endpoint "$from_node" | tr ' ' '\n' | head -1 | sed -E 's#^https?://([^:/]+).*#\1#')"
    [ -n "$from_host" ] || { echo "找不到节点 $from_node 的地址（它没有注册运行时？）" >&2; return 1; }
  fi

  echo "==> 停 ${from_node} 上的容器"
  if [ "$from_node" = local ]; then
    docker stop "$(docker ps -q --filter "label=mt.tenant=$tenant")" >/dev/null 2>&1 || true
  else
    ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${from_host}" \
      "docker stop \$(docker ps -q --filter 'label=mt.tenant=${tenant}') >/dev/null 2>&1 || true" || true
  fi

  echo "==> 搬数据 $tenant：${from_node} → ${to}"
  if [ "$from_node" = local ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${to_host}" "cd '$remote_root' && mkdir -p tenants" \
      && tar -cf - -C "$ROOT" "tenants/${tenant}" \
      | ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${to_host}" "cd '$remote_root' && tar -xf -" \
      || { echo "!! 数据搬运失败" >&2; return 1; }
  else
    ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${from_host}" "cd '$remote_root' && tar -cf - tenants/${tenant}" \
      | ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${to_host}" "cd '$remote_root' && tar -xf -" \
      || { echo "!! 数据搬运失败" >&2; return 1; }
  fi

  echo "==> 改注册表的 node 字段并重渲染"
  node_run bin/registry.js set-node "$tenant" "$to" || return 1
  node_run bin/render.js >/dev/null

  echo "==> 在 ${to} 上起来"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${to_host}" \
    "cd '$remote_root' && MT_NODE_NAME='$to' bin/mt.sh up" || { echo "!! 目标节点 up 失败：手工跑一次看输出" >&2; return 1; }
  # 源端那个已经停掉的容器没有用了：compose 文件里已经没有它的 service，下一次 up 也
  # 不会重建它，留着只会占 docker ps -a 与端口（doctor 会把它报成 exited 的故障）。
  # 数据目录 tenants/<租户>/ 保留：回滚就是把 set-node 改回去、再在源端 up 一次。
  echo "==> 清掉源端（${from_node}）那个已停的容器"
  if [ "$from_node" = local ]; then
    docker rm -f "$(docker ps -aq --filter "label=mt.tenant=${tenant}")" >/dev/null 2>&1 || true
  else
    ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${from_host}" \
      "docker rm -f \$(docker ps -aq --filter 'label=mt.tenant=${tenant}') >/dev/null 2>&1 || true" || true
  fi
  # 数据也要清掉：目标端已经确认起来了，而留在源端的 tenants/<租户>/ 会被源端的备份
  # 一起打进去（看起来"这台机器上有这个租户"），恢复时还会把一份过期副本铺回来。
  # 回滚不需要它——数据在目标端，再 move 回来就是了。要留着看，加 --keep-source。
  if [ "${keep_source:-no}" = yes ]; then
    echo "    --keep-source：源端数据保留在 ${from_host}:$remote_root/tenants/${tenant}/"
  else
    echo "==> 删除源端数据目录 tenants/${tenant}/（回滚＝再 move 回来）"
    if [ "$from_node" = local ]; then
      rm -rf "$ROOT/tenants/${tenant}"
    else
      ssh -o BatchMode=yes -o ConnectTimeout=10 "root@${from_host}" \
        "rm -rf '$remote_root/tenants/${tenant}'" || true
    fi
  fi
  echo "==> 完成。该租户现在跑在 ${to}（${to_host}）；用户侧不用改任何东西"
}

# 手动注册（远端节点或排查时用）。
cmd_register() {
  local id="" endpoint="" token="" node="${MT_NODE:-local}" arg
  for arg in "$@"; do
    case "$arg" in
      --endpoint=*) endpoint="${arg#*=}" ;;
      --token=*) token="${arg#*=}" ;;
      --node=*) node="${arg#*=}" ;;
      *) [ -z "$id" ] && id="$arg" ;;
    esac
  done
  if [ -z "$id" ]; then
    echo "用法: bin/mt.sh register <租户> [--endpoint=http://host:port] [--token=<启动token>] [--node=<节点名>]" >&2
    return 2
  fi
  if register_tenant "$id" "$endpoint" "$token" "$node"; then
    echo "已注册 ${id}（节点 ${node}）"
    return 0
  fi
  return 1
}

# 设置管理控制台的管理员密码。密码只以 scrypt 哈希落在 state/admin.json。
cmd_admin_passwd() {
  local password="${1:-}" confirm
  if [ -z "$password" ]; then
    printf '新管理员密码: '
    stty -echo 2>/dev/null || true
    read -r password
    stty echo 2>/dev/null || true
    echo
    printf '再输一次: '
    stty -echo 2>/dev/null || true
    read -r confirm
    stty echo 2>/dev/null || true
    echo
    if [ "$password" != "$confirm" ]; then
      echo "两次输入不一致" >&2
      return 1
    fi
  fi
  if [ ${#password} -lt 8 ]; then
    echo "密码太短（至少 8 位）" >&2
    return 1
  fi
  # 交给控制面写：它拥有 state/，而且哈希算法要和它校验时用的完全一致。
  node_run bin/admin-passwd.js "$password" | sed 's/^/  /'
}

cmd_unregister() {
  local id="${1:-}" key response
  if [ -z "$id" ]; then echo "用法: bin/mt.sh unregister <租户>" >&2; return 2; fi
  key="$(registry_key)"
  if [ -z "$key" ]; then
    echo "读不到注册密钥 ${MT_REGISTRY_KEY_FILE:-state/registry.key}（远端节点请用 MT_REGISTRY_KEY_FILE 指过去）" >&2
    return 1
  fi
  response="$(http POST "$(gw_base)/__mt/registry/unregister" \
    --header "x-mt-registry-key: ${key}" --header 'content-type: application/json' \
    --data "{\"tenant\":\"${id}\"}" --max-time 10 2>&1 || true)"
  printf '%s\n' "$response" | sed 's/^/  /'
  case "$response" in
    *'"ok":true'*) return 0 ;;
    *) return 1 ;;
  esac
}

# 列出控制面当前认识的运行时。
cmd_runtimes() {
  local body
  body="$(http GET "$(gw_base)/__mt/registry" --max-time 10 2>/dev/null || true)"
  if [ -z "$body" ]; then
    echo "控制面没有响应（bin/mt.sh status 看容器状态）" >&2
    return 1
  fi
  printf '%s' "$body" | node_run_stdin -e '
let text = ""
process.stdin.on("data", (chunk) => { text += chunk })
process.stdin.on("end", () => {
  const table = JSON.parse(text || "{}").runtimes ?? {}
  const ids = Object.keys(table).sort()
  if (ids.length === 0) {
    console.log("  还没有租户注册运行时：bin/mt.sh register <租户>")
    return
  }
  console.log("  租户       节点        地址                                     注册时间")
  for (const id of ids) {
    const entry = table[id]
    console.log(
      "  " + id.padEnd(11) +
      String(entry.node ?? "?").padEnd(12) +
      String(entry.endpoint ?? "?").padEnd(40) +
      String(entry.registeredAt ?? "").slice(0, 19),
    )
  }
})
'
}

health() { http GET "$(gw_base)/__mt/health" --max-time 10 2>/dev/null; }

# 租户出口代理的地址：mt-net 的网关 IP + 代理端口。
# 容器到宿主网关是本地投递，不需要 ip_forward；宿主到外网由宿主自己完成。
egress_proxy_url() {
  local gw
  gw="$(docker network inspect mt-net -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null | tr -d '\r')"
  # 用 if 而不是 `[ -n "$gw" ] && echo ...`：后者在条件为假时让函数返回非零，
  # 调用处会被 set -e 直接终止。
  if [ -n "$gw" ]; then
    echo "http://${gw}:${MT_EGRESS_PORT:-3128}"
  fi
  return 0
}

# 把探测到的代理地址写进 .env；地址变了就重新渲染并重建租户。
#
# 注意两处 set -e 陷阱：函数最后一条语句若是 `[ ... ] && cmd`，条件为假时函数返回非零、
# 调用处直接被终止；`x="$(grep ... | cut ...)"` 在 pipefail 下无匹配也会判失败。
# 因此这里用显式 if，并给管道补 `|| true`。
ensure_egress_proxy() {
  local url current
  url="$(egress_proxy_url)"
  if [ -z "$url" ]; then return 0; fi
  current="$(grep -E '^MT_EGRESS_PROXY=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  if [ "$current" = "$url" ]; then return 0; fi
  echo "==> 租户出口代理: ${url}（写入 .env 并重建租户）"
  if grep -qE '^MT_EGRESS_PROXY=' .env 2>/dev/null; then
    sed -i "s|^MT_EGRESS_PROXY=.*|MT_EGRESS_PROXY=${url}|" .env
  else
    printf '\n# 租户出口代理（容器到宿主网关是本地投递，无需 ip_forward）\nMT_EGRESS_PROXY=%s\n' "$url" >> .env
  fi
  node_run bin/render.js >/dev/null
  "${COMPOSE[@]}" up -d 2>&1 | tail -2
}

# 等待「全部」租户就绪。
#
# ready 由控制面给出：它逐个探测注册进来的地址，所以"就绪"现在是"真的连得上"，
# 而不是早期那种"日志里出现了启动行"。
cmd_wait() {
  if [ "${MT_NODE_NAME:-local}" != local ]; then
    echo "==> 节点 ${MT_NODE_NAME}：就绪状态由控制面观测（本机不查健康接口）"
    return 0
  fi
  echo "==> 等待租户运行时就绪"
  local ready total pending
  for _ in $(seq 1 90); do
    ready="$(health | tr -d ' \n' | grep -o '"ready":true' | wc -l | tr -d ' ')"
    total="$(health | tr -d ' \n' | grep -o '"id":"' | wc -l | tr -d ' ')"
    if [ -n "$total" ] && [ "$total" != "0" ] && [ "$ready" = "$total" ]; then
      pending=""
      break
    fi
    pending="yes"
    sleep 2
  done
  if [ -n "${pending:-}" ]; then
    echo "    !! 仍有租户未就绪（${ready:-0}/${total:-0}）：bin/mt.sh runtimes 看注册情况，bin/mt.sh logs <租户> 看运行时日志"
  fi
  health || echo "(网关还没就绪，查看 bin/mt.sh logs gateway)"
  echo
}

# 等待单个租户就绪，用于重启某一个租户之后。
# 模式里允许 id 与 ready 之间存在其它字段（例如 container/endpoint），否则会误判。
wait_tenant_ready() {
  local id="$1" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    if health | tr -d ' \n' | grep -qE "\"id\":\"${id}\"[^}]*\"ready\":true"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cmd_url() {
  local ip scheme port
  # `ip` 不一定在：节点代理的容器里就没有，而且它是动态链接的、挂进 Debian 容器也跑不起来。
  # 入口地址只是给人看的，拿不到就用回环地址，不能让整条 up 因此失败。
  ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1 || true)"
  fi
  port="${MT_EDGE_PORT:-8090}"
  if [ -f state/tls/server.crt ] || [ -n "${MT_TLS_CERT:-}" ]; then scheme="https"; else scheme="http"; fi
  echo "==> 入口"
  # 节点没有网关，本机不对外提供任何入口：真正的入口在控制面（或前端）那一台。
  # 照抄 entry-urls.txt 会把"192.168.122.138:8090 统一登录入口"这种不存在的地址
  # 打印出来——那是控制面的地址，不是这台机器的。
  if [ "${MT_NODE_NAME:-local}" != local ] && [ "${MT_CONTROL_PLANE_STANDBY:-}" != "1" ]; then
    echo "    本机是节点 ${MT_NODE_NAME}：不提供租户入口，入口在控制面那一台"
    [ -n "${MT_CONTROL_PLANE:-}" ] && echo "    控制面: ${MT_CONTROL_PLANE}（租户地址由它按会话跳转）"
    return 0
  fi
  if [ -f entry-urls.txt ]; then
    # 模板里写的是 ${MT_EDGE_PORT:-8090} 这种形式，默认值可能与本部署实际端口不同，
    # 所以替换要匹配任意默认值，否则打印出来的地址会原样带着未展开的变量。
    local url_lines
    url_lines="$(sed -e "s|\${IP}|${ip:-127.0.0.1}|g" -e "s|\${MT_EDGE_PORT:-[0-9]*}|${port}|g" -e "s|http://|${scheme}://|g" entry-urls.txt)"
    if [ "${MT_CONTROL_PLANE_STANDBY:-}" = "1" ]; then
      # 备用网关只服务共享入口：每租户的专属入口端口只开在主网关上，切换过去之后
      # 它们不存在（共享入口按会话路由，不受影响）。只打印第一行，避免把不存在的
      # 地址列出来。
      printf '%s\n' "$url_lines" | sed -n '1p'
      printf '    备用网关不监听各租户的专属入口端口（那些只在主网关上）；共享入口照常按会话路由\\n'
    else
      printf '%s\n' "$url_lines"
    fi
  else
    echo "    ${scheme}://${ip:-127.0.0.1}:${port}/"
  fi
  if [ "$scheme" = https ]; then
    echo "    本机运维入口（明文，仅 loopback）: http://127.0.0.1:${MT_HTTP_PORT:-8099}/"
  fi
}

cmd_status() { "${COMPOSE[@]}" ps; echo; cmd_wait; }

cmd_logs() {
  if [ -n "${1:-}" ]; then
    docker logs -f --tail 80 "$(tenant_container "$1")"
  else
    docker logs -f --tail 80 mt-gateway
  fi
}

cmd_restart() {
  local id="${1:-}"
  if [ -n "$id" ]; then
    docker restart "$(tenant_container "$id")"
    # 重启后容器地址可能变，控制面只认注册表，所以必须重新注册。
    register_tenant "$id"
    wait_tenant_ready "$id" 60 || echo "    !! ${id} 未在预期时间内就绪" >&2
  else
    "${COMPOSE[@]}" restart
    register_all_tenants
    cmd_wait
  fi
}

cmd_key() {
  local tenant="${1:-}" value="${2:-}"
  if [ -z "$tenant" ]; then
    echo "用法: bin/mt.sh key <租户> <值>" >&2
    echo "  给某个租户设置模型 key（写进 .env 的 MT_<租户>_GATEWAY_API_KEY，然后 bin/mt.sh model 生效）" >&2
    return 2
  fi
  if [ -z "$value" ]; then
    local current
    # `|| true`：grep 无匹配时管道在 pipefail 下返回 1，赋值失败会让脚本直接退出，
    # 走不到下面那行提示。
    current="$(grep "^MT_$(echo "$tenant" | tr '[:lower:]-' '[:upper:]_')_GATEWAY_API_KEY=" .env 2>/dev/null | head -1 || true)"
    if [ -n "$current" ]; then
      echo "  ${tenant} 当前: ${current%%=*}=<已设置，${#current} 字符>（要改：bin/mt.sh key ${tenant} <新值>）"
    else
      echo "  ${tenant} 还没有 key 槽位（先 bin/mt.sh add ${tenant}）" >&2
      return 1
    fi
    return 0
  fi
  local key="MT_$(echo "$tenant" | tr '[:lower:]-' '[:upper:]_')_GATEWAY_API_KEY"
  if ! grep -q "^${key}=" .env; then
    echo "没有这个租户的 key 槽位（先 bin/mt.sh add ${tenant}）" >&2
    exit 1
  fi
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env > .env.tmp && mv .env.tmp .env
  chmod 600 .env
  echo "已写入 ${key}；执行 bin/mt.sh up 生效"
}

cmd_smoke() { bash bin/smoke.sh "$@"; }

cmd_accept() { bash bin/accept.sh "$@"; }

# 移除租户：从注册表删掉 → 停止并删除容器 → 默认保留数据目录。
# 网关会热加载并摘掉该租户（含它的专属端口监听），不需要重启。
#   bin/mt.sh remove <id>           只摘除运行与注册，数据留在 tenants/<id>/
#   bin/mt.sh remove <id> --purge   连数据一起删除（不可恢复，先确保有备份）
cmd_remove() {
  local id="" purge=no arg
  for arg in "$@"; do
    case "$arg" in
      --purge) purge=yes ;;
      *) [ -z "$id" ] && id="$arg" ;;
    esac
  done
  [ -n "$id" ] || { echo "用法: bin/mt.sh remove <租户> [--purge]" >&2; return 2; }

  local container
  container="$(node_run -e 'const r=require("/w/tenants.json");const t=r.tenants.find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.container ?? ("mt-dsh-"+t.id)))' "$id" 2>/dev/null | tr -d '\r')"
  [ -n "$container" ] || container="${MT_CONTAINER_NAME_PREFIX:-mt-}dsh-$id"

  node_run bin/registry.js remove "$id" || return 1

  # 该租户在 .env 里的模型凭据键要一起清掉：留着就是"已删租户的残留键"，
  # doctor 会一直报，而没人会记得手工删。命名规则跟 bin/render.js 的 envKeyFor 一致
  # （id 全大写、短横线换成下划线）。
  env_prefix="MT_$(printf '%s' "$id" | tr '[:lower:]' '[:upper:]' | sed 's/-/_/g')_"
  if grep -q "^${env_prefix}" .env 2>/dev/null; then
    PRUNE_TMP="$(mktemp)"
    chmod 600 "$PRUNE_TMP"
    grep -v "^${env_prefix}" .env > "$PRUNE_TMP" && cat "$PRUNE_TMP" > .env
    rm -f "$PRUNE_TMP"
    echo "    已清掉 .env 里该租户的键（${env_prefix}*）"
  fi

  node_run bin/render.js >/dev/null

  # 直接按容器名删，不走 compose：重渲染后目标 service 已从 compose 文件里消失。
  echo "==> 停止并删除容器 ${container}"
  docker rm -f "$container" >/dev/null 2>&1 || true

  if [ "$purge" = yes ]; then
    echo "==> 删除数据目录 tenants/${id}/"
    rm -rf "tenants/${id}"
  else
    echo "    数据保留在 tenants/${id}/（要删除加 --purge）"
  fi

  # 该租户的网络要一起收掉：重新渲染后 compose 不再引用它，但 Docker 不会自己删，
  # 而模型网关仍接在上面（它接入了每一张租户网络），于是会留下一个没有租户、却挂着
  # 网关端点的孤儿网络。顺序很重要：必须等容器删掉之后再断网关、再删网络。
  tenant_net="${MT_NETWORK:-mt-net}-${id}"
  if docker network inspect "$tenant_net" >/dev/null 2>&1; then
    docker network disconnect --force "$tenant_net" "${MT_CONTAINER_NAME_PREFIX:-mt-}model-gateway" >/dev/null 2>&1 || true
    if docker network rm "$tenant_net" >/dev/null 2>&1; then
      echo "    已删除该租户的网络 ${tenant_net}"
    else
      echo "    网络 ${tenant_net} 仍被占用（下次 bin/mt.sh up 会把网关重新接好）"
    fi
  fi
  echo "    网关会在 2 秒内摘掉该租户，无需重启"
  return 0
}

# 一条命令开通新租户：注册 → 渲染 → 放行端口 → 只启动这个租户 → 等就绪 → 打印凭据与入口。
#
# 不重启网关：网关监听 tenants.json 的变化并热加载（2 秒轮询），因此已有租户的连接不受影响。
# 只 up 这一个 service，不碰其它正在运行的租户。
cmd_add() {
  local no_start=no
  local args=()
  local arg
  for arg in "$@"; do
    if [ "$arg" = "--no-start" ]; then no_start=yes; else args+=("$arg"); fi
  done

  local out id
  out="$(node_run bin/registry.js add "${args[@]}")" || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out"
  # 只取 id：打印行是 `added tenant <id> (node: <node>)`，整串当成 id 会让下面
  # 取 edgePort / service 全部落空（曾经如此），于是"开通"其实一个容器都没起。
  id="$(printf '%s\n' "$out" | sed -n 's/^added tenant \([^ ]*\).*/\1/p' | head -1)"
  [ -n "$id" ] || { echo "无法从输出里解析租户 id" >&2; return 1; }

  node_run bin/render.js >/dev/null
  ensure_egress_proxy
  # 网络限速是运行时状态，容器一重建就没了；容器起好之后按 state/bandwidth.json 恢复。
  # 失败只提示：限速不是可用性的前提，不该让 up 半途而废（可用 bandwidth show 查）。
  bash bin/bandwidth.sh apply || echo "    !! 网络限速未恢复，执行 bin/mt.sh bandwidth apply 查看"

  local edge service
  edge="$(node_run -e 'const r=require("/w/tenants.json");const t=r.tenants.find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.edgePort ?? ""))' "$id" 2>/dev/null | tr -d '\r')"
  service="$(node_run -e 'const r=require("/w/tenants.json");const t=r.tenants.find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.service ?? ("dsh-"+t.id)))' "$id" 2>/dev/null | tr -d '\r')"
  local tenant_node
  tenant_node="$(node_run -e 'const r=require("/w/tenants.json");const t=r.tenants.find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.node ?? "local"))' "$id" 2>/dev/null | tr -d '\r')"

  if [ "$no_start" = yes ]; then
    echo
    echo "==> 已注册（--no-start）；执行 bin/mt.sh up 可一起启动。"
    return 0
  fi

  if [ -n "$edge" ] && command -v firewall-cmd >/dev/null 2>&1; then
    echo "==> 防火墙放行 ${edge}/tcp"
    firewall-cmd --permanent --add-port="${edge}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi

  if [ "$tenant_node" != local ]; then
    # 容器住在别的机器上，控制面的 compose 里没有这个 service（`up -d dsh-n2t`
    # 只会打印 no such service）。两条路：那台机器上已经有代理上报过租户，就叫它
    # 开通（控制台走的是同一个 /provision：拉注册表 → 本机 up）；还没有代理，就
    # 只能去那台机器上跑一次 up——这正是新节点的第一次。
    echo "==> ${id} 分配给节点 ${tenant_node}：容器由那台机器创建，控制面只登记与路由"
    local agent_url=""
    agent_url="$(node_agent_url "$tenant_node")"
    if [ -n "$agent_url" ]; then
      echo "==> 让 ${tenant_node} 的代理开通（它先刷新注册表，再在那里 up）"
      if http POST "${agent_url}/provision" --header "x-mt-registry-key: $(registry_key)" \
           --max-time 600 --fail >/dev/null 2>&1; then
        echo "    ${tenant_node} 已开通 ${id}"
      else
        echo "    !! 代理开通失败：到 ${tenant_node} 上执行 bin/mt.sh up 看输出" >&2
      fi
    else
      echo "    节点 ${tenant_node} 还没有代理上报过任何租户，控制面找不到它的地址。"
      echo "    到 ${tenant_node} 上执行： bin/mt.sh up    （它会先从控制面刷新注册表）"
    fi
  else
    echo "==> 启动租户 ${id}（只动这一个 service）"
    "${COMPOSE[@]}" up -d "$service" 2>&1 | tail -2

    # 控制面只看注册表，新租户必须先注册（等它打出启动 token）。
    register_tenant "$id"
    if wait_tenant_ready "$id" 60; then
      echo "    ${id} 已就绪"
    else
      echo "    !! ${id} 未在预期时间内就绪，查看 bin/mt.sh logs ${id}" >&2
    fi
  fi

  local ip port
  # 同 cmd_url：`ip` 可能不在（节点代理容器），拿不到就用回环地址，不影响开通结果。
  ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1 || true)"
  fi
  port="${MT_EDGE_PORT:-8090}"
  echo
  echo "==> 租户 ${id} 开通完成"
  printf '%s\n' "$out" | grep -E '(user|password):' | sed 's/^/  /'
  echo "    统一入口 : http://${ip:-127.0.0.1}:${port}/   （只填用户名+密码）"
  if [ -n "$edge" ]; then
    echo "    专属入口 : http://${ip:-127.0.0.1}:${edge}/"
  fi
  return 0
}

cmd_add_batch() {
  local file="" no_start=no creds="" extra=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-start)         no_start=yes; shift ;;
      --credentials-file) creds="${2:-}"; shift 2 ;;
      # 其余按原样转给 bin/registry.js（--derive-id / --no-edge-port / --node）。
      --node)             extra+=("--node" "${2:-}"); shift 2 ;;
      --derive-id|--no-edge-port) extra+=("$1"); shift ;;
      *)                  [ -z "$file" ] && file="$1"; shift ;;
    esac
  done
  [ -n "$file" ] || {
    echo "用法: bin/mt.sh add-batch <清单.csv> [--derive-id] [--no-start] [--credentials-file <路径>]" >&2
    echo "  每行一个租户；# 开头与空行忽略。两种写法：" >&2
    echo "    id,用户名[,标题[,初始口令]]     有租户 id 时" >&2
    echo "    用户名,姓名[,初始口令]          加 --derive-id，租户 id 由用户名推导（liuy_1 → liuy-1）" >&2
    echo "  用户名用 Key 里的账号名（Key 免口令登录按用户名找租户）。" >&2
    return 2
  }
  [ -f "$file" ] || { echo "找不到清单文件: $file" >&2; return 2; }

  # registry.js 跑在容器里，只看得见项目目录；清单在别处就先拷进来，跑完删掉。
  # 路径一律先取绝对值再算"相对项目目录"——调用者给的是相对路径（`tenants.csv`）时，
  # 直接拼 `.$file` 会得到 `.tenants.csv`（实测踩过：容器里打开这个文件名直接 ENOENT）。
  local absolute cleanup=no
  absolute="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  case "$absolute" in
    "$ROOT"/*) ;;
    *)
      cp "$file" "$ROOT/.add-batch.csv" && chmod 600 "$ROOT/.add-batch.csv"
      absolute="$ROOT/.add-batch.csv"
      cleanup=yes
      ;;
  esac

  local out
  out="$(node_run bin/registry.js add-batch "./${absolute#"$ROOT"/}" ${extra[@]+"${extra[@]}"})" || {
    printf '%s\n' "$out"
    [ "$cleanup" = yes ] && rm -f "$ROOT/.add-batch.csv"
    return 1
  }
  printf '%s\n' "$out"
  [ "$cleanup" = yes ] && rm -f "$ROOT/.add-batch.csv"

  # 清单没给口令的租户拿到的是随机口令，只有这一次能看见。要发下去就写个 0600 的文件，
  # 形状与 bin/acceptance.sh 读的凭据文件一致，可以直接当它用（里面有明文，别进备份）。
  if [ -n "$creds" ]; then
    {
      printf '{\n  "tenants": {'
      printf '%s\n' "$out" | awk -F'\t' '
        /^  [a-z0-9-]+\t/ {
          id = $1; gsub(/^ +/, "", id)
          printf "%s\n    \"%s\": { \"user\": \"%s\", \"password\": \"%s\" }", (n++ ? "," : ""), id, $2, $3
        }
        END { if (n) printf "\n" }
      '
      printf '  }\n}\n'
    } > "$creds"
    chmod 600 "$creds"
    echo
    echo "==> 凭据已写入 ${creds}（0600，含明文口令；不要放进备份或版本库）"
    echo "    把它放到部署目录下的 .acceptance-credentials.json 即可直接跑 bin/acceptance.sh"
  fi

  node_run bin/render.js >/dev/null
  ensure_egress_proxy

  if [ "$no_start" = yes ]; then
    echo
    echo "==> 已注册（--no-start）；执行 bin/mt.sh up 可一起启动。"
    return 0
  fi

  echo "==> 建立租户网络并启动全部租户"
  "${COMPOSE[@]}" up -d 2>&1 | tail -3
  register_all_tenants
  cmd_wait
  # 限速是运行时状态，容器一重建就没了；按 state/bandwidth.json 重放。
  bash bin/bandwidth.sh apply || echo "    !! 网络限速未恢复，执行 bin/mt.sh bandwidth apply 查看"
  cmd_url
}

# 把根目录的 model.patch.yml / model.env 应用到所有租户并重启它们。
# 容器的环境变量来自 model.env，profile patch 来自 model.patch.yml 的标记块。
cmd_model() {
  node_run bin/render.js
  "${COMPOSE[@]}" up -d
  local id
  for id in $(grep -o '"id": *"[^"]*"' tenants.json 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' || true); do
    docker restart "$(tenant_container "$id")" >/dev/null
  done
  # 重启后容器地址可能变，控制面只认注册表，所以统一重新注册。
  register_all_tenants
  cmd_wait
  echo "==> 模型配置已应用到全部租户"
}

case "${1:-}" in
  up)      shift; cmd_up "${1:-}" ;;
  down)    require_render; "${COMPOSE[@]}" down ;;
  restart) shift; cmd_restart "${1:-}" ;;
  ps)      require_render; "${COMPOSE[@]}" ps ;;
  status)  require_render; cmd_status ;;
  logs)    shift; cmd_logs "${1:-}" ;;
  url)     cmd_url ;;
  wait)    cmd_wait ;;
  smoke)   shift; cmd_smoke "$@" ;;
  accept)  shift; cmd_accept "$@" ;;
  doctor)  bash bin/doctor.sh ;;
  mount-check)
    # 校验一个入口 URL 是不是真的按浏览器的方式工作（前置代理的子路径、
    # Host 是否带端口、Upgrade 有没有转发）。不带参数就查本机公开入口。
    shift
    _has_url=""
    for _a in "$@"; do
      case "$_a" in http://*|https://*) _has_url=1 ;; esac
    done
    if [ -z "$_has_url" ]; then
      _scheme="http"; [ -f state/tls/server.crt ] && _scheme="https"
      _default="$_scheme://127.0.0.1:${MT_EDGE_PORT:-8090}${MT_BASE_PATH:-}/"
      # 本机入口用的是本部署自签的证书，容器里没有它的 CA：这会儿只关心"地址对不对"，
      # 证书校验留给你们内网那台（配了 CA 或按需加 --insecure）。
      if [ "$_scheme" = "https" ]; then set -- "$_default" --insecure "$@"; else set -- "$_default" "$@"; fi
    fi
    # 不能用 node_run：它不带 --network host，容器里的 127.0.0.1 是容器自己。
    docker run --rm --network host -v "$ROOT:/w" -w /w "$NODE_IMAGE" node bin/mount-check.mjs "$@"
    ;;
  isolate) shift; bash bin/isolate.sh "$@" ;;   # 限制租户可访问的宿主端口（apply/remove/status/install-boot）
  register)
    # 不带租户 = 注册全部。以前是打印用法然后退出 0 —— 看起来像成功，
    # 实际什么都没做。我在恢复步骤里正是这么用的，结果注册表留在了已经停掉的
    # 第二个节点上，四个租户全部不可用。一个会在成功时什么也不做的命令，
    # 在出故障的时候最危险，所以让它做那件显然该做的事。
    if [ "$#" -le 1 ]; then
      register_all_tenants
    else
      shift; cmd_register "$@"
    fi
    ;;
  admin-passwd) shift; cmd_admin_passwd "$@" ;; # 设置管理控制台的管理员密码（同时吊销已登录会话）
  admin-kick) shift; node_run bin/admin-kick.js ;;    # 只吊销所有管理员会话，不改密码
  admin-users) shift; node_run bin/admin-users.js "$@" ;;  # 管理员与角色：list/add/passwd/remove
  admin-mfa) shift; node_run bin/admin-mfa.js "$@" ;;      # 管理员两步验证：setup/confirm/status/remove
  alert-sink) shift; bash bin/alert-sink.sh "$@" ;;              # 告警接收器：up/wire/test/status
  quota)   shift; bash bin/quota.sh "$@" ;;                     # 每租户磁盘配额：show/set/clear/check
  acceptance) shift; bash bin/acceptance.sh "$@" ;;            # 部署验收（--self-test / --quick）
  bandwidth) shift; bash bin/bandwidth.sh "$@" ;;                # 租户网络限速：show/set/clear
  keys)    shift; node_run bin/keys.js "$@" ;;                     # 生成/查看分用途密钥
  usage)   shift; node_run bin/usage.js "$@" ;;                  # 每租户模型用量（不带费率）
  export)  shift; node_run bin/tenant-transfer.js export "$@" ;;   # 导出一个租户（移交归档）
  import)  shift; node_run bin/tenant-transfer.js import "$@" ;;   # 从归档导入一个租户
  admin-add)   shift; node_run bin/admin-users.js add "$@" ;;
  admin-remove) shift; node_run bin/admin-users.js remove "$@" ;;
  unregister) shift; cmd_unregister "$@" ;;     # 让控制面忘掉某个租户的运行时
  agent)   shift; cmd_agent "$@" ;;               # 节点代理：up/down/status（控制面与节点共用）
  ha-sync) shift; cmd_ha_sync "$@" ;;             # 控制面 HA：从主网关单向同步状态
  move)    shift; cmd_move "$@" ;;                # 把一个租户搬到另一台节点
  runtimes)   cmd_runtimes ;;                   # 列出控制面当前认识的运行时
  usage)   shift; bash bin/usage.sh "$@" ;;     # 按租户汇总模型用量（--tenant/--tail）
  cert)    shift; bash bin/make-cert.sh "$@" ;;   # 生成自签证书；之后 bin/mt.sh up 切到 HTTPS
  backup)  shift; bash bin/backup.sh "$@" ;;
  restore) shift; bash bin/restore.sh "$@" ;;
  publish-image) shift; bash bin/publish-image.sh "$@" ;;
  model)   cmd_model ;;
  render)  shift; node_run bin/render.js "$@" ;;
  list)    node_run bin/registry.js list ;;
  add)     shift; cmd_add "$@" ;;
  add-batch) shift; cmd_add_batch "$@" ;;
  passwd)  shift; node_run bin/registry.js passwd "$@"; node_run bin/render.js ;;
  kick)    shift; node_run bin/registry.js kick "$@" ;;   # 让某租户（或某用户）已登录的会话失效
  limit)   shift; node_run bin/registry.js limit "$@" ;;  # 设置/查看某租户的模型限额
  registry-push) shift; bash bin/registry-push.sh "$@" ;;  # 把镜像推进内网仓库（离线环境用）
  disk)    shift; bash bin/disk.sh "$@" ;;                 # 磁盘现状与会话/镜像回收
  wire-prometheus) shift; bash bin/wire-prometheus.sh "$@" ;;  # 把告警接进本机 Prometheus
  upgrade) shift; bash bin/upgrade.sh "$@" ;;              # 滚动升级租户运行时镜像
  remove)  shift; cmd_remove "$@" ;;
  key)     shift; cmd_key "$@" ;;
  *)       echo "未知命令: ${1:-}" >&2; sed -n '/^#   bin\/mt.sh/,/^#$/p' "$0" | sed 's/^#   /  /; s/^#$//' >&2; exit 2 ;;
esac
