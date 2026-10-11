#!/usr/bin/env bash
# 一个租户当前的配额与限速状态，供控制台显示。
#
# 只读。控制台点一下"查看"就走这里，免得为了看一眼状态去敲两条命令。
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== 网络限速 =="
bash bin/bandwidth.sh show 2>&1 | sed 's/^/  /'

echo
echo "== 磁盘配额 =="
bash bin/quota.sh check 2>&1 | sed 's/^/  /'
echo
if [ -s state/quota.json ]; then
  echo "  已记下的配额意图:"
  python3 -c '
import json
d = json.load(open("state/quota.json", encoding="utf-8"))
for tenant in sorted(d):
    print(f"    {tenant}: {d[tenant].get(\"size\")}")
' 2>/dev/null | sed 's/^/  /'
else
  echo "  没有记下任何配额意图"
fi
echo
echo "== 实际占用 =="
for d in tenants/*/; do
  [ -d "$d" ] || continue
  printf '  %-8s %s\n' "$(basename "$d")" "$(du -sh "$d" 2>/dev/null | awk '{print $1}')"
done
