#!/usr/bin/env bash
# 备份整套多租户部署：全部租户数据 + 控制面状态 + 注册表 + 配置。
#
# 默认先冻结（docker pause）各租户运行时再打包，得到一个写入一致的快照；
# 会话日志是追加写的，冻结能避免抓到写了一半的 zstd 帧。冻结只持续打包那几秒。
#
# 用法：
#   bin/backup.sh                     # 备份到 ./backups，保留最近 7 份
#   bin/backup.sh --live              # 不冻结（运行中的 agent 不会被暂停）
#   bin/backup.sh --out /mnt/backup   # 指定备份目录
#   bin/backup.sh --keep 14           # 保留份数
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="$PWD/backups"
KEEP=7
LIVE=no
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --live) LIVE=yes; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[ -f tenants.json ] || { echo "不在部署目录（缺 tenants.json）" >&2; exit 1; }
mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$OUT/dsh-mt-$STAMP.tar.gz"

# 从注册表读出要冻结/打包的租户容器名。
TENANTS="$(grep -o '"id": *"[^"]*"' tenants.json | sed 's/.*"\([^"]*\)"$/\1/')"
CONTAINERS=""
for t in $TENANTS; do CONTAINERS="$CONTAINERS mt-dsh-$t"; done
PAUSED=""
unfreeze() {
  if [ -n "$PAUSED" ]; then
    echo "==> 恢复租户运行"
    for c in $PAUSED; do docker unpause "$c" >/dev/null 2>&1 || true; done
    PAUSED=""
  fi
}
trap unfreeze EXIT

if [ "$LIVE" = no ]; then
  echo "==> 冻结租户运行时（打包期间停止写入，数秒）"
  for c in $CONTAINERS; do
    if docker pause "$c" >/dev/null 2>&1; then
      PAUSED="$PAUSED $c"
    else
      echo "    $c 冻结失败（可能未运行），继续以实时方式打包" >&2
    fi
  done
fi

MANIFEST_DIR="$(mktemp -d)"
MANIFEST="$MANIFEST_DIR/MANIFEST.txt"
{
  echo "DSH 多租户部署备份"
  echo "时间        : $STAMP"
  echo "主机        : $(hostname)"
  echo "部署目录    : $PWD"
  echo "一致性      : $([ "$LIVE" = no ] && echo '冻结快照' || echo '实时（未冻结）')"
  echo "租户        : $(echo $TENANTS | tr '\n' ' ')"
  echo "运行时镜像  : $(docker inspect "mt-dsh-$(echo "$TENANTS" | head -1)" --format '{{.Config.Image}}' 2>/dev/null || echo '未知')"
  echo "网关镜像    : $(docker inspect mt-gateway --format '{{.Config.Image}}' 2>/dev/null || echo '未知')"
  echo
  echo "各租户数据量:"
  for t in $TENANTS; do
    echo "  $t  home=$(du -sh "tenants/$t/home" 2>/dev/null | cut -f1)  workspace=$(du -sh "tenants/$t/workspace" 2>/dev/null | cut -f1)  会话=$(find "tenants/$t/home/sessions" -name 'session*.jsonl*' 2>/dev/null | wc -l)"
  done
  echo
  echo "包含内容: tenants/ state/ tenants.json .env"
  echo "未包含  : image-overlay/（可由源码重建）、backups/、logs/"
} > "$MANIFEST"

echo "==> 打包 $ARCHIVE"
tar -czf "$ARCHIVE" \
  --exclude='tenants/*/workspace/node_modules' \
  -C "$PWD" tenants state tenants.json .env -C "$MANIFEST_DIR" MANIFEST.txt

unfreeze
chmod 600 "$ARCHIVE"

echo
echo "==> 完成"
echo "  文件: $ARCHIVE"
echo "  大小: $(du -h "$ARCHIVE" | cut -f1)"
# 列表只取一次：`tar | grep -q` 在 pipefail 下会因 SIGPIPE 被误判为失败。
ENTRIES="$(tar -tzf "$ARCHIVE")"
echo "  条目数: $(printf '%s\n' "$ENTRIES" | wc -l)"
echo "  内容:"
printf '%s\n' "$ENTRIES" | head -6 | sed 's/^/    /'
echo "    ..."

if [ "$KEEP" -gt 0 ]; then
  OLD="$(ls -1t "$OUT"/dsh-mt-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)"
  if [ -n "$OLD" ]; then
    echo
    echo "==> 清理超出保留份数（保留最近 $KEEP 份）"
    echo "$OLD" | while read -r f; do rm -f "$f"; echo "    删除 $(basename "$f")"; done
  fi
fi
rm -rf "$MANIFEST_DIR"
