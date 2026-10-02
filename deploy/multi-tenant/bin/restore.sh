#!/usr/bin/env bash
# 从备份归档恢复。
#
# 整套恢复：现有数据不会被删除：先整体挪到 restore-aside-<时间戳>/，解包完成后再提示你确认删除。
# 单租户恢复：只动那一个租户，控制面配置、其它租户、注册表都不受影响。
#
# 用法：
#   bin/restore.sh <归档>                      # 整套恢复
#   bin/restore.sh <归档> --data-only          # 只恢复 tenants/，保留当前 .env 与注册表
#   bin/restore.sh <归档> --tenant <租户>       # 只恢复这一个租户的数据
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVE=""
DATA_ONLY=no
TENANT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --data-only) DATA_ONLY=yes; shift ;;
    --tenant) TENANT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done
[ -n "$ARCHIVE" ] || { echo "用法: bin/restore.sh <归档> [--data-only] [--tenant <租户>]" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "找不到归档: $ARCHIVE" >&2; exit 1; }
if [ -n "$TENANT" ] && ! printf '%s' "$TENANT" | grep -qE '^[a-z][a-z0-9-]{1,30}$'; then
  echo "租户 id 不合法: $TENANT" >&2
  exit 2
fi

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

# 单租户恢复：只替换那一个租户的数据目录。
# 不碰注册表、不碰 state/、不碰其它租户，所以不需要停整个部署。
if [ -n "$TENANT" ]; then
  if ! printf '%s\n' "$ENTRIES" | grep -qE "^tenants/$TENANT/"; then
    echo "归档里没有租户 $TENANT 的数据" >&2
    exit 1
  fi
  echo
  echo "==> 恢复单个租户: $TENANT"
  echo "==> 停止该租户运行时"
  if command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else COMPOSE=(docker compose); fi
  docker stop "mt-dsh-$TENANT" >/dev/null 2>&1 || true
  echo "==> 现有数据挪到 $ASIDE/tenants/$TENANT"
  mkdir -p "$ASIDE/tenants"
  if [ -e "tenants/$TENANT" ]; then mv "tenants/$TENANT" "$ASIDE/tenants/"; fi
  mkdir -p tenants
  # 只取这个租户的路径；归档里的其它内容一概不展开。
  tar -xzf "$ARCHIVE" -C . "tenants/$TENANT" 2>/dev/null \
    || { echo "解包失败（归档里的路径可能不含前缀 tenants/$TENANT/）" >&2; exit 1; }
  chmod 700 "tenants/$TENANT" 2>/dev/null || true
  echo
  echo "==> 恢复完成，重新启动该租户"
  echo "    bin/mt.sh restart $TENANT"
  echo
  echo "恢复前的数据仍在 $ASIDE/tenants/$TENANT/，确认无误后删除： rm -rf $ASIDE"
  exit 0
fi

echo
echo "==> 停止整套部署"
if command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else COMPOSE=(docker compose); fi
[ -f docker-compose.yml ] && "${COMPOSE[@]}" down || true

echo "==> 现有数据挪到 $ASIDE/"
mkdir -p "$ASIDE"
for item in tenants state tenants.json .env entry-urls.txt; do
  if [ -e "$item" ]; then
    mv "$item" "$ASIDE/"
    echo "    $item"
  fi
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
