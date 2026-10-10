#!/usr/bin/env bash
# 目标机体检：这台机器能不能跑 DSH，租户该用哪种权限模式。
#
# 只读：除了拉取/运行一次性探针容器，不改宿主的任何配置、不写任何文件。
# 可以在一台还没部署过的机器上直接跑（Docker 必须在，探针都靠容器跑——
# 因为租户运行时、控制面、脚本全都跑在容器里，宿主自己的 glibc/Node 版本不参与）。
#
# 用法：
#   bin/preflight.sh                          # 体检本机
#   bin/preflight.sh http://15.11.40.44:3100  # 顺便测模型端点的可达性
#
# 判定依据（来自 DSH 自身，不是通用经验）：
#   * Linux 的沙箱选择链是 bwrap → Landlock（packages/sandbox/sandbox-local）。
#     - bwrap 需要非特权 user namespace；Ubuntu 24.04 起还有 apparmor 的额外限制。
#     - Landlock 需要内核 5.13+（ABI 1，partial）；平台包最多管到 ABI 5 = 内核 6.10+（full）。
#     - 两者都不可用时 DSH **fail closed**（SANDBOX_UNAVAILABLE），只能显式 danger-full-access。
#   * 容器限额靠 Docker：cgroup v1 上块设备（磁盘 I/O）限速无效，磁盘只能靠文件系统配额。
set -uo pipefail

MODEL_ENDPOINT="${1:-}"
OK=0; WARN=0; BAD=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; OK=$((OK + 1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; WARN=$((WARN + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; BAD=$((BAD + 1)); }
head_() { printf '\n\033[36m== %s ==\033[0m\n' "$1"; }

# 探针镜像：优先用本部署的租户运行时镜像（它带 landlock-run），否则退到 node 官方镜像
# （只能测 bwrap，且装 bubblewrap 需要网络）。
# 探针镜像必须【本机真的有】才算数：拉不下来的镜像会让 docker run 什么都不输出，
# 那不能读成"沙箱不可用"（我第一次跑就踩了这个：内核 5.15 且 LSM 里有 landlock，
# 却被报成不可用，而真正失败的是镜像没拉下来）。
PICK_IMAGE=""
IMAGE_SOURCE=""
for candidate in "${DSH_IMAGE:-}" $(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E '^dsh-web:' | head -1); do
  [ -n "$candidate" ] || continue
  if docker image inspect "$candidate" >/dev/null 2>&1; then
    PICK_IMAGE="$candidate"; IMAGE_SOURCE="本部署运行时镜像（带 landlock-run）"; break
  fi
done
if [ -z "$PICK_IMAGE" ] && docker image inspect node:22-bookworm-slim >/dev/null 2>&1; then
  PICK_IMAGE="node:22-bookworm-slim"; IMAGE_SOURCE="node 官方镜像（只能测 bwrap，不含 landlock-run）"
fi

head_ "发行版与内核"
[ -r /etc/os-release ] && ok "$(. /etc/os-release && echo "$PRETTY_NAME")" || warn "读不到 /etc/os-release"
ok "内核 $(uname -r)（$(uname -m)）"
KMAJ="$(uname -r | cut -d. -f1)"; KMIN="$(uname -r | cut -d. -f2)"
glibc="$(ldd --version 2>/dev/null | head -1 | awk '{print $NF}')"
[ -n "$glibc" ] && ok "glibc $glibc（宿主 glibc 只影响在宿主直接跑 Node；本部署的 Node 全在容器里）"

head_ "资源"
ok "CPU $(nproc) 核"
if command -v free >/dev/null 2>&1; then
  MEM="$(free -m 2>/dev/null | awk '/Mem:/{print $7}')"
  if [ -z "$MEM" ]; then
    warn "读不出可用内存（free 的输出不认识）"
  elif [ "$MEM" -ge 2048 ]; then
    ok "可用内存 ${MEM} MB"
  else
    warn "可用内存仅 ${MEM} MB（每个租户常驻约 100 MB，限额另算）"
  fi
else
  warn "没有 free（procps 未安装）：内存无法判定 —— apt install procps"
fi
DF="$(df -h / | awk 'NR==2{print $4" / "$2"（已用 "$5"）"}')"
ok "根分区 $DF"

head_ "Docker 与 cgroup"
if ! command -v docker >/dev/null 2>&1; then
  bad "没有 docker：先装 docker-ce 与 compose v2（本部署的一切都跑在容器里）"
else
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '（守护进程不可用）')"
  CG="$(docker info --format '{{.CgroupVersion}}' 2>/dev/null || stat -fc %T /sys/fs/cgroup 2>/dev/null)"
  CG="${CG#cgroup}"; CG="${CG%fs}"
  case "$CG" in
    v2|2) ok "cgroup v2：内存/CPU/PID 与磁盘 I/O 限速都能生效" ;;
    v1|1) warn "cgroup v1：内存/CPU/PID 可用，但**磁盘 I/O 限速无效**（CentOS 7 上实测同样现象）——磁盘要靠配额" ;;
    *)    warn "读不出 cgroup 版本（$CG）" ;;
  esac
  DRIVER="$(docker info --format '{{.Driver}}' 2>/dev/null)"
  [ "$DRIVER" = overlay2 ] && ok "存储驱动 overlay2" || warn "存储驱动 $DRIVER"
  if docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1; then
    ok "compose v2 可用"
  else
    bad "没有 compose v2（bin/mt.sh 依赖它）"
  fi
  if [ -n "$PICK_IMAGE" ]; then
    ok "探针镜像：$PICK_IMAGE（$IMAGE_SOURCE）"
  else
    warn "本机没有可用于探针的镜像（既无 dsh-web，也没有 node:22-bookworm-slim，且拉不下来）：沙箱只能按内核证据判断"
  fi
fi

head_ "user namespace（bwrap 的前提）"
US="$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo '（该内核没有这个开关）')"
case "$US" in
  1) ok "kernel.unprivileged_userns_clone=1" ;;
  *没有这个开关*) ok "内核没有该开关（5.10+ 默认允许非特权 userns，以 bwrap 实测为准）" ;;
  *) warn "kernel.unprivileged_userns_clone=$US —— bwrap 需要它是 1" ;;
esac
AR="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo '（无此开关）')"
case "$AR" in
  1) warn "kernel.apparmor_restrict_unprivileged_userns=1（Ubuntu 24.04 默认）：bwrap 需要有 AppArmor profile 才能用，否则会被拒" ;;
  *无此开关*) warn "该内核没有 apparmor 限制开关（正常：Ubuntu 24.04+ 才有）" ;;
  *) ok "apparmor 未限制非特权 userns（$AR）" ;;
esac

head_ "沙箱：bubblewrap"
if [ -n "$PICK_IMAGE" ]; then
  BWRAP="$(docker run --rm "$PICK_IMAGE" sh -c '
    command -v bwrap >/dev/null 2>&1 || {
      (apt-get update -qq && apt-get install -y -qq bubblewrap >/dev/null 2>&1) || { echo "no-bwrap"; exit 0; }
    }
    bwrap --ro-bind / / --dev /dev true >/dev/null 2>&1 && echo OK || echo FAIL
  ' 2>/dev/null | tr -d "\r")"
  case "$BWRAP" in
    OK)   ok "bwrap 在容器里可用 → 租户可以用 workspace-write（写限工作区）" ;;
    FAIL) warn "bwrap 装了但起不来（user namespace 被禁或受限）" ;;
    *)    warn "镜像里没有 bwrap 且装不上（离线/无源）：把 bubblewrap 打进镜像，或先接受无沙箱" ;;
  esac
else
  warn "没有可用探针镜像，跳过 bwrap 实测（bwrap 还需要打进租户镜像，见结论）"
fi

head_ "沙箱：Landlock"
# 内核版本决定能拿到哪个 Landlock ABI（1=5.13 ~ 2=5.19 ~ 3=6.2 ~ 4=6.7 ~ 5=6.10+）；
# launcher 最多管到 ABI 5，所以 ABI<5 一律只算 partial。
LL_ABI=0
if [ "$KMAJ" -lt 5 ] || { [ "$KMAJ" -eq 5 ] && [ "$KMIN" -lt 13 ]; }; then LL_ABI=0
elif [ "$KMAJ" -eq 5 ]; then { [ "$KMIN" -le 18 ] && LL_ABI=1; } || LL_ABI=2
else
  case "$KMAJ.$KMIN" in
    6.[0-1]) LL_ABI=2 ;;
    6.[2-6]) LL_ABI=3 ;;
    6.[7-9]) LL_ABI=4 ;;
    *)       LL_ABI=5 ;;
  esac
fi
LSM="$(cat /sys/kernel/security/lsm 2>/dev/null || echo '')"
case "$LSM" in
  *landlock*) LL_LSM=yes ;;
  "")         LL_LSM=unknown ;;
  *)          LL_LSM=no ;;
esac
if [ "$LL_ABI" = 0 ]; then
  bad "内核 $KMAJ.$KMIN < 5.13：**没有 Landlock**（Landlock 自 5.13 起；ABI 5 = 内核 6.10+ 才算 full）"
elif [ "$LL_LSM" = no ]; then
  bad "内核 $KMAJ.$KMIN 支持 Landlock，但 LSM 列表里没有它（lsm= 未启用）：$LSM"
else
  if [ "$LL_LSM" = unknown ]; then
    warn "读不到 /sys/kernel/security/lsm（securityfs 未挂载）：按内核版本推断，建议实测一次"
  else
    ok "LSM 列表含 landlock（$LSM）"
  fi
  if [ "$LL_ABI" = 5 ]; then
    ok "内核 $KMAJ.$KMIN → Landlock ABI 5：launcher 可达到 full"
  else
    warn "内核 $KMAJ.$KMIN → Landlock ABI $LL_ABI：可用，但只治理该 ABI 暴露的访问类别（partial）"
  fi
fi
if [ -n "$PICK_IMAGE" ] && [ "$LL_ABI" != 0 ]; then
  PROBE="$(docker run --rm "$PICK_IMAGE" sh -c '
    L="$(find / -name landlock-run -type f 2>/dev/null | head -1)"
    if [ -z "$L" ]; then echo "no-launcher"; exit 0; fi
    OUT="$("$L" --probe 2>&1)"; CODE=$?
    echo "$OUT (exit=$CODE)"
  ' 2>/dev/null | tr -d "\r")"
  case "$PROBE" in
    *fully*)        ok "Landlock 探针：$PROBE"; LL_PROBE=yes ;;
    *partially*)    warn "Landlock 探针：$PROBE（与内核推断一致）"; LL_PROBE=yes ;;
    *no-launcher*)  warn "探针镜像里没有 landlock-run：以上按内核与 LSM 判断；要实测就用本部署的 dsh-web 镜像"; LL_PROBE=unknown ;;
    "")             warn "探针没跑起来（镜像不可用）：以上按内核与 LSM 判断"; LL_PROBE=unknown ;;
    # 探针问的是内核本身，所以它说"没被强制"时它说了算 —— 版本号和 lsm= 都只是推断。
    *)              bad "Landlock 探针否决：$PROBE"; LL_PROBE=no ;;
  esac
elif [ "$LL_ABI" != 0 ]; then
  warn "没有可用探针镜像，Landlock 未实测（内核证据表明可用）"
  LL_PROBE=unknown
fi

head_ "宿主工具（部署脚本要用）"
for tool in python3 curl openssl nsenter tc ss; do
  command -v "$tool" >/dev/null 2>&1 && ok "$tool" || warn "缺少 $tool"
done
if command -v python3 >/dev/null 2>&1; then
  PYV="$(python3 -c 'import sys;print(".".join(map(str,sys.version_info[:2])))' 2>/dev/null)"
  case "$PYV" in
    3.[6-9]|3.1[0-9]) ok "python3 $PYV（脚本要求 ≥3.6）" ;;
    *) warn "python3 $PYV 太旧（脚本要求 ≥3.6）" ;;
  esac
fi
if command -v firewall-cmd >/dev/null 2>&1; then
  ok "firewalld 已安装（隔离脚本用它）"
elif command -v nft >/dev/null 2>&1 || command -v ufw >/dev/null 2>&1; then
  warn "没有 firewalld（conf：Ubuntu 默认是 nftables/ufw）——隔离规则要装 firewalld 或改写成 nft"
else
  warn "既没有 firewalld 也没有 nft/ufw：租户到宿主端口的隔离没有落点"
fi
command -v xfs_quota >/dev/null 2>&1 && ok "xfs_quota（磁盘配额）" || warn "缺少 xfs_quota：磁盘配额不可用（装 xfsprogs，且数据盘要 XFS + prjquota）"

head_ "文件系统与配额能力"
FS="$(stat -fc %T / 2>/dev/null)"
case "$FS" in
  xfs) ok "根分区是 XFS（可开 prjquota）" ;;
  # 老 coreutils 把 ext2/ext3/ext4 一律打成 "ext2/ext3"，别把它当另一种文件系统。
  ext2/ext3|ext3|ext4)
      warn "根分区是 ext 家族（$FS，多半是 ext4）：本部署的 quota.sh 用 xfs_quota 只对 XFS 有效——数据盘建议单独做 XFS + prjquota" ;;
  *) warn "根分区文件系统 $FS：配额方案要先确认" ;;
esac
mount | grep -q "prjquota" && ok "已有挂载带 prjquota" || warn "当前没有挂载带 prjquota（XFS 配额需要挂载参数，改 fstab 后重启生效）"

head_ "出网"
# 一律先试 IPv4：有 AAAA 记录但没有 IPv6 路由的机器，直接连主机名会去走 IPv6 而失败，
# 那种失败不代表"没有网络"。
reachable() {
  local url="$1"
  curl -sS -4 -o /dev/null -m 8 --connect-timeout 8 "$url" >/dev/null 2>&1 && return 0
  curl -sS    -o /dev/null -m 8 --connect-timeout 8 "$url" >/dev/null 2>&1 && return 0
  return 1
}
if [ -n "$MODEL_ENDPOINT" ]; then
  HOSTP="$(printf '%s' "$MODEL_ENDPOINT" | sed 's|^https\{0,1\}://||; s|[:/].*$||')"
  PORTP="$(printf '%s' "$MODEL_ENDPOINT" | sed 's|^https\{0,1\}://||; s|^[^:/]*||; s|^:||; s|/.*$||')"
  [ -n "$PORTP" ] || PORTP=80
  if reachable "$MODEL_ENDPOINT/"; then
    ok "宿主能连上模型端点 $MODEL_ENDPOINT（能拿到 HTTP 响应即可，401/404 也算通）"
  else
    bad "宿主连不上模型端点 $HOSTP:$PORTP —— 试点必须落在这张网里（或先打通路由）"
  fi
  case "$HOSTP" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|127.*|169.254.*)
      warn "  端点是私网地址：租户出口代理默认拒绝私网目标——真凭据经模型网关（宿主网络）出网，别把该地址当租户直连目标" ;;
  esac
else
  echo "  （未给模型端点参数，跳过；可加一个 URL 复测）"
fi
if reachable https://registry-1.docker.io/v2/; then
  ok "能拉公网镜像（首次部署要 node:22-bookworm-slim 与 npm 包）"
else
  warn "拉不到公网镜像：离线部署要在有网机器上 docker save / npm pack 之后导入"
fi

head_ "结论"
if [ "$BAD" -gt 0 ]; then
  printf '  \033[31m有 %s 项不可用\033[0m：上面标 ✗ 的必须处理，否则跑不起来。\n' "$BAD"
else
  printf '  \033[32m没有硬性不满足的项\033[0m（%s 项警告需要你判断）。\n' "$WARN"
fi
echo "  推荐的租户权限模式："
case "${BWRAP:-}" in
  OK) echo "    DSH_PERMISSION_MODE=workspace-write （bwrap 可用：写只允许落工作区）"; APPROVAL="ask" ;;
  *)
    if [ "${LL_PROBE:-unknown}" = no ]; then
      echo "    DSH_PERMISSION_MODE=danger-full-access （探针说这个内核没有强制 Landlock：只能以容器为边界，审批设 never）"
      APPROVAL="never"
    elif [ "${LL_ABI:-0}" != 0 ] && [ "${LL_LSM:-unknown}" != no ]; then
      if [ "${LL_ABI}" = 5 ]; then
        echo "    DSH_PERMISSION_MODE=workspace-write （Landlock full）"
      else
        echo "    DSH_PERMISSION_MODE=workspace-write （Landlock ABI ${LL_ABI}：可用但只治理部分访问类别）"
      fi
      APPROVAL="ask"
    else
      echo "    DSH_PERMISSION_MODE=danger-full-access （无可用沙箱：只能以容器为边界，审批设 never 免得无人值守挂住）"
      APPROVAL="never"
    fi ;;
esac
echo "    审批策略相应地设为 $APPROVAL"
echo "  另外两件事："
echo "    * 租户镜像里现在没有 bubblewrap。要用 bwrap（比 Landlock 覆盖更完整）就把它打进镜像："
echo "      image/Dockerfile 里加 apt-get install -y bubblewrap（或在基础镜像层里装）。"
echo "    * cgroup v1 上磁盘 I/O 限速无效：磁盘用 XFS + prjquota 兜（Ubuntu 20.04 也可以在 GRUB 加"
echo "      systemd.unified_cgroup_hierarchy=1 切到 cgroup v2，重启后块设备限速才生效）。"
printf '\n  %s 项通过, %s 项警告, %s 项不可用\n' "$OK" "$WARN" "$BAD"
