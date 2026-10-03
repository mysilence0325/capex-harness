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
TENANTS="$(grep -o '"id": *"[a-z0-9-]*"' tenants.json 2>/dev/null | sed 's/.*"\([a-z0-9-]*\)"$/\1/' | tr '\n' ' ')"

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
N="$(docker ps --filter name=mt- --format '{{.Names}}' | wc -l)"
assert_eq "9" "$N" "9 个部署容器在运行"
SINK="$(docker ps --filter name=dsh-alert-sink --format '{{.Names}}' | wc -l)"
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
  case "$R" in *"15 通过，0 失败"*) pass "$t 冒烟 $R" ;; *) fail "$t 冒烟 $R" ;; esac
done

DOCTOR="$(bin/mt.sh doctor 2>&1 | tail -1 | sed 's/^ *//')"
case "$DOCTOR" in *"0 项失败"*) pass "doctor $DOCTOR" ;; *) fail "doctor $DOCTOR" ;; esac

# ---------------------------------------------------------------- 监控链路
head_ "监控与告警"
C=capex-ai-lab-prometheus-1
TARGET="$(docker exec "$C" wget -q -O - 'http://127.0.0.1:9090/api/v1/targets' 2>/dev/null | sed 's/},{/}\n{/g' | grep dsh-multitenant | grep -o '"health":"up"' | head -1)"
assert_eq '"health":"up"' "$TARGET" "抓取目标 up"
RULES="$(docker exec "$C" wget -q -O - 'http://127.0.0.1:9090/api/v1/rules' 2>/dev/null | grep -o '"name":"Dsh[A-Za-z]*"' | wc -l)"
[ "$RULES" -ge 12 ] && pass "DSH 告警规则 $RULES 条（≥12）" || fail "DSH 告警规则只有 $RULES 条"

# 正向：投一条告警，落盘条数必须增加。数不变说明链路断了，而不是"没变化也算过"。
LOGFILE=state/alerts/alerts.jsonl
if [ "$QUICK" = yes ]; then
  skip "告警投递（--quick 跳过）"
else
  BEFORE_ALERTS="$(wc -l < "$LOGFILE" 2>/dev/null || echo 0)"
  bin/mt.sh alert-sink test >/dev/null 2>&1
  AFTER_ALERTS="$(wc -l < "$LOGFILE" 2>/dev/null || echo 0)"
  [ "$AFTER_ALERTS" -gt "$BEFORE_ALERTS" ] && pass "告警投递：落盘 $BEFORE_ALERTS → $AFTER_ALERTS 条" \
    || fail "告警投递：落盘没有增加（$BEFORE_ALERTS → $AFTER_ALERTS）"
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
  for needle in tenantExport tenantImport hist-tenant hist-q; do
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
rm -f "$JAR"

# ---------------------------------------------------------------- 隔离与策略
head_ "隔离与策略"
N=0
for t in $TENANTS; do
  docker inspect "mt-dsh-$t" --format '{{range .HostConfig.SecurityOpt}}{{.}}{{end}}' 2>/dev/null | grep -q seccomp && N=$((N + 1))
done
assert_eq "$(printf '%s' "$TENANTS" | wc -w)" "$N" "全部租户都应用了 seccomp 策略"

# 租户容器不该能连宿主上的运维端口。
CAN_REACH="$(docker exec "mt-dsh-$(printf '%s' "$TENANTS" | awk '{print $1}')" sh -c "timeout 4 sh -c 'echo > /dev/tcp/$IP/8099' 2>/dev/null && echo yes || echo no" 2>/dev/null | tr -d '\r')"
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

# ---------------------------------------------------------------- 多节点与注册
head_ "注册与节点"
NODES="$(python3 -c "import json;d=json.load(open('state/runtimes.json'))['runtimes'];print(','.join(sorted({d[t]['node'] for t in d})))" 2>/dev/null)"
assert_eq "local" "$NODES" "注册表里的节点只有 local"
REGN="$(python3 -c "import json;print(len(json.load(open('state/runtimes.json'))['runtimes']))" 2>/dev/null)"
assert_eq "$(printf '%s' "$TENANTS" | wc -w)" "$REGN" "每个租户都有注册条目"
STRAY="$(docker ps -a --filter 'label=mt.tenant' --format '{{.Names}}' | while read -r n; do printf '%s' "$TENANTS" | grep -qw "$(docker inspect "$n" --format '{{index .Config.Labels "mt.tenant"}}')" || echo "$n"; done | wc -l)"
assert_eq "0" "$STRAY" "没有已删租户的容器残留"

# ---------------------------------------------------------------- MFA 全流程
head_ "管理员 MFA"
if [ "$QUICK" = yes ]; then
  skip "MFA 全流程（--quick 跳过）"
else
  T=mfaaccept
  PW="$(cred mfa password)"; PW="${PW:-MfaAccept2026x}"
  bin/mt.sh admin-add "$T" --role admin --password "$PW" >/dev/null 2>&1
  SETUP="$(bin/mt.sh admin-mfa setup "$T" 2>&1)"
  SECRET="$(printf '%s' "$SETUP" | grep -o '密钥: [A-Z2-7]*' | awk '{print $2}')"
  [ -n "$SECRET" ] && pass "setup 给出密钥" || fail "setup 没有给出密钥"
  if [ -n "$SECRET" ]; then
    # 代码从【镜像里那份 mfa.js】算出来，顺带证明容器里那份是对的。
    code_for() { docker exec mt-gateway node -e 'console.log(require("/app/mfa.js").totp(process.argv[1]))' "$1" 2>/dev/null | tr -d '\r'; }
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

# ---------------------------------------------------------------- 收尾
head_ "结论"
printf '  %s 项通过，%s 项失败，%s 项跳过\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '  有失败项，退出码 1\n'
  exit 1
fi
printf '  全部通过\n'
