#!/usr/bin/env bash
# 租户 DSH 的 RPC 不答话时（model-check 第 2/3 步空、冒烟里 RPC 那几项失败）用它。
#
#   bin/repair-tenant-rpc.sh check [租户]       只读：看这个租户的模型 env、DSH 日志尾、RPC 探针
#   bin/repair-tenant-rpc.sh refresh [租户]     最小修：按容器当前打印的 token 重新注册（不重建容器）
#   bin/repair-tenant-rpc.sh refresh --all      全部租户（推荐先试这个）
#   bin/repair-tenant-rpc.sh fix  [租户]        更重：强制重建容器 → 重新注册 → 复验 RPC
#   bin/repair-tenant-rpc.sh fix --all          对注册表里全部租户做（逐个，慢）
#
# 两种原因，两种修法：
#   refresh —— 容器重启过、token 换了，注册表还是旧的。症状：登录与页面都正常，model-check
#              第 2 步"有 provider 加载失败："（列表为空）、第 3 步"建会话失败"；冒烟里 RPC
#              那几项失败。实测在真机上逐字复现过。重新注册只是把当前 token 报上去，不动容器。
#   fix     —— 容器里的模型 env 与 profile patch 是创建时注入的；`.env` 改过而容器没重建时，
#              provider 会真的加载不起来（日志里会有报错）。重建会把新配置注入，home/workspace
#              是挂载卷，数据不丢。
set -uo pipefail
cd "$(dirname "$0")/.."

die() { echo "$*" >&2; exit 1; }
[ -f tenants.json ] || die "这里不像部署目录（缺 tenants.json）"

if command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else COMPOSE=(docker compose); fi
PREFIX="${MT_CONTAINER_NAME_PREFIX:-mt-}"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

field() { # $1 = 租户, $2 = 字段
  python3 -c '
import json, sys
doc = json.load(open("tenants.json", encoding="utf-8"))
t = next((x for x in doc["tenants"] if x["id"] == sys.argv[1]), None)
print("" if t is None else str(t.get(sys.argv[2], "") or ""))
' "$1" "$2"
}

probe() { # RPC 探针：问一次模型目录。答话就是好的。
  local t="$1" pw user out
  user="$(python3 -c '
import json, sys
doc = json.load(open("tenants.json", encoding="utf-8"))
t = next((x for x in doc["tenants"] if x["id"] == sys.argv[1]), None)
print("" if not t or not t.get("users") else t["users"][0]["name"])
' "$t")"
  pw="$(python3 -c '
import json, sys
try:
    doc = json.load(open(".acceptance-credentials.json", encoding="utf-8"))
    print(doc.get("tenants", {}).get(sys.argv[1], {}).get("password", ""))
except Exception:
    print("")
' "$t")"
  if [ -z "$pw" ]; then echo "（没有 $t 的口令，跳过 RPC 探针：请先 bin/make-acceptance-credentials.sh）"; return 0; fi
  out="$(bin/model-check.sh --tenant "$t" --user "$user" --password "$pw" 2>&1 | sed -n '2,8p' | tr '\n' ' ')"
  case "$out" in
    *"建会话失败"*|*"provider 加载失败"*) echo "RPC 不通：${out:0:160}" ;;
    *) echo "RPC 通：${out:0:120}" ;;
  esac
}

show() { # 只读诊断
  # 写成两行：`local t="$1" c="$PREFIX$t"` 里 $t 在同一行的展开阶段还没赋值（set -u 会报 unbound）
  local t="$1" c
  c="$PREFIX""dsh-$t"
  docker inspect "$c" >/dev/null 2>&1 || { echo "  $t: 容器 $c 不存在"; return 0; }
  echo "  == $t（$c / $(docker inspect "$c" --format '{{.State.Status}}')）"
  echo "     模型 env: $(docker exec "$c" sh -c 'printf "BASE=%s KEY=%s" "${DEEPSEEK_BASE_URL:-（无）}" "$(printf %s "${DEEPSEEK_API_KEY:-}" | cut -c1-6)"' 2>/dev/null)"
  echo "     日志尾: $(docker logs --tail 3 "$c" 2>&1 | tr '\n' ' ' | head -c 220)"
  echo "     $(probe "$t")"
}

action="${1:-check}"; shift || true
case "$action" in
  check)
    if [ $# -gt 0 ]; then show "$1"; else
      for t in $(python3 -c '
import json
doc = json.load(open("tenants.json", encoding="utf-8"))
print(" ".join(x["id"] for x in doc["tenants"]))
'); do show "$t"; done
    fi
    ;;
  refresh)
    targets="$*"
    case " $targets " in *" --all "*) targets="$(python3 -c '
import json
doc = json.load(open("tenants.json", encoding="utf-8"))
print(" ".join(x["id"] for x in doc["tenants"]))
')" ;; esac
    [ -n "${targets// /}" ] || usage
    for t in $targets; do
      # register 会从容器日志里读**当前这次启动**打印的 token 再上报（旧 token 就这下换掉）
      echo "==> $t：$(bin/mt.sh register "$t" 2>&1 | tail -1)"
    done
    echo
    echo "复验（单租户）：bin/model-check.sh --tenant <租户> --user <用户名> --password '<口令>'"
    echo "全量复验：bin/acceptance.sh | tail -3"
    ;;
  fix)
    targets="$*"
    case " $targets " in *" --all "*) targets="$(python3 -c '
import json
doc = json.load(open("tenants.json", encoding="utf-8"))
print(" ".join(x["id"] for x in doc["tenants"]))
')" ;; esac
    [ -n "${targets// /}" ] || usage
    for t in $targets; do
      c="$PREFIX""dsh-$t"
      service="$(field "$t" service)"; [ -n "$service" ] || service="dsh-$t"
      docker inspect "$c" >/dev/null 2>&1 || { echo "!! $t：容器 $c 不存在，先 bin/mt.sh up" >&2; continue; }
      echo "==> $t：强制重建 $service（home/workspace 是挂载卷，不会丢）"
      "${COMPOSE[@]}" up -d --force-recreate --no-deps "$service" >/dev/null 2>&1 \
        || { echo "!! $t：重建失败，手工跑 ${COMPOSE[*]} up -d --force-recreate --no-deps $service 看输出" >&2; continue; }
      echo "    等容器 running…"
      for _ in $(seq 1 30); do
        [ "$(docker inspect "$c" --format '{{.State.Status}}' 2>/dev/null)" = running ] && break
        sleep 2
      done
      # 重建后启动 token 会换，控制面必须重新拿到它（网关按 token 激活 DSH 会话）。
      echo "    重新注册（新 token）：$(bin/mt.sh register "$t" 2>&1 | tail -1)"
      show "$t"
    done
    echo
    echo "复验（单租户）：bin/model-check.sh --tenant <租户> --user <用户名> --password '<口令>'"
    echo "全量复验：bin/acceptance.sh | tail -3"
    ;;
  -h|--help|*) usage ;;
esac
