#!/usr/bin/env bash
# 限制租户容器能访问宿主上的哪些端口。
#
# 为什么需要：Docker 把每个网桥都放进 firewalld 的 docker 区域，而该区域是
# target: ACCEPT。于是容器可以直达宿主上任何监听端口——实测租户容器能打开
# Harbor、Nexus、Nacos、Prometheus、Grafana。这些是宿主上其它系统的服务，
# 从局域网访问被 public 区域挡着，但从我们的容器里不设防。租户的 agent 以
# danger-full-access 运行，等于把这些接口交给了租户。
#
# 做法：给本部署的网桥在 firewalld 里加 direct 规则，只放行出口代理端口，
# 其余到宿主的连接丢弃。
#
# 为什么挂在 INPUT_direct：firewalld 的评估顺序是
#   INPUT: 1 ESTABLISHED,RELATED  2 lo  3 INPUT_direct  4 ZONES_SOURCE  5 INPUT_ZONES …
# docker 区域的 ACCEPT 发生在第 5 步，所以规则必须挂在第 3 步才拦得住。
# 用 --permanent 写入，因此 firewall-cmd --reload 和主机重启都不会丢。
#
# 影响范围：只匹配本部署网桥的入向流量，其它系统的网桥不受影响。
#
# 用法：
#   bin/isolate.sh apply     应用（幂等，网桥变了会自动改用新接口）
#   bin/isolate.sh remove    撤销
#   bin/isolate.sh status    查看当前状态
set -uo pipefail
cd "$(dirname "$0")/.."

CHAIN="INPUT_direct"
COMMENT="mt-tenant-isolation"
NETWORK="${MT_NETWORK:-mt-net}"
EGRESS_PORT="${MT_EGRESS_PORT:-3128}"

bridge() {
  bridge_of "$NETWORK"
}

# 本部署涉及的所有网桥：主网络，加上被单独隔离的租户各自的网络。
# 每个网桥都要各自应用一遍宿主端口规则——只处理主网络会让隔离出去的租户失去这层保护。
all_bridges() {
  docker network ls --format '{{.Name}}' 2>/dev/null \
    | grep -E "^${NETWORK}(-|$)" \
    | while read -r name; do
        bridge_of "$name"
      done \
    | sort -u
}

# 单个网络对应的网桥名（优先取渲染时固定的名字）。
bridge_of() {
  local name="$1" pinned
  pinned="$(docker network inspect "$name" --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null | tr -d '\r')"
  if [ -n "$pinned" ] && [ "$pinned" != "<no value>" ]; then
    echo "$pinned"
    return 0
  fi
  local id
  id="$(docker network inspect "$name" --format '{{.Id}}' 2>/dev/null | tr -d '\r')"
  if [ -n "$id" ]; then
    echo "br-$(printf '%s' "$id" | cut -c1-12)"
  fi
  return 0
}

# 本部署留下的 direct 规则（靠注释识别，网桥名变了也能找回来）
own_rules() {
  firewall-cmd --permanent --direct --get-all-rules 2>/dev/null | grep -F "$COMMENT" || true
}

apply_rules() {
  local bridges
  bridges="$(all_bridges)"
  if [ -z "$bridges" ]; then
    echo "找不到 ${NETWORK} 相关网络的网桥，先执行 bin/mt.sh up" >&2
    return 1
  fi
  local missing=no
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    ip link show "$br" >/dev/null 2>&1 || missing="$br"
  done <<< "$bridges"
  if [ "$missing" != no ]; then
    echo "网桥 ${missing} 不存在，先执行 bin/mt.sh up" >&2
    return 1
  fi

  # 先清掉旧的（网桥重建后接口名会变，旧规则会失效但又碍事）
  local rule
  while IFS= read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    firewall-cmd --permanent --direct --remove-rule $rule >/dev/null 2>&1 || true
  done <<< "$(own_rules)"

  echo "==> 限制以下网桥对宿主的访问（每个网桥各自一条放行 + 一条丢弃）"
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    # 优先级决定链内顺序：先放行出口代理，再丢弃其余。
    # 被单独隔离的租户在它自己的网桥上，它的出口代理是那个网桥的网关地址，
    # 所以这条放行对每个网桥都成立。
    firewall-cmd --permanent --direct --add-rule ipv4 filter "$CHAIN" 1 \
      -i "$br" -p tcp --dport "$EGRESS_PORT" -m comment --comment "$COMMENT" -j ACCEPT >/dev/null || return 1
    firewall-cmd --permanent --direct --add-rule ipv4 filter "$CHAIN" 9 \
      -i "$br" -m comment --comment "$COMMENT" -j DROP >/dev/null || return 1
    echo "    ${br}: 放行 -> 宿主:${EGRESS_PORT}，丢弃其余"
  done <<< "$bridges"

  firewall-cmd --reload >/dev/null 2>&1 || return 1
  echo "    规则已写入 firewalld 永久配置：reload 与重启后都保留"
  return 0
}

remove_rules() {
  local rule count=0
  while IFS= read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    if firewall-cmd --permanent --direct --remove-rule $rule >/dev/null 2>&1; then
      count=$((count + 1))
    fi
  done <<< "$(own_rules)"
  firewall-cmd --reload >/dev/null 2>&1 || true
  echo "==> 已移除 ${count} 条租户隔离规则；容器恢复可访问宿主的全部端口"
  return 0
}

status_rules() {
  local rules bridges
  bridges="$(all_bridges)"
  rules="$(own_rules)"
  echo "==> 租户 -> 宿主 的访问限制"
  echo "    本部署的网桥: $(printf '%s' "$bridges" | tr '\n' ' ')"
  if [ -z "$rules" ]; then
    echo "    状态: 未启用（租户可访问宿主上任何监听端口）"
    return 1
  fi
  printf '%s\n' "$rules" | sed 's/^/    /'
  # 每个网桥都必须有自己的规则：漏掉一个，那个网桥上的租户就能访问宿主全部端口。
  local bad=no
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    if ! printf '%s' "$rules" | grep -q -- "-i ${br} "; then
      echo "    状态: 网桥 ${br} 没有规则——执行 bin/isolate.sh apply"
      bad=yes
    elif ! iptables -S "$CHAIN" 2>/dev/null | grep -q -- "-i ${br}"; then
      echo "    状态: 网桥 ${br} 的规则未加载到运行时（执行 firewall-cmd --reload）"
      bad=yes
    fi
  done <<< "$bridges"
  if [ "$bad" = no ]; then
    echo "    状态: 已启用，覆盖全部 $(printf '%s' "$bridges" | grep -c .) 个网桥，运行时已加载"
  else
    return 1
  fi
  return 0
}

case "${1:-status}" in
  apply)  apply_rules ;;
  remove) remove_rules ;;
  status) status_rules ;;
  *) echo "用法: bin/isolate.sh [apply|remove|status]" >&2; exit 2 ;;
esac
