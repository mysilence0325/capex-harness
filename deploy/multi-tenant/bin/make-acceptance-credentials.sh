#!/usr/bin/env bash
# 生成验收用的凭据文件（默认 .acceptance-credentials.json），一条命令搞定。
#
#   bin/make-acceptance-credentials.sh --admin-password '<至少8位>'            # 复用现有明文口令（--from 指定的文件）
#   bin/make-acceptance-credentials.sh --rotate --admin-password '<至少8位>'   # 找不到明文就重置（新口令打印一次）
#   bin/make-acceptance-credentials.sh --from .tenant-credentials.json --admin-password '...'
#
# 它做四件事：读注册表拿"租户 + 用户名" → 拿到口令（--from 复用，或 --rotate 重置）
# → 写凭据文件（0600）→ 设好控制台管理员口令并实测登录一次。最后打印一张表，
# 重置出来的口令只在这里出现一次，请自己存好（发给本人时走一次性渠道）。
set -uo pipefail
cd "$(dirname "$0")/.."

FROM=""; ROTATE=no; ADMIN_PW=""; MFA_PW="MfaAccept2026x"; OUT=".acceptance-credentials.json"; SET_ADMIN=yes
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from)            FROM="${2:-}"; shift 2 ;;
    --rotate)          ROTATE=yes; shift ;;
    --admin-password)  ADMIN_PW="${2:-}"; shift 2 ;;
    --mfa-password)    MFA_PW="${2:-}"; shift 2 ;;
    --out)             OUT="${2:-}"; shift 2 ;;
    --no-set-admin)    SET_ADMIN=no; shift ;;
    -h|--help)         sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                 echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

die() { echo "$*" >&2; exit 1; }
[ -f tenants.json ] || die "这里不像部署目录（缺 tenants.json）"
command -v python3 >/dev/null 2>&1 || die "需要 python3（读注册表与写凭据文件）"
[ -n "$ADMIN_PW" ] || die "缺 --admin-password '<至少8位>'：验收的控制台检查要用它登录控制台"
[ "${#ADMIN_PW}" -ge 8 ] || die "管理员口令至少 8 位"
[ "${#MFA_PW}" -ge 8 ] || die "mfa 口令至少 8 位（随便给一个字符串即可）"

PAIRS="$(python3 - <<'PY'
import json
doc = json.load(open("tenants.json", encoding="utf-8"))
for tenant in doc.get("tenants", []):
    users = tenant.get("users") or []
    if users:
        print(tenant["id"], users[0]["name"])
PY
)" || die "读 tenants.json 失败"
[ -n "$PAIRS" ] || die "注册表里没有租户"

# 没有用户的租户：没人能登录，也没法重置口令（口令属于用户，不属于租户），而且渲染会
# 直接失败（render.js: "tenant X needs at least one user"）——所以正常部署里不该存在。
# 这里点名，别让它在凭据文件里被静默跳过。
NOUSER="$(python3 - <<'PY'
import json
doc = json.load(open("tenants.json", encoding="utf-8"))
print(" ".join(t["id"] for t in doc.get("tenants", []) if not (t.get("users") or [])))
PY
)"
if [ -n "${NOUSER// /}" ]; then
  echo "!! 这些租户在注册表里没有用户：$NOUSER" >&2
  echo "   没有用户 = 没人能登录，也没法重置口令（口令挂在用户上）。修法（数据保留）：" >&2
  echo "     bin/mt.sh remove <租户>            # 只摘注册表与容器，tenants/<租户>/ 数据不动" >&2
  echo "     bin/mt.sh add <租户> --user <用户名>  # 新口令打印一次，然后 bin/mt.sh up" >&2
fi

CREDS=""
if [ -n "$FROM" ]; then
  [ -f "$FROM" ] || die "找不到 $FROM"
  # 复用明文口令：支持 {"tenants":{"<id>":{"password":..}}} 与 {"<id>":{"password":..}} 两种
  CREDS="$(python3 - "$FROM" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rows = doc.get("tenants", doc)
for tenant, entry in rows.items():
    if isinstance(entry, dict) and entry.get("password"):
        print(tenant, entry["password"])
PY
)" || die "读 $FROM 失败"
fi
lookup_password() { # $1 = 租户
  printf '%s\n' "$CREDS" | awk -v t="$1" '$1 == t { print $2 }' | head -1
}

if [ -z "$CREDS" ] && [ "$ROTATE" != yes ]; then
  die "没有现成的明文口令可用。两种办法：
  ① 找到建租户时用的凭据文件，然后： bin/make-acceptance-credentials.sh --from <那个文件> --admin-password '<口令>'
  ② 直接重置（12 个租户的新口令会打印出来，请存好并重新发给本人）：
     bin/make-acceptance-credentials.sh --rotate --admin-password '<口令>'"
fi

echo "==> 租户与用户名（来自 tenants.json）"
printf '%s\n' "$PAIRS" | awk '{ printf "    %-16s %s\n", $1, $2 }'

ROWS=""
MISSING=""
while read -r id user; do
  [ -n "${id:-}" ] || continue
  pw="$(lookup_password "$id")"
  if [ -z "$pw" ]; then
    if [ "$ROTATE" = yes ]; then
      OUT_TXT="$(bin/mt.sh passwd "$id" "$user" 2>&1)"
      pw="$(printf '%s' "$OUT_TXT" | sed -n 's/^ *password: *//p' | head -1)"
      [ -n "$pw" ] || die "重置 $id/$user 失败：$OUT_TXT"
      echo "==> 已重置 $id/$user"
    else
      MISSING="$MISSING $id"
      continue
    fi
  fi
  ROWS="$ROWS$id $user $pw"$'\n'
done <<< "$PAIRS"

if [ -n "${MISSING// /}" ]; then
  die "这些租户在 $FROM 里没有口令：$MISSING（要么补全，要么加 --rotate 重置）"
fi

printf '%s' "$ROWS" | python3 -c '
import json, sys
rows = [line.split(None, 2) for line in sys.stdin.read().splitlines() if line.strip()]
doc = {"tenants": {t[0]: {"user": t[1], "password": t[2]} for t in rows},
       "admin": {"user": "admin", "password": sys.argv[1]},
       "mfa": {"password": sys.argv[2]}}
with open(sys.argv[3], "w", encoding="utf-8") as handle:
    json.dump(doc, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
' "$ADMIN_PW" "$MFA_PW" "$OUT" || die "写 $OUT 失败"
chmod 600 "$OUT"
echo "==> 已写 $OUT（0600，${OUT} 属于明文口令，别外传、别进版本库）"

# 口令表先打出来再碰管理员那一步：曾经把它放在后面，结果管理员设置失败时脚本提前退出，
# 重置出来的口令一次都没显示过——那 12 个用户的口令谁也不知道了，只能再重置一遍。
# 顺序就按"先落地、再打印、最后动控制台"。
echo
echo "==> 租户口令（重置出来的只在这里出现一次，请存好并按需要重新发给本人）"
printf '%s' "$ROWS" | awk '{ printf "    %-16s %-14s %s\n", $1, $2, $3 }'

# 控制台管理员：默认设成传进来的那个口令，免得"文件里的和实际的不一致"这种假失败。
# 这台机器上还没建过管理员时先建一个——没有管理员的控制台是登不进去的（验收里那几段
# 控制台检查就会跳过或报错），这正是实测遇到的情况。
if [ "$SET_ADMIN" = yes ]; then
  echo
  # 列表是"名字 角色 创建时间"三列、带前导空格的表格，所以不能只匹配行首。
  if bin/mt.sh admin-users list 2>/dev/null | grep -qE '^[[:space:]]*admin([[:space:]]|$)'; then
    echo "==> 设置控制台管理员口令（同时吊销已登录的管理员会话）"
    bin/mt.sh admin-passwd "$ADMIN_PW" >/dev/null 2>&1 || echo "!! 设置管理员口令失败（bin/mt.sh admin-passwd）；文件已经写好，控制台那几段验收会跳过" >&2
  else
    echo "==> 这台机器还没有控制台管理员：创建 admin（角色 admin）"
    bin/mt.sh admin-add admin --role admin --password "$ADMIN_PW" >/dev/null 2>&1 \
      || echo "!! 创建管理员失败（bin/mt.sh admin-add admin --role admin --password '<口令>'）；文件已经写好，控制台那几段验收会跳过" >&2
  fi
fi

# 实测一次控制台登录：文件里的口令对不对，这一条说了算。
if [ -f bin/lib-http.sh ]; then
  # shellcheck disable=SC1091
  . bin/lib-http.sh
fi
CODE="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/__mt/admin/login \
  --data-urlencode "user=admin" --data-urlencode "password=$ADMIN_PW" 2>/dev/null || true)"
if [ "$CODE" = "303" ]; then
  echo "==> 控制台登录实测通过（303）"
else
  echo "!! 控制台登录实测返回 ${CODE:-无响应}：文件已写好（租户口令可用），但控制台登录没通。" >&2
  echo "   先 bin/mt.sh admin-users list 看有没有 admin；没有就 bin/mt.sh admin-add admin --role admin --password '<口令>'；" >&2
  echo "   已有却登不进就看 bin/mt.sh logs gateway。" >&2
fi

echo
echo "下一步："
echo "    bin/mt.sh doctor        # 期望 0 项失败"
echo "    bin/acceptance.sh       # 期望 0 项失败、跳过项明显减少（每租户冒烟、控制台、Key 登录都会真跑）"
echo "    bin/model-check.sh --tenant $(printf '%s' "$ROWS" | head -1 | awk '{print $1}') --user $(printf '%s' "$ROWS" | head -1 | awk '{print $2}') --password '<上表里对应的口令>'"
