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
  # 优先用渲染时固定的网桥名：Docker 默认的 br-<网络id> 会随网络重建而改变，
  # 规则就会在没有报错的情况下失效。bin/render.js 通过
  # com.docker.network.bridge.name 固定了它（见 MT_BRIDGE_NAME）。
  local pinned
  pinned="$(docker network inspect "$NETWORK" --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null | tr -d '\r')"
  if [ -n "$pinned" ] && [ "$pinned" != "<no value>" ]; then
    echo "$pinned"
    return 0
  fi
  local id
  id="$(docker network inspect "$NETWORK" --format '{{.Id}}' 2>/dev/null | tr -d '\r')"
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
  local br
  br="$(bridge)"
  if [ -z "$br" ]; then
    echo "找不到网络 ${NETWORK} 的网桥，先执行 bin/mt.sh up" >&2
    return 1
  fi
  if ! ip link show "$br" >/dev/null 2>&1; then
    echo "网桥 ${br} 不存在，先执行 bin/mt.sh up" >&2
    return 1
  fi

  # 先清掉旧的（网桥重建后接口名会变，旧规则会失效但又碍事）
  local rule
  while IFS= read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086
    firewall-cmd --permanent --direct --remove-rule $rule >/dev/null 2>&1 || true
  done <<< "$(own_rules)"

  echo "==> 限制网桥 ${br} 对宿主的访问"
  # 优先级决定链内顺序：先放行出口代理，再丢弃其余
  firewall-cmd --permanent --direct --add-rule ipv4 filter "$CHAIN" 1 \
    -i "$br" -p tcp --dport "$EGRESS_PORT" -m comment --comment "$COMMENT" -j ACCEPT >/dev/null || return 1
  firewall-cmd --permanent --direct --add-rule ipv4 filter "$CHAIN" 9 \
    -i "$br" -m comment --comment "$COMMENT" -j DROP >/dev/null || return 1

  firewall-cmd --reload >/dev/null 2>&1 || return 1
  echo "    放行 ${br} -> 宿主:${EGRESS_PORT}（出口代理）"
  echo "    丢弃 ${br} -> 宿主的其它所有端口"
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
  local br rules
  br="$(bridge)"
  rules="$(own_rules)"
  echo "==> 租户 -> 宿主 的访问限制"
  echo "    当前网桥: ${br:-未知}"
  if [ -z "$rules" ]; then
    echo "    状态: 未启用（租户可访问宿主上任何监听端口）"
    return 1
  fi
  printf '%s\n' "$rules" | sed 's/^/    /'
  if printf '%s' "$rules" | grep -q -- "-i ${br} "; then
    echo "    状态: 已启用，且作用于当前网桥"
  else
    echo "    状态: 规则指向的网桥不是当前的 ${br}——执行 bin/isolate.sh apply 修正"
    return 1
  fi
  # 运行时是否真的生效（不只是写在配置里）。
  # `iptables -L -n` 不显示 in 接口列，要用 -S 才能看到 -i 参数。
  if iptables -S "$CHAIN" 2>/dev/null | grep -q -- "-i ${br}"; then
    echo "    运行时: 已加载"
  else
    echo "    运行时: 未加载（执行 firewall-cmd --reload）"
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
