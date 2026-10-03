#!/usr/bin/env bash
# 备份服务的主循环：先按保留策略归档清理会话，再备份，然后睡一段时间。
#
# 这段逻辑曾经写在渲染模板的 entrypoint 里，结果变量外层的引号提前结束了那个 YAML
# 字符串，渲染出的 docker-compose.yml 直接不可解析——整个部署都起不来。放进独立脚本
# 就没有这个问题：模板里只剩一行 `bash /project/bin/retention-loop.sh`，
# 而且这个脚本可以单独 bash -n、也可以手工跑一次看结果。
#
# 环境变量（由 docker-compose 从 .env 传入）：
#   MT_SESSION_RETENTION_DAYS  会话保留天数。留空 = 不自动清理。必须是非负整数。
#   MT_BACKUP_KEEP             保留多少个备份归档
#   MT_BACKUP_INTERVAL_SECONDS 每轮间隔秒数
set -uo pipefail

RETENTION="${MT_SESSION_RETENTION_DAYS:-}"
KEEP="${MT_BACKUP_KEEP:-7}"
INTERVAL="${MT_BACKUP_INTERVAL_SECONDS:-86400}"

# 保留天数必须是纯数字。
#
# 这是本脚本里最要紧的一行：`--older-than` 收到空串或乱码时，disk.sh 可能把**所有**
# 会话都判为过期并删掉。宁可什么都不做，也不能让一个没校验的值驱动破坏性操作。
retention_is_usable() {
  case "$RETENTION" in
    '' ) return 1 ;;
    *[!0-9]* ) return 1 ;;
    * ) return 0 ;;
  esac
}

if [ -n "$RETENTION" ] && ! retention_is_usable; then
  echo "会话保留天数不是非负整数（MT_SESSION_RETENTION_DAYS=$RETENTION），本轮不做自动清理" >&2
elif retention_is_usable; then
  echo "会话保留策略：${RETENTION} 天"
else
  echo "会话保留策略：未设置，不自动清理"
fi

while true; do
  echo "--- $(date -Iseconds) 新一轮 ---"

  # 先清理再备份：这样清理产生的归档也在本次备份之前就位，而备份反映的是清理之后的租户数据。
  if retention_is_usable; then
    if ! bin/disk.sh prune-sessions --older-than "$RETENTION" --archive; then
      # 清理失败（比如某个租户的容器停了）不该让整个循环停下来：备份比清理重要。
      echo "会话清理失败，继续备份" >&2
    fi
  fi

  if ! bin/backup.sh --keep "$KEEP"; then
    echo "备份失败，下一轮重试" >&2
  fi

  sleep "$INTERVAL"
done
