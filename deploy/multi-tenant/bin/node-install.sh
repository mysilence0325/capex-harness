#!/usr/bin/env bash
# 把一台机器接进这套部署：加一个**节点**（跑租户），或加一个**备用网关**。
#
#   # 节点（跑租户）
#   bin/node-install.sh --node node2 --control-plane https://192.168.122.137:8090 \
#     --fetch-from 192.168.122.137
#   bin/mt.sh up && bin/mt.sh agent up        # 起容器与节点代理
#
#   # 备用网关（只服务共享入口，不跑租户）
#   bin/node-install.sh --standby --node standby1 --control-plane https://192.168.122.137:8090 \
#     --fetch-from 192.168.122.137
#   bin/mt.sh up                              # 网关 + 出口代理 + 模型网关
#   bin/mt.sh ha-sync --from 192.168.122.137 --install-timer
#
# 它做的是"接线"：写 .env 里的角色与地址、把控制面的注册/运维密钥与 CA 取到本地
# （节点代理要用它们向控制面注册），再把租户注册表拉一份下来让 bin/mt.sh up 有东西可渲染。
# 还会放行网关对本机代理端口（3199）的访问——浏览器请求是网关转发到那里的，
# 只放行 --allow-from 给的地址（默认控制面那一台；主备两台网关都要列上）。
# 可重复执行：已经装过的机器再跑一次，只是把同样的值写一遍。
#
# 需要：本机有 docker/compose；能从本机 ssh 到控制面（--fetch-from），或手工把
# 控制面的 state/{register,ops,registry}.key 与 state/tls/ca.crt 放到 --key-dir 指定的目录里。
set -uo pipefail

die() { echo "$*" >&2; exit 1; }

NODE=""; CONTROL=""; FETCH=""; KEY_DIR=""; ADDRESS=""; ALLOW_FROM=""; STANDBY=no; FORCE=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --node)          NODE="${2:-}"; shift 2 ;;
    --control-plane) CONTROL="${2:-}"; shift 2 ;;
    --fetch-from)    FETCH="${2:-}"; shift 2 ;;
    --key-dir)       KEY_DIR="${2:-}"; shift 2 ;;
    --address)       ADDRESS="${2:-}"; shift 2 ;;
    --allow-from)    ALLOW_FROM="${2:-}"; shift 2 ;;
    --standby)       STANDBY=yes; shift ;;
    --force)         FORCE=yes; shift ;;
    -h|--help)       sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               die "未知参数: $1" ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -n "$NODE" ] || die "缺少 --node <本机在该部署里的名字>"
[ -n "$CONTROL" ] || die "缺少 --control-plane <控制面地址，例如 https://192.168.122.137:8090>"
[ "$NODE" != local ] || die "--node 不能叫 local（local 是控制面自己）"
case "$NODE" in
  *[!a-z0-9-]*) die "--node 只能用小写字母、数字与连字符（它会进容器名与日志）" ;;
esac
command -v docker >/dev/null 2>&1 || die "找不到 docker"
[ -f .env ] && { set -a; . ./.env; set +a; }
[ -f tenants.example.json ] || die "这个目录不像部署目录（缺 tenants.example.json）"

# 已经配过别的角色时，除非 --force，否则停下来说清楚——把一台控制面误配成节点
# 会让它在下次 up 时不再渲染自己的租户。
if [ -f .env ] && [ "$FORCE" != yes ]; then
  EXISTING_NODE="$(grep '^MT_NODE_NAME=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
  EXISTING_STANDBY="$(grep '^MT_CONTROL_PLANE_STANDBY=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
  if [ -n "$EXISTING_NODE" ] && [ "$EXISTING_NODE" != "$NODE" ]; then
    die "这台机器的 .env 里 MT_NODE_NAME=$EXISTING_NODE（想改名加 --force；控制面自己是 local）"
  fi
  if [ "$STANDBY" = yes ] && [ "${EXISTING_STANDBY:-0}" != "1" ] && grep -q '^MT_NODE_NAME=local' .env 2>/dev/null; then
    die "这台机器看起来是控制面（MT_NODE_NAME=local）：备用网关要另起一台，或用 --force"
  fi
fi

# 主机地址：节点代理用它拼出"控制面该来哪儿找我"的 endpoint，写错等于注册了也连不上。
if [ -z "$ADDRESS" ]; then
  ADDRESS="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1)"
fi
[ -n "$ADDRESS" ] || die "探测不到本机局域网地址，用 --address <IP> 指定"

[ -f .env ] || cp .env.example .env
chmod 600 .env
set_env() {
  local key="$1" value="$2"
  if grep -qE "^#?${key}=" .env; then
    sed -i "s|^#\?${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
set_env MT_NODE_NAME "$NODE"
set_env MT_NODE_ADDRESS "$ADDRESS"
set_env MT_CONTROL_PLANE "$CONTROL"
set_env MT_CONTROL_PLANE_CA "/key/ca.crt"
if [ "$STANDBY" = yes ]; then set_env MT_CONTROL_PLANE_STANDBY 1; else set_env MT_CONTROL_PLANE_STANDBY 0; fi

mkdir -p state
if [ -n "$FETCH" ]; then
  echo "==> 从 ${FETCH} 取注册密钥、运维密钥与 CA"
  for f in register.key ops.key registry.key; do
    scp -q -o BatchMode=yes -o ConnectTimeout=10 "root@${FETCH}:${MT_HA_REMOTE_ROOT:-$ROOT}/state/${f}" state/ \
      || die "取不到 ${f}（免密 ssh 通吗？或改用 --key-dir）"
  done
  # 分用途密钥表：备用网关自己的网关进程要用它（节点注册走 register 那一把）。
  # 节点用不到，取不到就只提醒；备用网关取不到就别继续了——它的网关会认不出
  # 节点送来的密钥，切换过去之后远端租户全部 401。
  if ! scp -q -o BatchMode=yes -o ConnectTimeout=10 "root@${FETCH}:${MT_HA_REMOTE_ROOT:-$ROOT}/state/keys.json" state/; then
    if [ "$STANDBY" = yes ]; then
      die "备用网关要 state/keys.json（控制面的分用途密钥），但取不到"
    fi
    echo "    !! 没取到 state/keys.json（节点自己不需要；备用网关需要）"
  fi
  scp -q -o BatchMode=yes -o ConnectTimeout=10 "root@${FETCH}:${MT_HA_REMOTE_ROOT:-$ROOT}/state/tls/ca.crt" state/ca.crt \
    || die "取不到控制面的 ca.crt"
elif [ -n "$KEY_DIR" ]; then
  echo "==> 从 ${KEY_DIR} 复制密钥与 CA"
  for f in register.key ops.key registry.key; do
    [ -f "${KEY_DIR}/${f}" ] || die "${KEY_DIR} 里没有 ${f}"
    cp "${KEY_DIR}/${f}" state/
  done
  cp "${KEY_DIR}/keys.json" state/ 2>/dev/null || echo "    !! ${KEY_DIR} 里没有 keys.json（节点自己不需要；备用网关需要）"
  cp "${KEY_DIR}/tls/ca.crt" state/ca.crt 2>/dev/null || cp "${KEY_DIR}/ca.crt" state/ca.crt 2>/dev/null \
    || die "找不到 CA（${KEY_DIR}/tls/ca.crt 或 ${KEY_DIR}/ca.crt）"
else
  echo "!! 没给 --fetch-from 或 --key-dir：注册密钥与 CA 需要你手工放好"
  echo "   控制面: scp ${MT_HA_REMOTE_ROOT:-$ROOT}/state/{register,ops,registry}.key ${ADDRESS}:$ROOT/state/"
  echo "   控制面: scp ${MT_HA_REMOTE_ROOT:-$ROOT}/state/tls/ca.crt ${ADDRESS}:$ROOT/state/ca.crt"
fi
chmod 600 state/*.key state/keys.json state/ca.crt 2>/dev/null || true

# 租户注册表：节点必须先有一份，bin/mt.sh up 才知道该渲染什么（渲染时会按 MT_NODE_NAME
# 过滤，所以这份"全量"表在节点上只会落地属于它的那几个）。代理也会自己拉一份，这里先拉
# 一次是为了让 up 立刻可用。
if [ "$STANDBY" = no ] && [ -f state/register.key ]; then
  echo "==> 拉取租户注册表"
  if command -v curl >/dev/null 2>&1; then
    curl -sSk --max-time 15 -H "x-mt-registry-key: $(tr -d '\r\n' < state/register.key)" \
      "${CONTROL%/}/__mt/registry/tenants" > tenants.json.new 2>/dev/null || true
  else
    docker run --rm --network host -v "$ROOT:/w" -w /w --entrypoint curl node:22-bookworm-slim \
      -sSk --max-time 15 -H "x-mt-registry-key: $(tr -d '\r\n' < state/register.key)" \
      "${CONTROL%/}/__mt/registry/tenants" > tenants.json.new 2>/dev/null || true
  fi
  if [ -s tenants.json.new ] && grep -q '"tenants"' tenants.json.new; then
    [ -f tenants.json ] || mv tenants.json.new tenants.json
    rm -f tenants.json.new
  else
    rm -f tenants.json.new
    echo "    !! 拉不到租户注册表（控制面地址/密钥/网络？）：稍后节点代理会自己拉一份"
  fi
fi

echo
echo "接线完成："
echo "    角色        : $([ "$STANDBY" = yes ] && echo '备用网关（只服务共享入口，不跑租户）' || echo "节点 ${NODE}（跑分配给它的租户）")"
echo "    本机地址    : ${ADDRESS}"
echo "    控制面      : ${CONTROL}"
echo "    .env        : MT_NODE_NAME=${NODE}、MT_NODE_ADDRESS=${ADDRESS}、MT_CONTROL_PLANE、MT_CONTROL_PLANE_CA"

# 节点代理的端口必须能被**网关**连上：浏览器的租户请求是网关转发到
# http://<本机>:3199/proxy/<租户> 的。CentOS 7 的 firewalld 默认只在 public 区域
# 放行 ssh，于是节点侧一切正常（它能连出去注册），而统一入口一登录就是
# 502 "connect EHOSTUNREACH <本机>:3199"——本机看不出来，控制面那边才看得见。
#
# 来源只给网关地址（默认控制面那一台；主备两台网关都要给，切换后备网关也要能连过来），
# 不是整个网段：这个端口不鉴权到租户粒度，是"谁能连上谁就能代理某个租户"的入口。
AGENT_PORT="${MT_AGENT_PORT:-3199}"
# 端口与来源：节点代理要给网关用；备用网关自己的 8090 要给前端（以及主网关的
# 健康检查）用。主网关那一台本来就开着 8090（它是现网入口），所以只在备用上补。
OPEN_PORTS="${AGENT_PORT}"
[ "$STANDBY" = yes ] && OPEN_PORTS="${OPEN_PORTS} ${MT_EDGE_PORT:-8090}"
if [ -z "$ALLOW_FROM" ]; then
  ALLOW_FROM="$(printf '%s' "$CONTROL" | sed -E 's#^[a-z]+://##; s#/.*$##; s#:.*$##')"
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  echo "==> 放行端口 ${OPEN_PORTS}（来源: ${ALLOW_FROM}）"
  for ip in $(printf '%s' "$ALLOW_FROM" | tr ',' ' '); do
    for port in $OPEN_PORTS; do
      firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${ip} port port=${port} protocol=tcp accept" >/dev/null 2>&1 || true
    done
  done
  firewall-cmd --reload >/dev/null 2>&1 || echo "    !! firewall-cmd --reload 失败，规则可能要等下次 reload 才生效" >&2
else
  echo "==> 本机没在跑 firewalld：请自行放行 ${ALLOW_FROM} → 本机 ${OPEN_PORTS}/tcp"
fi
echo
echo "下一步："
echo "    1) bin/mt.sh up                          # 渲染并启动本机该有的容器"
if [ "$STANDBY" = yes ]; then
  echo "    2) bin/mt.sh ha-sync --from <主网关> --install-timer   # 每 60 秒同步一次状态"
  echo "    3) 前端把本机加进 upstream（server <本机>:8090 backup;），配置见 ha/nginx.conf"
else
  echo "    2) bin/mt.sh agent up                    # 起节点代理（它负责向控制面注册）"
  echo "    3) 在控制面上 bin/mt.sh runtimes 应当看到节点 ${NODE}"
fi
