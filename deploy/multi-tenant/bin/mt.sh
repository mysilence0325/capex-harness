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
#   bin/mt.sh cert [额外SAN]     generate a self-signed certificate; then bin/mt.sh up serves HTTPS
#   bin/mt.sh backup [args]      back up every tenant's data + control-plane state
#   bin/mt.sh restore <archive>  restore a backup (current data is moved aside, not deleted)
#   bin/mt.sh publish-image      build the runtime image from an uploaded local-source overlay
#   bin/mt.sh list               list tenants from the registry
#   bin/mt.sh add <id> [...]     add a tenant (see bin/registry.js)
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
#   bin/mt.sh usage [--days N] [--csv|--json]   per-tenant model usage, no rates
#   bin/mt.sh export <tenant>    write a portable archive of one tenant
#   bin/mt.sh import <archive> --as <id>   bring one in with fresh ports and names
#   bin/mt.sh admin-add <name> --role viewer   add a read-only administrator
#   bin/mt.sh wire-prometheus    wire the alert rules into this host's Prometheus
#   bin/mt.sh register <id>      register a tenant runtime with the control plane
#   bin/mt.sh unregister <id>    make the control plane forget a tenant runtime
#   bin/mt.sh runtimes           list the runtimes the control plane knows about
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
  # 老租户可能还没有占位 key；先补发，否则渲染出来的租户没有模型凭据。
  node_run bin/registry.js ensure-model-keys | sed "s/^/    /"
  node_run bin/render.js "${1:-}"
  echo "==> 构建镜像并启动（本机节点名: ${this_node}）"
  # 经典构建器：本机 Docker Hub 不可达，buildkit 会去远端解析基础镜像元数据而失败，
  # 经典构建器直接使用本地已有的 node:22-bookworm-slim。
  # 网关只在控制面上有；worker 节点的 compose 里没有这个 service，构建它会失败。
  if [ "$this_node" = local ]; then
    DOCKER_BUILDKIT=0 "${COMPOSE[@]}" build gateway egress-proxy model-gateway
  else
    DOCKER_BUILDKIT=0 "${COMPOSE[@]}" build egress-proxy model-gateway
  fi
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
    register_all_tenants
  else
    # 节点：不自己注册，交给本机节点代理——它随容器变化持续重报，而 up 只跑一次。
    echo "==> 本节点是 ${this_node}：运行时由节点代理上报（在控制面用 bin/mt.sh runtimes 查看）"
  fi
  cmd_wait
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
    endpoint="http://${ip}:${port}"
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
  ids="$(node_run -e 'const r=require("/w/tenants.json");process.stdout.write((r.tenants??[]).map(t=>t.id).join(" "))' 2>/dev/null | tr -d '\r')"
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
  if [ -f entry-urls.txt ]; then
    # 模板里写的是 ${MT_EDGE_PORT:-8090} 这种形式，默认值可能与本部署实际端口不同，
    # 所以替换要匹配任意默认值，否则打印出来的地址会原样带着未展开的变量。
    sed -e "s|\${IP}|${ip:-127.0.0.1}|g" -e "s|\${MT_EDGE_PORT:-[0-9]*}|${port}|g" -e "s|http://|${scheme}://|g" entry-urls.txt
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
  id="$(printf '%s\n' "$out" | sed -n 's/^added tenant //p' | head -1)"
  [ -n "$id" ] || { echo "无法从输出里解析租户 id" >&2; return 1; }

  node_run bin/render.js >/dev/null
  ensure_egress_proxy

  local edge service
  edge="$(node_run -e 'const r=require("/w/tenants.json");const t=r.tenants.find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.edgePort ?? ""))' "$id" 2>/dev/null | tr -d '\r')"
  service="$(node_run -e 'const r=require("/w/tenants.json");const t=r.tenants.find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.service ?? ("dsh-"+t.id)))' "$id" 2>/dev/null | tr -d '\r')"

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

  echo "==> 启动租户 ${id}（只动这一个 service）"
  "${COMPOSE[@]}" up -d "$service" 2>&1 | tail -2

  # 控制面只看注册表，新租户必须先注册（等它打出启动 token）。
  register_tenant "$id"
  if wait_tenant_ready "$id" 60; then
    echo "    ${id} 已就绪"
  else
    echo "    !! ${id} 未在预期时间内就绪，查看 bin/mt.sh logs ${id}" >&2
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
  isolate) shift; bash bin/isolate.sh "$@" ;;   # 限制租户可访问的宿主端口（apply/remove/status）
  register)   shift; cmd_register "$@" ;;       # 向控制面注册租户运行时（地址 + 启动 token）
  admin-passwd) shift; cmd_admin_passwd "$@" ;; # 设置管理控制台的管理员密码（同时吊销已登录会话）
  admin-kick) shift; node_run bin/admin-kick.js ;;    # 只吊销所有管理员会话，不改密码
  admin-users) shift; node_run bin/admin-users.js "$@" ;;  # 管理员与角色：list/add/passwd/remove
  usage)   shift; node_run bin/usage.js "$@" ;;                  # 每租户模型用量（不带费率）
  export)  shift; node_run bin/tenant-transfer.js export "$@" ;;   # 导出一个租户（移交归档）
  import)  shift; node_run bin/tenant-transfer.js import "$@" ;;   # 从归档导入一个租户
  admin-add)   shift; node_run bin/admin-users.js add "$@" ;;
  admin-remove) shift; node_run bin/admin-users.js remove "$@" ;;
  unregister) shift; cmd_unregister "$@" ;;     # 让控制面忘掉某个租户的运行时
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
