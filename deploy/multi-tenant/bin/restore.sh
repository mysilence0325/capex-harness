#!/usr/bin/env bash
# 从备份归档恢复整套部署。
#
# 现有数据不会被删除：先整体挪到 restore-aside-<时间戳>/，解包完成后再提示你确认删除。
#
# 用法：
#   bin/restore.sh backups/dsh-mt-20261001T0230Z.tar.gz
#   bin/restore.sh <归档> --data-only     # 只恢复 tenants/，保留当前 .env 与注册表
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVE=""
DATA_ONLY=no
while [ $# -gt 0 ]; do
  case "$1" in
    --data-only) DATA_ONLY=yes; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done
[ -n "$ARCHIVE" ] || { echo "用法: bin/restore.sh <归档> [--data-only]" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "找不到归档: $ARCHIVE" >&2; exit 1; }

echo "==> 校验归档"
# 归档清单只取一次：`tar -tzf … | grep -q` 在 pipefail 下会因 grep 提前退出导致
# tar 收到 SIGPIPE，把完好的归档误判为不合格。
ENTRIES="$(tar -tzf "$ARCHIVE" 2>/dev/null)" || { echo "归档损坏或不是 tar.gz" >&2; exit 1; }
case "$ENTRIES" in
  *tenants/*) ;;
  *) echo "归档里没有 tenants/，不像是本部署的备份" >&2; exit 1 ;;
esac
printf '%s\n' "$ENTRIES" | grep -E 'MANIFEST\.txt$' >/dev/null 2>&1 \
  && tar -xzOf "$ARCHIVE" MANIFEST.txt 2>/dev/null | sed 's/^/    /' \
  || echo "    （归档不含 MANIFEST.txt）"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ASIDE="restore-aside-$STAMP"

echo
echo "==> 停止整套部署"
if command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else COMPOSE=(docker compose); fi
[ -f docker-compose.yml ] && "${COMPOSE[@]}" down || true

echo "==> 现有数据挪到 $ASIDE/"
mkdir -p "$ASIDE"
for item in tenants state tenants.json .env entry-urls.txt; do
  [ -e "$item" ] && mv "$item" "$ASIDE/" && echo "    $item"
done

echo "==> 解包归档"
tar -xzf "$ARCHIVE" -C .
chmod 700 tenants state 2>/dev/null || true
chmod 600 .env 2>/dev/null || true

if [ "$DATA_ONLY" = yes ]; then
  echo "==> --data-only：把归档里的配置放回 $ASIDE 旁，改用当前配置"
  for item in state tenants.json .env; do
    if [ -e "$item" ] && [ -e "$ASIDE/$item" ]; then
      rm -rf "$item.aside-restored"
      mv "$item" "$item.aside-restored"
      mv "$ASIDE/$item" "$item"
      echo "    $item: 保留当前版本，归档版本放在 $item.aside-restored"
    fi
  done
fi

echo
echo "==> 恢复完成，可以启动"
echo "    bin/mt.sh up"
echo
echo "现有（恢复前）的数据仍在 $ASIDE/，确认无误后删除： rm -rf $ASIDE"
