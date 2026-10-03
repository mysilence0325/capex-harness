#!/usr/bin/env bash
# 每租户磁盘配额（XFS project quota）。
#
# 用法：
#   bin/quota.sh show                  # 各租户的配额与用量
#   bin/quota.sh set <租户> <大小>      # 例如 set alpha 2g
#   bin/quota.sh clear <租户>
#   bin/quota.sh check                 # 只检查这个文件系统能不能用配额
#
# 环境变量（验证与演练用）：MT_QUOTA_TENANTS 指定租户目录，MT_QUOTA_MOUNT 指定挂载点。
#
# 为什么第一件事是检查挂载项：
#   XFS 的配额【必须在挂载时带上】。`mount -o remount,prjquota` 会被【静默忽略】——
#   它返回成功，挂载项不变，xfs_quota 的 state 是空的，然后设限时报
#   "cannot set limits: Function not implemented"。看起来像"配额在这台机器上不生效"，
#   其实只是没打开。实测在一个挂载时带 prjquota 的临时 XFS 上，20MB 硬上限确实把
#   40MB 的写入拦在 20MB。所以能开就要开，开不了要说清怎么开。
set -uo pipefail
cd "$(dirname "$0")/.."

TENANTS_DIR="${MT_QUOTA_TENANTS:-$PWD/tenants}"

# 意图文件，与带宽那份同样的道理：配额可能还没在文件系统上启用，但"这个租户应该有多少"
# 必须记下来 —— 指标与告警靠它工作，启用之后也靠它恢复。
QUOTA_FILE="$PWD/state/quota.json"

quota_intent_set() {
  python3 - "$QUOTA_FILE" "$1" "$2" <<'PY'
import json
import os
import sys

path, tenant, size = sys.argv[1], sys.argv[2], sys.argv[3]
data = {}
if os.path.exists(path):
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except ValueError:
        data = {}
if size == '':
    data.pop(tenant, None)
else:
    data[tenant] = {'size': size}
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write('\n')
os.chmod(path, 0o600)
PY
}
MOUNT_POINT="${MT_QUOTA_MOUNT:-$(df -T "$TENANTS_DIR" 2>/dev/null | awk 'NR==2 {print $NF}')}"
# project id 由租户名决定：同一个租户每次算出来都一样，不依赖顺序，删了再加也对得上。
projid_of() {
  printf '%s' "$1" | cksum | awk '{print ($1 % 4000) + 1000}'
}

# 检查的是【配额要生效的那个挂载点】。有 MT_QUOTA_MOUNT 时以它为准：
# 只看 TENANTS_DIR 的目标会让"指向另一个文件系统"的验证自相矛盾。
prjquota_enabled() {
  findmnt -rno OPTIONS --target "$MOUNT_POINT" 2>/dev/null | grep -q 'prjquota\|pquota'
}

explain_how() {
  local src fstype
  src="$(df -T "$TENANTS_DIR" 2>/dev/null | awk 'NR==2 {print $1}')"
  fstype="$(df -T "$TENANTS_DIR" 2>/dev/null | awk 'NR==2 {print $2}')"
  echo "这个文件系统（$src，$fstype）没有以 prjquota 挂载，配额用不了。" >&2
  echo >&2
  echo "注意：remount 是【静默无效】的 —— 不要用下面这条，它会报成功但什么都不改：" >&2
  echo "    mount -o remount,prjquota $MOUNT_POINT        # ✗ 无效" >&2
  echo >&2
  echo "要在挂载时带上。两种做法，都需要一次停机窗口：" >&2
  echo "  1) 改 /etc/fstab，把 $MOUNT_POINT 那一行的 defaults 换成 defaults,prjquota，然后重启：" >&2
  echo "       cp /etc/fstab /etc/fstab.bak" >&2
  echo "       # 编辑后先核对：找 $src 那一行，确认多了 ,prjquota" >&2
  echo "  2) 或者在停机窗口内：停掉部署 → umount $MOUNT_POINT → mount -o prjquota $MOUNT_POINT" >&2
  echo >&2
  echo "做完之后 bin/quota.sh check 会通过，set 才能真正设上限。" >&2
}

cmd_check() {
  echo "租户数据目录: $TENANTS_DIR"
  df -hT "$TENANTS_DIR" 2>/dev/null | sed 's/^/  /'
  echo "  挂载项: $(findmnt -rno OPTIONS --target "$TENANTS_DIR" 2>/dev/null)"
  if prjquota_enabled; then
    echo "  项目配额: 已启用 ✓"
    xfs_quota -x -c 'state' "$MOUNT_POINT" 2>&1 | grep -i project | sed 's/^/    /'
  else
    echo "  项目配额: 未启用 ✗"
  fi
}

cmd_show() {
  prjquota_enabled || { explain_how; exit 1; }
  echo "各租户的配额（project quota）："
  xfs_quota -x -c 'report -p -h -b' "$MOUNT_POINT" 2>/dev/null | sed 's/^/  /'
  echo
  for d in "$TENANTS_DIR"/*/; do
    [ -d "$d" ] || continue
    t="$(basename "$d")"
    p="$(projid_of "$t")"
    # 从 report 的表格里按 project id 取那一行。用 `quota -p <id>` 解析字段位置错过一次：
    # 两个子命令的列不一样，结果把已设置的配额报成"未设置"，与上面的表自相矛盾。
    limit="$(xfs_quota -x -c 'report -p -h -b' "$MOUNT_POINT" 2>/dev/null | awk -v id="#$p" '$1 == id {print $3"/"$4}')"
    used="$(du -sh "$d" 2>/dev/null | awk '{print $1}')"
    printf '  %-10s project=%-6s 已用 %-8s 配额 %s\n' "$t" "$p" "${used:-?}" "${limit:-未设置}"
  done
}

cmd_set() {
  local tenant="${1:-}" size="${2:-}"
  if [ -z "$tenant" ] || [ -z "$size" ]; then
    echo "用法: bin/quota.sh set <租户> <大小>   例如 set alpha 2g" >&2
    exit 2
  fi
  case "$size" in
    *[!0-9kmgtKMGT]*) echo "大小写法不对：$size（例如 2g、500m）" >&2; exit 2 ;;
  esac
  local dir="$TENANTS_DIR/$tenant"
  [ -d "$dir" ] || { echo "没有这个租户的目录: $dir" >&2; exit 1; }
  if ! prjquota_enabled; then
    # 记下意图再退出：启用配额要一次重启，而"打算给多少"这件事不该等到那时才能表达。
    # 指标与告警因此可以先于强制生效。
    quota_intent_set "$tenant" "$size"
    echo "已记下租户 $tenant 的配额意图 $size —— 但这台机器上还没启用配额，暂不强制。"
    explain_how
    exit 1
  fi

  local p; p="$(projid_of "$tenant")"
  xfs_quota -x -c "project -s -p $dir $p" "$MOUNT_POINT" >/dev/null 2>&1
  # 软上限设成硬上限的 90%：到软上限会开始有宽限期警告，硬上限才是写不进去的那条线。
  local soft; soft="$(printf '%s' "$size" | awk '{n=$0; u=substr(n,length(n),1); v=substr(n,1,length(n)-1)+0; if (u ~ /[0-9]/) {v=n+0; u="m"} print int(v*0.9) u}')"
  if xfs_quota -x -c "limit -p bhard=$size bsoft=$soft $p" "$MOUNT_POINT" 2>&1; then
    quota_intent_set "$tenant" "$size"
    echo "已为租户 $tenant 设置磁盘配额 $size（软 $soft，project $p，已记入 state/quota.json）"
    echo "  注意：配额按【目录】统计，包含它的会话归档与工作区数据。"
  else
    echo "设置失败" >&2
    exit 1
  fi
}

cmd_clear() {
  local tenant="${1:-}"
  [ -z "$tenant" ] && { echo "用法: bin/quota.sh clear <租户>" >&2; exit 2; }
  # 先删意图，再检查挂载：意图是"打算给多少"，与文件系统能不能强制无关。
  # 放在 guard 之后的话，在没启用配额的机器上就永远删不掉自己刚记下的意图。
  quota_intent_set "$tenant" ""
  if ! prjquota_enabled; then
    echo "已删除租户 $tenant 的配额意图（这台机器上本来也没有强制）"
    exit 0
  fi
  local p dir; p="$(projid_of "$tenant")"; dir="$TENANTS_DIR/$tenant"
  xfs_quota -x -c "limit -p bhard=0 bsoft=0 $p" "$MOUNT_POINT" >/dev/null 2>&1
  xfs_quota -x -c "project -C -p $dir $p" "$MOUNT_POINT" >/dev/null 2>&1
  quota_intent_set "$tenant" ""
  echo "已移除租户 $tenant 的磁盘配额（意图也已删除）"
}

case "${1:-show}" in
  check) cmd_check ;;
  show)  cmd_show ;;
  set)   shift; cmd_set "$@" ;;
  clear) shift; cmd_clear "$@" ;;
  *)     echo "用法: bin/quota.sh show | set <租户> <大小> | clear <租户> | check" >&2; exit 2 ;;
esac
