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

# ---------------------------------------------------------------- 控制台的限额操作
head_ "控制台的配额与限速操作"
# 经控制台设，再读回来。只看"接口返回 ok"不算 —— 那可能什么都没落下。
if [ "$QUICK" = yes ]; then
  skip "控制台设限速并读回（--quick 跳过）"
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
  # 与真实目录对账：同量级即可（指标按文件大小，du 按分配的块，本来就略有出入）
  for t in $TENANTS; do
    M="$(printf '%s' "$DISK" | awk -v t="$t" '$0 ~ "tenant=\"" t "\"" {print $2}')"
    D="$(du -sb "tenants/$t" 2>/dev/null | awk '{print $1}')"
    if [ -z "$M" ] || [ -z "$D" ]; then skip "$t 无法对账"; continue; fi
    RATIO="$(awk -v m="$M" -v d="$D" 'BEGIN{ if (d == 0) { print "na"; exit } r = m / d; print (r > 0.8 && r <= 1.01) ? "ok" : "bad" }')"
    [ "$RATIO" = "ok" ] && pass "$t 指标 $M 与目录 $D 同量级" || fail "$t 指标 $M 与目录 $D 不成比例"
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
    docker exec mt-gateway node -e "$1" "$2" "${3:-0}" 2>/dev/null | tr -d '\r'
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

# ---------------------------------------------------------------- 控制台登录的落地页
head_ "控制台登录：表单提交到哪、落在哪一页"
if [ "$QUICK" = yes ]; then
  skip "控制台登录落地页（--quick 跳过）"
else
  ADMIN_PW_LOCAL="$(cred admin password)"
  if [ -z "$ADMIN_PW_LOCAL" ]; then
    skip "控制台登录落地页（$CREDS 里缺 admin.password）"
  else
    LPAGE=$(mktemp)
    curl -sSk -o "$LPAGE" -w '%{http_code}' --max-time 15 https://127.0.0.1:8090/__mt/admin > /tmp/lp_code.txt 2>/dev/null
    assert_eq "200" "$(cat /tmp/lp_code.txt)" "控制台登录页返回 200"

    # 关键：不问"路由对不对"，问【浏览器会提交到哪里】。
    # 页面地址没有结尾斜杠时，相对 action 会被解析到上一级目录 —— 这正是线上那次事故。
    RESOLVED="$(python3 - "$LPAGE" <<'PY'
import re, sys
from urllib.parse import urljoin
page_url = 'https://127.0.0.1:8090/__mt/admin'
html = open(sys.argv[1], encoding='utf-8', errors='replace').read()
base = re.search(r'<base href="([^"]+)"', html)
base_url = urljoin(page_url, base.group(1)) if base else page_url
form = re.search(r'<form[^>]*action="([^"]+)"', html)
print(urljoin(base_url, form.group(1)) if form else '(没有表单)')
PY
)"
    assert_eq "https://127.0.0.1:8090/__mt/admin/login" "$RESOLVED" "登录表单解析后的提交地址"

    # 提交到那个地址，并【跟随跳转】—— 只看状态码是不够的，那次事故里状态码是 303。
    LANDED=$(mktemp); LANDJAR=$(mktemp)
    # 必须带上 cookie jar：303 的 Set-Cookie 不保存的话，跟随跳转后是未登录状态，
    # 而 /__mt/admin 对未登录者返回登录页 —— 登录页的 <h1> 也叫「DSH 多租户管理控制台」，
    # 于是只比标题的断言会在什么都没发生时也通过。
    FINAL=$(curl -sSk -L -c "$LANDJAR" -b "$LANDJAR" -o "$LANDED" -w '%{url_effective}' --max-time 20 \
      --data-urlencode "user=$(cred admin user)" --data-urlencode "password=$ADMIN_PW_LOCAL" \
      "$RESOLVED" 2>/dev/null)
    assert_eq "https://127.0.0.1:8090/__mt/admin" "$FINAL" "登录后落在控制台（不是租户页）"
    # hist-tenant 只在控制台页里出现，登录页没有 —— 用它区分两页，而不是用标题。
    grep -q 'hist-tenant' "$LANDED" && pass "落地页是控制台（含只有控制台才有的控件）" \
      || fail "落地页不是控制台页（拿到的多半是登录页）"
    grep -q 'name="password"' "$LANDED" && fail "落地页仍是登录表单（会话没带上）" || pass "落地页不是登录表单"

    # 页内脚本用的相对地址也走同一个基准，必须解析到 /__mt/admin/ 之下
    API_BASE="$(python3 - "$LPAGE" <<'PY'
import re, sys
from urllib.parse import urljoin
html = open(sys.argv[1], encoding='utf-8', errors='replace').read()
base = re.search(r'<base href="([^"]+)"', html)
base_url = urljoin('https://127.0.0.1:8090/__mt/admin', base.group(1)) if base else 'https://127.0.0.1:8090/__mt/admin'
print(urljoin(base_url, 'api/state'))
PY
)"
    assert_eq "https://127.0.0.1:8090/__mt/admin/api/state" "$API_BASE" "页内脚本的相对地址基准"
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
