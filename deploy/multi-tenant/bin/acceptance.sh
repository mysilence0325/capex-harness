#!/usr/bin/env bash
# 部署验收：把这一段里用过的关键断言固化成可以反复跑的脚本。
#
# 为什么需要它：这一段工作中我至少八次把"设置失败的测试"读成了通过——查错文件、
# 查错页面、grep 变量名而不是程序打印的文字、用 head 把结果截掉、脚本在编译期就死了
# 却以为跑过了。每次真正救场的是那些"没跑就过不了"的断言。那些断言当时都写在临时脚本里，
# 跑完就删了，于是下一次改动没有回归网。
#
# 这个脚本的纪律：
#   1. 每条检查要么是【正向结果】（登录成功、计数增加、规则出现），要么是
#      【可检测的反向】（用了错误的密钥必须不是 200）。不做"什么都没发生也算过"的检查。
#   2. 抓页面时明确区分【登录页】与【登录后的控制台页】——这两者我搞错过两次。
#   3. 断言程序【打印出来的字】，不去 grep 源码里的变量名——那样在消息变了以后会假阴性。
#   4. --self-test 会故意跑一条必然失败的检查，确认检查器本身会报失败。
#      一个永远报成功的检查器比没有检查器更糟。
#
# 用法：
#   bin/acceptance.sh              # 全部检查（会临时建/删一个测试管理员，其余只读）
#   bin/acceptance.sh --self-test  # 证明这个检查器会失败
#   bin/acceptance.sh --quick      # 跳过会改状态的检查（MFA 绑定、告警投递）
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0; SKIP=0
pass() { printf '  [OK ] %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  [BAD] %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip() { printf '  [-- ] %s\n' "$1"; SKIP=$((SKIP + 1)); }
head_() { printf '\n\033[36m== %s ==\033[0m\n' "$1"; }

# 断言两个值相等。这是脚本里唯一判定通过的地方，好让 --self-test 能验证它会失败。
assert_eq() {
  local want="$1" got="$2" label="$3"
  if [ "$want" = "$got" ]; then pass "$label（$got）"; else fail "$label：期望 $want，实际 $got"; fi
}

SELF_TEST=no
QUICK=no
for a in "$@"; do
  [ "$a" = "--self-test" ] && SELF_TEST=yes
  [ "$a" = "--quick" ] && QUICK=yes
done

IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1)"
EDGE="$(grep '^MT_EDGE_PORT=' .env 2>/dev/null | cut -d= -f2)"; EDGE="${EDGE:-8090}"
# 前置代理把我们挂在哪个子路径下（浏览器看到的入口）。留空 = 直接挂在根路径。
MT_BASE="$(grep '^MT_BASE_PATH=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"; MT_BASE="${MT_BASE%/}"
TENANTS="$(grep -o '"id": *"[a-z0-9-]*"' tenants.json 2>/dev/null | sed 's/.*"\([a-z0-9-]*\)"$/\1/' | tr '\n' ' ')"

# 本机租户 / 远端租户：多机之后"所有租户"与"本机的租户"不是一回事。容器、限额、
# seccomp、隔离、占位 key 这些只能在本机租户上查；远端租户由它所在的节点负责
# （在那边跑 bin/mt.sh doctor）。
NODE_OF() { grep -A6 "\"id\": \"$1\"" tenants.json 2>/dev/null | grep -o '"node": *"[^"]*"' | head -1 | cut -d'"' -f4; }
LOCAL_TENANTS=""
REMOTE_TENANTS=""
for t in $TENANTS; do
  case "$(NODE_OF "$t")" in
    ""|local) LOCAL_TENANTS="$LOCAL_TENANTS $t" ;;
    *)        REMOTE_TENANTS="$REMOTE_TENANTS $t" ;;
  esac
done
LOCAL_TENANT_COUNT="$(printf '%s' "$LOCAL_TENANTS" | wc -w)"

# 宿主机没有 curl 时用容器里的顶（局域网装不了包的情况）；有 curl 时它什么都不做。
# shellcheck disable=SC1091
. bin/lib-http.sh

# 口令不写进仓库：从部署机上这个 0600 文件读。它【不放在 state/ 里】——那个目录会进
# 备份归档，把明文口令塞进备份是降级。文件不存在时，用得到口令的检查会明确跳过，
# 而不是默默算作通过。
CREDS="$PWD/.acceptance-credentials.json"
cred() {
  [ -f "$CREDS" ] || return 0
  python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(0)
node = d
for key in sys.argv[2:]:
    if not isinstance(node, dict):
        sys.exit(0)
    node = node.get(key)
print(node if isinstance(node, str) else "")
' "$CREDS" "$@" 2>/dev/null
}

http() { curl -sSk -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null; }

if [ "$SELF_TEST" = yes ]; then
  head_ "--self-test：检查器本身必须会失败"
  before_fail="$FAIL"
  assert_eq "a" "b" "这条必然失败（如果它被报成通过，说明检查器只会说好话）"
  if [ "$FAIL" -gt "$before_fail" ]; then
    printf '  检查器正确地把假命题报成了失败 ✓（fail 计数 %s → %s）\n' "$before_fail" "$FAIL"
    exit 0
  fi
  printf '  ✗ 检查器把假命题报成了通过 —— 这个脚本的所有结果都不可信\n'
  exit 1
fi

printf '验收对象: %s（入口 %s）\n租户: %s\n' "$PWD" "$EDGE" "$TENANTS"

# ---------------------------------------------------------------- 部署健康
head_ "部署健康"
# 期望值按配置推导，不写死：容器名前缀是可配的（同机第二套部署、演练会换），租户数
# 更是随部署而变——写死 9 会在"不是 4 个租户"的机器上误报，而那正是真实部署。
PREFIX_CFG="$(grep '^MT_CONTAINER_NAME_PREFIX=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
PREFIX_CFG="${PREFIX_CFG:-mt-}"
PREFIX="$PREFIX_CFG"
SINK_CFG="$(grep '^MT_ALERT_SINK_CONTAINER=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
SINK_CFG="${SINK_CFG:-dsh-alert-sink}"
# 本机容器数 = 与租户无关的 5 个 + **本机**租户数。远端租户的容器在别的机器上，
# 算进来只会让这条断言在多机部署上必然失败。
TENANT_COUNT="$LOCAL_TENANT_COUNT"
# 与租户无关的部署容器：网关、模型网关、出口代理、定时备份、节点代理
BASE_CONTAINERS=5
N="$(docker ps --filter "name=^${PREFIX_CFG}" --format '{{.Names}}' | wc -l)"
assert_eq "$((BASE_CONTAINERS + TENANT_COUNT))" "$N" "$((BASE_CONTAINERS + TENANT_COUNT)) 个部署容器在运行（${BASE_CONTAINERS} 固定 + ${TENANT_COUNT} 租户）"
SINK="$(docker ps --filter "name=^${SINK_CFG}" --format '{{.Names}}' | wc -l)"
assert_eq "1" "$SINK" "告警接收器在运行"

for t in $TENANTS; do
  U="$(cred tenants "$t" user)"
  P="$(cred tenants "$t" password)"
  [ -z "$U" ] && U="$(cred tenants "$t" user)"
  if [ -z "$P" ]; then
    skip "$t 没有可用口令（在 $CREDS 里补 tenants.$t.user/password）"
    continue
  fi
  R="$(bin/mt.sh smoke --tenant "$t" --user "$U" --password "$P" 2>&1 | grep -o '结果.*')"
  # 断言"0 失败"而不是写死条数：检查项会增加（例如把一条一直没被计数的检查接回计数），
  # 写死 15 会让加一条检查就报红 —— 那不是发现缺陷，只是数字变了。条数只做下限校验。
  case "$R" in
    *"0 失败"*)
      # 条数在"通过"**前面**：`结果：16 通过，0 失败` —— 用 sed 取，别用前缀/后缀截断
      # （`${R#*通过}` 拿到的是"通过"之后，取不出数字）。
      PASSED="$(printf '%s' "$R" | sed -n 's/.*结果：\([0-9][0-9]*\) 通过.*/\1/p')"
      # 下限按租户住哪儿分：本机租户多两条 home/凭据文件检查（那些文件在本机），
      # 远端租户的 home 在它那台机器上，那两条改由节点上的 doctor 覆盖（远端 14 条）。
      SMOKE_FLOOR=16
      case " $REMOTE_TENANTS " in *" $t "*) SMOKE_FLOOR=14 ;; esac
      if [ -n "$PASSED" ] && [ "$PASSED" -ge "$SMOKE_FLOOR" ]; then pass "$t 冒烟 $R"; else fail "$t 冒烟条数偏少（下限 $SMOKE_FLOOR）：$R"; fi ;;
    *) fail "$t 冒烟 $R" ;;
  esac
done

DOCTOR="$(bin/mt.sh doctor 2>&1 | tail -1 | sed 's/^ *//')"
case "$DOCTOR" in *"0 项失败"*) pass "doctor $DOCTOR" ;; *) fail "doctor $DOCTOR" ;; esac

# ---------------------------------------------------------------- 监控链路
head_ "监控与告警"
# Prometheus 既不保证在本机、也不叫某个固定名字：写死一个容器名会让"这台机器上没有
# Prometheus"变成一条红字缺陷（实测在真机上就是这样）。优先 MT_PROMETHEUS_URL（直连，
# 容器外的 Prometheus 也算），其次 MT_PROMETHEUS_CONTAINER，再次在本机容器里找一个
# 名字含 prometheus 的；都没有就跳过这两条并说清楚该怎么接。
PROM_BASE="${MT_PROMETHEUS_URL:-}"
# 候选：显式指定的在前，其次本机所有名字含 prometheus 的容器。一台机器上可能有
# 好几套 stack 各自的 Prometheus（实测 .137 上就有两台），随手取第一个会问到
# **没在抓我们**的那个，然后报一条不存在的缺陷——所以要逐个问"谁在抓 dsh-multitenant"。
prom_candidates() {
  {
    [ -n "${MT_PROMETHEUS_CONTAINER:-}" ] && printf '%s\n' "$MT_PROMETHEUS_CONTAINER"
    docker ps --format '{{.Names}}' 2>/dev/null | grep -i prometheus || true
  } | awk 'NF' | awk '!seen[$0]++'
}
prom_get() { # $1 = 候选容器, $2 = 路径
  docker exec "$1" wget -q -O - "http://127.0.0.1:9090$2" 2>/dev/null
}
PROM_USED=""; TARGET=""; RULES=""
if [ -n "$PROM_BASE" ]; then
  PROM_USED="$PROM_BASE"
  TARGET="$(curl -sSk --max-time 10 "$PROM_BASE/api/v1/targets" 2>/dev/null | sed 's/},{/}\n{/g' | grep dsh-multitenant | grep -o '"health":"up"' | head -1)"
  RULES="$(curl -sSk --max-time 10 "$PROM_BASE/api/v1/rules" 2>/dev/null | grep -o '"name":"Dsh[A-Za-z]*"' | wc -l)"
else
  for c in $(prom_candidates); do
    T="$(prom_get "$c" /api/v1/targets | sed 's/},{/}\n{/g' | grep dsh-multitenant | grep -o '"health":"up"' | head -1)"
    [ -n "$T" ] || continue
    PROM_USED="$c"
    TARGET="$T"
    RULES="$(prom_get "$c" /api/v1/rules | grep -o '"name":"Dsh[A-Za-z]*"' | wc -l)"
    break
  done
  # 没人抓我们：拿第一个候选当上下文去报错（比"实际（空）"有用）
  [ -n "$PROM_USED" ] || PROM_USED="$(prom_candidates | head -1)"
fi
if [ -z "$PROM_USED" ]; then
  skip "抓取目标 up（本机没有 Prometheus：装一个，或用 MT_PROMETHEUS_URL / MT_PROMETHEUS_CONTAINER 指向你们的）"
  skip "DSH 告警规则（同上；规则由 bin/mt.sh wire-prometheus 写进去）"
else
  assert_eq '"health":"up"' "$TARGET" "抓取目标 up（$PROM_USED）"
  [ "$RULES" -ge 12 ] && pass "DSH 告警规则 $RULES 条（≥12，在 $PROM_USED）" \
    || fail "DSH 告警规则只有 $RULES 条（在 $PROM_USED；执行 bin/mt.sh wire-prometheus 把规则写进去）"
fi

# 正向：投一条告警，落盘条数必须增加。数不变说明链路断了，而不是"没变化也算过"。
LOGFILE=state/alerts/alerts.jsonl
if [ "$QUICK" = yes ]; then
  skip "告警投递（--quick 跳过）"
else
  BEFORE_ALERTS="$(wc -l < "$LOGFILE" 2>/dev/null || echo 0)"
  # 接收器没起时，"落盘没增加"是必然的，而原因不是链路断了。分开报，并把命令写出来。
  if [ "$SINK" = "0" ]; then
    fail "告警投递：接收器没在运行（bin/mt.sh alert-sink up 起它，再 bin/mt.sh alert-sink test 验证）"
  else
    bin/mt.sh alert-sink test >/dev/null 2>&1
    AFTER_ALERTS="$(wc -l < "$LOGFILE" 2>/dev/null || echo 0)"
    [ "$AFTER_ALERTS" -gt "$BEFORE_ALERTS" ] && pass "告警投递：落盘 $BEFORE_ALERTS → $AFTER_ALERTS 条" \
      || fail "告警投递：落盘没有增加（$BEFORE_ALERTS → $AFTER_ALERTS）——看 bin/mt.sh alert-sink status 与 logs"
  fi
fi

# ---------------------------------------------------------------- 密钥权限
head_ "密钥拆分"
MKEY="$(grep -o '"metrics": *"[^"]*"' state/keys.json 2>/dev/null | sed 's/.*: *"//; s/"$//')"
RKEY="$(grep -o '"register": *"[^"]*"' state/keys.json 2>/dev/null | sed 's/.*: *"//; s/"$//')"
PURPOSES="$(grep -o '"[a-z]*": *"' state/keys.json 2>/dev/null | wc -l)"
[ "$PURPOSES" -ge 3 ] && pass "state/keys.json 有 $PURPOSES 把密钥" || fail "state/keys.json 只有 $PURPOSES 把密钥"
assert_eq "200" "$(http -H "x-mt-registry-key: $MKEY" "https://$IP:$EDGE/__mt/metrics")" "指标密钥可读指标"
# 反向且可检测：注册密钥不该能读指标。若它也能读，说明拆分没生效。
NON200="$(http -H "x-mt-registry-key: $RKEY" "https://$IP:$EDGE/__mt/metrics")"
[ "$NON200" != "200" ] && pass "注册密钥读不到指标（$NON200）" || fail "注册密钥也能读指标 —— 拆分没生效"

# ---------------------------------------------------------------- 控制台
head_ "控制台"
# 登录页与登录后的页面是两个东西。我搞错过两次，所以这里分别抓、分别断言。
LOGIN_HTML="$(curl -sSk --max-time 15 "http://127.0.0.1:8099/__mt/admin" 2>/dev/null)"
printf '%s' "$LOGIN_HTML" | grep -q 'name="password"' && pass "未登录时拿到的是登录页" || fail "未登录时拿到的不是登录页"
printf '%s' "$LOGIN_HTML" | grep -q 'id="login-code"' && pass "登录页有验证码字段" || fail "登录页缺验证码字段"

JAR="$(mktemp)"
ADMIN_USER="$(cred admin user)"; ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PW="$(cred admin password)"
if [ -z "$ADMIN_PW" ]; then
  skip "管理员登录与控制台检查（$CREDS 里缺 admin.password）"
  CODE="skip"
else
  CODE="$(curl -sS -o /dev/null -w '%{http_code}' -c "$JAR" --data-urlencode "user=$ADMIN_USER" --data-urlencode "password=$ADMIN_PW" http://127.0.0.1:8099/__mt/admin/login)"
fi
[ "$CODE" = "skip" ] || assert_eq "303" "$CODE" "管理员登录"
CONSOLE_HTML="$([ "$CODE" = "skip" ] && echo '' || curl -sS -b "$JAR" http://127.0.0.1:8099/__mt/admin 2>/dev/null)"
if [ "$CODE" = "skip" ]; then
  skip "控制台页的按钮与筛选控件"
else
  for needle in tenantExport tenantImport hist-tenant hist-q new-user; do
    printf '%s' "$CONSOLE_HTML" | grep -q "$needle" && pass "控制台页含 $needle" || fail "控制台页缺 $needle"
  done
fi

# 历史筛选：正向断言"返回的每一条都真的属于该租户"。
if [ "$CODE" = "skip" ]; then
  skip "历史筛选（没有管理员会话）"
else
HIST="$(curl -sS -b "$JAR" -X POST -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:8099' \
  -d '{"action":"ops-history","limit":500,"tenantFilter":"alpha"}' http://127.0.0.1:8099/__mt/admin/api/tenant 2>/dev/null)"
printf '%s' "$HIST" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("BAD 历史接口返回的不是 JSON: %s" % e); sys.exit(0)
rows = d.get("entries", [])
others = sorted({str(r.get("tenant")) for r in rows} - {"alpha"})
if not rows:
    print("BAD 筛选 alpha 返回 0 条（无法证明筛选正确）")
elif others:
    print("BAD 筛选 alpha 的结果里混入了 %s" % others)
else:
    print("OK 筛选 alpha 返回 %d 条，全部属于 alpha（共匹配 %s / 总计 %s）" % (len(rows), d.get("matched"), d.get("total")))
' | while read -r line; do
  case "$line" in OK*) pass "${line#OK }" ;; BAD*) fail "${line#BAD }" ;; esac
done
fi

# 建租户 / 删租户：管理员在控制台上最常做的两件事。真的建一个、等它就绪、再连数据删掉，
# 并确认注册表、容器、数据目录都回到原样 —— 只看接口返回 ok 不算（删租户曾经返回
# ok:false 而后台其实删干净了：节点代理先摘掉注册表条目，控制面再读就以为不存在）。
if [ "$CODE" = "skip" ]; then
  skip "控制台建租户/删租户（没有管理员会话）"
else
  PROBE_TENANT="accpt$(date -u +%H%M%S)"
  POST_TENANT="$(curl -sS -b "$JAR" -X POST -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:8099' \
    -d "{\"tenant\":\"$PROBE_TENANT\",\"action\":\"add\",\"user\":\"acctpuser\",\"title\":\"验收探针\"}" \
    http://127.0.0.1:8099/__mt/admin/api/tenant 2>/dev/null)"
  printf '%s' "$POST_TENANT" | grep -q '"ok":true' && pass "控制台新建租户 $PROBE_TENANT（带首个用户）" \
    || fail "控制台新建租户失败：$(printf '%s' "$POST_TENANT" | sed 's/"password":"[^"]*"/"password":"<hidden>"/g' | head -c 200)"
  printf '%s' "$POST_TENANT" | grep -q '"password"' && pass "新建租户回执带初始密码" || fail "新建租户没有返回初始密码"
  READY=no
  for _ in $(seq 1 20); do
    sleep 3
    curl -sS -b "$JAR" http://127.0.0.1:8099/__mt/admin/api/state 2>/dev/null | python3 -c "
import json, sys
try:
    rows = json.load(sys.stdin).get('tenants', [])
except Exception:
    sys.exit(0)
row = [t for t in rows if t.get('id') == '$PROBE_TENANT']
print('ready' if row and row[0].get('ready') else '')
" | grep -q ready && { READY=yes; break; }
  done
  [ "$READY" = "yes" ] && pass "新租户在 60 秒内就绪（容器起来了并被注册）" || fail "新租户始终没有就绪"
  LONG="$(curl -sS -b "$JAR" -X POST -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:8099' \
    -d "{\"tenant\":\"$PROBE_TENANT\",\"action\":\"remove\",\"purge\":true}" \
    http://127.0.0.1:8099/__mt/admin/api/tenant 2>/dev/null)"
  printf '%s' "$LONG" | grep -q '"ok":true' && pass "控制台删除租户（含数据）报成功" \
    || fail "删除租户报了失败，但其实可能已经删掉：$(printf '%s' "$LONG" | head -c 200)"
  sleep 2
  [ -d "tenants/$PROBE_TENANT" ] && fail "租户数据目录还在：tenants/$PROBE_TENANT" || pass "租户数据目录已清除"
  docker ps -a --format '{{.Names}}' | grep -q "${PREFIX}dsh-$PROBE_TENANT" && fail "容器残留：mt-dsh-$PROBE_TENANT" || pass "容器已移除"
  grep -q "\"$PROBE_TENANT\"" tenants.json && fail "注册表里还有该租户" || pass "注册表已摘除"
  # .env 里的租户键曾留在原地，doctor 会一直报"已删租户的残留键"。
  PROBE_ENV_PREFIX="MT_$(printf '%s' "$PROBE_TENANT" | tr '[:lower:]' '[:upper:]')_"
  grep -q "^${PROBE_ENV_PREFIX}" .env && fail "该租户的 .env 键还在：$(grep -c "^${PROBE_ENV_PREFIX}" .env) 行" \
    || pass "该租户在 .env 里的键已清掉"
  # 该租户的网络也要一起收掉，否则会留下挂着模型网关端点的孤儿网络。
  docker network inspect "${MT_NETWORK:-mt-net}-$PROBE_TENANT" >/dev/null 2>&1 \
    && fail "该租户的网络还在：${MT_NETWORK:-mt-net}-$PROBE_TENANT" || pass "该租户的网络已删除"
fi
rm -f "$JAR"

# ---------------------------------------------------------------- 隔离与策略
head_ "隔离与策略"
# 加固策略按租户启用（见 security/README.md）：只有 `MT_SECCOMP_TENANTS` 里列出的租户带那份
# 追加拒绝的策略，留空则全部用 Docker 默认策略——"先放一个租户看它跑得正常再放开下一个"是刻意的。
# 所以这里断言"**配了就必须真的生效**"，并把未加固的租户点名报出来：那是选择，但必须看得见。
SECCOMP_CFG="$(grep '^MT_SECCOMP_TENANTS=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr ',' ' ')"
ON_PROFILE=""
for t in $SECCOMP_CFG; do
  if printf '%s\n' "$TENANTS" | grep -qw "$t"; then
    # 远端租户的容器不在这台机器上：它的加固要在它所在的节点上查（那边跑 doctor/验收）。
    if printf '%s\n' "$LOCAL_TENANTS" | grep -qw "$t"; then
      ON_PROFILE="$ON_PROFILE $t"
    fi
  else
    warn_skip="MT_SECCOMP_TENANTS 里的 $t 不在租户注册表里（配置残留，render 会忽略它）"
    skip "$warn_skip"
  fi
done
if [ -z "${ON_PROFILE// /}" ]; then
  skip "seccomp 加固（MT_SECCOMP_TENANTS 为空：全部租户按设计用 Docker 默认策略）"
else
  SEEN=0; MISSING=""
  for t in $ON_PROFILE; do
    if docker inspect "${PREFIX_CFG}dsh-$t" --format '{{range .HostConfig.SecurityOpt}}{{.}}{{end}}' 2>/dev/null | grep -q seccomp; then
      SEEN=$((SEEN + 1))
    else
      MISSING="$MISSING $t"
    fi
  done
  assert_eq "$(printf '%s' "$ON_PROFILE" | wc -w)" "$SEEN" "加固列表里的租户都应用了 seccomp 策略"
  [ -z "${MISSING// /}" ] || fail "这些租户配了加固却没生效：$MISSING（bin/mt.sh up 重新渲染并重建）"
  STILL_DEFAULT=""
  for t in $TENANTS; do
    printf '%s\n' " $ON_PROFILE " | grep -qw "$t" || STILL_DEFAULT="$STILL_DEFAULT $t"
  done
  pass "未列入加固列表的租户（按设计用默认策略）：${STILL_DEFAULT:-无}"
fi

# 租户容器不该能连宿主上的运维端口。
CAN_REACH="$(docker exec "${PREFIX}dsh-$(printf '%s' "$LOCAL_TENANTS" | awk '{print $1}')" sh -c "timeout 4 sh -c 'echo > /dev/tcp/$IP/8099' 2>/dev/null && echo yes || echo no" 2>/dev/null | tr -d '\r')"
assert_eq "no" "${CAN_REACH:-no}" "租户连不上宿主的运维端口"

# ---------------------------------------------------------------- 网络限速
head_ "网络限速"
T1="$(printf '%s' "$TENANTS" | awk '{print $1}')"
bin/mt.sh bandwidth set "$T1" 10mbit --both >/dev/null 2>&1
SHOW="$(bin/mt.sh bandwidth show "$T1" 2>&1)"
printf '%s' "$SHOW" | grep -q '上行已限速' && pass "上行规则已落下" || fail "上行规则没落下"
printf '%s' "$SHOW" | grep -q '下行已限速' && pass "下行规则已落下" || fail "下行规则没落下"
INTENT="$(python3 -c "import json,sys;print(json.load(open('state/bandwidth.json')).get('$T1',{}).get('rate',''))" 2>/dev/null)"
assert_eq "10mbit" "$INTENT" "限速意图已记录"
bin/mt.sh bandwidth clear "$T1" >/dev/null 2>&1
printf '%s' "$(bin/mt.sh bandwidth show "$T1" 2>&1)" | grep -q '未限速' && pass "清除后回到未限速" || fail "清除后仍显示限速"

# ---------------------------------------------------------------- 磁盘配额
head_ "磁盘配额"
QCHECK="$(bin/mt.sh quota check 2>&1)"
printf '%s' "$QCHECK" | grep -q '项目配额' && pass "quota check 可运行" || fail "quota check 没有输出项目配额状态"
if printf '%s' "$QCHECK" | grep -q '已启用'; then
  # 真开了就先设一个配额再读回来 —— 正向断言。
  bin/mt.sh quota set "$T1" 2g >/dev/null 2>&1
  printf '%s' "$(bin/mt.sh quota show 2>&1)" | grep -q "$T1" && pass "配额可设可读" || fail "配额设了读不回来"
  bin/mt.sh quota clear "$T1" >/dev/null 2>&1
else
  # 没开：断言它拒绝时说的是真正的原因（而不是假装设好了）。
  OUT="$(bin/mt.sh quota set "$T1" 2g 2>&1)"
  printf '%s' "$OUT" | grep -q '没有以 prjquota 挂载' && pass "未启用时说明真实原因" || fail "未启用时的说明不对"
  printf '%s' "$OUT" | grep -q '静默无效' && pass "提醒了 remount 无效这个坑" || fail "没有提醒 remount 无效"
  skip "配额的实际拦写（需要先在 fstab 里开 prjquota 并重启）"
fi

# ---------------------------------------------------------------- 控制台的限额操作
head_ "控制台的配额与限速操作"
# 经控制台设，再读回来。只看"接口返回 ok"不算 —— 那可能什么都没落下。
if [ "$QUICK" = yes ]; then
  skip "控制台设限速并读回（--quick 跳过）"
elif [ -z "$ADMIN_PW" ]; then
  # 没有管理员口令就没有会话，后面三条必然红——那是"没测成"，不是"功能坏了"。
  # 这段以前忘了这一判断，实测在一台真机上三条全红，看着像控制台坏了。
  skip "控制台设限速并读回（$CREDS 里缺 admin.password）"
else
  AJAR="$(mktemp)"
  curl -sS -o /dev/null -c "$AJAR" --data-urlencode "user=${ADMIN_USER:-admin}" --data-urlencode "password=$ADMIN_PW"     http://127.0.0.1:8099/__mt/admin/login 2>/dev/null
  adminop() {
    curl -sS -b "$AJAR" -X POST -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:8099' \
      -d "$1" http://127.0.0.1:8099/__mt/admin/api/tenant 2>/dev/null
  }
  LIMT="$(printf '%s' "$TENANTS" | awk '{print $1}')"
  adminop "{\"action\":\"ops\",\"node\":\"local\",\"op\":\"bandwidth-set\",\"params\":{\"tenant\":\"$LIMT\",\"rate\":\"9mbit\",\"direction\":\"both\"}}" >/dev/null
  SHOWN="$(adminop '{"action":"ops","node":"local","op":"limits-report","params":{}}')"
  printf '%s' "$SHOWN" | grep -q '下行已限速' && pass "经控制台设限速后读回显示下行已限速" || fail "经控制台设限速后读回没有限速"
  # 意图也要记下来 —— 代理容器里没有 python3，这里曾经悄悄丢过
  INTENT="$(python3 -c "import json;d=json.load(open('state/bandwidth.json'));print((d.get('$LIMT') or {}).get('direction',''))" 2>/dev/null)"
  assert_eq "both" "$INTENT" "限速意图连方向一起记下（重建后靠它恢复）"
  adminop "{\"action\":\"ops\",\"node\":\"local\",\"op\":\"bandwidth-clear\",\"params\":{\"tenant\":\"$LIMT\"}}" >/dev/null
  printf '%s' "$(adminop '{"action":"ops","node":"local","op":"limits-report","params":{}}')" | grep -q "$LIMT    未限速" \
    && pass "取消后读回未限速" || fail "取消后读回仍显示限速"
  rm -f "$AJAR"
fi

# ---------------------------------------------------------------- 租户磁盘用量
head_ "租户磁盘用量"
MKEY2="$(grep -o '"metrics": *"[^"]*"' state/keys.json 2>/dev/null | sed 's/.*: *"//; s/"$//')"
METRICS="$(curl -sSk -H "x-mt-registry-key: $MKEY2" "https://$IP:$EDGE/__mt/metrics" 2>/dev/null)"
DISK="$(printf '%s' "$METRICS" | grep -E '^mt_tenant_disk_used_bytes' || true)"
if [ -z "$DISK" ]; then
  fail "指标里没有 mt_tenant_disk_used_bytes"
else
  # 用 grep -c 数行数，不用 wc -l：$(...) 会去掉结尾换行，wc -l 因此少数一行。
  # 这个错我犯过一次——检查报"4/3"，而指标本身是对的，误报比没有检查更糟。
  ALL="$(printf '%s' "$DISK" | grep -c '^mt_tenant_disk_used_bytes')"
  NZ="$(printf '%s' "$DISK" | awk '$2 != 0' | grep -c '^mt_tenant_disk_used_bytes')"
  assert_eq "$ALL" "$NZ" "磁盘用量指标全部非零（$NZ/$ALL）—— 0 会看起来像正常值"
  # 与真实目录对账。两边必须是同一种算法：指标是 node-agent 的 measureTenantBytes，
  # 它按**文件字节**累加，不含目录自身；`du -sb` 会把每个目录的 4 KB 也计进去，于是
  # 新建的租户（只有凭据与 patch，六个目录 ≈ 24 KB 比内容还多）必然报"不成比例"——
  # 实测在一台真机上 12 个租户全红，而指标是对的。改成同样只数文件字节，留 ±10% 余量
  # （两次测量之间可能有写入）。
  for t in $LOCAL_TENANTS; do
    M="$(printf '%s' "$DISK" | awk -v t="$t" '$0 ~ "tenant=\"" t "\"" {print $2}')"
    D="$(find "tenants/$t" -type f -printf '%s\n' 2>/dev/null | awk '{ s += $1 } END { printf "%d", s + 0 }')"
    if [ -z "$M" ] || [ -z "$D" ]; then skip "$t 无法对账"; continue; fi
    RATIO="$(awk -v m="$M" -v d="$D" 'BEGIN{ if (d == 0) { print "na"; exit } r = m / d; print (r > 0.9 && r <= 1.1) ? "ok" : "bad" }')"
    [ "$RATIO" = "ok" ] && pass "$t 指标 $M 与目录里文件字节 $D 一致" || fail "$t 指标 $M 与目录里文件字节 $D 不成比例"
  done
fi

# 配额意图：设一个，指标里必须出现限额，再清掉
if [ "$QUICK" = yes ]; then
  skip "配额目标指标（--quick 跳过）"
else
  QT="$(printf '%s' "$TENANTS" | awk '{print $1}')"
  bin/mt.sh quota set "$QT" 2g >/dev/null 2>&1
  # 代理 15 秒一轮，指标要等它上报
  FOUND=""
  for _ in $(seq 1 12); do
    sleep 5
    FOUND="$(curl -sSk -H "x-mt-registry-key: $MKEY2" "https://$IP:$EDGE/__mt/metrics" 2>/dev/null | grep -E '^mt_tenant_disk_limit_bytes' | awk -v t="$QT" '$0 ~ "tenant=\"" t "\"" {print $2}')"
    [ -n "$FOUND" ] && break
  done
  assert_eq "2147483648" "$FOUND" "配额意图出现在指标里（2g）"
  bin/mt.sh quota clear "$QT" >/dev/null 2>&1
fi

# ---------------------------------------------------------------- 多节点与注册
head_ "注册与节点"
NODES="$(python3 -c "import json;d=json.load(open('state/runtimes.json'))['runtimes'];print(','.join(sorted({d[t]['node'] for t in d})))" 2>/dev/null)"
# 运行时表里的节点集合必须**恰好**等于各租户 node 字段的集合：多一个说明有节点上报了
# 不属于它的租户（迁移遗留），少一个说明那台的代理没在注册——那台机器上的用户会 503。
EXPECT_NODES="$(python3 -c "
import json
print(','.join(sorted({t.get('node', 'local') for t in json.load(open('tenants.json'))['tenants']})))
" 2>/dev/null)"
assert_eq "$EXPECT_NODES" "$NODES" "运行时表的节点集合与注册表一致"
REGN="$(python3 -c "import json;print(len(json.load(open('state/runtimes.json'))['runtimes']))" 2>/dev/null)"
assert_eq "$(printf '%s' "$TENANTS" | wc -w)" "$REGN" "每个租户都有注册条目"
# 远端租户的 endpoint 必须真的从那台机器答话——注册成功但地址写错时，只有这条能发现。
for t in $REMOTE_TENANTS; do
  EP="$(python3 -c "
import json
print(json.load(open('state/runtimes.json'))['runtimes'].get('$t', {}).get('endpoint', ''))
" 2>/dev/null)"
  CODE="$(http "$EP/" 2>/dev/null || true)"
  case "$CODE" in
    ""|000) fail "远端租户 $t 的 endpoint 不可达：${EP:-（运行时表里没有它）}" ;;
    *)      pass "远端租户 $t 的 endpoint 可达：$EP（HTTP $CODE）" ;;
  esac
done
STRAY="$(docker ps -a --filter 'label=mt.tenant' --format '{{.Names}}' | while read -r n; do printf '%s' "$TENANTS" | grep -qw "$(docker inspect "$n" --format '{{index .Config.Labels "mt.tenant"}}')" || echo "$n"; done | wc -l)"
assert_eq "0" "$STRAY" "没有已删租户的容器残留"

# ---------------------------------------------------------------- MFA 全流程
head_ "管理员 MFA"
if [ "$QUICK" = yes ]; then
  skip "MFA 全流程（--quick 跳过）"
else
  T=mfaaccept
  # 口令一律来自凭据文件。没有默认值 —— 一个写在仓库里的默认口令，
  # 即使只对"运行时临时创建、结束时删除"的账号有效，也仍然是仓库里的一份口令。
  # 凭据文件缺失时这段检查整体跳过，这正是该有的行为。
  PW="$(cred mfa password)"
  if [ -z "$PW" ]; then
    skip "MFA 全流程（$CREDS 里缺 mfa.password）"
  else
  bin/mt.sh admin-add "$T" --role admin --password "$PW" >/dev/null 2>&1
  SETUP="$(bin/mt.sh admin-mfa setup "$T" 2>&1)"
  SECRET="$(printf '%s' "$SETUP" | grep -o '密钥: [A-Z2-7]*' | awk '{print $2}')"
  [ -n "$SECRET" ] && pass "setup 给出密钥" || fail "setup 没有给出密钥"
  if [ -n "$SECRET" ]; then
    # 代码从【镜像里那份 mfa.js】算出来，顺带证明容器里那份是对的。
    code_for() { docker exec ${PREFIX}gateway node -e 'console.log(require("/app/mfa.js").totp(process.argv[1]))' "$1" 2>/dev/null | tr -d '\r'; }
    login_with() { curl -sS -o /dev/null -w '%{http_code}' --data-urlencode "user=$T" --data-urlencode "password=$PW" --data-urlencode "code=$1" http://127.0.0.1:8099/__mt/admin/login; }

    assert_eq "303" "$(login_with '')" "未确认时仍可登录（不会把人锁在外面）"
    # 反向：错码确认必须被拒。
    bin/mt.sh admin-mfa confirm "$T" --code 000000 >/dev/null 2>&1
    printf '%s' "$(bin/mt.sh admin-mfa status 2>&1)" | grep -q '待确认' && pass "错误验证码不能激活" || fail "错误验证码竟然激活了"
    # 正向：真码激活。
    CONF="$(bin/mt.sh admin-mfa confirm "$T" --code "$(code_for "$SECRET")" 2>&1)"
    printf '%s' "$CONF" | grep -q 'MFA 已为' && pass "真实验证码激活成功" || fail "真实验证码没能激活"
    RECOVERY="$(printf '%s' "$CONF" | grep -oE '[0-9A-F]{5}-[0-9A-F]{5}' | head -1)"
    [ -n "$RECOVERY" ] && pass "给出恢复码" || fail "没有给出恢复码"
    # 这几条是核心：没跑成就不可能通过。
    assert_eq "401" "$(login_with '')" "不带验证码登录被拒"
    assert_eq "401" "$(login_with '123456')" "错误验证码登录被拒"
    assert_eq "303" "$(login_with "$(code_for "$SECRET")")" "【真实验证码登录成功】"
    if [ -n "$RECOVERY" ]; then
      assert_eq "303" "$(login_with "$RECOVERY")" "恢复码可用一次"
      assert_eq "401" "$(login_with "$RECOVERY")" "同一个恢复码不能再用"
    fi
    assert_eq "303" "$(login_with "$(code_for "$SECRET")")" "验证码仍然可用"
  fi
  bin/mt.sh admin-mfa remove "$T" --yes >/dev/null 2>&1
  bin/mt.sh admin-remove "$T" >/dev/null 2>&1
  printf '%s' "$(bin/mt.sh admin-mfa status 2>&1)" | grep -q "$T" && fail "测试管理员没清干净" || pass "测试管理员已清除"
  if [ -n "$ADMIN_PW" ]; then
    assert_eq "303" "$(http --data-urlencode "user=$ADMIN_USER" --data-urlencode "password=$ADMIN_PW" http://127.0.0.1:8099/__mt/admin/login)" "$ADMIN_USER 账号仍然可登录"
  else
    skip "admin 账号登录复查（缺口令）"
  fi
  fi
fi

# ---------------------------------------------------------------- 历史：时间与翻页
head_ "控制台历史的时间与翻页"
if [ "$QUICK" = yes ] || [ -z "${ADMIN_PW:-}" ]; then
  skip "历史的时间与翻页（--quick 或缺管理员口令）"
else
  HJAR="$(mktemp)"
  curl -sS -o /dev/null -c "$HJAR" --data-urlencode "user=${ADMIN_USER:-admin}" --data-urlencode "password=$ADMIN_PW" \
    http://127.0.0.1:8099/__mt/admin/login 2>/dev/null
  hist() {
    curl -sS -b "$HJAR" -X POST -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:8099' \
      -d "$1" http://127.0.0.1:8099/__mt/admin/api/tenant 2>/dev/null
  }
  # 时间运算一律交给容器里的 node：这台宿主上的 python3 是 3.6，没有
  # datetime.fromisoformat。我因为这个空跑过两次断言，而且都读成了"服务器不一致"。
  node_time() {
    docker exec ${PREFIX}gateway node -e "$1" "$2" "${3:-0}" 2>/dev/null | tr -d '\r'
  }

  hist '{"action":"ops-history","limit":200}' > /tmp/hist_all.json
  if ! python3 -c 'import json,sys; sys.exit(0 if json.load(open("/tmp/hist_all.json")).get("entries") else 1)' 2>/dev/null; then
    fail "历史接口没返回记录，后面的断言无从谈起"
  else
    BOUND="$(python3 -c '
import json
rows = json.load(open("/tmp/hist_all.json"))["entries"]
print(sorted(r["ts"] for r in rows)[len(rows) // 2])')"
    hist "{\"action\":\"ops-history\",\"limit\":200,\"since\":\"$BOUND\"}" > /tmp/hist_w.json
    OUTSIDE="$(python3 -c '
import json
bound = open("/tmp/hist_bound.txt").read().strip()
rows = json.load(open("/tmp/hist_w.json"))["entries"]
print(sum(1 for r in rows if r["ts"] < bound))' 2>/dev/null || echo "?")"
    printf '%s' "$BOUND" > /tmp/hist_bound.txt
    OUTSIDE="$(python3 -c '
import json
bound = open("/tmp/hist_bound.txt").read().strip()
rows = json.load(open("/tmp/hist_w.json"))["entries"]
print(sum(1 for r in rows if r["ts"] < bound))')"
    assert_eq "0" "$OUTSIDE" "时间范围：返回的每条都在窗口内"

    # 游标翻页：用 node 算"最旧那条减 1 毫秒"
    hist '{"action":"ops-history","limit":10}' > /tmp/hist_p1.json
    OLD="$(python3 -c '
import json
rows = json.load(open("/tmp/hist_p1.json"))["entries"]
print(sorted(r["ts"] for r in rows)[0])')"
    CUR="$(node_time 'process.stdout.write(new Date(new Date(process.argv[1]).getTime()-1).toISOString())' "$OLD")"
    if [ -z "$CUR" ]; then
      fail "算不出游标（node 没产出东西）—— 这条断言会是空跑，所以直接算失败"
    else
      hist "{\"action\":\"ops-history\",\"limit\":10,\"until\":\"$CUR\"}" > /tmp/hist_p2.json
      OVERLAP="$(python3 -c '
import json
a = [r["ts"] for r in json.load(open("/tmp/hist_p1.json"))["entries"]]
b = [r["ts"] for r in json.load(open("/tmp/hist_p2.json"))["entries"]]
print(len(set(a) & set(b)))')"
      assert_eq "0" "$OVERLAP" "游标翻页：两页没有重叠"
      EARLIER="$(python3 -c '
import json
a = [r["ts"] for r in json.load(open("/tmp/hist_p1.json"))["entries"]]
b = [r["ts"] for r in json.load(open("/tmp/hist_p2.json"))["entries"]]
print(1 if b and max(b) < min(a) else 0)')"
      assert_eq "1" "$EARLIER" "第二页确实更早（不是把第一页又发了一遍）"
    fi

    # 坏时间必须被拒：被静默忽略的筛选，回答的是没人问过的问题
    hist '{"action":"ops-history","since":"2026"}' > /tmp/hist_bad.json
    grep -q '"ok":false' /tmp/hist_bad.json && pass "坏时间（2026）被拒绝" || fail "坏时间被接受了"
  fi
  rm -f "$HJAR" /tmp/hist_all.json /tmp/hist_w.json /tmp/hist_p1.json /tmp/hist_p2.json /tmp/hist_bad.json /tmp/hist_bound.txt
fi

# ---------------------------------------------------------------- 租户入口
head_ "租户入口（含前置代理的子路径）"
# 用户拿到的最短地址就是这一个：没登录 -> 租户登录页；登录过 -> 直接进自己的 DSH。
# 断言程序打印出来的表单地址，因为它决定浏览器下一步去哪（前后端不一致时状态码照样是 200）。
# 公开端口装了证书就是 HTTPS（与 doctor 同一条判断），否则明文。
PUBLIC_SCHEME="http"; [ -f state/tls/server.crt ] && PUBLIC_SCHEME="https"
ENTRY="$(curl -sSk --max-time 15 "$PUBLIC_SCHEME://127.0.0.1:8090${MT_BASE}/" 2>/dev/null)"
printf '%s' "$ENTRY" | grep -q 'name="password"' && pass "租户入口是登录页（未登录时）" \
  || fail "租户入口不是登录页"
printf '%s' "$ENTRY" | grep -q "action=\"${MT_BASE}/__mt/login\"" \
  && pass "租户登录表单提交到 ${MT_BASE}/__mt/login" \
  || fail "租户登录表单没提交到 ${MT_BASE}/__mt/login（前缀没进到页面里）"
if [ -n "$MT_BASE" ]; then
  BARE_CODE="$(http "$PUBLIC_SCHEME://127.0.0.1:8090$MT_BASE")"
  assert_eq "301" "$BARE_CODE" "不带尾斜杠的 $MT_BASE 会跳转到 $MT_BASE/"
fi

# 端到端按浏览器的方式走一遍：登录页 -> 在子路径下提交 -> 落进该租户自己的 DSH。
# 断言 DSH 送出的文档带 <base href="./"> 且资源是相对地址 —— 这就是"挂在子路径下还能用"
# 的依据：根绝对地址（/assets/…）会被浏览器解析到代理的根路径，那里没有我们。
MOUNT_TENANT=""; MOUNT_USER=""; MOUNT_PW=""
for t in $TENANTS; do
  _u="$(cred tenants "$t" user)"; _p="$(cred tenants "$t" password)"
  if [ -n "$_p" ]; then MOUNT_TENANT="$t"; MOUNT_USER="$_u"; MOUNT_PW="$_p"; break; fi
done
if [ "$QUICK" = yes ]; then
  skip "子路径端到端（--quick 跳过）"
elif [ -z "$MOUNT_TENANT" ]; then
  skip "子路径端到端（$CREDS 里没有租户口令）"
else
  MJAR="$(mktemp)"; MPAGE="$(mktemp)"
  curl -sSk -o /dev/null -c "$MJAR" -w '%{http_code}' --max-time 20 \
    --data-urlencode "tenant=$MOUNT_TENANT" --data-urlencode "user=$MOUNT_USER" --data-urlencode "password=$MOUNT_PW" \
    "$PUBLIC_SCHEME://127.0.0.1:8090${MT_BASE}/__mt/login" > /tmp/mt_mount_code.txt 2>/dev/null
  assert_eq "303" "$(cat /tmp/mt_mount_code.txt)" "$MOUNT_TENANT 在子路径下登录"
  APP_CODE="$(curl -sSk -o "$MPAGE" -b "$MJAR" -c "$MJAR" -w '%{http_code}' --max-time 30 \
    "$PUBLIC_SCHEME://127.0.0.1:8090${MT_BASE}/" 2>/dev/null)"
  assert_eq "200" "$APP_CODE" "已登录时同一地址直接进入 $MOUNT_TENANT 的 DSH"
  grep -q '<base href="./"' "$MPAGE" && pass "DSH 文档带 <base href=\"./\">（相对地址按挂载点解析）" \
    || fail "DSH 文档没有 <base href=\"./\">"
  grep -qE 'src="\./assets/|href="\./assets/' "$MPAGE" && pass "DSH 资源是相对地址" \
    || fail "DSH 资源不是相对地址（浏览器会去代理根路径取）"
  grep -qE 'src="/assets/|href="/assets/' "$MPAGE" && fail "DSH 文档里有根绝对资源地址" \
    || pass "DSH 文档里没有根绝对资源地址"
  rm -f "$MJAR" "$MPAGE"
fi

# ---------------------------------------------------------------- Key 免口令登录
head_ "Key 免口令登录（USB Key）"
# 身份只从 cookie 来、且只从信任的来源来，这两条是这个功能的全部安全性。这里的
# 请求都从 loopback 发出（网关恒信 loopback），所以不必配 MT_KEY_LOGIN_FROM 也能测；
# 但功能本身要开着才谈得上测，没开就明说跳过，不用"通过"糊过去。
KEY_FROM_CFG="$(grep '^MT_KEY_LOGIN_FROM=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
KEY_SECRET_CFG="$(grep '^MT_KEY_LOGIN_SECRET=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
KEY_COOKIE_CFG="$(grep '^MT_KEY_LOGIN_COOKIE=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
KEY_COOKIE_CFG="${KEY_COOKIE_CFG:-KOAL_CERT_E}"
if [ -z "$KEY_FROM_CFG" ] && [ -z "$KEY_SECRET_CFG" ]; then
  skip "Key 登录（未开启：MT_KEY_LOGIN_FROM / MT_KEY_LOGIN_SECRET 都没配）"
else
  KT=""; KU=""; KP=""
  for t in $TENANTS; do
    _u="$(cred tenants "$t" user)"; _p="$(cred tenants "$t" password)"
    if [ -n "$_u" ] && [ -n "$_p" ]; then KT="$t"; KU="$_u"; KP="$_p"; break; fi
  done
  if [ -z "$KT" ]; then
    skip "Key 登录（$CREDS 里没有租户账号，取不到用户名）"
  else
    KENTRY="$PUBLIC_SCHEME://127.0.0.1:8090${MT_BASE}"
    # 1) 没有身份就必须被拒，而且拒的是登录页（不是 500、不是空白）
    assert_eq "401" "$(curl -sSk -o /tmp/mt_key_none.html -w '%{http_code}' --max-time 15 \
      "$KENTRY/__mt/key-login" 2>/dev/null)" "没有 Key 身份时被拒（401）"
    grep -q 'name="password"' /tmp/mt_key_none.html && pass "拒绝页仍是登录页（口令人工兜底还在）" \
      || fail "拒绝页不是登录页"
    # 2) 用户名只能来自 cookie：查询参数不许换人
    assert_eq "401" "$(curl -sSk -o /dev/null -w '%{http_code}' --max-time 15 \
      "$KENTRY/__mt/key-login?user=$KU" 2>/dev/null)" "查询参数里的用户名不作数（401）"
    # 3) 注册表里没有的身份：401，不是 500（参考实现里这一条最容易漏）
    assert_eq "401" "$(curl -sSk -o /dev/null -w '%{http_code}' --max-time 15 \
      -H "Cookie: ${KEY_COOKIE_CFG}=no-such-account" "$KENTRY/__mt/key-login" 2>/dev/null)" \
      "注册表里没有的身份被拒（401，不是 500）"
    # 4) 有效身份 -> 303 -> 直接进该租户的 DSH。放在最后：成功一次会清掉本来源的失败计数，
    #    于是反复跑这个脚本不会把自己锁在限流里。
    KJAR="$(mktemp)"; KAPP="$(mktemp)"
    assert_eq "303" "$(curl -sSk -o /dev/null -c "$KJAR" -w '%{http_code}' --max-time 20 \
      -H "Cookie: ${KEY_COOKIE_CFG}=${KU}" "$KENTRY/__mt/key-login" 2>/dev/null)" \
      "Key 身份登录（$KT/$KU）"
    grep -q 'mt_session' "$KJAR" && pass "签发了网关会话 cookie" || fail "没有签发会话 cookie"
    assert_eq "200" "$(curl -sSk -o "$KAPP" -b "$KJAR" -w '%{http_code}' --max-time 30 \
      "$KENTRY/" 2>/dev/null)" "Key 登录后直接进入 $KT 的 DSH"
    grep -q '<base href="./"' "$KAPP" && pass "DSH 文档带 <base href=\"./\">" || fail "DSH 文档没有相对基准"
    # 5) 自动登录：带着身份打开入口页，不用点任何东西
    assert_eq "303" "$(curl -sSk -o /dev/null -w '%{http_code}' --max-time 20 \
      -H "Cookie: ${KEY_COOKIE_CFG}=${KU}" "$KENTRY/" 2>/dev/null)" "带 Key 打开入口页自动登录"
    # 6) 口令方式没有被 Key 顶掉
    assert_eq "303" "$(curl -sSk -o /dev/null -w '%{http_code}' --max-time 15 \
      --data-urlencode "tenant=$KT" --data-urlencode "user=$KU" --data-urlencode "password=$KP" \
      "$KENTRY/__mt/login" 2>/dev/null)" "口令登录仍然可用"
    rm -f "$KJAR" "$KAPP" /tmp/mt_key_none.html
  fi
fi

# ---------------------------------------------------------------- 控制台登录的落地页
head_ "多节点（租户住在别的机器上）"
# 多机真正的验收点：一个住在**别的节点**的租户，经同一个统一入口登录，落到它自己那台
# 机器上的运行时里。注册、路由、cookie（authority 与运行位置无关）、代理转发这一段
# 只要有一处不对，这条就会失败——而单机的检查全都看不出来。
if [ -z "${REMOTE_TENANTS// /}" ]; then
  skip "多节点（本部署没有远端租户，单机形态）"
else
  RT=""; RU=""; RP=""
  for t in $REMOTE_TENANTS; do
    _u="$(cred tenants "$t" user)"; _p="$(cred tenants "$t" password)"
    if [ -n "$_u" ] && [ -n "$_p" ]; then RT="$t"; RU="$_u"; RP="$_p"; break; fi
  done
  if [ -z "$RT" ]; then
    skip "多节点登录（$CREDS 里没有远端租户的口令；远端租户：$REMOTE_TENANTS）"
  elif [ "$QUICK" = yes ]; then
    skip "多节点登录（--quick 跳过）"
  else
    RJAR="$(mktemp)"; RPAGE="$(mktemp)"
    assert_eq "303" "$(curl -sSk -o /dev/null -c "$RJAR" -w '%{http_code}' --max-time 20 \
      --data-urlencode "tenant=$RT" --data-urlencode "user=$RU" --data-urlencode "password=$RP" \
      "$PUBLIC_SCHEME://127.0.0.1:8090${MT_BASE}/__mt/login" 2>/dev/null)" \
      "$RT（远端节点上）经统一入口登录"
    assert_eq "200" "$(curl -sSk -o "$RPAGE" -b "$RJAR" -w '%{http_code}' --max-time 30 \
      "$PUBLIC_SCHEME://127.0.0.1:8090${MT_BASE}/" 2>/dev/null)" "远端租户登录后进入自己的 DSH"
    grep -q '<base href="./"' "$RPAGE" && pass "远端租户的 DSH 文档带 <base href=\"./\">" \
      || fail "远端租户的 DSH 文档没有相对基准"
    rm -f "$RJAR" "$RPAGE"
  fi
fi

head_ "控制台登录：表单提交到哪、落在哪一页"
if [ "$QUICK" = yes ]; then
  skip "控制台登录落地页（--quick 跳过）"
else
  ADMIN_PW_LOCAL="$(cred admin password)"
  if [ -z "$ADMIN_PW_LOCAL" ]; then
    skip "控制台登录落地页（$CREDS 里缺 admin.password）"
  else
    LPAGE=$(mktemp)
    curl -sSk -o "$LPAGE" -w '%{http_code}' --max-time 15 "https://127.0.0.1:8090${MT_BASE}/__mt/admin" > /tmp/lp_code.txt 2>/dev/null
    assert_eq "200" "$(cat /tmp/lp_code.txt)" "控制台登录页返回 200"

    # 关键：不问"路由对不对"，问【浏览器会提交到哪里】。
    # 页面地址没有结尾斜杠时，相对 action 会被解析到上一级目录 —— 这正是线上那次事故。
    RESOLVED="$(python3 - "$LPAGE" "https://127.0.0.1:8090${MT_BASE}/__mt/admin" <<'PY'
import re, sys
from urllib.parse import urljoin
page_url = sys.argv[2]
html = open(sys.argv[1], encoding='utf-8', errors='replace').read()
base = re.search(r'<base href="([^"]+)"', html)
base_url = urljoin(page_url, base.group(1)) if base else page_url
form = re.search(r'<form[^>]*action="([^"]+)"', html)
print(urljoin(base_url, form.group(1)) if form else '(没有表单)')
PY
)"
    assert_eq "https://127.0.0.1:8090${MT_BASE}/__mt/admin/login" "$RESOLVED" "登录表单解析后的提交地址"

    # 提交到那个地址，并【跟随跳转】—— 只看状态码是不够的，那次事故里状态码是 303。
    LANDED=$(mktemp); LANDJAR=$(mktemp)
    # 必须带上 cookie jar：303 的 Set-Cookie 不保存的话，跟随跳转后是未登录状态，
    # 而 /__mt/admin 对未登录者返回登录页 —— 登录页的 <h1> 也叫「DSH 多租户管理控制台」，
    # 于是只比标题的断言会在什么都没发生时也通过。
    FINAL=$(curl -sSk -L -c "$LANDJAR" -b "$LANDJAR" -o "$LANDED" -w '%{url_effective}' --max-time 20 \
      --data-urlencode "user=$(cred admin user)" --data-urlencode "password=$ADMIN_PW_LOCAL" \
      "$RESOLVED" 2>/dev/null)
    assert_eq "https://127.0.0.1:8090${MT_BASE}/__mt/admin" "$FINAL" "登录后落在控制台（不是租户页）"
    # hist-tenant 只在控制台页里出现，登录页没有 —— 用它区分两页，而不是用标题。
    grep -q 'hist-tenant' "$LANDED" && pass "落地页是控制台（含只有控制台才有的控件）" \
      || fail "落地页不是控制台页（拿到的多半是登录页）"
    grep -q 'name="password"' "$LANDED" && fail "落地页仍是登录表单（会话没带上）" || pass "落地页不是登录表单"

    # 页内脚本用的相对地址也走同一个基准，必须解析到 /__mt/admin/ 之下
    API_BASE="$(python3 - "$LPAGE" "https://127.0.0.1:8090${MT_BASE}/__mt/admin" <<'PY'
import re, sys
from urllib.parse import urljoin
html = open(sys.argv[1], encoding='utf-8', errors='replace').read()
base = re.search(r'<base href="([^"]+)"', html)
base_url = urljoin(sys.argv[2], base.group(1)) if base else sys.argv[2]
print(urljoin(base_url, 'api/state'))
PY
)"
    assert_eq "https://127.0.0.1:8090${MT_BASE}/__mt/admin/api/state" "$API_BASE" "页内脚本的相对地址基准"

    # 服务端【真正送出】的脚本必须能被解析。页面脚本包在模板字符串里，
    # 文件里写成 '\n' 的转义会被模板解成真实换行，让整段脚本语法错误、
    # 页面永远停在"加载中…"——而源文件本身看起来完全正常。
    SERVED="$LANDED"
    python3 - "$SERVED" <<'PY' > /tmp/served.js
import re, sys
html = open(sys.argv[1], encoding='utf-8', errors='replace').read()
blocks = re.findall(r'<script[^>]*>(.*?)</script>', html, re.S)
sys.stdout.write(blocks[0] if blocks else '')
PY
    if [ -s /tmp/served.js ]; then
      PARSED="$(docker exec -i ${PREFIX}gateway sh -c 'cat > /tmp/served.js && node --check /tmp/served.js 2>&1 | head -3; rm -f /tmp/served.js' < /tmp/served.js)"
      [ -z "$PARSED" ] && pass "服务端送出的脚本能解析" || fail "服务端送出的脚本有语法错误：$PARSED"
    else
      fail "页面里没有 script 块（脚本根本不会被调用）"
    fi
    rm -f /tmp/served.js
    rm -f "$LPAGE" "$LANDED" "$LANDJAR" /tmp/lp_code.txt
  fi
fi

# ---------------------------------------------------------------- MFA：控制台动作
head_ "MFA 的控制台动作"
if [ "$QUICK" = yes ]; then
  skip "MFA 控制台动作（--quick 跳过）"
else
  MT2=mfaconsole
  MPW="$(cred mfa password)"
  if [ -z "$MPW" ]; then
    skip "MFA 控制台动作（$CREDS 里缺 mfa.password）"
  else
    bin/mt.sh admin-add "$MT2" --role admin --password "$MPW" >/dev/null 2>&1
    MJAR="$(mktemp)"
    curl -sS -o /dev/null -c "$MJAR" --data-urlencode "user=$MT2" --data-urlencode "password=$MPW" \
      http://127.0.0.1:8099/__mt/admin/login 2>/dev/null
    mfaop() {
      curl -sS -b "$MJAR" -X POST -H 'content-type: application/json' -H 'Origin: http://127.0.0.1:8099' \
        -d "$1" http://127.0.0.1:8099/__mt/admin/api/tenant 2>/dev/null
    }
    mfa_login() {
      curl -sS -o /dev/null -w '%{http_code}' --data-urlencode "user=$MT2" --data-urlencode "password=$MPW" \
        ${1:+--data-urlencode "code=$1"} http://127.0.0.1:8099/__mt/admin/login
    }

    SETUP="$(mfaop '{"action":"mfa-setup"}')"
    SECRET="$(printf '%s' "$SETUP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("secret",""))' 2>/dev/null)"
    [ -n "$SECRET" ] && pass "控制台 mfa-setup 给出密钥" || fail "控制台 mfa-setup 没给出密钥"

    if [ -n "$SECRET" ]; then
      mfaop '{"action":"mfa-confirm","code":"000000"}' > /tmp/mfa_bad.json
      grep -q '"ok":false' /tmp/mfa_bad.json && pass "错误验证码不能激活" || fail "错误验证码竟然激活了"
      CODE="$(node_time 'console.log(require("/app/mfa.js").totp(process.argv[1]))' "$SECRET")"
      mfaop "{\"action\":\"mfa-confirm\",\"code\":\"$CODE\"}" > /tmp/mfa_ok.json
      grep -q '"ok":true' /tmp/mfa_ok.json && pass "真实验证码激活成功" || fail "真实验证码没能激活"
      grep -q 'recovery' /tmp/mfa_ok.json && pass "激活时返回恢复码" || fail "激活时没有恢复码"

      # 这几条是核心：没跑成就不可能通过
      assert_eq "401" "$(mfa_login '')" "控制台开启后：不带验证码登录被拒"
      CODE2="$(node_time 'console.log(require("/app/mfa.js").totp(process.argv[1]))' "$SECRET")"
      assert_eq "303" "$(mfa_login "$CODE2")" "控制台开启后：真实验证码登录成功"

      CODE3="$(node_time 'console.log(require("/app/mfa.js").totp(process.argv[1]))' "$SECRET")"
      mfaop "{\"action\":\"mfa-recovery\",\"code\":\"$CODE3\"}" > /tmp/mfa_rec.json
      grep -q '"ok":true' /tmp/mfa_rec.json && pass "重新生成恢复码可用" || fail "重新生成恢复码不可用"

      CODE4="$(node_time 'console.log(require("/app/mfa.js").totp(process.argv[1]))' "$SECRET")"
      mfaop "{\"action\":\"mfa-disable\",\"code\":\"$CODE4\"}" > /tmp/mfa_off.json
      grep -q '"ok":true' /tmp/mfa_off.json && pass "关闭两步验证可用" || fail "关闭两步验证不可用"
      assert_eq "303" "$(mfa_login '')" "关闭后不带验证码可登录"
    fi
    rm -f "$MJAR" /tmp/mfa_bad.json /tmp/mfa_ok.json /tmp/mfa_rec.json /tmp/mfa_off.json
    bin/mt.sh admin-mfa remove "$MT2" --yes >/dev/null 2>&1
    bin/mt.sh admin-remove "$MT2" >/dev/null 2>&1
    printf '%s' "$(bin/mt.sh admin-users 2>&1)" | grep -q "$MT2" && fail "测试管理员没清干净" || pass "测试管理员已清除"
  fi
fi

# ---------------------------------------------------------------- 收尾
head_ "结论"
printf '  %s 项通过，%s 项失败，%s 项跳过\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '  有失败项，退出码 1\n'
  exit 1
fi
printf '  全部通过\n'
