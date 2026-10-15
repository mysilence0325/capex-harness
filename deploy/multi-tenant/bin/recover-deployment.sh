#!/usr/bin/env bash
# 停机/半停之后的一键复位：清孤儿容器 → 清验收探针租户 → up → 重新登记 token → 自检。
#
#   bin/recover-deployment.sh                 # 正常使用
#   bin/recover-deployment.sh --keep-probes   # 保留 accptNNNNNN 探针租户
#   bin/recover-deployment.sh --no-up         # 只清理与登记，不起栈
#
# 为什么需要它：这套栈被停过（`docker stop`/`down`/重建）之后有两类残留会让下一次 up 失败或
# 让"页面能开、API 全挂"：
#   · `Created` 状态的孤儿容器（上次 up 中途失败留下的，占着容器名）；
#   · 验收的"控制台建/删租户"测试留下的探针租户（名字形如 accpt145630）。
# 另外容器重建会换启动 token，控制面拿着旧 token 时会拒掉一切 API 调用 —— 所以最后一步
# 一定是 refresh --all，而不是可选项。
set -uo pipefail
cd "$(dirname "$0")/.."

KEEP_PROBES=no; DO_UP=yes
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep-probes) KEEP_PROBES=yes; shift ;;
    --no-up)       DO_UP=no; shift ;;
    -h|--help)     sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ -f tenants.json ] || { echo "这里不像部署目录（缺 tenants.json）" >&2; exit 1; }
PREFIX="${MT_CONTAINER_NAME_PREFIX:-mt-}"

echo "== 1/5 清掉 Created 状态的孤儿容器（只认本部署前缀）"
ORPHANS="$(docker ps -a --filter status=created --format '{{.Names}}' 2>/dev/null \
  | grep -E "(^|_)${PREFIX}(gateway|model-gateway|node-agent|egress-proxy|backup|dsh-)" || true)"
if [ -z "$ORPHANS" ]; then
  echo "    没有"
else
  printf '%s\n' "$ORPHANS" | sed 's/^/    删除 /'
  printf '%s\n' "$ORPHANS" | while read -r name; do [ -n "$name" ] && docker rm -f "$name" >/dev/null 2>&1 || true; done
fi

echo "== 2/5 清掉验收留下的探针租户（accptNNNNNN）"
PROBES="$(python3 -c '
import json, re
try:
    document = json.load(open("tenants.json", encoding="utf-8"))
except Exception:
    raise SystemExit(0)
print(" ".join(t["id"] for t in document.get("tenants", []) if re.fullmatch(r"accpt[0-9]+", t["id"] or "")))
' 2>/dev/null || true)"
if [ "$KEEP_PROBES" = yes ]; then
  echo "    --keep-probes：保留 ${PROBES:-（无）}"
elif [ -z "${PROBES// /}" ]; then
  echo "    没有"
else
  for probe in $PROBES; do
    echo "    删除 $probe（连容器与数据）"
    bin/mt.sh remove "$probe" --purge >/dev/null 2>&1 || echo "      !! $probe 删除失败，手工跑 bin/mt.sh remove $probe --purge"
  done
fi

if [ "$DO_UP" = yes ]; then
  echo "== 3/5 起栈：bin/mt.sh up"
  bin/mt.sh up 2>&1 | grep -E 'rendered|applied the shared model block|Container|已注册|入口|!!' | tail -12 || true
else
  echo "== 3/5 按 --no-up 跳过起栈"
fi

echo "== 4/5 重新登记启动 token（重建/重启会换 token，不登记就是"页面能开、API 全挂"）"
if [ -x bin/repair-tenant-rpc.sh ]; then
  bin/repair-tenant-rpc.sh refresh --all 2>&1 | grep -E '^==>' | tail -20
else
  for tenant in $(bin/mt.sh list | cut -f1); do echo "    $tenant: $(bin/mt.sh register "$tenant" 2>&1 | tail -1)"; done
fi

echo "== 5/5 自检"
bin/mt.sh doctor 2>&1 | tail -2

echo
echo "接下来（要你决定的两件）："
echo "  1) 接内网模型：bin/model-setup.sh --key <内网模型 key>        # 写 .env 与 model.patch.yml 并重建"
echo "  2) 真实模型自检：bin/model-check.sh --tenant <租户> --user <用户名> --password '<凭据文件里那条>'"
echo "     第 1 步必须是 303；401=口令不对（用凭据文件里的），429=限流（docker restart ${PREFIX}gateway 后只跑一次）"
echo "  3) 全量验收（只在确认上面都通过后跑一次）：bin/acceptance.sh | tail -3"
