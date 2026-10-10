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
# 两个后端（自动选，也可以用 MT_ISOLATE_BACKEND 强制）：
#   * firewalld：CentOS 等装了 firewalld 的机器，规则写进永久配置（reload/重启都在）。
#   * iptables：Ubuntu 默认没有 firewalld（也装不了包）时用。规则落在专用链
#     MT_TENANT_ISOLATION 里，INPUT 跳过去；**运行时规则重启会丢**，所以另有
#     `install-boot`：写一个 systemd 单元，开机自动 apply（ufw 处于启用状态时会重写
#     INPUT 链，status 会提示）。
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
ROOT="$PWD"
# 后端：显式指定优先；否则有 firewalld 就用 firewalld，没有就用 iptables。
BACKEND="${MT_ISOLATE_BACKEND:-}"
if [ -z "$BACKEND" ]; then
  if command -v firewall-cmd >/dev/null 2>&1; then BACKEND=firewalld; else BACKEND=iptables; fi
fi
MT_CHAIN="MT_TENANT_ISOLATION"
BOOT_UNIT="mt-tenant-isolation.service"
BOOT_UNIT_PATH="/etc/systemd/system/$BOOT_UNIT"

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

# ── iptables 后端 ──────────────────────────────────────────────────────────
# 规则落在专用链里，INPUT 第一条跳过去。语义与 firewalld 那条一致：每个网桥先放行出口
# 代理端口，再丢弃其余到宿主的连接。只匹配本部署网桥的入向流量。

# 所有 iptables 调用都走 `-w`：不等待就会与 firewalld / docker 抢 xtables 锁，抢输时
# 命令直接失败（实测：`-I INPUT` 因此没执行，链建好了却没挂上去 —— 看起来"隔离好了"，
# 其实一点作用都没有）。
ipt() { iptables -w "$@"; }

ipt_apply() {
  local bridges
  bridges="$(all_bridges)"
  if [ -z "$bridges" ]; then
    echo "找不到 ${NETWORK} 相关网络的网桥，先执行 bin/mt.sh up" >&2
    return 1
  fi
  ip link show "$(printf '%s\n' "$bridges" | head -1)" >/dev/null 2>&1 || {
    echo "网桥不存在，先执行 bin/mt.sh up" >&2
    return 1
  }

  ipt -N "$MT_CHAIN" 2>/dev/null || true
  ipt -F "$MT_CHAIN" || return 1
  echo "==> 限制以下网桥对宿主的访问（iptables 链 $MT_CHAIN）"
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    ip link show "$br" >/dev/null 2>&1 || { echo "    跳过不存在的网桥 $br" >&2; continue; }
    ipt -A "$MT_CHAIN" -i "$br" -p tcp --dport "$EGRESS_PORT" -j ACCEPT || return 1
    ipt -A "$MT_CHAIN" -i "$br" -j DROP || return 1
    echo "    ${br}: 放行 -> 宿主:${EGRESS_PORT}，丢弃其余"
  done <<< "$bridges"
  # 挂到 INPUT 最前面：后面的规则（含 Docker 放行的那些）就不会先把它放过去。
  if ! ipt -S INPUT | grep -q -- "-j $MT_CHAIN"; then
    ipt -I INPUT 1 -j "$MT_CHAIN" || return 1
  fi
  # 挂载是这一步的全部意义：必须核实它真的挂上去了，而不是"命令没报错就算成"。
  if ! ipt -S INPUT | grep -q -- "-j $MT_CHAIN"; then
    echo "规则已写入链，但没能挂到 INPUT 上（多为 xtables 锁竞争）：请重跑 bin/isolate.sh apply" >&2
    return 1
  fi
  echo "    规则已加载；注意：iptables 规则重启会丢，用 bin/isolate.sh install-boot 让它开机重建"
  return 0
}

ipt_remove() {
  while ipt -S INPUT | grep -q -- "-j $MT_CHAIN"; do
    ipt -D INPUT -j "$MT_CHAIN" || break
  done
  ipt -F "$MT_CHAIN" 2>/dev/null || true
  ipt -X "$MT_CHAIN" 2>/dev/null || true
  echo "==> 已移除租户隔离链 $MT_CHAIN；容器恢复可访问宿主的全部端口"
  return 0
}

ipt_status() {
  local bridges rules bad=no
  bridges="$(all_bridges)"
  echo "==> 租户 -> 宿主 的访问限制（后端 iptables）"
  echo "    本部署的网桥: $(printf '%s' "$bridges" | tr '\n' ' ')"
  rules="$(ipt -S "$MT_CHAIN" 2>/dev/null || true)"
  if [ -z "$rules" ] || ! ipt -S INPUT | grep -q -- "-j $MT_CHAIN"; then
    echo "    状态: 未启用（租户可访问宿主上任何监听端口）"
    return 1
  fi
  printf '%s\n' "$rules" | sed 's/^/    /'
  while IFS= read -r br; do
    [ -n "$br" ] || continue
    printf '%s' "$rules" | grep -q -- "-i ${br} " || { echo "    状态: 网桥 ${br} 没有规则——执行 bin/isolate.sh apply"; bad=yes; }
  done <<< "$bridges"
  command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active' && \
    echo "    注意: ufw 处于启用状态，它重写 INPUT 时可能把这条跳转冲掉（apply 或重跑 install-boot 的单元即可恢复）"
  [ "$bad" = no ] && echo "    状态: 已启用，覆盖全部 $(printf '%s' "$bridges" | grep -c .) 个网桥"
  [ "$bad" = no ] || return 1
  return 0
}

install_boot() {
  [ "$(id -u)" = 0 ] || { echo "install-boot 需要 root（要写 /etc/systemd/system）" >&2; return 1; }
  command -v systemctl >/dev/null 2>&1 || { echo "这台机器没有 systemd，无法自动重建；请在启动脚本里调用 bin/isolate.sh apply" >&2; return 1; }
  cat > "$BOOT_UNIT_PATH" <<EOF
[Unit]
Description=DSH multi-tenant: keep tenant bridges from reaching host ports
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT
ExecStart=$ROOT/bin/isolate.sh apply
ExecStop=$ROOT/bin/isolate.sh remove

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable --now "$BOOT_UNIT" || return 1
  echo "==> 已安装并启动 $BOOT_UNIT（开机自动重建隔离规则）"
  return 0
}

uninstall_boot() {
  [ "$(id -u)" = 0 ] || { echo "uninstall-boot 需要 root" >&2; return 1; }
  systemctl disable --now "$BOOT_UNIT" >/dev/null 2>&1 || true
  rm -f "$BOOT_UNIT_PATH"
  systemctl daemon-reload >/dev/null 2>&1 || true
  echo "==> 已移除 $BOOT_UNIT"
  return 0
}

# ── 派发 ───────────────────────────────────────────────────────────────────
apply_rules() {
  [ "$BACKEND" = iptables ] && { ipt_apply; return $?; }
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
  [ "$BACKEND" = iptables ] && { ipt_remove; return $?; }
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
  [ "$BACKEND" = iptables ] && { ipt_status; return $?; }
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
  install-boot)   install_boot ;;
  uninstall-boot) uninstall_boot ;;
  *) echo "用法: bin/isolate.sh [apply|remove|status|install-boot|uninstall-boot]" >&2; exit 2 ;;
esac
