#!/usr/bin/env bash
# 部署自检：把"能不能用、哪里不对"一次性列清楚。
#
#   bin/doctor.sh
#
# 只读，不改任何状态；退出码 0 表示没有致命问题（警告不算）。
set -uo pipefail
cd "$(dirname "$0")/.."

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
[ -f docker-compose.yml ] && ok "docker-compose.yml 已生成" || warn "docker-compose.yml 未生成（bin/mt.sh render）"

head_ "租户运行时"
for t in $TENANTS; do
  state="$(docker inspect "mt-dsh-$t" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  case "$state" in
    running) ok "$t 容器运行中（镜像 $(docker inspect "mt-dsh-$t" --format '{{.Config.Image}}')）" ;;
    missing) bad "$t 容器不存在" ;;
    *)       bad "$t 容器状态: $state" ;;
  esac
  [ -d "tenants/$t/home" ] && ok "  $t home 存在（$(du -sh "tenants/$t/home" 2>/dev/null | cut -f1)，会话 $(find "tenants/$t/home/sessions" -name 'session*.jsonl*' 2>/dev/null | wc -l) 个）" \
    || bad "  $t home 缺失"
  patch="tenants/$t/home/profiles/web/cordis.patch.yml"
  [ -f "$patch" ] && ok "  $t profile patch 存在" || warn "  $t 没有 profile patch（bin/mt.sh render 会补）"
done

head_ "控制面"
gstate="$(docker inspect mt-gateway --format '{{.State.Status}}' 2>/dev/null || echo missing)"
[ "$gstate" = running ] && ok "网关容器运行中" || bad "网关容器状态: $gstate"
# 监听表只取一次：`ss | grep -q` 在 pipefail 下会因 SIGPIPE 被误判为没有监听。
LISTEN="$(ss -ltn 2>/dev/null)"
HEALTH="$(curl -fsS "http://127.0.0.1:${MT_EDGE_PORT:-8090}/__mt/health" 2>/dev/null || true)"
if [ -n "$HEALTH" ]; then
  READY="$(printf '%s' "$HEALTH" | tr -d ' \n' | grep -o '"ready":true' | wc -l)"
  TOTAL="$(printf '%s' "$HEALTH" | tr -d ' \n' | grep -o '"id":"' | wc -l)"
  [ "$READY" = "$TOTAL" ] && ok "全部租户就绪 ($READY/$TOTAL)" || bad "仅 $READY/$TOTAL 个租户就绪"
else
  bad "健康接口无响应（本机 curl 127.0.0.1:${MT_EDGE_PORT:-8090}/__mt/health）"
fi
for p in 8090 8091 8092 8093; do
  if printf '%s\n' "$LISTEN" | grep -q ":$p "; then ok "端口 $p 在监听"; else warn "端口 $p 未监听"; fi
done

head_ "防火墙与网络"
PORTS="$(firewall-cmd --list-ports 2>/dev/null || true)"
if [ -n "$PORTS" ]; then
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

head_ "模型接入"
if grep -q 'CHANGE-ME' model.patch.yml 2>/dev/null; then
  warn "model.patch.yml 仍是模板：租户只能用内置 DeepSeek 卡片，且需要 key 才能真的对话"
else
  ok "model.patch.yml 已填写"
  grep -oE '^ +[a-z0-9-]+:' model.patch.yml 2>/dev/null | sed 's/^/      路由 /' || true
fi
# `grep -c` 无匹配时打印 0 且退出码为 1，这里按行取值，避免把 "0" 与默认值拼在一起。
KEYS="$(grep -cE '^[A-Z_]+=.+' model.env 2>/dev/null)"
KEYS="${KEYS:-0}"
[ "$KEYS" -gt 0 ] && ok "model.env 里有 $KEYS 个非空变量" || warn "model.env 里没有非空变量（租户无法发起模型请求）"

head_ "资源与备份"
AVAIL="$(df -h / | awk 'NR==2{print $4}')"
USEDP="$(df -h / | awk 'NR==2{print $5}' | tr -d '%')"
[ "$USEDP" -lt 85 ] && ok "磁盘剩余 $AVAIL（已用 ${USEDP}%）" || warn "磁盘已用 ${USEDP}%，剩余 $AVAIL"
MEM="$(free -m | awk '/Mem:/{print $7}')"
[ "${MEM:-0}" -gt 512 ] && ok "可用内存 ${MEM} MB" || warn "可用内存仅 ${MEM} MB"
LAST="$(ls -1t backups/dsh-mt-*.tar.gz 2>/dev/null | head -1 || true)"
if [ -z "$LAST" ]; then
  warn "还没有任何备份（bin/backup.sh）"
else
  AGE_H=$(( ($(date +%s) - $(stat -c %Y "$LAST")) / 3600 ))
  [ "$AGE_H" -lt 48 ] && ok "最近备份 $(basename "$LAST")（${AGE_H} 小时前）" \
    || warn "最近备份是 ${AGE_H} 小时前的 $(basename "$LAST")"
fi

printf '\n\033[36m== 结论 ==\033[0m\n  %s 项通过, %s 项警告, %s 项失败\n' "$OK" "$WARN" "$BAD"
[ "$BAD" -eq 0 ] || exit 1
