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
# 重要：这是**运行时**规则，不在 compose 里。
#   容器一旦重建（升级、改配置、bin/mt.sh up 之后），限速就没了，需要重新执行。
#   要长期生效，把它挂在重建之后（例如自建的 post-up 脚本里逐个调用）。
#
# 用法：
#   bin/bandwidth.sh show [租户]              # 看当前规则与计数器
#   bin/bandwidth.sh set <租户> <速率>        # 例如 set alpha 10mbit
#   bin/bandwidth.sh clear <租户>             # 移除限制
set -uo pipefail
cd "$(dirname "$0")/.."

PREFIX="${MT_CONTAINER_NAME_PREFIX:-mt-}"
ARGV=("$@")
COMMAND="${ARGV[0]:-show}"

container_of() { printf '%s' "${PREFIX}dsh-$1"; }

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
  local out
  out="$(nsenter -t "$pid" -n tc qdisc show dev eth0 2>/dev/null | head -1)"
  if printf '%s' "$out" | grep -q tbf; then
    local rate counters
    rate="$(printf '%s' "$out" | grep -o 'rate [^ ]*' | head -1)"
    counters="$(nsenter -t "$pid" -n tc -s qdisc show dev eth0 2>/dev/null | sed -n '2p' | sed 's/^ *//')"
    printf '  %-8s 已限速（%s）\n' "$t" "$rate"
    printf '           %s\n' "$counters"
  else
    printf '  %-8s 未限速\n' "$t"
  fi
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
    if [ -z "$TENANT" ] || [ -z "$RATE" ]; then
      echo "用法: bin/bandwidth.sh set <租户> <速率>   例如 set alpha 10mbit" >&2
      exit 2
    fi
    # 速率写法交给 tc 校验，但先挡掉明显错误的输入：这个值会进入 tc 的命令行。
    case "$RATE" in
      *[!0-9a-z.]* ) echo "速率写法不对：$RATE（例如 10mbit、2mbit、500kbit）" >&2; exit 2 ;;
    esac
    PID="$(pid_or_empty "$TENANT")"
    if [ -z "$PID" ]; then not_running "$TENANT"; exit 1; fi
    # replace 而不是 add：重复执行不会报错，也不会叠加多条规则。
    nsenter -t "$PID" -n tc qdisc replace dev eth0 root tbf rate "$RATE" burst 32kbit latency 400ms || {
      echo "设置失败" >&2; exit 1
    }
    echo "已为租户 $TENANT 设置上行限速 $RATE"
    show_one "$TENANT"
    echo "  提醒：容器重建后这条规则会消失，需要重新执行。"
    ;;

  clear)
    TENANT="${ARGV[1]:-}"
    [ -z "$TENANT" ] && { echo "用法: bin/bandwidth.sh clear <租户>" >&2; exit 2; }
    PID="$(pid_or_empty "$TENANT")"
    if [ -z "$PID" ]; then not_running "$TENANT"; exit 1; fi
    if nsenter -t "$PID" -n tc qdisc del dev eth0 root 2>/dev/null; then
      echo "已移除租户 $TENANT 的网络限制"
    else
      echo "租户 $TENANT 本来就没有限制"
    fi
    show_one "$TENANT"
    ;;

  *)
    echo "用法: bin/bandwidth.sh show [租户] | set <租户> <速率> | clear <租户>" >&2
    exit 2
    ;;
esac
