#!/usr/bin/env bash
# 导出单个租户。包装 bin/tenant-transfer.js：节点代理用 bash 执行操作脚本，
# 而这个脚本是 node 写的；代理容器里有 node，宿主机没有，所以包装一层。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node bin/tenant-transfer.js export "$@"
