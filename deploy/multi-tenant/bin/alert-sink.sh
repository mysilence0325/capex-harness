#!/usr/bin/env bash
# 告警接收器：常驻、可重建、可接线、可自检。
#
# 为什么需要它：这个部署自己没有邮件服务器或告警平台，而 Alertmanager 在接收人为空时
# 会**收下告警然后丢掉**。那是最糟的状态——规则在跑、Prometheus 在评估、告警也到了，
# 只是永远没人知道。接收器把每条告警写进 state/alerts/alerts.jsonl 并打到容器日志，
# 于是这条链路可见、可测。等你们有内网告警平台，改 alertmanager.yml 里那一行 url 即可。
#
# 为什么不写进 docker-compose.yml：它必须加入 Alertmanager 所在的那张网络，而那张网络
# 不属于本部署。要引用它得改 compose 顶层的 networks 块，那个文件出过三次事故。
# 这里用常驻容器（restart: unless-stopped，开机自动拉起）+ 本脚本达到同样的长期效果：
# 需要时一条命令重建，重建前后行为一致。
#
# 用法：
#   bin/alert-sink.sh up        # 建立或重建接收器（幂等）
#   bin/alert-sink.sh wire      # 把 Alertmanager 的接收人指向它（幂等，改前备份）
#   bin/alert-sink.sh test      # 发一条测试告警并验证落盘
#   bin/alert-sink.sh status    # 看当前状态与最近收到的告警
set -uo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

CONTAINER="${MT_ALERT_SINK_CONTAINER:-dsh-alert-sink}"
SINK_IMAGE="${MT_ALERT_SINK_IMAGE:-node:22-bookworm-slim}"
SINK_NETWORK="${MT_ALERT_SINK_NETWORK:-capex-ai-lab_ops}"
AM_CONTAINER="${MT_ALERTMANAGER_CONTAINER:-capex-ai-lab-alertmanager-1}"
AM_CONFIG="${MT_ALERTMANAGER_CONFIG:-/home/capex-ai-lab/deploy/private/alertmanager/alertmanager.yml}"
DATA_DIR="$ROOT/state/alerts"
LOG_FILE="$DATA_DIR/alerts.jsonl"
SINK_URL="http://${CONTAINER}:9110/alert"

command="${1:-status}"

case "$command" in
  up)
    [ -f alerts/sink.js ] || { echo "缺少 alerts/sink.js" >&2; exit 1; }
    if ! docker network inspect "$SINK_NETWORK" >/dev/null 2>&1; then
      echo "找不到网络 $SINK_NETWORK —— 用 MT_ALERT_SINK_NETWORK 指定 Alertmanager 所在的网络" >&2
      exit 1
    fi
    mkdir -p "$DATA_DIR"
    touch "$LOG_FILE"
    chmod 640 "$LOG_FILE" 2>/dev/null || true
    echo "==> 重建接收器容器 $CONTAINER（网络 $SINK_NETWORK）"
    docker rm -f "$CONTAINER" >/dev/null 2>&1
    docker run -d --name "$CONTAINER" --restart unless-stopped --network "$SINK_NETWORK" \
      -v "$ROOT/alerts/sink.js:/sink.js:ro" \
      -v "$DATA_DIR:/data" \
      --entrypoint node "$SINK_IMAGE" /sink.js >/dev/null
    sleep 4
    echo "  $(docker ps --filter "name=$CONTAINER" --format '{{.Names}}  {{.Status}}')"
    echo "  日志: $(docker logs "$CONTAINER" 2>&1 | tail -1)"
    ;;

  wire)
    [ -f "$AM_CONFIG" ] || { echo "找不到 $AM_CONFIG（用 MT_ALERTMANAGER_CONFIG 指定）" >&2; exit 1; }
    cp "$AM_CONFIG" "/tmp/alertmanager.yml.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    echo "==> 已备份 $AM_CONFIG 到 /tmp"
    python3 - "$AM_CONFIG" "$SINK_URL" <<'PY'
import re
import sys

path, url = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    text = f.read()

# 只在真正的配置行上判断：注释里也会出现 webhook_configs 这个词，
# 拿字符串直接搜会误判成"已经配好了"，从而跳过配置（这个坑我踩过一次）。
if re.search(r'^\s+webhook_configs:', text, re.M):
    print('  接收人已经配了 webhook，未改动')
    sys.exit(0)

old = 'receivers:\n  - name: default'
if text.count(old) != 1:
    print('  找不到 receivers 段（%d 处匹配），请手工确认' % text.count(old), file=sys.stderr)
    sys.exit(1)

new = (
    'receivers:\n'
    '  - name: default\n'
    '    # 本部署的接收器：告警写进 /home/dsh-mt/state/alerts/alerts.jsonl 并打到 docker logs。\n'
    '    # 内网有统一告警平台时，把下面这一行 url 换成它的地址即可，其余不用动。\n'
    '    webhook_configs:\n'
    '      - url: \'%s\'\n'
    '        send_resolved: true' % url
)
with open(path, 'w', encoding='utf-8') as f:
    f.write(text.replace(old, new, 1))
print('  已把接收人指向 %s' % url)
PY
    # 单文件挂载：原地写保住了 inode，容器通常立刻可见；看不到就重启它。
    if docker exec "$AM_CONTAINER" sh -c 'grep -qE "^[[:space:]]+webhook_configs:" /etc/alertmanager/alertmanager.yml' 2>/dev/null; then
      echo "  Alertmanager 容器已可见此改动"
      docker exec "$AM_CONTAINER" wget -q -O - --post-data='' http://127.0.0.1:9093/-/reload >/dev/null 2>&1 && echo "  已热加载"
    else
      echo "  Alertmanager 容器还看不到（inode 变了），重启它"
      docker restart "$AM_CONTAINER" >/dev/null 2>&1
      for _ in $(seq 1 20); do
        sleep 2
        docker exec "$AM_CONTAINER" wget -q -O - http://127.0.0.1:9093/-/ready >/dev/null 2>&1 && break
      done
      echo "  已重启并就绪"
    fi
    ;;

  test)
    touch "$LOG_FILE"
    before="$(wc -l < "$LOG_FILE")"
    # 告警名必须每次都不同。用固定名字的话，第二次之后的投递都会因为
    # group_interval（默认 5 分钟）被认为"同一组已经通知过"而不重发 ——
    # 自检会失败，但链路其实是好的（我这么误判过一次）。
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    echo "==> 投递前落盘条目: $before（本次告警名 DshDeliveryCheck-$stamp）"
    docker exec "$AM_CONTAINER" wget -q -O - \
      --post-data='[{"labels":{"alertname":"DshDeliveryCheck-'"$stamp"'","severity":"warning","instance":"self-test","job":"dsh-multitenant"},"annotations":{"summary":"告警投递自检","description":"验证 Alertmanager 能把告警投出去、接收器能收到。"},"startsAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}]' \
      --header='Content-Type: application/json' http://127.0.0.1:9093/api/v2/alerts >/dev/null 2>&1
    echo "  已投递，等 group_wait(30s) 与转发…"
    sleep 60
    after="$(wc -l < "$LOG_FILE")"
    echo "  投递后落盘条目: $after"
    if [ "$after" -gt "$before" ]; then
      echo "  链路打通 ✓  最新一条:"
      tail -1 "$LOG_FILE" | sed 's/^/    /'
    else
      echo "  ✗ 没有新条目；看接收器与 Alertmanager 的日志:"
      docker logs "$CONTAINER" 2>&1 | tail -3 | sed 's/^/    /'
      docker logs "$AM_CONTAINER" 2>&1 | tail -3 | sed 's/^/    /'
      exit 1
    fi
    ;;

  status)
    echo "==> 接收器容器"
    docker ps -a --filter "name=$CONTAINER" --format '  {{.Names}}  {{.Status}}  (restart={{.Label "restart"}})' 2>/dev/null || true
    echo "==> Alertmanager 的接收人"
    docker exec "$AM_CONTAINER" sh -c 'grep -A6 "^receivers:" /etc/alertmanager/alertmanager.yml' 2>/dev/null | sed 's/^/  /' || echo "  （读不到配置）"
    echo "==> 收到的告警"
    if [ -s "$LOG_FILE" ]; then
      echo "  共 $(wc -l < "$LOG_FILE") 条，最近 3 条："
      tail -3 "$LOG_FILE" | sed 's/^/    /'
    else
      echo "  还没有收到任何告警（文件为空或不存在）"
    fi
    ;;

  *)
    echo "用法: bin/alert-sink.sh up | wire | test | status" >&2
    exit 2
    ;;
esac
