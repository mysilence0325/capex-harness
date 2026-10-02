#!/usr/bin/env bash
# 磁盘：看清楚空间被什么占了，以及按需回收。
#
# 这台机器的实际压力与直觉不同，所以先说清楚现状再动手：
#   - Docker 的镜像/容器在根分区（现网 50G，长期 78%），重建一次就多几层；
#   - 租户的会话数据在 /home（现网 441G），空间充裕，但会随使用一直长；
#   - 备份也在 /home，按 MT_BACKUP_KEEP 保留。
# 因此"清理"要分两头：根分区看镜像，会话看保留策略。
#
# 用法：
#   bin/disk.sh report                                   # 现状与可回收量
#   bin/disk.sh prune-sessions --older-than 90 [--tenant a,b] [--dry-run] [--archive]
#     注意 --older-than 的语义：N 个完整的 24 小时。0 = 超过一天，不是"全部"。
#   bin/disk.sh prune-images                             # 只删本部署重建产生的悬空镜像
set -uo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a
PREFIX="${MT_CONTAINER_NAME_PREFIX:-mt-}"

all_tenants() { grep -o '"id": *"[^"]*"' tenants.json 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/'; }
tenant_home() { echo "tenants/$1/home"; }

human() { du -sh "$1" 2>/dev/null | cut -f1; }

report() {
  echo "==> 文件系统"
  df -h / /home 2>/dev/null | sed 's/^/    /'

  echo
  echo "==> 本部署占用"
  printf "    部署目录总计: %s\n" "$(human .)"
  du -sh ./* ./.??* 2>/dev/null | sort -rh | head -6 | sed 's/^/      /'

  echo
  echo "==> 各租户"
  printf "    %-8s %10s %10s %10s %8s %s\n" 租户 会话 存储 总计 会话数 最老会话
  local total_sessions=0
  for t in $(all_tenants); do
    local home sessions storages count oldest
    home="$(tenant_home "$t")"
    [ -d "$home" ] || continue
    sessions="$(human "$home/sessions")"
    storages="$(human "$home/storages")"
    count="$(find "$home/sessions" -name 'session-*' -type d 2>/dev/null | wc -l)"
    oldest="$(find "$home/sessions" -name 'session-*' -type d -printf '%T@ %TY-%Tm-%Td\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2)"
    printf "    %-8s %10s %10s %10s %8s %s\n" "$t" "${sessions:-0}" "${storages:-0}" "$(human "$home")" "$count" "${oldest:-—}"
    total_sessions=$((total_sessions + count))
  done
  echo "    合计会话目录: ${total_sessions}"

  echo
  echo "==> 日志与备份"
  printf "    网关/模型网关日志: %s\n" "$(human logs)"
  for f in logs/access.jsonl logs/admin.jsonl logs/model-usage.jsonl; do
    [ -f "$f" ] && printf "      %-22s %s\n" "$(basename "$f")" "$(du -sh "$f" 2>/dev/null | cut -f1)"
  done
  printf "    备份: %s（%s 个归档，保留 %s 份）\n" "$(human backups)" "$(ls backups/*.tar.gz 2>/dev/null | wc -l)" "${MT_BACKUP_KEEP:-7}"

  echo
  echo "==> Docker（根分区压力的主要来源）"
  local all_images dangling
  all_images="$(docker images -q 2>/dev/null | wc -l)"
  dangling="$(docker images -f dangling=true -q 2>/dev/null | wc -l)"
  printf "    镜像总数: %s 个，其中悬空（无标签）: %s 个\n" "$all_images" "$dangling"
  echo "    本部署相关镜像:"
  docker images --format '      {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' 2>/dev/null \
    | grep -E 'dsh-web|mt-gateway|mt-egress|mt-model|mt-node-agent' | head -10
  if [ "$dangling" -gt 0 ]; then
    echo "    镜像层可回收（Docker 统计）: $(docker system df --format '{{.Type}}\t{{.Reclaimable}}' 2>/dev/null | awk -F"\t" '$1=="Images"{print $2}')"
    echo "    回收：bin/disk.sh prune-images"
  fi
}

prune_images() {
  local yes=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes) yes=yes; shift ;;
      *) echo "未知参数: $1" >&2; exit 2 ;;
    esac
  done

  local before size
  before="$(docker images -f dangling=true -q 2>/dev/null | wc -l)"
  if [ "$before" -eq 0 ]; then
    echo "==> 没有悬空镜像，无需回收"
    return 0
  fi
  # 用 docker 自己的统计：镜像的 Size 是 "1.2GB" 这种字符串，自己拼数字会算出笑话。
  size="$(docker system df --format '{{.Type}}\t{{.Reclaimable}}' 2>/dev/null | awk -F"\t" '$1=="Images"{print $2}')"

  echo "==> 悬空镜像 ${before} 个（Docker 报告镜像层可回收 ${size:-未知}）"
  if [ "$yes" = no ]; then
    echo "    这是**全机范围**的操作：悬空镜像没有标签、也没有容器引用，删除不会影响任何"
    echo "    正在运行的栈（只影响以后重建时的缓存命中）。但这台机器上还有别的栈，所以"
    echo "    要你显式确认："
    echo "      bin/disk.sh prune-images --yes"
    return 0
  fi

  # 仍然不用 docker system prune：那会连带清网络与构建缓存，影响这台机器上的其它栈。
  docker image prune -f 2>&1 | tail -2 | sed 's/^/    /'
  echo "    悬空镜像: ${before} -> $(docker images -f dangling=true -q 2>/dev/null | wc -l)"
  echo "    带标签的旧版本镜像不会被删（也不该自动删）："
  docker images --format '    {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' 2>/dev/null \
    | grep -E 'dsh-web:' | head -5
}

prune_sessions() {
  local older="" tenants="" dry=no archive=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --older-than) older="${2:-}"; shift 2 ;;
      --tenant) tenants="${2:-}"; shift 2 ;;
      --dry-run) dry=yes; shift ;;
      --archive) archive=yes; shift ;;
      *) echo "未知参数: $1" >&2; exit 2 ;;
    esac
  done
  # find 的 -mtime +N 是"超过 N 个完整的 24 小时"，所以 --older-than 0 表示"超过一天"，
  # 而不是"全部"。这条很容易误解，写在这里也写在用法里。
  [ -n "$older" ] || { echo "必须给 --older-than <天数>：删除超过 N 个完整 24 小时的会话（0 = 超过一天，不是全部）" >&2; exit 2; }
  case "$older" in ''|*[!0-9]*) echo "--older-than 要是天数，例如 90" >&2; exit 2 ;; esac

  local list
  if [ -n "$tenants" ]; then list="$(printf '%s' "$tenants" | tr ',' ' ')"; else list="$(all_tenants)"; fi

  local total=0
  for t in $list; do
    local dir; dir="$(tenant_home "$t")/sessions"
    [ -d "$dir" ] || continue
    local found
    # 会话目录在 home/sessions/<分组>/session-<uuid>/，不是 sessions 的直接子目录：
    # 按名字找而不是按深度找，否则"分组"那一层会把结果全挡掉。
    found="$(find "$dir" -type d -name 'session-*' -mtime "+${older}" 2>/dev/null | sort)"
    local n=0
    [ -n "$found" ] && n="$(printf '%s\n' "$found" | grep -c .)"
    printf "  %-8s 超过 %s 天的会话目录: %s 个\n" "$t" "$older" "$n"
    [ "$n" -eq 0 ] && continue
    if [ "$dry" = yes ]; then
      printf '%s\n' "$found" | head -3 | sed 's|^|      会删 |'
      [ "$n" -gt 3 ] && echo "      …（其余 $((n - 3)) 个）"
    else
      if [ "$archive" = yes ]; then
        local stamp out
        stamp="$(date -u +%Y%m%dT%H%M%SZ)"
        out="backups/sessions-${t}-${stamp}.tar.gz"
        # 先打包再删：会话是用户的对话记录，删掉就没了。
        if printf '%s\n' "$found" | tar -czf "$out" -T - 2>/dev/null; then
          echo "      已归档到 ${out}（$(du -sh "$out" | cut -f1)）"
        else
          echo "      归档失败，跳过该租户（不删任何东西）" >&2
          continue
        fi
      fi
      printf '%s\n' "$found" | while IFS= read -r d; do rm -rf "$d"; done
      echo "      已删除 ${n} 个"
    fi
    total=$((total + n))
  done
  echo
  if [ "$dry" = yes ]; then
    echo "==> 这是 --dry-run，没有删除任何东西。去掉它才真的执行。"
  else
    echo "==> 共处理 ${total} 个会话目录"
    [ "$archive" = no ] && echo "    提示：下次加 --archive 会先打包到 backups/ 再删。"
  fi
}

case "${1:-report}" in
  report) shift; report ;;
  prune-sessions) shift; prune_sessions "$@" ;;
  prune-images) shift; prune_images "$@" ;;
  *) echo "用法: bin/disk.sh [report|prune-sessions|prune-images]" >&2; exit 2 ;;
esac
