#!/usr/bin/env bash
# 租户容器的网络带宽限制。
#
# 为什么是 nsenter 而不是在宿主上加规则：
#   宿主侧的 qdisc（veth 的 root、或网桥设备的 root）在这台机器上**不在流量路径上**。
#   实测：宿主侧加了 tbf 10Mbit，传 100MB 时 qdisc 只看到 907KB，overlimits=0 ——
#   配置落下了，但根本没管到流量。改到容器自己的 netns 里就对了：
#   同一实验变成 overlimits=24313 且队列积压，说明它在限、而且在路径上。
#
#   容器本身不需要 NET_ADMIN —— 是宿主 nsenter 进去改的，租户容器不必放权。
#
# 为什么是两层 nsenter：
#   -t 1 -m        先进入宿主的 mount 命名空间。节点代理镜像里【没有 tc】，而离线环境
#                  装不了包；宿主文件系统里有。实测过：不加这层报
#                  "nsenter: failed to execute tc: No such file or directory"。
#   -t <pid> -n    再切到租户容器的网络命名空间。
# 在宿主上直接跑这个脚本时，外层等于原地，所以同一段代码两边都能用。
#
# 重要：这是**运行时**规则，不在 compose 里。
#   容器一旦重建（升级、改配置、bin/mt.sh up 之后），限速就没了，需要重新执行。
#   要长期生效，把它挂在重建之后（例如自建的 post-up 脚本里逐个调用）。
#
# 用法：
#   bin/bandwidth.sh show [租户]                          # 看两个方向的规则与计数器
#   bin/bandwidth.sh set <租户> <速率> [方向]             # 方向: --up(默认) --down --both
#   bin/bandwidth.sh clear <租户>                         # 两个方向都移除（含意图）
#   bin/bandwidth.sh apply                                # 按 state/bandwidth.json 重新应用
#                                                          （bin/mt.sh up 会自动调用）
#
# 两个方向用的是不同的机制，这不是实现细节而是必须知道的：
#   上行（容器发出）= root qdisc 上的 tbf，排队限速。
#   下行（进入容器）= ingress qdisc 上的 police，丢包限速。
# 实测（一次性容器，100MB）：上行与下行都能从约 900 Mbit/s 压到 1~10 Mbit/s，
# 且 police/tbf 的计数器里 overlimits 会显著增长 —— 那是它真的在管的证据。
set -uo pipefail
cd "$(dirname "$0")/.."

PREFIX="${MT_CONTAINER_NAME_PREFIX:-mt-}"
ARGV=("$@")
COMMAND="${ARGV[0]:-show}"

container_of() { printf '%s' "${PREFIX}dsh-$1"; }

# 意图，而不只是当下那条规则：容器重建会丢掉规则，但"这个租户应该限到多少"必须留着，
# 否则重建之后没人知道要恢复什么。set/clear 维护它，apply 按它重建规则。
STATE_FILE="$PWD/state/bandwidth.json"

state_read() {
  [ -f "$STATE_FILE" ] || { printf '{}'; return; }
  cat "$STATE_FILE"
}

state_write() {
  local json="$1"
  mkdir -p "$(dirname "$STATE_FILE")"
  printf '%s\n' "$json" > "$STATE_FILE"
  chmod 600 "$STATE_FILE" 2>/dev/null || true
}

# 用 python3 改 JSON：手写字符串拼接在带引号的值上很容易出错，而**宿主机上没有 node**
#（这个脚本跑在宿主上）——用 node 会让意图文件根本写不出来，从而无从恢复。
# 那台机器的 python3 是 3.6，所以这里不用 3.7+ 的写法。
state_set() {
  local tenant="$1" rate="$2" direction="$3"
  python3 - "$STATE_FILE" "$tenant" "$rate" "$direction" <<'PY'
import json
import os
import sys

path, tenant, rate, direction = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
data = {}
if os.path.exists(path):
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except ValueError:
        data = {}
if rate == '':
    data.pop(tenant, None)
else:
    data[tenant] = {'rate': rate, 'direction': direction}
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write('\n')
os.chmod(path, 0o600)
PY
}

# 从意图文件里取键（空格分隔）或某个键的一个字段。
state_keys() {
  python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    d = {}
print(" ".join(sorted(d.keys())))' "$STATE_FILE" 2>/dev/null
}

state_field() {
  python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    d = {}
print((d.get(sys.argv[2]) or {}).get(sys.argv[3], ""))' "$STATE_FILE" "$1" "$2" 2>/dev/null
}

# 把一个租户的规则按给定方向落下去。set 与 apply 共用这一段。
apply_rules() {
  local tenant="$1" pid="$2" rate="$3" direction="$4"
  if [ "$direction" = "up" ] || [ "$direction" = "both" ]; then
    nsenter -t 1 -m -- nsenter -t "$pid" -n tc qdisc replace dev eth0 root tbf rate "$rate" burst 32kbit latency 400ms || return 1
  fi
  if [ "$direction" = "down" ] || [ "$direction" = "both" ]; then
    # 下行是进入容器的流量，root qdisc 管不到，要 ingress qdisc + police（丢包式，TCP 会退避）。
    nsenter -t 1 -m -- nsenter -t "$pid" -n tc qdisc add dev eth0 handle ffff: ingress 2>/dev/null \
      || nsenter -t 1 -m -- nsenter -t "$pid" -n tc qdisc replace dev eth0 handle ffff: ingress 2>/dev/null || true
    nsenter -t 1 -m -- nsenter -t "$pid" -n tc filter del dev eth0 parent ffff: 2>/dev/null || true
    nsenter -t 1 -m -- nsenter -t "$pid" -n tc filter add dev eth0 parent ffff: protocol ip u32 match u32 0 0 \
      police rate "$rate" burst 32k drop flowid :1 || return 1
  fi
  return 0
}

pid_of() {
  local name; name="$(container_of "$1")"
  docker inspect "$name" --format '{{.State.Pid}}' 2>/dev/null
}

# 返回容器的 pid，或空。
#
# 刻意不在这里 exit：这个函数是在命令替换里调用的，exit 只能结束子 shell，
# 外层会带着空的 pid 继续走到 nsenter，打出一行与真正原因无关的报错。
# 检查放在调用处（见下面两处 `if [ -z "$PID" ]`）。
pid_or_empty() {
  local pid; pid="$(pid_of "$1")"
  [ "$pid" = "0" ] && pid=""
  printf '%s' "$pid"
}

not_running() {
  echo "租户 $1 的容器（$(container_of "$1")）不在运行，无法限制它的网络" >&2
}

show_one() {
  local t="$1" pid
  pid="$(pid_of "$t")"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    printf '  %-8s 容器未运行\n' "$t"
    return
  fi
  # 上行：root qdisc（tbf）。下行：ingress qdisc + police 过滤器。
  local up down
  up="$(nsenter -t 1 -m -- nsenter -t "$pid" -n tc qdisc show dev eth0 2>/dev/null | grep -o 'tbf.*rate [^ ]*' | head -1)"
  down="$(nsenter -t 1 -m -- nsenter -t "$pid" -n tc filter show dev eth0 parent ffff: 2>/dev/null | grep -o 'police .*rate [^ ]*' | head -1)"
  if [ -n "$up" ]; then
    printf '  %-8s 上行已限速（%s）\n' "$t" "$(printf '%s' "$up" | grep -o 'rate [^ ]*')"
    nsenter -t 1 -m -- nsenter -t "$pid" -n tc -s qdisc show dev eth0 2>/dev/null | sed -n '2p' | sed 's/^ */            /'
  fi
  if [ -n "$down" ]; then
    printf '  %-8s 下行已限速（%s）\n' "$t" "$(printf '%s' "$down" | grep -o 'rate [^ ]*')"
    nsenter -t 1 -m -- nsenter -t "$pid" -n tc -s filter show dev eth0 parent ffff: 2>/dev/null \
      | grep -E 'Sent .*pkt' | sed 's/^ */            /'
  fi
  [ -z "$up" ] && [ -z "$down" ] && printf '  %-8s 未限速\n' "$t"
  return 0
}

case "$COMMAND" in
  show)
    if [ -n "${ARGV[1]:-}" ]; then
      show_one "${ARGV[1]}"
    else
      echo "各租户的网络限制："
      for t in $(grep -o '"id": *"[a-z0-9-]*"' tenants.json 2>/dev/null | sed 's/.*"\([a-z0-9-]*\)"$/\1/'); do
        show_one "$t"
      done
    fi
    ;;

  set)
    TENANT="${ARGV[1]:-}"
    RATE="${ARGV[2]:-}"
    DIRECTION=up
    for a in "$@"; do
      case "$a" in
        --down) DIRECTION=down ;;
        --both) DIRECTION=both ;;
        --up)   DIRECTION=up ;;
      esac
    done
    if [ -z "$TENANT" ] || [ -z "$RATE" ]; then
      echo "用法: bin/bandwidth.sh set <租户> <速率> [--up|--down|--both]" >&2
      echo "  默认 --up（容器发出）。--down 限容器下载，--both 两个方向都限。" >&2
      exit 2
    fi
    # 速率写法交给 tc 校验，但先挡掉明显错误的输入：这个值会进入 tc 的命令行。
    case "$RATE" in
      *[!0-9a-z.]* ) echo "速率写法不对：$RATE（例如 10mbit、2mbit、500kbit）" >&2; exit 2 ;;
    esac
    PID="$(pid_or_empty "$TENANT")"
    if [ -z "$PID" ]; then not_running "$TENANT"; exit 1; fi
    apply_rules "$TENANT" "$PID" "$RATE" "$DIRECTION" || { echo "设置失败" >&2; exit 1; }
    # 记下意图：容器重建后 apply 靠它把规则恢复回来。
    state_set "$TENANT" "$RATE" "$DIRECTION"
    echo "已为租户 $TENANT 设置限速 $RATE（方向: $DIRECTION，已记入 state/bandwidth.json）"
    show_one "$TENANT"
    echo "  提醒：容器重建后这条规则会消失，需要重新执行。"
    ;;

  apply)
    # 按 state/bandwidth.json 重新应用。bin/mt.sh up 在容器起好之后调用它 ——
    # 规则是运行时状态，容器一重建就没了，这一步是恢复它们的唯一时机。
    DATA="$(state_read)"
    if [ "$DATA" = "{}" ] || [ -z "$DATA" ]; then
      echo "没有任何租户配置了限速（state/bandwidth.json 为空）"
      exit 0
    fi
    for t in $(state_keys); do
      RATE="$(state_field "$t" rate)"
      DIR="$(state_field "$t" direction)"
      [ -z "$DIR" ] && DIR=up
      PID="$(pid_or_empty "$t")"
      if [ -z "$PID" ]; then
        echo "  $t: 容器未运行，跳过（它起来之后需要再跑一次 apply）"
        continue
      fi
      if apply_rules "$t" "$PID" "$RATE" "$DIR"; then
        echo "  $t: 已恢复限速 $RATE（$DIR）"
      else
        echo "  $t: 恢复失败" >&2
      fi
    done
    ;;

  clear)
    TENANT="${ARGV[1]:-}"
    [ -z "$TENANT" ] && { echo "用法: bin/bandwidth.sh clear <租户>" >&2; exit 2; }
    PID="$(pid_or_empty "$TENANT")"
    if [ -z "$PID" ]; then not_running "$TENANT"; exit 1; fi
    removed=0
    nsenter -t 1 -m -- nsenter -t "$PID" -n tc qdisc del dev eth0 root 2>/dev/null && removed=1
    nsenter -t 1 -m -- nsenter -t "$PID" -n tc filter del dev eth0 parent ffff: 2>/dev/null && removed=1
    nsenter -t 1 -m -- nsenter -t "$PID" -n tc qdisc del dev eth0 ingress 2>/dev/null && removed=1
    state_set "$TENANT" "" ""
    if [ "$removed" = "1" ]; then
      echo "已移除租户 $TENANT 的网络限制（上行与下行都清，意图也已删除）"
    else
      echo "租户 $TENANT 本来就没有限制（意图已删除）"
    fi
    show_one "$TENANT"
    ;;

  *)
    echo "用法: bin/bandwidth.sh show [租户] | set <租户> <速率> | clear <租户>" >&2
    exit 2
    ;;
esac
