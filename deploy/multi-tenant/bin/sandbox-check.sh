#!/usr/bin/env bash
# 沙箱体检：这套部署的租户实际会走哪条沙箱路，以及它是不是真的在拦。
#
#   bin/sandbox-check.sh              # 用 .env 里的 DSH_IMAGE
#   bin/sandbox-check.sh <镜像>       # 指定镜像
#   bin/sandbox-check.sh --all        # 额外试一次"给容器 SYS_ADMIN"时 bwrap 能否起来
#
# 只读：起几个一次性容器跑探针，不改任何状态。退出码 0 = 至少一条路可用。
#
# 为什么需要它：DSH 的沙箱链是 bwrap → Landlock，**两条路的前提完全不同**——
#   bwrap 需要一个用户命名空间（容器里能不能建，取决于内核与 Docker 的 seccomp）；
#   Landlock 需要内核 5.13+（ABI 1 起，ABI 越高管得越细）。
# 而"宿主上 bwrap 可用"不等于"容器里的 DSH 可用"，所以这件事只能在这里问。
set -uo pipefail
cd "$(dirname "$0")/.."

ALL=no
IMG=""
for arg in "$@"; do
  case "$arg" in
    --all) ALL=yes ;;
    *) IMG="$arg" ;;
  esac
done
if [ -z "$IMG" ] && [ -f .env ]; then IMG="$(grep -E '^DSH_IMAGE=' .env | tail -1 | cut -d= -f2-)"; fi
[ -n "$IMG" ] || { echo "用法: bin/sandbox-check.sh [镜像]（或先在 .env 里写 DSH_IMAGE）" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "找不到 docker" >&2; exit 2; }
docker image inspect "$IMG" >/dev/null 2>&1 || { echo "本机没有镜像 $IMG" >&2; exit 2; }

MODE="${DSH_PERMISSION_MODE:-（未设置 → DSH 默认 workspace-write）}"
SECCOMP=()
[ -f security/seccomp-tenant.json ] && SECCOMP=(--security-opt "seccomp=$PWD/security/seccomp-tenant.json")

echo "镜像           : $IMG"
echo "权限模式       : $MODE"
echo "内核           : $(uname -r)"
echo "LSM            : $(cat /sys/kernel/security/lsm 2>/dev/null || echo '读不到')"
echo "seccomp 策略   : ${SECCOMP[1]:-（没找到 security/seccomp-tenant.json）}"
echo

bwrap=no
landlock=no

echo "== 1) bwrap =="
if ! docker run --rm --entrypoint sh "$IMG" -c 'command -v bwrap >/dev/null 2>&1'; then
  echo "   ✗ 镜像里没有 bwrap（系统命令里也没有）"
  echo "     要这条路的更强隔离：把 bubblewrap 打进镜像（离线包里的 sandbox-debs/ 就是它）"
else
  echo "   ✓ 镜像里有 bwrap：$(docker run --rm --entrypoint sh "$IMG" -c 'bwrap --version' | head -1)"
  # DSH 自己就是这么探的：跑一次只读 profile 的 true，退出码 0 才算可用。
  probe() {
    docker run --rm "${SECCOMP[@]}" --entrypoint sh "$IMG" -c "$1" 2>&1 | tail -2
  }
  echo -n "   原样参数（DSH 内置探针）："
  out="$(probe 'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true && echo OK || echo FAIL')"
  case "$out" in
    *OK*) echo "可用"; bwrap=yes ;;
    *)    echo "不可用 —— $(printf '%s' "$out" | head -1)" ;;
  esac
  echo -n "   加 --unshare-user（自建用户命名空间）："
  out="$(probe 'bwrap --unshare-user --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true && echo OK || echo FAIL')"
  case "$out" in
    *OK*) echo "可用"; bwrap=yes ;;
    *)    echo "不可用 —— $(printf '%s' "$out" | head -1)" ;;
  esac
  if [ "$ALL" = yes ]; then
    echo -n "   给容器 SYS_ADMIN + 不套默认 seccomp："
    out="$(docker run --rm --cap-add SYS_ADMIN --security-opt seccomp=unconfined --entrypoint sh "$IMG" \
      -c 'bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true && echo OK || echo FAIL' 2>&1 | tail -1)"
    case "$out" in
      *OK*) echo "可用（但代价见下：这是给租户容器加 SYS_ADMIN，等于削弱容器边界）" ;;
      *)    echo "不可用" ;;
    esac
  fi
fi
echo

echo "== 2) Landlock =="
LAUNCHER="$(docker run --rm --entrypoint sh "$IMG" -c 'find /usr/local/lib/node_modules -name landlock-run | head -1' 2>/dev/null | tr -d '\r')"
if [ -z "$LAUNCHER" ]; then
  echo "   ✗ 镜像里找不到 landlock-run（这个镜像不是本部署的运行时镜像？）"
else
  echo "   启动器：$LAUNCHER"
  # 启动器自带功能性探针：退出码 0 = 内核真的在拦；125 = 没拦住（附原因）。
  LOUT="$(docker run --rm "${SECCOMP[@]}" --entrypoint sh "$IMG" -c "$LAUNCHER --probe; echo 退出码=\$?" 2>&1 | tail -2)"
  case "$LOUT" in
    *"退出码=0"*) echo "   ✓ 功能性探针通过：内核在拦（ABI 见下）"; landlock=yes ;;
    *)            echo "   ✗ 探针未通过：$(printf '%s' "$LOUT" | head -1)" ;;
  esac
  ABI="$(docker run --rm --entrypoint node -w /usr/local/lib/node_modules/@deepseek-ai/dsh "$IMG" -e '
    import("@deepseek-ai/node-addon-system/landlock-run").then((m) => {
      const value = typeof m.abi === "function" ? m.abi() : (typeof m.landlockAbi === "function" ? m.landlockAbi() : undefined)
      console.log(value === undefined ? "（这个构建没导出 ABI 读数）" : `ABI ${String(value)}`)
    }).catch(() => console.log("（读不到）"))' 2>/dev/null | tr -d '\r')"
  echo "   内核 ABI：${ABI:-（读不到）}"
fi
echo

# 机器可读的一行，给 bin/doctor.sh 用（人看下面的结论）。
if [ "$bwrap" = yes ]; then echo "沙箱结论: bwrap"
elif [ "$landlock" = yes ]; then echo "沙箱结论: landlock"
else echo "沙箱结论: none"; fi

echo "== 结论 =="
if [ "$bwrap" = yes ]; then
  echo "   bwrap 可用 → 想拿到更强隔离（多一层 PID/proc 视图隔离）就在 .env 里加 MT_SANDBOX_BWRAP=1；"
  echo "   不加也已经是好的：DSH 会自己选 bwrap。"
elif [ "$landlock" = yes ]; then
  echo "   bwrap 在容器里起不来，但 **Landlock 可用** → 保持 DSH_PERMISSION_MODE=workspace-write，"
  echo "   沙箱是开着的（Landlock 管文件写入：只读全盘 + 只允许写工作区与 /tmp）。"
  echo "   想让 bwrap 也起来，得给租户容器加 SYS_ADMIN 并放宽 seccomp——那会削弱容器边界，"
  echo "   本部署不建议（用 --all 可以看到它的效果）。"
else
  echo "   两条路都不可用 → 租户的命令会以 SANDBOX_UNAVAILABLE 失败。"
  echo "   选择：① 换/升级内核（Landlock 要 5.13+）；② 显式接受 DSH_PERMISSION_MODE=danger-full-access"
  echo "   （容器本身即边界），并把原因写进部署记录。"
  exit 1
fi
