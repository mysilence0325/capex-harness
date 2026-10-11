#!/usr/bin/env bash
# 从归档导入一个租户。见 tenant-export.sh 为什么需要包装。
#
# 归档名由节点代理的白名单校验过：只允许 [A-Za-z0-9._-]+.tar.gz，不含任何分隔符。
# 所以这里拼上 exports/ 前缀是安全的——用户输入不可能变成路径。
# 不拼的话脚本会按当前目录找，而归档在 exports/ 里，结果就是"找不到归档"。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node bin/tenant-transfer.js import "exports/$1" "${@:2}"
