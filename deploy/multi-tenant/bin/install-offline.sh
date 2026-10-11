#!/usr/bin/env bash
# 离线部署包在**目标机**上的入口：校验文件 → 导入镜像 → 铺开部署目录 → 生成 .env。
#
#   cd dsh-offline-<stamp>
#   ./install-offline.sh --dest /data/dsh-mt        # 装到指定目录（默认 /data/dsh-mt）
#   ./install-offline.sh --check-only               # 只校验，不改任何东西（部署前的门禁）
#
# 只做这四件事，然后停下打印下一步：**不启动容器、不生成密钥、不碰防火墙**——
# 那些都要先看到 .env 里的模型密钥填好了（留空时模型网关会拒绝启动，这是设计如此）。
set -euo pipefail

die() { echo "$*" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="/data/dsh-mt"
CHECK_ONLY=no

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest)       DEST="${2:-}"; shift 2 ;;
    --check-only) CHECK_ONLY=yes; shift ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[ -f "$ROOT/MANIFEST.json" ] || die "这个脚本要放在离线包根目录执行（找不到 MANIFEST.json）"
[ -d "$ROOT/deploy" ] || die "包里缺 deploy/ 目录"
[ -d "$ROOT/images" ] || die "包里缺 images/ 目录"

# 清单里的字段名都是唯一的，用 grep/sed 读比在目标机上引一个 JSON 解析器可靠。
json_get() {
  local value
  value="$(grep -m1 "\"$1\"" "$ROOT/MANIFEST.json" | sed 's/.*: *"\([^"]*\)".*/\1/')"
  [ -n "$value" ] || die "MANIFEST.json 里读不出字段 $1"
  printf '%s' "$value"
}
BUNDLE_NAME="$(json_get bundle)"
SITE="$(json_get site)"
BASE_PATH="$(json_get basePath)"
UPSTREAM="$(json_get upstream)"
DEPLOY_DIR="$(json_get deployDir)"

# 镜像三元组：清单里每个镜像一条 `image_xxx`，逐条取出 ref/id/file。
image_rows() {
  grep -o '"image_[^"]*": {[^}]*}' "$ROOT/MANIFEST.json" | sed 's/^"//; s/": {//; s/}$//'
}
mapfile -t IMAGE_ROWS < <(image_rows)
[ "${#IMAGE_ROWS[@]}" -gt 0 ] || die "MANIFEST.json 里没有镜像条目"

echo "离线包   : $BUNDLE_NAME"
echo "目标站点 : $SITE，入口前缀 $BASE_PATH，模型端点 $UPSTREAM"
echo "部署目录 : $DEST"
echo

echo "== 1/4 校验文件（sha256sum -c SHA256SUMS）"
[ -f "$ROOT/SHA256SUMS" ] || die "包里缺 SHA256SUMS"
( cd "$ROOT" && sha256sum -c SHA256SUMS --quiet ) || die "校验失败：这个包不完整或传输中损坏了（别继续装）"
echo "    ${#IMAGE_ROWS[@]} 个镜像 + 部署目录，全部匹配"

echo "== 2/4 前置检查"
command -v docker >/dev/null 2>&1 || die "找不到 docker"
docker info >/dev/null 2>&1 || die "docker 守护进程不可用（systemctl status docker）"
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else die "既没有 docker compose 插件也没有 docker-compose"; fi
for row in "${IMAGE_ROWS[@]}"; do
  ref="$(printf '%s' "$row" | sed 's/.*"ref": "\([^"]*\)".*/\1/')"
  file="$(printf '%s' "$row" | sed 's/.*"file": "\([^"]*\)".*/\1/')"
  [ -f "$ROOT/$file" ] || die "镜像文件缺失: $file"
  printf '    %-38s %5sMB  %s\n' "$file" "$(( $(stat -c%s "$ROOT/$file") / 1024 / 1024 ))" "$ref"
done
# `|| true` 是必需的：`set -o pipefail` 下 df 对不存在的目录失败会让整条赋值管道失败，
# 而 set -e 会因此**静默**结束脚本——现场看到的是"前几步打印完就没了"。
AVAIL_KB="$(df -Pk "$(dirname "$DEST")" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt $((5 * 1024 * 1024)) ]; then
  echo "    !! $(dirname "$DEST") 只剩 $((AVAIL_KB/1024/1024)) GB —— 镜像约 1.4 GB（解压后），加上租户数据会不够" >&2
fi
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  die "$DEST 不是空目录：换个 --dest，或先手工确认那里的东西不要了（安装脚本不覆盖已有部署）"
fi
echo "    环境检查通过（$COMPOSE）"

if [ "$CHECK_ONLY" = yes ]; then
  echo
  echo "== --check-only：包完整、镜像齐全、$DEST 可用，没有改动任何东西"
  exit 0
fi

echo "== 3/4 导入镜像"
for row in "${IMAGE_ROWS[@]}"; do
  ref="$(printf '%s' "$row" | sed 's/.*"ref": "\([^"]*\)".*/\1/')"
  id="$(printf '%s' "$row" | sed 's/.*"id": "\([^"]*\)".*/\1/')"
  file="$(printf '%s' "$row" | sed 's/.*"file": "\([^"]*\)".*/\1/')"
  docker load -i "$ROOT/$file" >/dev/null || die "导入失败: $file"
  loaded="$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null || true)"
  [ "$loaded" = "$id" ] || die "导入后的 $ref 与清单不符（清单 $id，实际 ${loaded:-无}）"
  echo "    $ref  ← $file（id ${id:0:19}…）"
done

echo "== 4/5 铺开部署目录与 .env"
mkdir -p "$DEST"
( cd "$ROOT/$DEPLOY_DIR" && tar -cf - . ) | ( cd "$DEST" && tar -xf - )
# 可执行位在这里补一次：从 Windows 侧拷贝、解压或经 git 检出都可能丢掉它，
# 而手册里写的是直接 `bin/mt.sh`、`./install-offline.sh`。
chmod +x "$DEST"/bin/*.sh "$DEST"/bin/*.py "$DEST"/bin/*.mjs 2>/dev/null || true
[ -f "$DEST/.env" ] && die "包里的 deploy/ 竟然带着 .env——停在这里，请人工看一下这个包"
cp "$DEST/.env.example" "$DEST/.env"
chmod 600 "$DEST/.env"

set_env() {
  local key="$1" value="$2"
  if grep -qE "^#?${key}=" "$DEST/.env"; then
    sed -i "s|^#\?${key}=.*|${key}=${value}|" "$DEST/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$DEST/.env"
  fi
}
RUNTIME_IMAGE="$(printf '%s\n' "${IMAGE_ROWS[@]}" | grep -o '"ref": "dsh-web:local[^"]*"' | sed 's/.*: "//; s/"$//' | head -1 || true)"
[ -n "$RUNTIME_IMAGE" ] || die "清单里没有本机构建的运行时镜像（dsh-web:local*）"
set_env DSH_IMAGE "$RUNTIME_IMAGE"
set_env TZ "Asia/Shanghai"
set_env MT_BIND_IP "0.0.0.0"
set_env MT_EDGE_PORT "8090"
set_env MT_BASE_PATH "$BASE_PATH"
set_env MT_KEY_LOGIN_FROM "$(json_get keyLoginFrom)"
set_env MT_UPSTREAM_BASE "$UPSTREAM"
set_env DSH_PERMISSION_MODE "workspace-write"
set_env MT_TENANT_NETWORKS "all"
# 真密钥不进包：留空让模型网关**拒绝启动**（响亮地失败），而不是带着占位符悄悄跑起来。
if grep -qE "^#?MT_UPSTREAM_API_KEY=" "$DEST/.env"; then
  sed -i "s|^#\?MT_UPSTREAM_API_KEY=.*|MT_UPSTREAM_API_KEY=|" "$DEST/.env"
else
  printf 'MT_UPSTREAM_API_KEY=\n' >> "$DEST/.env"
fi
sed -i '1i # 由 install-offline.sh 生成：目标站点 '"$SITE"'。真密钥请填在下面这一行，\n# 留空时模型网关会拒绝启动（这是设计如此，不是故障）。' "$DEST/.env"
echo "    部署目录 $DEST（.env 已生成，权限 600）"

echo "== 5/5 沙箱：把 bubblewrap 补进运行时镜像"
# 运行时镜像里没有 bubblewrap（基础镜像没装），而 DSH 的沙箱链首选就是 bwrap。
# 离线包带了一个 47 KB 的 deb；这里从刚导入的运行时镜像派生一层把它装进去，
# 于是"用不用 bwrap"变成一条配置（MT_SANDBOX_BWRAP=1）而不是一次重建。
if ls "$DEST"/sandbox-debs/*.deb >/dev/null 2>&1; then
  SANDBOX_IMAGE="${RUNTIME_IMAGE}-sandbox"
  BUILD_DIR="$(mktemp -d)"
  mkdir -p "$BUILD_DIR/debs" && cp "$DEST"/sandbox-debs/*.deb "$BUILD_DIR/debs/"
  printf 'FROM %s\nCOPY debs /tmp/debs\nRUN dpkg -i /tmp/debs/*.deb && rm -rf /tmp/debs\n' "$RUNTIME_IMAGE" > "$BUILD_DIR/Dockerfile"
  # 经典构建器：BuildKit 会去公网解析基础镜像元数据，这类机器上必失败。
  if DOCKER_BUILDKIT=0 docker build -q -t "$SANDBOX_IMAGE" "$BUILD_DIR" >/dev/null; then
    set_env DSH_IMAGE "$SANDBOX_IMAGE"
    echo "    已派生 $SANDBOX_IMAGE：$(docker run --rm --entrypoint bwrap "$SANDBOX_IMAGE" --version 2>&1 | head -1)"
    echo "    （DSH 默认仍自己选沙箱；要用 bwrap 那条路，先跑 bin/sandbox-check.sh 确认，再加 MT_SANDBOX_BWRAP=1）"
  else
    echo "    !! 派生失败；DSH 仍可用自己选的那条沙箱路（bin/sandbox-check.sh 会给结论）" >&2
  fi
  rm -rf "$BUILD_DIR"
else
  echo "    包里没有 sandbox-debs/*.deb（跳过）"
fi

echo
echo "装好了。接下来五步（手册《离线部署手册.md》第 4-6 节逐条对照）："
echo "    1) 填密钥：  vi $DEST/.env      # MT_UPSTREAM_API_KEY=<内网模型端点的真 key>"
echo "    2) 建租户：  cd $DEST && bin/mt.sh add-batch tenants.csv --derive-id --credentials-file .tenant-credentials.json"
echo "                 （清单格式见 tenants.csv.example；没有该文件就先照它建一份）"
echo "    3) 证书与启动：bin/mt.sh cert && bin/mt.sh up"
echo "    4) 验证：    bin/mt.sh doctor && bin/acceptance.sh && bin/mt.sh mount-check --key-user <某个用户名>"
echo "    5) 沙箱：    bin/sandbox-check.sh     # 这台机器上到底哪条沙箱路可用"
