#!/usr/bin/env bash
# 部署自检：把"能不能用、哪里不对"一次性列清楚。
#
#   bin/doctor.sh
#
# 只读，不改任何状态；退出码 0 表示没有致命问题（警告不算）。
set -uo pipefail
cd "$(dirname "$0")/.."

# 自己读 .env。以前这里只看环境变量，于是 `bin/mt.sh doctor`（mt.sh 已经 source 过
# .env）与直接跑 `bash bin/doctor.sh` 会给出不同结论 —— 同一份配置，两种答案。
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# 宿主机没有 curl 时用容器里的顶（局域网装不了包的情况）；有 curl 时这个文件什么都不做。
# shellcheck disable=SC1091
. bin/lib-http.sh

# 容器名前缀与网络名都是可配的：同机可以跑第二套部署（演练、测试），而 doctor 必须
# 检查**自己这一套**——写死 mt- 时会去查另一套的容器，结论全是错的。
PREFIX="${MT_CONTAINER_NAME_PREFIX:-mt-}"
NET="${MT_NETWORK:-mt-net}"

OK=0; WARN=0; BAD=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; OK=$((OK + 1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARN=$((WARN + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; BAD=$((BAD + 1)); }
head_() { printf '\n\033[36m== %s ==\033[0m\n' "$1"; }

head_ "前置条件"
command -v docker >/dev/null 2>&1 && ok "docker 可用 ($(docker --version | cut -d, -f1))" || bad "找不到 docker"
docker info >/dev/null 2>&1 && ok "docker 守护进程在运行" || bad "docker 守护进程不可用"
if command -v docker-compose >/dev/null 2>&1; then ok "docker-compose $(docker-compose version --short 2>/dev/null)"
elif docker compose version >/dev/null 2>&1; then ok "docker compose 插件"
else bad "既没有 docker-compose 也没有 compose 插件"; fi
# 有几处 JSON 检查用 python3 解析（注册表里的账号数、运行时表的节点集合）。缺了它这些
# 检查会静默跳过——"没报错"会被读成"没问题"，所以在这里明说一次。
if command -v python3 >/dev/null 2>&1; then ok "python3 $(python3 -V 2>&1 | awk '{print $2}')（少数 JSON 检查需要它）"
else warn "没有 python3：注册表账号数、运行时表节点集合这类检查会跳过（结论仍然可信，覆盖少一点）"; fi

head_ "配置"
[ -f .env ] && ok ".env 存在" || bad "缺 .env（cp .env.example .env）"
IMAGE="$(grep -E '^DSH_IMAGE=' .env 2>/dev/null | tail -1 | cut -d= -f2)"
if [ -n "$IMAGE" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
  ok "运行时镜像存在: $IMAGE"
  if docker run --rm --entrypoint sh "$IMAGE" -c 'test -f /opt/dsh-local-build/SOURCE' >/dev/null 2>&1; then
    ok "  该镜像是本地源码构建的"
    docker run --rm --entrypoint cat "$IMAGE" /opt/dsh-local-build/manifest.json 2>/dev/null \
      | grep -E '"(builtAt|packages|frontendIndexSha256)"' | sed 's/^/      /' || true
  else
    warn "  该镜像是 npm 发行版，不是本地源码构建（bin/publish-image.sh 可换成本地构建）"
  fi
elif [ -n "$IMAGE" ]; then
  bad "镜像不存在: $IMAGE"
else
  bad ".env 里没有 DSH_IMAGE"
fi

[ -f tenants.json ] && ok "tenants.json 存在" || bad "缺 tenants.json（bin/mt.sh add <租户> 创建）"
TENANTS="$(grep -o '"id": *"[^"]*"' tenants.json 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$TENANTS" ] && ok "注册了 $(echo "$TENANTS" | wc -l) 个租户: $(echo $TENANTS | tr '\n' ' ')" || bad "tenants.json 里没有租户"

# 这套部署的模型是【一个租户 = 一个账号 = 一个独占空间】。注册表结构允许一个租户挂
# 多个用户，但那不是这里的模型：多出来的账号会和原账号共用同一个容器、同一份 home 与
# workspace，也就是共用同一个空间，而"谁做的"只能靠用户名去猜。手工编辑过的注册表
# 不会报错，只会悄悄变成那个样子，所以这里点名。
ODD_USERS="$(python3 - tenants.json <<'PY' 2>/dev/null || true
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
odd = [f"{t['id']}({len(t.get('users') or [])})" for t in doc.get('tenants', []) if len(t.get('users') or []) != 1]
print(' '.join(odd))
PY
)"
if [ -n "${ODD_USERS// /}" ]; then
  warn "有租户的账号数不是 1：$ODD_USERS（本部署是一个租户一个账号；要再加一个隔离空间就新增租户）"
else
  ok "每个租户恰好一个账号（一租户＝一账号＝一个独占空间）"
fi
[ -f docker-compose.yml ] && ok "docker-compose.yml 已生成" || warn "docker-compose.yml 未生成（bin/mt.sh render）"
# 控制面只对"住在本机"的租户检查容器与 home；其余租户的运行时在别的节点上，
# 由本机的节点代理创建，控制面能查的只有它的注册与可达性（下一节）。
NODE_OF() { grep -A6 "\"id\": \"$1\"" tenants.json 2>/dev/null | grep -o '"node": *"[^"]*"' | head -1 | cut -d'"' -f4; }
# 本机在这套部署里的角色。同一个词（local）在两处含义不同：注册表里 `node: local`
# 指的是**控制面那台**；而这台机器自己是不是控制面由 MT_NODE_NAME 决定。节点上把
# "node=local" 当成"本机"是错的，那会让节点去查控制面才有的容器、home 与网关。
THIS_NODE="${MT_NODE_NAME:-local}"
if [ "$THIS_NODE" = local ]; then
  ROLE=control
elif [ "${MT_CONTROL_PLANE_STANDBY:-}" = "1" ]; then
  ROLE=standby
else
  ROLE=node
fi
if [ "$ROLE" = control ] || [ "$ROLE" = standby ]; then HAS_GATEWAY=yes; else HAS_GATEWAY=no; fi
LOCAL_TENANTS=""
REMOTE_TENANTS=""
for t in $TENANTS; do
  tnode="$(NODE_OF "$t")"
  [ -n "$tnode" ] || tnode=local
  if [ "$tnode" = "$THIS_NODE" ]; then
    LOCAL_TENANTS="$LOCAL_TENANTS $t"
  else
    REMOTE_TENANTS="$REMOTE_TENANTS $t"
  fi
done
# 节点渲染用的是它自己那份 tenants.json 副本（控制面下发，口令哈希已剥掉）。副本过期
# 时本机容器集合与控制面的期望不一致：少建的租户在控制面上永远不注册，多留的容器占着
# 端口与磁盘。所以节点上以控制面的表为准核对，并点名不一致——只报"本机副本过期"，
# 让操作者跑一次 bin/mt.sh up 就够了。
if [ "$HAS_GATEWAY" != yes ] && [ -f state/register.key ] && [ -n "${MT_CONTROL_PLANE:-}" ]; then
  CP_DOC="$(curl -fsSk --max-time 10 -H "x-mt-registry-key: $(tr -d '\r\n' < state/register.key)" \
    "${MT_CONTROL_PLANE%/}/__mt/registry/tenants" 2>/dev/null || true)"
  if [ -n "$CP_DOC" ]; then
    CP_TENANTS="$(printf '%s' "$CP_DOC" | grep -o '"id": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"
    # 比的是"租户:节点"对，不只是租户集合：租户被 move 到别的机器之后两边 id 一模一样，
    # 只有 node 变了——只比 id 就会把"这台机器上已经不该有它了"当成一致（实测踩到：
    # 节点上留着已迁出租户的目录与停止的容器，doctor 一路报故障）。
    CP_PAIRS=""
    for t in $CP_TENANTS; do
      tn="$(printf '%s' "$CP_DOC" | grep -A6 "\"id\": \"$t\"" | grep -o '"node": *"[^"]*"' | head -1 | cut -d'"' -f4)"
      [ -n "$tn" ] || tn=local
      CP_PAIRS="$CP_PAIRS$t:$tn "
    done
    LOCAL_PAIRS=""
    for t in $TENANTS; do
      tn="$(NODE_OF "$t")"
      [ -n "$tn" ] || tn=local
      LOCAL_PAIRS="$LOCAL_PAIRS$t:$tn "
    done
    if [ "$(printf '%s\n' $CP_PAIRS | tr ' ' '\n' | sort | tr '\n' ' ')" != "$(printf '%s\n' $LOCAL_PAIRS | tr ' ' '\n' | sort | tr '\n' ' ')" ]; then
      warn "本机 tenants.json 与控制面不一致（本机: $LOCAL_PAIRS|控制面: $CP_PAIRS）：bin/mt.sh up 会先刷新再渲染"
      TENANTS="$CP_TENANTS"
      LOCAL_TENANTS=""
      REMOTE_TENANTS=""
      for t in $TENANTS; do
        tn="$(printf '%s\n' $CP_PAIRS | tr ' ' '\n' | grep "^${t}:" | head -1 | cut -d: -f2)"
        [ -n "$tn" ] || tn=local
        if [ "$tn" = "$THIS_NODE" ]; then
          LOCAL_TENANTS="$LOCAL_TENANTS $t"
        else
          REMOTE_TENANTS="$REMOTE_TENANTS $t"
        fi
      done
    fi
  fi
fi
if [ -n "$REMOTE_TENANTS" ]; then
  ok "远端租户（运行时不在本机）:$REMOTE_TENANTS"
  printf '      它们的容器、home、限额与隔离要在运行它们的机器上查：在那台上跑 bin/mt.sh doctor\n'

  # 节点是用控制面的密钥注册的（bin/node-install.sh 取回 state/{register,ops}.key）。
  # 控制面这边重新生成过密钥（重建 state/keys.json）之后，节点手上还是旧的那把，注册
  # 会被 401 拒绝，而现象只是"那台节点的租户在控制面上一直没注册"或"重启后统一入口
  # 一直 303"——从现象追不到密钥。只报"比最近一次成功注册还新的拒绝"：密钥取回之后
  # 节点每 15 秒重报一次，这条警告自己就会消失。
  LAST_REJECT="$(grep -h 'registry-key-rejected' logs/access.jsonl* 2>/dev/null | tail -1 | grep -o '"ts": *"[^"]*"' | cut -d'"' -f4)"
  LAST_REG="$(grep -o '"registeredAt": *"[^"]*"' state/runtimes.json 2>/dev/null | cut -d'"' -f4 | sort | tail -1)"
  if [ -n "$LAST_REJECT" ] && { [ -z "$LAST_REG" ] || [[ "$LAST_REJECT" > "$LAST_REG" ]]; }; then
    warn "  节点注册密钥被拒过（最后一次 $LAST_REJECT）：到那台节点重跑 bin/node-install.sh --fetch-from <控制面> 取回新密钥"
  else
    ok "  节点注册密钥没有被拒的记录"
  fi
fi

head_ "租户运行时"
for t in $LOCAL_TENANTS; do
  state="$(docker inspect "${PREFIX}dsh-$t" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  case "$state" in
    running) ok "$t 容器运行中（镜像 $(docker inspect "${PREFIX}dsh-$t" --format '{{.Config.Image}}')）" ;;
    missing) bad "$t 容器不存在" ;;
    *)       bad "$t 容器状态: $state" ;;
  esac
  [ -d "tenants/$t/home" ] && ok "  $t home 存在（$(du -sh "tenants/$t/home" 2>/dev/null | cut -f1)，会话 $(find "tenants/$t/home/sessions" -name 'session*.jsonl*' 2>/dev/null | wc -l) 个）" \
    || bad "  $t home 缺失"
  patch="tenants/$t/home/profiles/web/cordis.patch.yml"
  want_port="$(grep -A4 "\"id\": \"$t\"" tenants.json | grep -o '"internalPort": *[0-9]*' | grep -o '[0-9]*' | head -1)"
  if [ -f "$patch" ]; then
    have_port="$(grep -A3 'id: webserver' "$patch" | grep -o 'port: *[0-9]*' | grep -o '[0-9]*' | head -1)"
    if [ -z "$have_port" ]; then
      bad "  $t 的 patch 缺少 webserver.port（会退到默认 3080，网关将无法代理）"
    elif [ "$have_port" != "$want_port" ]; then
      bad "  $t 的 patch 端口 $have_port 与注册表 $want_port 不一致"
    else
      ok "  $t patch 端口 $have_port 与注册表一致"
    fi
  else
    warn "  $t 没有 profile patch（bin/mt.sh render 会补）"
  fi
done

head_ "控制面"
# 监听表只取一次：`ss | grep -q` 在 pipefail 下会因 SIGPIPE 被误判为没有监听。
LISTEN="$(ss -ltn 2>/dev/null)"
GW_BASE="http://127.0.0.1:${MT_EDGE_PORT:-8090}"
if [ -f state/tls/server.crt ]; then GW_BASE="http://127.0.0.1:${MT_HTTP_PORT:-8099}"; fi
gstate="$(docker inspect ${PREFIX}gateway --format '{{.State.Status}}' 2>/dev/null || echo missing)"
if [ "$HAS_GATEWAY" = yes ]; then
  [ "$gstate" = running ] && ok "网关容器运行中" || bad "网关容器状态: $gstate"
  HEALTH="$(curl -fsS "$GW_BASE/__mt/health" 2>/dev/null || true)"
  if [ -n "$HEALTH" ]; then
    READY="$(printf '%s' "$HEALTH" | tr -d ' \n' | grep -o '"ready":true' | wc -l)"
    TOTAL="$(printf '%s' "$HEALTH" | tr -d ' \n' | grep -o '"id":"' | wc -l)"
    [ "$READY" = "$TOTAL" ] && ok "全部租户就绪 ($READY/$TOTAL)" || bad "仅 $READY/$TOTAL 个租户就绪"
  else
    bad "健康接口无响应（本机 curl $GW_BASE/__mt/health）"
  fi
  # 本机租户的注册端点是 http://<本机>:3199/proxy/<租户>，由本机节点代理提供。代理不在
  # 时症状是一长串"每个租户都连不上 + 就绪 0/N + 登录 503"，全部指向同一个原因，所以这
  # 里单独点名——控制面这台上也需要它（不是只有节点才需要）。
  if [ -n "$LOCAL_TENANTS" ]; then
    APORT="${MT_AGENT_PORT:-3199}"
    ASTATUS="$(docker inspect ${PREFIX}node-agent --format '{{.State.Status}}' 2>/dev/null || echo missing)"
    if printf '%s\n' "$LISTEN" | grep -q ":$APORT "; then
      ok "节点代理在监听 $APORT（本机租户的注册端点由它提供）"
    else
      bad "没有进程监听 ${APORT}：本机租户的注册端点 http://<本机>:${APORT}/proxy/<租户> 由它提供，代理不在时每个租户都连不上（容器状态: ${ASTATUS}，执行 bin/mt.sh agent up）"
    fi
  fi
else
  # 节点没有网关。它要保证的是"节点代理在跑、知道向谁注册、密钥对得上"——
  # 这三样里任何一样不对，本机的租户在控制面上都不会出现（登录 503）。
  astate="$(docker inspect ${PREFIX}node-agent --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  [ "$astate" = running ] && ok "节点代理运行中（发现本机租户并注册到控制面）" || bad "节点代理状态: $astate（bin/mt.sh agent up）"
  RKEY_A="$(tr -d '\r\n' < state/register.key 2>/dev/null || true)"
  if [ -z "${MT_CONTROL_PLANE:-}" ] || [ -z "$RKEY_A" ]; then
    bad "控制面地址或注册密钥缺失：bin/node-install.sh --node ${THIS_NODE} --fetch-from <控制面>"
  else
    CP_CODE="$(curl -sSk -o /dev/null -w '%{http_code}' --max-time 10 -H "x-mt-registry-key: $RKEY_A" "${MT_CONTROL_PLANE%/}/__mt/registry" 2>/dev/null || true)"
    case "$CP_CODE" in
      200) ok "控制面可达且认这把注册密钥（${MT_CONTROL_PLANE}）" ;;
      401) bad "控制面拒绝了本机的注册密钥（401）：state/register.key 与控制面不一致，重跑 bin/node-install.sh --fetch-from <控制面>" ;;
      "")  bad "控制面连不上（${MT_CONTROL_PLANE}）：查网络与防火墙" ;;
      *)   bad "控制面返回 $CP_CODE（${MT_CONTROL_PLANE}）" ;;
    esac
  fi
fi

# 子路径接入：浏览器入口常常是前置代理上的 https://<域名>/<前缀>，而本机端口只是
# 它的后端。网关必须把登录表单、跳转、cookie Path 都按这个前缀生成，否则表单会提交到
# 代理的根路径上（那里没有我们），页面看起来正常却登不进去——这类故障在浏览器里才暴露，
# 所以在这里用一条不需要口令的请求把它钉住。
head_ "子路径接入"
# 节点没有网关，也没有浏览器入口：子路径、登录表单、cookie Path 都是网关那边的事。
# 在节点上照跑只会得到一串"入口页取不到"的假失败（它本来就不提供入口）。
if [ "$HAS_GATEWAY" != yes ]; then
  printf '    本机是节点 %s：网关与浏览器入口在提供入口的那台机器上，这些检查在它上面做\n' "$THIS_NODE"
else
BASE_PATH="${MT_BASE_PATH:-}"
BASE_PATH="${BASE_PATH%/}"
# 必须问公开入口，而不是上面那个 loopback 运维端口：运维端口不属于浏览器入口，
# 网关在它上面故意不挂载（脚本与 cookie 的 Path 都按老样子）。挂在子路径下这件事
# 只有浏览器看到的那个入口才体现得出来。
PUBLIC_SCHEME="http"; [ -f state/tls/server.crt ] && PUBLIC_SCHEME="https"
PUBLIC_BASE="$PUBLIC_SCHEME://127.0.0.1:${MT_EDGE_PORT:-8090}"
ENTRY_PAGE="$(curl -fsSk "$PUBLIC_BASE${BASE_PATH}/" 2>/dev/null || true)"
if [ -z "$ENTRY_PAGE" ]; then
  bad "入口页取不到（$PUBLIC_BASE${BASE_PATH}/）"
else
  ACTION="$(printf '%s' "$ENTRY_PAGE" | grep -o 'action="[^"]*"' | head -1 | cut -d'"' -f2)"
  if [ "$ACTION" = "${BASE_PATH}/__mt/login" ]; then
    ok "登录表单提交到 ${BASE_PATH}/__mt/login（与入口前缀一致）"
  else
    bad "登录表单提交到 ${ACTION:-（页面里没有 action）}，但入口前缀是 ${BASE_PATH:-（根路径）} —— 浏览器会提交到代理的根路径上"
  fi
  if [ -n "$BASE_PATH" ]; then
    BARE="$(curl -sSk -o /dev/null -w '%{http_code}' "$PUBLIC_BASE$BASE_PATH" 2>/dev/null || true)"
    [ "$BARE" = "301" ] && ok "不带尾斜杠的 $BASE_PATH 会 301 到 $BASE_PATH/" \
      || warn "访问 $BASE_PATH（无尾斜杠）返回 $BARE，期望 301；代理若已自行规范化可以忽略"
  fi
fi
# .env 里写了前缀但容器没拿到，是"改完配置没有重建/up"这一类：入口页看着对，实际仍是旧行为。
if [ -n "$BASE_PATH" ]; then
  IN_CONTAINER="$(docker inspect ${PREFIX}gateway --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep -E '^MT_BASE_PATH=' | head -1 | cut -d= -f2-)"
  [ "$IN_CONTAINER" = "$BASE_PATH" ] && ok "网关容器已带 MT_BASE_PATH=$BASE_PATH" \
    || bad "网关容器里 MT_BASE_PATH='${IN_CONTAINER:-（空）}'，.env 里是 '$BASE_PATH'（bin/mt.sh up 重渲染，网关镜像改了还要先 build）"
else
  ok "没配 MT_BASE_PATH：入口挂在根路径（直接访问本机端口）"
fi
fi
# Key 免口令登录：身份网关校验证书后把用户名写进一个 cookie，本网关只认它，而且
# 只认配置里那些地址送来的它（否则网段里谁都能自造一条 cookie 冒名登录）。
head_ "Key 免口令登录"
if [ "$HAS_GATEWAY" != yes ]; then
  printf '    本机是节点 %s：Key 免口令登录在网关那一台，这里不检查\n' "$THIS_NODE"
else
KEY_FROM="${MT_KEY_LOGIN_FROM:-}"
KEY_SECRET="${MT_KEY_LOGIN_SECRET:-}"
KEY_COOKIE="${MT_KEY_LOGIN_COOKIE:-KOAL_CERT_E}"
if [ -z "$KEY_FROM" ] && [ -z "$KEY_SECRET" ]; then
  ok "未开启（MT_KEY_LOGIN_FROM / MT_KEY_LOGIN_SECRET 都没配），登录页只有口令方式"
else
  ok "已开启，身份 Cookie 名 ${KEY_COOKIE}"
  [ -n "$KEY_FROM" ] && ok "  只接受这些地址送来的身份: $KEY_FROM"
  [ -n "$KEY_SECRET" ] && ok "  要求代理带 X-MT-Key-Auth 头（第二道锁）"
  case "${KEY_FROM// /}" in
    *0.0.0.0/0*)
      if [ -n "$KEY_SECRET" ]; then
        warn "  信任列表含 0.0.0.0/0，靠第二道锁收紧：别把 MT_KEY_LOGIN_SECRET 泄露给网段"
      else
        bad "  信任列表是 0.0.0.0/0 且没有第二道锁：网段里任何人自造一条 Cookie 就能登录成任意用户"
      fi
      ;;
  esac
  IN_CONTAINER_FROM="$(docker inspect ${PREFIX}gateway --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep -E '^MT_KEY_LOGIN_FROM=' | head -1 | cut -d= -f2-)"
  [ "$IN_CONTAINER_FROM" = "$KEY_FROM" ] && ok "网关容器已带 MT_KEY_LOGIN_FROM" \
    || bad "网关容器里 MT_KEY_LOGIN_FROM='${IN_CONTAINER_FROM:-（空）}'，.env 里是 '${KEY_FROM}'（bin/mt.sh up 重渲染）"
  KEY_PAGE="$(curl -fsSk "$PUBLIC_BASE${BASE_PATH}/" 2>/dev/null || true)"
  printf '%s' "$KEY_PAGE" | grep -q "action=\"${BASE_PATH}/__mt/key-login\"" \
    && ok "登录页给出了 Key 入口（${BASE_PATH}/__mt/key-login）" \
    || bad "登录页没有 Key 入口：Key 登录开着，用户却看不到这条路径"
  printf '%s' "$KEY_PAGE" | grep -q "action=\"${BASE_PATH}/__mt/login\"" \
    && ok "登录页仍然保留口令方式" || bad "登录页只剩下 Key 一条路，口令登录不见了"
fi
fi

# 沙箱：DSH 的选择链是 bwrap → Landlock，两条都不行时租户的每条命令都会以
# SANDBOX_UNAVAILABLE 失败——只有显式 danger-full-access 才跑得起来。所以这里把
# "实际哪条可用"与"配置的权限模式"对照一次：配了 workspace-write 却没有沙箱，
# 是一个会让人百思不得其解的故障（命令全挂，看起来像模型不会用工具）。
head_ "沙箱"
SANDBOX_VERDICT="$(bash bin/sandbox-check.sh 2>/dev/null | sed -n 's/^沙箱结论: //p' | head -1)"
MODE_CFG="$(grep '^DSH_PERMISSION_MODE=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
MODE_CFG="${MODE_CFG:-workspace-write}"
case "$SANDBOX_VERDICT" in
  bwrap|landlock)
    if [ "$MODE_CFG" = danger-full-access ]; then
      warn "  沙箱可用（${SANDBOX_VERDICT}）但配置是 danger-full-access：当前是无约束在跑，可以改成 workspace-write"
    else
      ok "  沙箱可用（${SANDBOX_VERDICT}），权限模式 ${MODE_CFG}"
    fi
    ;;
  none)
    if [ "$MODE_CFG" = danger-full-access ]; then
      warn "  这台机器没有可用沙箱（bwrap 与 Landlock 都不行），已显式选择 danger-full-access：容器本身即边界"
    else
      bad "  没有可用沙箱，但 DSH_PERMISSION_MODE=${MODE_CFG}：租户的每条命令都会以 SANDBOX_UNAVAILABLE 失败（改成 danger-full-access，或换内核 ≥5.13，或给镜像补 bubblewrap）"
    fi
    ;;
  *)
    warn "  沙箱结论读不到：手工跑 bin/sandbox-check.sh 看原因"
    ;;
esac

head_ "运行时注册"
# 控制面不再看 Docker，只代理注册进来的地址。没有注册 = 该租户登录后必然 503。
# 节点上没有网关：注册表在控制面那一台，用注册密钥从远端读（这个接口对非回环调用者
# 要求注册密钥）。节点读不到控制面时，下面每条注册检查都会失败——那正是它要说的事。
REG_URL=""
REGISTRY=""
if [ "$HAS_GATEWAY" = yes ]; then
  REG_URL="$GW_BASE/__mt/registry"
  REGISTRY="$(curl -fsS "$REG_URL" 2>/dev/null || true)"
else
  RKEY="$(tr -d '\r\n' < state/register.key 2>/dev/null || true)"
  if [ -z "${MT_CONTROL_PLANE:-}" ]; then
    bad "节点没有配 MT_CONTROL_PLANE：代理不知道向谁注册（bin/node-install.sh）"
  elif [ -z "$RKEY" ]; then
    bad "缺 state/register.key：节点注册要用控制面的密钥（bin/node-install.sh --fetch-from <控制面>）"
  else
    REG_URL="${MT_CONTROL_PLANE%/}/__mt/registry"
    REGISTRY="$(curl -fsSk --max-time 10 -H "x-mt-registry-key: $RKEY" "$REG_URL" 2>/dev/null || true)"
  fi
fi
if [ -z "$REGISTRY" ]; then
  [ -n "$REG_URL" ] && bad "注册表接口无响应（$REG_URL）"
else
  [ "$HAS_GATEWAY" = yes ] || ok "控制面注册表可读（$REG_URL）"
  REG_COUNT="$(printf '%s' "$REGISTRY" | tr -d ' \n' | grep -o '"endpoint":"' | wc -l)"
  TENANT_COUNT="$(printf '%s\n' "$TENANTS" | grep -c . || true)"
  if [ "${REG_COUNT:-0}" = "${TENANT_COUNT:-0}" ]; then
    ok "${REG_COUNT}/${TENANT_COUNT} 个租户都已注册运行时"
  else
    bad "只有 ${REG_COUNT}/${TENANT_COUNT} 个租户注册了运行时：bin/mt.sh runtimes 查看；本机租户用 bin/mt.sh register，远端租户看该节点的代理日志"
  fi
  # 逐个核对：注册了但要连不上，同样是故障。
  for t in $TENANTS; do
    ENTRY="$(printf '%s' "$REGISTRY" | tr -d ' \n' | grep -o "\"${t}\":{[^}]*}" || true)"
    if [ -z "$ENTRY" ]; then
      bad "  $t 未注册"
      continue
    fi
    EP="$(printf '%s' "$ENTRY" | grep -o '"endpoint":"[^"]*"' | cut -d'"' -f4)"
    NODE="$(printf '%s' "$ENTRY" | grep -o '"node":"[^"]*"' | cut -d'"' -f4)"
    # 只探测住在**本机**的租户：别的节点上的运行时本机多半连不上（那里的防火墙
    # 只放行网关），那是正常状态，不该报成故障。
    if [ "$NODE" != "$THIS_NODE" ]; then
      ok "  $t -> 节点 $NODE（不在本机，注册存在即可）"
      continue
    fi
    CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 4 "$EP/" 2>/dev/null || true)"
    if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
      ok "  $t -> $EP （节点 $NODE，HTTP $CODE）"
    else
      bad "  $t -> $EP 连不上（节点 $NODE）"
    fi
  done
fi
if [ "$HAS_GATEWAY" = yes ]; then
  # 控制面不该再需要 Docker：一旦挂上了 socket，"攻破网关 = 拿到宿主" 就回来了。
  if docker inspect ${PREFIX}gateway --format '{{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null | grep -q 'docker.sock'; then
    bad "网关仍挂载 Docker socket（等于宿主 root 等价物）"
  else
    ok "网关未挂载 Docker socket"
  fi

  for p in 8090 8091 8092 8093; do
    if printf '%s\n' "$LISTEN" | grep -q ":$p "; then ok "端口 $p 在监听"; else warn "端口 $p 未监听"; fi
  done
else
  # 节点上必须监听的是节点代理端口：网关要把浏览器的租户请求转发到
  # http://<本机>:3199/proxy/<租户>。
  APORT="${MT_AGENT_PORT:-3199}"
  if printf '%s\n' "$LISTEN" | grep -q ":$APORT "; then ok "节点代理端口 $APORT 在监听"; else bad "节点代理端口 $APORT 未监听（bin/mt.sh agent up）"; fi
fi

# 控制台页面能不能用，不看状态码也不看页面里有没有那些控件：整页脚本一旦有语法
# 错误，浏览器里表格永远停在"加载中"、所有按钮都不响应，而接口、状态码、页面
# 内容全都是好的。这里解析服务端【真正会送出】的那段脚本，不需要登录。
head_ "控制台页面"
if [ "$HAS_GATEWAY" != yes ]; then
  printf '    本机是节点 %s：管理控制台在网关那一台（/__mt/admin），这里不检查\n' "$THIS_NODE"
elif [ "$gstate" = running ]; then
  SERVED_ERR="$(docker exec ${PREFIX}gateway node -e '
const vm = require("node:vm")
const html = require("/app/admin-page.js").consolePage("/__mt/admin", { user: "doctor", role: "admin" })
const open = html.indexOf("<script>")
const close = html.lastIndexOf("</script>")
if (open < 0 || close < 0) { console.log("页面里没有 script 块"); } else {
  try { new vm.Script(html.slice(open + 8, close)); console.log("") } catch (error) { console.log(error.message) }
}
' 2>&1 | tr -d '\r')"
  if [ -z "$SERVED_ERR" ]; then
    ok "服务端送出的控制台脚本能解析（页面上的按钮才会响应）"
  else
    bad "控制台脚本有语法错误，页面在浏览器里不会工作: $SERVED_ERR"
  fi
else
  warn "网关没在运行，跳过控制台页面检查"
fi

# 租户网络本身：MAC 撞车与孤儿网络。
#
# Docker 按容器在某网络上的 IP 生成 MAC（02:42:<ip>）并一直保留。IP 会随重建变化，
# 留下的旧 MAC 让网桥分不清两台容器。实测：mt-dsh-alpha 与模型网关在 mt-net-alpha 上
# 都是 02:42:0a:62:8e:02，alpha 连不上模型网关（EHOSTUNREACH），另外三个租户却正常。
head_ "租户网络"
NET_PREFIX="$NET"
# 注册表里的租户是换行分隔的，拼成"两端带空格"的一行才好做子串匹配（多租户时
# 用空格拼模式会一个都匹配不上，把正常网络全报成孤儿）。
TENANTS_SPACE=" $(printf '%s' "$TENANTS" | tr '\n' ' ') "
COLLIDE=""
ORPHAN=""
for n in $(docker network ls --format '{{.Name}}' 2>/dev/null | grep -E "^${NET_PREFIX}(-|$)" | sort); do
  PAIRS=""
  for c in $(docker network inspect "$n" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null); do
    mac="$(docker inspect "$c" --format "{{with index .NetworkSettings.Networks \"$n\"}}{{.MacAddress}}{{end}}" 2>/dev/null)"
    [ -n "$mac" ] && PAIRS="${PAIRS}${mac} ${c}"$'\n'
  done
  for m in $(printf '%s' "$PAIRS" | awk 'NF{print $1}' | sort | uniq -d); do
    WHO="$(printf '%s' "$PAIRS" | awk -v m="$m" 'NF && $1 == m {printf "%s ", $2}')"
    COLLIDE="${COLLIDE}"$'\n'"    ${n}: ${m} 同时属于 ${WHO}"
  done
  if [ "$n" != "$NET_PREFIX" ]; then
    # 用 sed 取后缀：`${n#"$PREFIX"-}` 这种嵌套引号在 CentOS 7 的 bash 4.2 上不成立，
    # 会把所有租户网络都当成孤儿。
    SUFFIX="$(printf '%s' "$n" | sed "s/^${NET_PREFIX}-//")"
    case "$TENANTS_SPACE" in
      *" $SUFFIX "*) : ;;
      *) ORPHAN="$ORPHAN $n" ;;
    esac
  fi
done
if [ -n "$COLLIDE" ]; then
  bad "同一张网络上有容器 MAC 相同（网桥分不清它们，会随机连不上）：$COLLIDE
   修法：重建其中一个容器（bin/mt.sh restart 不会换 MAC，需要 docker-compose up -d --force-recreate <service>）"
else
  ok "租户网络上没有 MAC 冲突"
fi
if [ -n "${ORPHAN// /}" ]; then
  warn "注册表里没有对应租户的网络还在:$ORPHAN（删租户现在会连带删除；历史残留可 docker network rm）"
else
  ok "没有多余的租户网络"
fi

# 限速是**运行时**规则（tc 落在容器的 netns 里）：机器重启或容器重建都会把它清掉，而
# 意图文件 state/bandwidth.json 还在 —— 于是"以为限着、其实没限"。这里逐租户核对意图与
# 现状，不一致就点名（重放：bin/mt.sh up 或 bin/bandwidth.sh apply）。
if [ -s state/bandwidth.json ]; then
  BW_INTENT="$(python3 - state/bandwidth.json <<'PY' 2>/dev/null || true
import json, sys
try:
    print(' '.join(json.load(open(sys.argv[1], encoding='utf-8')).keys()))
except Exception:
    pass
PY
)"
  BW_MISSING=""
  for t in ${BW_INTENT:-}; do
    # 先取输出再匹配，不要写成 `cmd | grep -q`：doctor 开了 pipefail，而 bandwidth.sh
    # 的退出码在"该租户没规则"等路径上可能是非零，管道整体就会失败，把"已限速"也判成没限速
    # （这个假警报我自己踩过：同一时刻手工 show 显示已限速，doctor 却说没落下）。
    BW_OUT="$(bash bin/bandwidth.sh show "$t" 2>/dev/null || true)"
    case "$BW_OUT" in *已限速*) : ;; *) BW_MISSING="$BW_MISSING $t" ;; esac
  done
  # 增删租户会重建容器：那一刻运行时规则被清掉，随后由同一次操作重放（可能几十秒）。
  # 只在缺规则时才轮询等待，避免把"正在重放"报成"没限速"。
  for _ in 1 2 3; do
    [ -z "${BW_MISSING// /}" ] && break
    sleep 5
    BW_MISSING=""
    for t in ${BW_INTENT:-}; do
      BW_OUT="$(bash bin/bandwidth.sh show "$t" 2>/dev/null || true)"
      case "$BW_OUT" in *已限速*) : ;; *) BW_MISSING="$BW_MISSING $t" ;; esac
    done
  done
  if [ -n "${BW_MISSING// /}" ]; then
    warn "限速规则没落下:$BW_MISSING（重启/重建会清掉运行时规则，跑 bin/bandwidth.sh apply 重放）"
  else
    ok "限速意图与现状一致（${BW_INTENT}）"
  fi
fi

head_ "防火墙与网络"
PORTS="$(firewall-cmd --list-ports 2>/dev/null || true)"
# 租户网络的地址段（默认 10.98.<n>.0/24）如果被这台机器上**别的系统**也占着，发往
# 容器的包会被那个系统的路由抢走，症状是节点代理报 connect ETIMEDOUT <容器地址>:<端口>，
# 而宿主自己看着一切正常（租户容器 Up、代理在监听）。k8s 的 pod CIDR 常常就是 10.98.0.0/16。
# 这里只看路由：有指向非本部署网桥的 10.98.x.x 路由，就说明这段地址有别人在用。
TENANT_BASE="$(grep '^MT_TENANT_SUBNET_BASE=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
TENANT_BASE="${TENANT_BASE:-10.98}"
ROUTE_CLASH="$(ip route 2>/dev/null | grep -E "(^| )${TENANT_BASE//./\\.}\.[0-9]+" | grep -vE 'dev (mtbr|br-|docker)' | head -3)"
if [ -n "$ROUTE_CLASH" ]; then
  warn "租户网段 ${TENANT_BASE}.x 也被这台机器上的别的系统路由（$(printf '%s' "$ROUTE_CLASH" | tr '\n' ';')）：发往租户容器的包会被抢走，症状是节点代理报 connect ETIMEDOUT。把 .env 的 MT_TENANT_SUBNET_BASE 换一段没人用的（例如 10.99），然后 bin/mt.sh up（租户容器会重建并换地址）"
fi
# 节点不用开网关端口，它要开的是"网关能连到本机代理"。放行没做对时，节点侧一切正常
# （它能连出去注册），只有控制面那台登录会 502 —— 实测过，从现象追不到防火墙。
if [ "$HAS_GATEWAY" != yes ]; then
  APORT="${MT_AGENT_PORT:-3199}"
  if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    RICH="$(firewall-cmd --list-rich-rules 2>/dev/null || true)"
    if printf '%s\n' "$PORTS" | grep -q "${APORT}/tcp" || printf '%s' "$RICH" | grep -q "port=\"${APORT}\""; then
      ok "防火墙放行到节点代理端口 ${APORT}/tcp"
    else
      warn "防火墙没放行 ${APORT}/tcp：网关转发租户请求会被拒（bin/node-install.sh --allow-from <网关地址> 补规则）"
    fi
  else
    warn "本机没跑 firewalld：自行确认网关能连 ${APORT}/tcp（bin/node-install.sh --allow-from <网关地址>）"
  fi
elif [ -n "$PORTS" ]; then
  for p in 8090 8091 8092 8093; do
    echo "$PORTS" | grep -q "$p/tcp" && ok "防火墙放行 $p/tcp" || warn "防火墙未放行 $p/tcp"
  done
else
  warn "没有 firewalld（或未运行），跳过端口检查"
fi
if [ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = "0" ]; then
  warn "宿主 ip_forward=0：bridge 网络的端口映射对外不通，控制面因此用 host 网络（这是本部署的既定做法）"
else
  ok "宿主 ip_forward 已开启"
fi

head_ "租户出网"
EGRESS_STATE="$(docker inspect ${PREFIX}egress-proxy --format '{{.State.Status}}' 2>/dev/null || echo missing)"
if [ "$EGRESS_STATE" = running ]; then
  ok "出口代理容器运行中（端口 ${MT_EGRESS_PORT:-3128}，宿主的公网出口）"
else
  bad "出口代理容器状态: $EGRESS_STATE"
fi
if [ -n "${MT_EGRESS_PROXY:-}" ]; then
  ok "MT_EGRESS_PROXY=${MT_EGRESS_PROXY}"
else
  warn "MT_EGRESS_PROXY 未设置：bridge 容器没有外网路由，租户将无法调用模型（bin/mt.sh up 会自动补）"
fi
# 出口与隔离的实测要在**本机**的租户容器里做：远端租户的容器不在本机，
# 拿它当探针只会得到"容器不存在"这种与结论无关的错误。
# 注意 Local_TENANTS 是**空格分隔的一行**（不是多行）：要拆词，不能直接 printf '%s\n'。
FIRST_TENANT="$(printf '%s\n' $LOCAL_TENANTS | head -1)"
# 用出口代理自己的宿主地址当"内网目标"：它必然是私网地址，且不必写死任何 IP。
PROBE_INTERNAL="$(printf '%s' "${MT_EGRESS_PROXY:-}" | sed 's|^http[s]*://||; s|:.*$||')"
if [ -n "$FIRST_TENANT" ] && [ "$EGRESS_STATE" = running ] && [ -n "$PROBE_INTERNAL" ]; then
  egress_probe() {
    docker exec -e PROBE_INTERNAL="$PROBE_INTERNAL" "${PREFIX}dsh-${FIRST_TENANT}" node -e '
    const proxy = process.env.HTTPS_PROXY
    const internal = process.env.PROBE_INTERNAL
    if (!proxy) { console.log("no-proxy-in-container"); process.exit(0) }
    const net = require("node:net")
    const [phost, pport] = proxy.replace("http://", "").split(":")
    const ask = (host, port) => new Promise((resolve) => {
      const socket = net.connect(Number(pport), phost, () => {
        socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
      })
      socket.once("data", (chunk) => { socket.destroy(); resolve(String(chunk).split("\r\n")[0]) })
      socket.on("error", () => resolve("error"))
      setTimeout(() => { socket.destroy(); resolve("timeout") }, 10000)
    })
    ;(async () => {
      const publicResult = await ask("api.deepseek.com", 443)
      const internalResult = await ask(internal, 8090)
      console.log(`${publicResult.includes("200") ? "public-ok" : "public-fail"} ${internalResult.includes("403") ? "internal-blocked" : "internal-ALLOWED"}`)
    })()
  ' 2>/dev/null | tr -d '\r'
  }
  PROBE="$(egress_probe)"
  # 刚 up 完时最早的那次可能撞上出口代理还在起（租户容器同理），于是报出一个
  # 只存在几秒的假故障——而"部署完立刻跑 doctor"正是最会撞上的时刻，所以重试一次再判。
  case "$PROBE" in
    "public-ok internal-blocked") ;;
    *) sleep 3; PROBE="$(egress_probe)" ;;
  esac
  case "$PROBE" in
    "public-ok internal-blocked") ok "  实测 ${FIRST_TENANT}: 可经代理访问公网，且内网地址被拒" ;;
    "no-proxy-in-container") warn "  ${FIRST_TENANT} 容器里没有 HTTPS_PROXY（执行 bin/mt.sh up）" ;;
    # 这条检查要断言的不变量是两条：租户能连上出口代理、私网地址被它拒掉。
    # 公网能不能出去是**环境事实**，不是部署正确性——隔离内网里本来就没有公网，
    # 配了 MT_EGRESS_ALLOW 时公网按白名单被拒也是设计行为。把它们当成失败，会让
    # 一台跑得好好的隔离机器永远停在"1 项失败"上，然后有人去追一个不存在的问题。
    "public-fail internal-blocked") warn "  实测 ${FIRST_TENANT}: 出口代理可达、内网地址被拒；公网不可达（隔离内网下正常，被白名单拒绝也算这一档）" ;;
    "public-ok internal-ALLOWED") bad "  ${FIRST_TENANT} 的出口代理放行了私网地址：隔离失效（检查 MT_EGRESS_ALLOW 与 NO_PROXY）" ;;
    "") bad "  出口代理没有应答：租户的出网链路不通（bin/mt.sh logs egress-proxy）" ;;
    *) bad "  ${FIRST_TENANT} 出口实测异常: ${PROBE}" ;;
  esac
fi

head_ "租户对宿主的访问"
# 与 bin/isolate.sh 用同一套解析：优先渲染时固定的网桥名，否则退回 br-<网络id>。
# 两边必须一致，否则 doctor 会在规则完全正常时报"网桥不对"。
BRIDGE="$(docker network inspect ${NET} --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null | tr -d '\r')"
if [ -z "$BRIDGE" ] || [ "$BRIDGE" = "<no value>" ]; then
  BRIDGE="br-$(docker network inspect ${NET} --format '{{.Id}}' 2>/dev/null | cut -c1-12)"
fi
  # 两个后端都要认：CentOS 上是 firewalld 的 direct 规则，Ubuntu（装不了 firewalld）上是
  # iptables 专用链。只按 firewalld 判断会在 Ubuntu 上把"已经隔离好了"报成未启用。
  DIRECT_RULES="$(firewall-cmd --permanent --direct --get-all-rules 2>/dev/null | grep -c 'mt-tenant-isolation' || true)"
  # 一律带 -w：iptables 与 firewalld/docker 会抢 xtables 锁，不等就会随机拿到空结果。
  IPT_RULES="$(iptables -w -S MT_TENANT_ISOLATION 2>/dev/null | grep -c -- "-i " || true)"
  IPT_JUMPED=no
  iptables -w -S INPUT 2>/dev/null | grep -q -- "-j MT_TENANT_ISOLATION" && IPT_JUMPED=yes
  if [ "${DIRECT_RULES:-0}" -lt 2 ] && [ "${IPT_RULES:-0}" -ge 2 ] && [ "$IPT_JUMPED" = yes ]; then
    ok "隔离规则已生效（iptables 链 MT_TENANT_ISOLATION，${IPT_RULES} 条接口规则）"
    if [ -f /etc/systemd/system/mt-tenant-isolation.service ]; then
      ok "  有开机单元：重启后会自动重建（iptables 规则本身重启会丢）"
    else
      warn "  没有开机单元：重启后租户又能访问宿主端口（bin/isolate.sh install-boot）"
    fi
  elif [ "${DIRECT_RULES:-0}" -ge 2 ]; then
  if firewall-cmd --permanent --direct --get-all-rules 2>/dev/null | grep 'mt-tenant-isolation' | grep -q -- "-i ${BRIDGE} "; then
    ok "隔离规则已生效，作用于当前网桥 ${BRIDGE}"
    # `iptables -L -n` 不显示 in 接口列，要用 -S 才能看到 -i 参数。
    if iptables -w -S INPUT_direct 2>/dev/null | grep -q -- "-i ${BRIDGE}"; then
      ok "  规则已在运行时加载"
    else
      bad "  规则未加载到运行时：firewall-cmd --reload"
    fi
  else
    bad "隔离规则指向的网桥不是当前的 ${BRIDGE}：bin/mt.sh isolate apply"
  fi
else
  bad "未限制租户对宿主端口的访问：容器可直达 Harbor/Nacos/Prometheus 等（bin/mt.sh isolate apply）"
fi
# 实测一次：从第一个租户容器访问宿主的一个端口，应当连不上。
# 目标地址运行时推导（宿主自己的局域网 IP），不写死任何 IP。
LAN_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1)"
if [ -n "${FIRST_TENANT:-}" ] && [ -n "$LAN_IP" ]; then
  REACHED="$(docker exec -e PROBE_HOST="$LAN_IP" -e PROBE_PORT="${MT_EGRESS_PORT:-3128}" "${PREFIX}dsh-${FIRST_TENANT}" node -e '
    const net = require("node:net")
    // 探一个宿主上公开但不属于本部署的端口：既有单租户部署的 3080。
      // 打印一次就退出：留着定时器会再打印一行，比较结果时就变成了两行（实测踩过）。
      const done = (text) => { console.log(text); process.exit(0) }
      const s = net.connect(3080, process.env.PROBE_HOST, () => { s.destroy(); done("reached") })
      s.on("error", () => done("blocked"))
      setTimeout(() => { s.destroy(); done("blocked") }, 3000)
  ' 2>/dev/null | tr -d '\r')"
  if [ "$REACHED" = blocked ]; then
    ok "  实测 ${FIRST_TENANT}: 访问宿主其它端口被拒"
  else
    bad "  实测 ${FIRST_TENANT}: 仍能访问宿主端口（结果 ${REACHED:-无响应}）"
  fi
fi
# 反方向也必须通：宿主上的节点代理与网关要能连**进**租户容器，这是投递用户请求的那一跳。
# 隔离规则只该丢"容器主动发起的新连接"，一旦连带把回程也丢掉，症状就非常难认：容器里
# 能看到 SYN_RECV（SYN 到了）、宿主侧 ETIMEDOUT、节点代理 502、统一入口登录 502，而两边
# 各自看着都正常。iptables 后端曾经如此（链挂在 INPUT 第 1 位、在 conntrack 之前）。
if [ -n "$LOCAL_TENANTS" ]; then
  HOST_TO_TENANT=no
  for _t in $(printf '%s\n' $LOCAL_TENANTS | head -2); do
    _ip="$(docker inspect "${PREFIX}dsh-$_t" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -m1 '^10\.' || true)"
    _pt="$(grep -A6 "\"id\": \"$_t\"" tenants.json 2>/dev/null | grep -o '"internalPort": *[0-9]*' | grep -o '[0-9]*' | head -1)"
    [ -n "$_ip" ] && [ -n "$_pt" ] || continue
    if timeout 4 bash -c "cat < /dev/null > /dev/tcp/${_ip}/${_pt}" 2>/dev/null; then HOST_TO_TENANT=yes; break; fi
  done
  if [ "$HOST_TO_TENANT" = yes ]; then
    ok "  实测 宿主 -> 本机租户容器：可连（代理与网关投递请求走的就是这条路）"
  else
    bad "  实测 宿主 -> 本机租户容器：连不上——隔离规则可能把回程也丢了（重跑 bin/isolate.sh apply），或容器里的运行时没在监听"
  fi
fi

head_ "日志上限"
# json-file 驱动默认不封顶：容器一直写就把磁盘写满。逐个容器核实，并报出实际占用。
UNBOUNDED=""
LOG_TOTAL=0
for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^(mt-|mock-model)' | sort); do
  MAXSIZE="$(docker inspect "$c" --format '{{index .HostConfig.LogConfig.Config "max-size"}}' 2>/dev/null)"
  LOGPATH="$(docker inspect "$c" --format '{{.LogPath}}' 2>/dev/null)"
  if [ -n "$LOGPATH" ] && [ -f "$LOGPATH" ]; then
    SIZE="$(stat -c%s "$LOGPATH" 2>/dev/null || echo 0)"
    LOG_TOTAL=$((LOG_TOTAL + SIZE))
  fi
  if [ -z "$MAXSIZE" ] || [ "$MAXSIZE" = "<no value>" ]; then
    UNBOUNDED="$UNBOUNDED $c"
  fi
done
if [ -z "$UNBOUNDED" ]; then
  ok "本部署的容器都有日志上限（${MT_LOG_MAX_SIZE:-10m} × ${MT_LOG_MAX_FILE:-3}）"
else
  bad "以下容器日志无上限，磁盘可能被写满：$UNBOUNDED"
fi
ok "  本部署容器日志当前合计 $(echo "scale=1; $LOG_TOTAL/1048576" | bc) MB"
AVAIL_KB="$(df -k / | tail -1 | awk '{print $4}')"
if [ "${AVAIL_KB:-0}" -lt 5242880 ]; then
  warn "  根分区可用不足 5 GB，先清理再排查其它问题"
fi
if ! grep -q 'max-size' /etc/docker/daemon.json 2>/dev/null; then
  ok "  备注：宿主 daemon.json 未设全局 log-opts，其它系统的容器仍无上限（不属于本部署）"
fi

head_ "传输加密"
CERT="state/tls/server.crt"
if [ -f "$CERT" ] && [ -f state/tls/server.key ]; then
  if openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null 2>&1; then
    ok "证书有效，到期 $(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2)"
  else
    bad "证书已过期：$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2)"
  fi
  if [ "$HAS_GATEWAY" != yes ]; then
    printf '    本机是节点 %s：证书由提供入口的网关使用，本机不据此提供 TLS\n' "$THIS_NODE"
  elif docker inspect ${PREFIX}gateway --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^MT_TLS_CERT='; then
    ok "  网关以 HTTPS 提供公开端口"
    if printf '%s\n' "$LISTEN" | grep -q ":${MT_HTTP_PORT:-8099} "; then
      ok "  运维明文端口 ${MT_HTTP_PORT:-8099} 在监听（仅 loopback，供本机脚本用）"
    else
      warn "  运维端口 ${MT_HTTP_PORT:-8099} 未监听（本机脚本会连不上）"
    fi
  else
    warn "  证书已存在但网关仍走明文：执行 bin/mt.sh up 让它生效"
  fi
else
  warn "未配置 TLS，公开端口为明文 HTTP；bin/mt.sh cert 可生成自签证书"
fi

head_ "模型接入"
MG_STATE="$(docker inspect ${PREFIX}model-gateway --format '{{.State.Status}}' 2>/dev/null || echo missing)"
if [ "$MG_STATE" = running ]; then
  ok "模型网关容器运行中"
  UP_LEN="$(docker exec ${PREFIX}model-gateway sh -c 'printf %s "${#MT_UPSTREAM_KEY}"' 2>/dev/null || echo 0)"
  if [ "${UP_LEN:-0}" -gt 0 ]; then
    ok "  网关持有真凭据（长度 ${UP_LEN}）"
  else
    bad "  网关没有上游凭据：在 .env 设置 MT_UPSTREAM_API_KEY 后 bin/mt.sh up"
  fi
  # 伪造 key 必须被拒——否则网关成了任何人可用的中转。
  #
  # 探测容器按注册表顺序挑一个【在跑的】租户，而不是 docker ps 的第一行：
  # 新增/删除租户时会有容器正在建或正在删，挑到它就得到 "unreachable"，
  # 那不是拦截失败，是探针自己踩空了。另外新增租户会重建模型网关（它要接入
  # 新租户的网络），这几秒里连真请求也会失败，所以失败等 5 秒再判一次。
  PROBE_CONTAINER=""
  for t in $LOCAL_TENANTS; do
    if [ "$(docker inspect "${PREFIX}dsh-$t" --format '{{.State.Status}}' 2>/dev/null)" = running ]; then
      PROBE_CONTAINER="${PREFIX}dsh-$t"
      break
    fi
  done
  FORGED=""
  for _ in 1 2; do
    [ -n "$PROBE_CONTAINER" ] || break
    FORGED="$(docker exec -e MT_MODEL_URL="http://${PREFIX}model-gateway:8080" "$PROBE_CONTAINER" node -e '
    fetch(process.env.MT_MODEL_URL + "/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-mt-forged" },
      body: "{}",
    }).then((r) => console.log(String(r.status))).catch(() => console.log("unreachable"))
  ' 2>/dev/null | tr -d '\r')"
    [ "$FORGED" = "401" ] && break
    sleep 5
  done
  if [ "$FORGED" = "401" ]; then
    ok "  未知 key 被拒（401）"
  elif [ -z "$PROBE_CONTAINER" ]; then
    # 本机没有在跑的租户容器可用作探针（节点上租户都在别处，或刚建好还没起来）。
    # 这不是"网关没拦"，是这台机器上没法从租户侧发起请求。
    warn "  本机没有在跑的租户容器可作探针，跳过伪造 key 检查（网关侧拦截已随其它检查覆盖）"
  else
    bad "  未知 key 未被拒绝：${FORGED:-无响应}（刚新增过租户时会重建模型网关，那几秒里请求本就不通）"
  fi
else
  bad "模型网关容器状态: $MG_STATE（bin/mt.sh up）"
fi

# 真凭据绝不能出现在租户容器里：环境变量、容器配置、容器文件三者都查。
REAL_KEY="$(grep -E '^MT_UPSTREAM_API_KEY=.+' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
if [ -n "$REAL_KEY" ]; then
  REAL_TAIL="${REAL_KEY: -8}"
  LEAKED=""
  for t in $LOCAL_TENANTS; do
    if docker exec "${PREFIX}dsh-$t" sh -c 'env' 2>/dev/null | grep -q "$REAL_TAIL" \
      || docker inspect "${PREFIX}dsh-$t" 2>/dev/null | grep -q "$REAL_TAIL"; then
      LEAKED="$LEAKED $t"
    fi
  done
  if [ -z "$LEAKED" ]; then
    ok "  真凭据未出现在任何租户容器里"
  else
    bad "  真凭据泄漏到租户容器:$LEAKED"
  fi
else
  warn "  .env 里没有 MT_UPSTREAM_API_KEY（模型调用会失败）"
fi

# 每个租户应持有占位 key，且 base URL 指向网关。
KEY_OK=0; KEY_BAD=0; KEY_MISSING=0
for t in $LOCAL_TENANTS; do
  KEY_HEAD="$(docker exec "${PREFIX}dsh-$t" sh -c 'printf %s "${DEEPSEEK_API_KEY:-}"' 2>/dev/null | cut -c1-6)"
  BASE="$(docker exec "${PREFIX}dsh-$t" sh -c 'printf %s "${DEEPSEEK_BASE_URL:-}"' 2>/dev/null)"
  case "$KEY_HEAD" in
    sk-mt-) KEY_OK=$((KEY_OK + 1)) ;;
    "") KEY_MISSING=$((KEY_MISSING + 1)); warn "  $t 没有 DEEPSEEK_API_KEY：bin/mt.sh up 会补发占位 key" ;;
    *) KEY_BAD=$((KEY_BAD + 1)); bad "  $t 的 DEEPSEEK_API_KEY 不是占位 key" ;;
  esac
  case "$BASE" in
    http://${PREFIX}model-gateway:*|"") ;;
    *) KEY_BAD=$((KEY_BAD + 1)); bad "  $t 的 DEEPSEEK_BASE_URL 未指向模型网关：$BASE" ;;
  esac
done
if [ "$KEY_BAD" = 0 ] && [ "$KEY_MISSING" = 0 ]; then
  ok "  ${KEY_OK} 个租户都持有占位 key，模型请求都经网关"
fi

if grep -q 'CHANGE-ME' model.patch.yml 2>/dev/null; then
  warn "model.patch.yml 仍是模板：租户只能用内置 DeepSeek 卡片（已由网关代理）"
else
  ok "model.patch.yml 已填写"
  grep -oE '^ +[a-z0-9-]+:' model.patch.yml 2>/dev/null | sed 's/^/      路由 /' || true
fi
# `grep -c` 无匹配时打印 0 且退出码为 1，这里按行取值，避免把 "0" 与默认值拼在一起。
KEYS="$(grep -cE '^[A-Z_]+=.+' model.env 2>/dev/null)"
KEYS="${KEYS:-0}"
[ "$KEYS" -gt 0 ] && ok "model.env 里有 $KEYS 个非空变量" || warn "model.env 里没有非空变量"
if grep -qE '^DEEPSEEK_API_KEY=.+' model.env 2>/dev/null; then
  warn "model.env 里仍有 DEEPSEEK_API_KEY：真凭据会被注入所有租户容器，请删掉并放到 .env 的 MT_UPSTREAM_API_KEY"
fi
# 用量记录：网关每次请求都会追加一行，用来回答"哪个租户花了多少"。
if [ -f logs/model-usage.jsonl ]; then
  USAGE_LINES="$(wc -l < logs/model-usage.jsonl 2>/dev/null | tr -d ' ')"
  ok "模型用量记录 logs/model-usage.jsonl（${USAGE_LINES:-0} 条）"
else
  warn "还没有模型用量记录（租户尚未发起过模型请求）"
fi

# 离线升级要先有镜像：有内网仓库时走 registry-push，没有时只能 docker save/load。
# 仓库挂了不会影响正在跑的租户，所以这里不当作致命错误，但必须看得见。
head_ "内网仓库（离线升级用）"
REG_HOST="$(grep -E '^MT_REGISTRY_HOST=' .env 2>/dev/null | tail -1 | cut -d= -f2)"
REG_PLAIN="$(grep -E '^MT_REGISTRY_PLAIN_HTTP=' .env 2>/dev/null | tail -1 | cut -d= -f2)"
if [ -z "$REG_HOST" ]; then
  warn "未配 MT_REGISTRY_HOST：registry-push 不可用，离线升级只能 docker save/load 搬镜像"
else
  REG_SCHEME=https
  [ "$REG_PLAIN" = "1" ] && REG_SCHEME=http
  REG_CODE="$(curl -sSk -o /dev/null -w '%{http_code}' --max-time 8 "$REG_SCHEME://$REG_HOST/v2/" 2>/dev/null)"
  case "$REG_CODE" in
    200|401) ok "内网仓库可达: $REG_SCHEME://$REG_HOST（HTTP $REG_CODE）" ;;
    000|"")  bad "内网仓库 $REG_SCHEME://$REG_HOST 连不上 —— registry-push 会失败" ;;
    *)       warn "内网仓库返回 HTTP $REG_CODE（可能不是 registry v2 端点）" ;;
  esac
fi

head_ "资源与备份"
AVAIL="$(df -h / | awk 'NR==2{print $4}')"
USEDP="$(df -h / | awk 'NR==2{print $5}' | tr -d '%')"
[ "$USEDP" -lt 85 ] && ok "磁盘剩余 $AVAIL（已用 ${USEDP}%）" || warn "磁盘已用 ${USEDP}%，剩余 $AVAIL"
# `free` 的 available 列（$7）是 procps 3.3 之后才有的；老版本或裁剪过的镜像里
# 读到空值，原先那条判断就打印成"可用内存仅  MB"——一个没有数字的警告没人能处理。
MEM="$(free -m 2>/dev/null | awk '/Mem:/{print $7}')"
case "${MEM:-}" in
  ''|*[!0-9]*) MEM="$(awk '/^MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || true)" ;;
esac
case "${MEM:-}" in
  ''|*[!0-9]*) warn "读不到可用内存（free 与 /proc/meminfo 都没给数）：手工看一眼 free -m" ;;
  *) if [ "$MEM" -gt 512 ]; then ok "可用内存 ${MEM} MB"; else warn "可用内存仅 ${MEM} MB"; fi ;;
esac
LAST="$(ls -1t backups/dsh-mt-*.tar.gz 2>/dev/null | head -1 || true)"
if [ -z "$LAST" ]; then
  warn "还没有任何备份（bin/backup.sh）"
else
  AGE_H=$(( ($(date +%s) - $(stat -c %Y "$LAST")) / 3600 ))
  [ "$AGE_H" -lt 48 ] && ok "最近备份 $(basename "$LAST")（${AGE_H} 小时前）" \
    || warn "最近备份是 ${AGE_H} 小时前的 $(basename "$LAST")"
fi

# 备份打的是本机的 tenants/，别节点上的租户不在里面。这是警告而不是失败：
# 多节点部署本来就该在每台机器上各备一次，但操作者必须知道"这份备份不完整"。
# 否则出了事照它恢复，会以为那个租户本来就没数据。
THIS_NODE_NAME="${MT_NODE_NAME:-local}"
OFF_NODE=""
for t in $TENANTS; do
  n="$(NODE_OF "$t")"
  [ -n "$n" ] && [ "$n" != "$THIS_NODE_NAME" ] && OFF_NODE="$OFF_NODE $t($n)"
done
if [ -n "$OFF_NODE" ]; then
  warn "这些租户不在本机备份内（数据在别的节点上，需到那台机器执行 bin/mt.sh backup）:$OFF_NODE"
else
  ok "全部租户都由本机备份覆盖"
fi

# 会话保留策略：设了就会自动清理，没设就一直长。两种都行，但操作者要知道是哪种。
RETENTION="$(grep '^MT_SESSION_RETENTION_DAYS=' .env 2>/dev/null | cut -d= -f2- | tr -d '"')"
if [ -n "$RETENTION" ]; then
  # 说清楚是"打算保留多少"，而不是"系统会替你清理"——清理目前仍要手工执行。
  ok "会话保留策略记为 ${RETENTION} 天（清理目前需手工执行 bin/mt.sh disk prune-sessions）"
else
  warn "没有设置 MT_SESSION_RETENTION_DAYS，也没有自动清理：会话会一直增长，磁盘会慢慢满"
fi

# 节点代理的控制面地址。留空时代理只提供运维能力、不做租户发现与注册，而且这是静默的：
# 界面上一切正常，直到某个租户重启（启动 token 会轮换）之后，统一入口才开始一直返回 303。
# 这一项曾经丢掉过一次（restore 用归档里的 .env 覆盖了当前配置），排查了一整轮，所以它是失败项。
#
# 还有第三种状态：值还是 .env.example 里的占位符（https://CHANGE-ME:8090）。它非空，
# 于是"配过了"，但代理每次注册都会以 getaddrinfo（解析 change-me）失败告终——实测在
# 一台真机上，日志里 12 个租户全是 `register ... failed: getaddrinfo EAI_AGAIN change-me`，
# 而 doctor 说"已配置、会注册"。非空不等于配好，占位符在这里是失败项。
# 取**最后**一条：`. ./.env` 与 compose 都是后出现的赋值生效，doctor 取第一条时，
# 一份 .env 里出现两次（先占位符、后真地址）会让它报一个不存在的失败。
CONTROL_PLANE_VALUE="$(grep '^MT_CONTROL_PLANE=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
CONTROL_PLANE_CA_VALUE="$(grep '^MT_CONTROL_PLANE_CA=' .env 2>/dev/null | tail -1 | cut -d= -f2-)"
case "$(printf '%s' "$CONTROL_PLANE_VALUE" | tr 'A-Z' 'a-z')" in
  *change-me*|*changeme*|*example.com*)
    bad "MT_CONTROL_PLANE 还是占位符（${CONTROL_PLANE_VALUE}）：节点代理解析不了这个主机名，注册全部失败——实测真机上 docker logs ${PREFIX}node-agent 里 12 个租户全是 getaddrinfo EAI_AGAIN change-me。改成这台机器自己的地址：MT_CONTROL_PLANE=https://<本机IP>:${MT_EDGE_PORT:-8090}" ;;
  "")
    bad "MT_CONTROL_PLANE 为空：节点代理不会注册租户，租户重启后统一入口会一直返回 303" ;;
  *)
    if [ -n "$CONTROL_PLANE_CA_VALUE" ]; then
      ok "节点代理已配置控制面地址与 CA（会注册租户）"
    else
      warn "节点代理有控制面地址但没有 MT_CONTROL_PLANE_CA：HTTPS 自签证书下注册会失败"
    fi ;;
esac

# .env 里已删租户的残留键。
#
# 不能简单地看 MT_<前缀>_：MT_CONTROL_PLANE、MT_BACKUP_KEEP、MT_EDGE_PORT 这些功能键
# 都会命中那个形状。实测过：天真写法把 13 个功能键误报成"残留租户"，
# 而一个每次都喊狼来了的检查，结局是被忽略。
#
# 所以后缀是【推导】出来的：当前租户的键用过哪些后缀，那些后缀就是租户后缀。
# render 以后加了新字段，这里自动跟上，不用改。
STALE_TMP="$(mktemp -d)"
python3 - "$STALE_TMP" <<'PY' >/dev/null 2>&1 || true
import json, re, sys
out = sys.argv[1]
ids = {t['id'] for t in json.load(open('tenants.json'))['tenants']}
entries = []
for line in open('.env', encoding='utf-8'):
    m = re.match(r'^MT_([A-Z0-9_]+?)_([A-Z0-9_]+)=', line)
    if m:
        entries.append((m.group(1).lower().replace('_', '-'), m.group(2), line.split('=')[0]))
# 当前租户用过的后缀，才算法租户后缀
suffixes = {suf for prefix, suf, _ in entries if prefix in ids}
stale = sorted({prefix for prefix, suf, _ in entries if suf in suffixes and prefix not in ids})
keys = sorted(k for prefix, suf, k in entries if suf in suffixes and prefix not in ids)
open(f'{out}/stale.txt', 'w').write(' '.join(stale))
open(f'{out}/keys.txt', 'w').write('\n'.join(keys))
open(f'{out}/suffixes.txt', 'w').write(' '.join(sorted(suffixes)))
PY
STALE="$(cat "$STALE_TMP/stale.txt" 2>/dev/null)"
SUFFIXES="$(cat "$STALE_TMP/suffixes.txt" 2>/dev/null)"
if [ -n "${STALE// /}" ]; then
  bad ".env 里有已删租户的残留键 → $STALE（租户后缀: $SUFFIXES；删掉这些行，然后 render 一次）"
else
  ok ".env 里没有已删租户的残留键（租户后缀: ${SUFFIXES:-推导不出}）"
fi
rm -rf "$STALE_TMP"

# 配置漂移：拿最近一次备份里记下的 .env 键清单，和当前 .env 比对。
# restore 会用归档里的 .env 覆盖当前配置，而且不提示——真正咬人的是键整个消失
# （MT_CONTROL_PLANE 丢过一次，表现为节点代理静默降级、租户重启后入口一直 303）。
LATEST_ARCHIVE="$(ls -t backups/dsh-mt-*.tar.gz 2>/dev/null | head -1)"
if [ -n "$LATEST_ARCHIVE" ]; then
  DRIFT_TMP="$(mktemp -d)"
  if tar -xzf "$LATEST_ARCHIVE" -C "$DRIFT_TMP" MANIFEST.txt 2>/dev/null; then
    # 备份时的键（MANIFEST 里 "  - KEY" 形式）
    sed -n '/^环境键清单  :/,/^[^ ]/p' "$DRIFT_TMP/MANIFEST.txt" 2>/dev/null \
      | grep -oE '^  - [A-Za-z_][A-Za-z0-9_]*' | sed 's/^  - //' | sort -u > "$DRIFT_TMP/then.txt"
    grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env 2>/dev/null | sed 's/=$//' | sort -u > "$DRIFT_TMP/now.txt"
    MISSING="$(comm -23 "$DRIFT_TMP/then.txt" "$DRIFT_TMP/now.txt" | tr '\n' ' ')"
    ADDED="$(comm -13 "$DRIFT_TMP/then.txt" "$DRIFT_TMP/now.txt" | tr '\n' ' ')"
    if [ -n "${MISSING// /}" ]; then
      bad "配置漂移：$(basename "$LATEST_ARCHIVE") 里有的这些键现在没了 → $MISSING（多半是 restore 用归档覆盖了 .env，恢复后要补回并 render）"
    elif [ -n "${ADDED// /}" ]; then
      warn "备份之后新增的配置键: $ADDED（记得在下一次备份前确认它们是对的）"
    else
      ok "配置键与最近一次备份一致（$(wc -l < "$DRIFT_TMP/now.txt" | tr -d ' ') 个）"
    fi
    # 没有清单的老归档：说清楚，而不是假装检查过
    [ -s "$DRIFT_TMP/then.txt" ] || warn "最近一次备份的 MANIFEST 里没有键清单（老版本备份），无法比对配置漂移"
  else
    warn "读不出最近一次备份的 MANIFEST，跳过配置漂移检查"
  fi
  rm -rf "$DRIFT_TMP"
else
  warn "还没有备份，无法比对配置漂移"
fi

printf '\n\033[36m== 结论 ==\033[0m\n  %s 项通过, %s 项警告, %s 项失败\n' "$OK" "$WARN" "$BAD"
[ "$BAD" -eq 0 ] || exit 1
