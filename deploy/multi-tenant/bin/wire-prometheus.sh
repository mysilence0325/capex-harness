#!/usr/bin/env bash
# 把本部署的告警接进这台机器上已有的 Prometheus（capex-ai-lab 那套）。
#
# 这件事之所以需要脚本而不是几条命令，是因为踩过两次坑，而两次都不会报错：
#
#   1. 他们的 prometheus.yml 与规则文件是**单文件绑定挂载**。用 cp 覆盖会换掉 inode，
#      容器里仍然指向旧 inode——文件"改了"，容器看不到，且没有任何提示。
#      所以这里一律用 `cat > 目标`（原地写）。若之前被 cp 破坏过，必须重启容器重新建立挂载。
#   2. 往他们的 prometheus.yml 追加抓取任务时，列表项缩进必须与他们一致（2 空格）。
#      缩进错了 YAML 直接解析失败——靠 promtool 在**上线前**拦住，而不是让他们的
#      Prometheus 去加载一份坏配置。
#
# 用法：
#   bin/wire-prometheus.sh              # 接入（幂等，可重复执行）
#   bin/wire-prometheus.sh --check      # 只看现在接得怎么样，不改动
#   bin/wire-prometheus.sh --remove     # 撤掉（从备份恢复）
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

PROM_DIR="${MT_PROMETHEUS_DIR:-/home/capex-ai-lab/deploy/private/prometheus}"
PROM_DATA="${MT_PROMETHEUS_DATA:-/home/capex-data/prometheus}"
PROM_CONTAINER="${MT_PROMETHEUS_CONTAINER:-capex-ai-lab-prometheus-1}"
PROBE_IMAGE="${MT_PROMETHEUS_IMAGE:-prom/prometheus:v3.6.0}"
CFG="$PROM_DIR/prometheus.single-node.generated.yml"
SRC_CFG="$PROM_DIR/prometheus.single-node.yml"
RULES="$PROM_DIR/alerts.single-node.yml"
JOB=dsh-multitenant

MODE=wire
case "${1:-}" in
  --check) MODE=check ;;
  --remove) MODE=remove ;;
  '') ;;
  *) echo "用法: bin/wire-prometheus.sh [--check|--remove]" >&2; exit 2 ;;
esac

[ -f "$CFG" ] || { echo "找不到 $CFG；如果你的 Prometheus 不在默认位置，用 MT_PROMETHEUS_DIR 指定" >&2; exit 1; }

container_cmd() { docker exec "$PROM_CONTAINER" "$@" 2>/dev/null; }
api() { container_cmd wget -q -O - "http://127.0.0.1:9090$1"; }

if [ "$MODE" = check ]; then
  echo "==> 现在的状态"
  echo "  抓取任务: $(api /api/v1/targets | sed 's/},{/}\n{/g' | grep -c "$JOB") 个"
  api /api/v1/targets | sed 's/},{/}\n{/g' | grep "$JOB" | grep -oE '"health":"[a-z]+"|"lastError":"[^"]*"' | sed 's/^/    /'
  echo "  已加载规则: $(api /api/v1/rules | grep -o '"name":"Dsh[A-Za-z]*"' | wc -l) 条"
  echo "  抓到的指标: $(api /api/v1/label/__name__/values | tr ',' '\n' | grep -c '^"mt_') 类"
  exit 0
fi

if [ "$MODE" = remove ]; then
  B="$(ls -t /tmp/dsh-prom-cfg.bak.* 2>/dev/null | head -1)"
  R="$(ls -t /tmp/dsh-prom-rules.bak.* 2>/dev/null | head -1)"
  [ -n "$B" ] && [ -n "$R" ] || { echo "没有找到本脚本的备份（/tmp/dsh-prom-*.bak.*），手工处理" >&2; exit 1; }
  echo "==> 从备份恢复（原地写）"
  cat "$B" > "$CFG"
  cat "$B" > "$SRC_CFG" 2>/dev/null || true
  cat "$R" > "$RULES"
  rm -f "$PROM_DATA/dsh.token"
  container_cmd wget -q -O - --post-data='' http://127.0.0.1:9090/-/reload >/dev/null
  echo "  已恢复；令牌已删除"
  exit 0
fi

IP="${MT_BIND_IP:-}"
if [ -z "$IP" ] || [ "$IP" = "0.0.0.0" ]; then
  IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br|veth|virbr|lo|tun|tap)/ { split($4,a,"/"); print a[1] }' | head -1)"
fi
EDGE="${MT_EDGE_PORT:-8090}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

echo "==> 目标: https://${IP}:${EDGE}/__mt/metrics（用 IP 而不是域名：这台机器的 Docker 内嵌 DNS 有超时问题，IP 不受影响）"

echo
echo "==> 1. 备份"
cp "$CFG" "/tmp/dsh-prom-cfg.bak.$STAMP"
cp "$RULES" "/tmp/dsh-prom-rules.bak.$STAMP"
cp "$SRC_CFG" "/tmp/dsh-prom-srccfg.bak.$STAMP" 2>/dev/null || true
echo "    /tmp/dsh-prom-*.bak.$STAMP"

echo
echo "==> 2. 令牌（放进已挂载的目录，容器内为 /prometheus/dsh.token）"
tr -d '\r\n' < state/registry.key > "$PROM_DATA/dsh.token"
chmod 644 "$PROM_DATA/dsh.token"
echo "    $(wc -c < "$PROM_DATA/dsh.token") 字节"

echo
echo "==> 3. 在临时目录组装（不碰线上文件）"
# mktemp 建的是 700，而 promtool 容器以非 root 运行，读不到——那样校验会以
# "permission denied" 失败，看起来像配置有问题。放开目录与文件权限。
TMP="$(mktemp -d)"
chmod 755 "$TMP"
cat "$CFG" > "$TMP/prometheus.yml"
cat "$RULES" > "$TMP/alerts.single-node.yml"
cp "$PROM_DATA/dsh.token" "$TMP/dsh.token"
[ -f "$PROM_DATA/contextforge.token" ] && cp "$PROM_DATA/contextforge.token" "$TMP/contextforge.token"
chmod 644 "$TMP"/*.token "$TMP"/*.yml 2>/dev/null || true

if grep -q "job_name: $JOB" "$TMP/prometheus.yml"; then
  echo "    抓取任务已存在"
else
  [ -n "$(tail -c1 "$TMP/prometheus.yml")" ] && printf '\n' >> "$TMP/prometheus.yml"
  cat >> "$TMP/prometheus.yml" <<EOF

  # DSH 多租户控制面。列表项缩进必须与上面各任务一致（2 空格），否则 YAML 解析失败。
  # 目标用 IP：这台机器的 Docker 内嵌 DNS 有超时，IP 不受影响。
  - job_name: $JOB
    scheme: https
    metrics_path: /__mt/metrics
    scrape_interval: 30s
    tls_config:
      insecure_skip_verify: true
    authorization:
      type: Bearer
      credentials_file: /prometheus/dsh.token
    static_configs:
      - targets: ['${IP}:${EDGE}']
        labels:
          deployment: $JOB
EOF
  echo "    已加抓取任务"
fi

# 托管段先在临时文件里组装，并且**数一遍里面的规则**。
#
# 上一版的问题是：从源文件里抽规则的那条 sed 什么都没抽到（新规则缩进错了，成了分组项
# 而不是规则），而旧托管段已经被截断移除——结果是追加了空内容，把他们正在用的 10 条
# 规则从 Prometheus 里弄没了。所以这里先抽、验数量，再动线上文件。
{
  echo ""
  echo "  # ===== DSH 多租户（规范副本：${ROOT}/alerts/mt-alerts.yml）====="
  echo "  # 指标来自 job $JOB。改动请同步回规范副本，否则下次会以那边为准。"
  sed -n "/^  - name: ${JOB}/,\$p" "$ROOT/alerts/mt-alerts.yml"
} > "$TMP/managed.yml"

WANT="$(grep -c '^      - alert:' "$TMP/managed.yml" || true)"
if [ "${WANT:-0}" -lt 1 ]; then
  echo "    ✗ 从 $ROOT/alerts/mt-alerts.yml 里抽不出规则（分组名或缩进不对），线上文件未改动" >&2
  exit 1
fi
echo "    托管段含 ${WANT} 条规则"

# 移除旧的托管段（标记行之前的内容是他们自己的，一律保留）
if grep -q 'DSH 多租户（规范副本' "$TMP/alerts.single-node.yml"; then
  awk '/DSH 多租户（规范副本/ { exit } { print }' "$TMP/alerts.single-node.yml" > "$TMP/alerts.trimmed.yml"
  mv "$TMP/alerts.trimmed.yml" "$TMP/alerts.single-node.yml"
fi
cat "$TMP/managed.yml" >> "$TMP/alerts.single-node.yml"

# 最后一道：数一遍组装结果。数量对不上就中止，绝不写线上。
HAVE="$(grep -c 'alert: Dsh' "$TMP/alerts.single-node.yml" || true)"
if [ "${HAVE:-0}" -ne "$WANT" ]; then
  echo "    ✗ 组装后有 ${HAVE} 条 Dsh 规则，源里有 ${WANT} 条，不一致，线上文件未改动" >&2
  exit 1
fi
echo "    组装后有 ${HAVE} 条 Dsh 规则，与源一致"

echo
echo "==> 4. promtool 校验（不通过就停，线上文件不动）"
# 同时挂到 /prometheus：令牌在真实容器里的路径就是 /prometheus/dsh.token，校验环境要还原它
if docker run --rm -v "$TMP:/etc/prometheus" -v "$TMP:/prometheus" --entrypoint promtool "$PROBE_IMAGE" \
     check config /etc/prometheus/prometheus.yml 2>&1 | sed 's/^/    /'; then
  echo "    通过 ✓"
else
  echo "    ✗ 未通过，线上文件未改动（临时目录 $TMP 保留以便排查）" >&2
  exit 1
fi

echo
echo "==> 5. 原地写入（cat > 而不是 cp：这两个文件是单文件挂载，换 inode 容器就看不到）"
cat "$TMP/prometheus.yml" > "$CFG"
cat "$TMP/prometheus.yml" > "$SRC_CFG" 2>/dev/null || true
cat "$TMP/alerts.single-node.yml" > "$RULES"
rm -rf "$TMP"

SEEN="$(container_cmd sh -c "grep -c 'alert: Dsh' /etc/prometheus/alerts.single-node.yml" || echo 0)"
echo "    容器里立刻可见的规则: ${SEEN} 条"
if [ "${SEEN:-0}" = "0" ]; then
  # inode 不匹配：此前有人用 cp 覆盖过，容器还指向旧 inode，挂载要重新建立
  echo "    ✗ 容器看到的还是旧文件（挂载指向旧 inode）。重启容器重新建立挂载："
  echo "        docker restart $PROM_CONTAINER"
  exit 2
fi

echo
echo "==> 6. 热加载并验证"
container_cmd wget -q -O - --post-data='' http://127.0.0.1:9090/-/reload >/dev/null
sleep 12
echo "    已加载规则: $(api /api/v1/rules | grep -o '"name":"Dsh[A-Za-z]*"' | wc -l) 条"
echo "    抓取目标: $(api /api/v1/targets | sed 's/},{/}\n{/g' | grep "$JOB" | grep -oE '"health":"[a-z]+"' | head -1)"
echo "    抓到的指标: $(api /api/v1/label/__name__/values | tr ',' '\n' | grep -c '^"mt_') 类"
