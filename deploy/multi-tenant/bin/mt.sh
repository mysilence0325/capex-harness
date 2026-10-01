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
#   bin/mt.sh passwd <id> <user> set a tenant password
#   bin/mt.sh remove <id>        remove a tenant from the registry
#   bin/mt.sh key <id> <value>   set a tenant's model key in .env
#   bin/mt.sh model              apply model.patch.yml + model.env to every tenant and restart them
#   bin/mt.sh render             re-render docker-compose.yml from tenants.json
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

node_run() { docker run --rm -v "$ROOT:/w" -w /w "$NODE_IMAGE" node "$@"; }

require_render() {
  if [ ! -f docker-compose.yml ]; then
    echo "==> 首次运行，先渲染 docker-compose.yml"
    node_run bin/render.js
  fi
}

cmd_up() {
  node_run bin/render.js "${1:-}"
  echo "==> 构建镜像并启动"
  # 经典构建器：本机 Docker Hub 不可达，buildkit 会去远端解析基础镜像元数据而失败，
  # 经典构建器直接使用本地已有的 node:22-bookworm-slim。
  DOCKER_BUILDKIT=0 "${COMPOSE[@]}" build gateway egress-proxy
  "${COMPOSE[@]}" up -d
  # 网络建立后才能探测到网关地址；首次运行或网段变化时补上租户出口代理。
  ensure_egress_proxy
  # 收紧租户容器对宿主端口的访问；失败只提示，不让 up 半途而废（doctor 会报出来）。
  bash bin/isolate.sh apply || echo "    !! 租户隔离规则未应用，执行 bin/isolate.sh status 查看"
  # 重建容器会换掉租户的 bridge 地址，网关缓存里可能还是旧的；重启一次让它从零开始。
  docker restart mt-gateway >/dev/null 2>&1 || true
  cmd_wait
  cmd_url
}

# 脚本自己访问网关用的地址：TLS 开着时公开端口是 HTTPS，本机脚本改走 loopback 明文运维端口。
gw_base() {
  if [ -f state/tls/server.crt ] || [ -n "${MT_TLS_CERT:-}" ]; then
    echo "http://127.0.0.1:${MT_HTTP_PORT:-8099}"
  else
    echo "http://127.0.0.1:${MT_EDGE_PORT:-8090}"
  fi
}

health() { curl -fsS "$(gw_base)/__mt/health" 2>/dev/null; }

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

# 某个租户的运行时是否真的在接受连接。
#
# DSH 在 stdout 打出 "dsh web: http://…" 那行之后才绑定端口，网关健康接口的 ready
# 只看那行日志，因此刚重启完的一小段时间里它会说 ready 而连接仍被拒（502）。
# 这里直接连一次它的内部端口：任何 HTTP 状态（401/403 都是 DSH 的正常拒绝）都算在监听。
tenant_listening() {
  local id="$1" ip port code
  ip="$(docker inspect "mt-dsh-${id}" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null)"
  if [ -z "$ip" ]; then return 1; fi
  port="$(node_run -e 'const r=require("/w/tenants.json");const t=r.tenants.find(x=>x.id===process.argv[1]);process.stdout.write(String(t?.internalPort ?? ""))' "$id" 2>/dev/null | tr -d '\r')"
  if [ -z "$port" ]; then return 1; fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://${ip}:${port}/" 2>/dev/null || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then return 0; fi
  return 1
}

# 等待「全部」租户真的可服务：既要网关认为就绪，也要端口真的在监听。
cmd_wait() {
  echo "==> 等待租户运行时就绪"
  local ids ready total id pending
  ids="$(node_run -e 'const r=require("/w/tenants.json");process.stdout.write(r.tenants.map(t=>t.id).join(" "))' 2>/dev/null | tr -d '\r')"
  for _ in $(seq 1 90); do
    ready="$(health | tr -d ' \n' | grep -o '"ready":true' | wc -l | tr -d ' ')"
    total="$(health | tr -d ' \n' | grep -o '"id":"' | wc -l | tr -d ' ')"
    pending=""
    if [ -n "$total" ] && [ "$total" != "0" ] && [ "$ready" = "$total" ]; then
      for id in $ids; do
        if ! tenant_listening "$id"; then pending="$pending $id"; fi
      done
      if [ -z "$pending" ]; then break; fi
    fi
    sleep 2
  done
  if [ -n "${pending:-}" ]; then
    echo "    !! 以下租户仍在启动（端口尚未监听）:$pending"
  fi
  health || echo "(网关还没就绪，查看 bin/mt.sh logs)"
  echo
}

# 等待单个租户就绪，用于重启某一个租户之后。
# 模式里允许 id 与 ready 之间存在其它字段（例如 container），否则会把已就绪的租户误判为未就绪。
wait_tenant_ready() {
  local id="$1" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    if health | tr -d ' \n' | grep -qE "\"id\":\"${id}\"[^}]*\"ready\":true" && tenant_listening "$id"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cmd_url() {
  local ip scheme port
  ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1)"
  port="${MT_EDGE_PORT:-8090}"
  if [ -f state/tls/server.crt ] || [ -n "${MT_TLS_CERT:-}" ]; then scheme="https"; else scheme="http"; fi
  echo "==> 入口"
  if [ -f entry-urls.txt ]; then
    sed -e "s|\${IP}|${ip:-127.0.0.1}|g" -e "s|\${MT_EDGE_PORT:-${port}}|${port}|g" -e "s|http://|${scheme}://|g" entry-urls.txt
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
    docker logs -f --tail 80 "mt-dsh-${1}"
  else
    docker logs -f --tail 80 mt-gateway
  fi
}

cmd_restart() {
  if [ -n "${1:-}" ]; then
    docker restart "mt-dsh-${1}"
  else
    "${COMPOSE[@]}" restart
  fi
}

cmd_key() {
  local tenant="$1" value="$2"
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
  [ -n "$container" ] || container="mt-dsh-$id"

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

  if wait_tenant_ready "$id" 60; then
    echo "    ${id} 已就绪"
  else
    echo "    !! ${id} 未在预期时间内就绪，查看 bin/mt.sh logs ${id}" >&2
  fi

  local ip port
  ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1)"
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
    docker restart "mt-dsh-${id}" >/dev/null
  done
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
  cert)    shift; bash bin/make-cert.sh "$@" ;;   # 生成自签证书；之后 bin/mt.sh up 切到 HTTPS
  backup)  shift; bash bin/backup.sh "$@" ;;
  restore) shift; bash bin/restore.sh "$@" ;;
  publish-image) shift; bash bin/publish-image.sh "$@" ;;
  model)   cmd_model ;;
  render)  shift; node_run bin/render.js "$@" ;;
  list)    node_run bin/registry.js list ;;
  add)     shift; cmd_add "$@" ;;
  passwd)  shift; node_run bin/registry.js passwd "$@"; node_run bin/render.js ;;
  remove)  shift; cmd_remove "$@" ;;
  key)     shift; cmd_key "$@" ;;
  *)       sed -n '2,22p' "$0" ;;
esac
