#!/usr/bin/env bash
# 用本地源码构建产物构建运行时镜像，并把 .env 指向它。
#
# 用法：
#   bin/publish-image.sh [标签]                    # 用已解包的 image/image-overlay
#   bin/publish-image.sh [标签] <覆盖层.tar.gz>    # 先解包再构建（一步到位）
#
# 覆盖层由源码检出里的
#   node deploy/multi-tenant/bin/make-image-overlay.mjs --src . --out image-overlay
# 生成，目录结构刻意与容器内安装路径一致（node_modules/@deepseek-ai/<包>/…）。
set -euo pipefail
cd "$(dirname "$0")/.."

TARBALL=""
case "${2:-}" in
  *.tar.gz|*.tgz) TARBALL="$2" ;;
esac
if [ -z "$TARBALL" ] && [ $# -ge 1 ] && [ -f "$1" ]; then TARBALL="$1"; fi
if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || { echo "找不到覆盖层归档: $TARBALL" >&2; exit 1; }
  echo "==> 解包覆盖层 $TARBALL"
  rm -rf image/image-overlay
  mkdir -p image/image-overlay
  tar -xzf "$TARBALL" -C image/image-overlay
fi

IMAGE_TAG="${1:-local-$(date -u +%Y%m%dT%H%M)}"
case "$IMAGE_TAG" in *.tar.gz|*.tgz) IMAGE_TAG="local-$(date -u +%Y%m%dT%H%M)" ;; esac

# 始终从干净的原始镜像重建，而不是叠在上一次发布之上：
# 否则旧构建里已被删除的文件会一直留在镜像里，层数也会越堆越多。
# MT_BASE_IMAGE 记录原始基础镜像；DSH_IMAGE 是当前生效（可能是本地构建）的镜像。
BASE_IMAGE="$(grep -E '^MT_BASE_IMAGE=' .env 2>/dev/null | tail -1 | cut -d= -f2)"
if [ -z "$BASE_IMAGE" ]; then
  BASE_IMAGE="$(grep -E '^DSH_IMAGE=' .env | tail -1 | cut -d= -f2)"
fi
BASE_IMAGE="${BASE_IMAGE:-dsh-web:0.2.0-rc.2}"
docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || { echo "基础镜像不存在: $BASE_IMAGE" >&2; exit 1; }
if grep -qE '^MT_BASE_IMAGE=' .env 2>/dev/null; then :; else
  echo "MT_BASE_IMAGE=$BASE_IMAGE" >> .env
  echo "  已在 .env 记录 MT_BASE_IMAGE=$BASE_IMAGE（后续发布都以它为底）"
fi

[ -d image/image-overlay ] || { echo "缺少 image/image-overlay，请先上传覆盖层" >&2; exit 1; }
[ -f image/image-overlay/manifest.json ] || { echo "覆盖层缺少 manifest.json" >&2; exit 1; }

echo "==> 覆盖层概况"
docker run --rm -v "$PWD/image/image-overlay:/o:ro" node:22-bookworm-slim \
  node -e 'const m=require("/o/manifest.json");console.log(`  ${m.packages} 个包, 约 ${(m.approxBytes/1048576).toFixed(1)} MiB, 源: ${m.source}`);console.log(`  前端 index.html sha256: ${m.frontendIndexSha256}`)'

echo
echo "==> 构建镜像 $IMAGE_TAG（基础镜像 $BASE_IMAGE）"
# 经典构建器：本机 Docker Hub 不可达，buildkit 会去远端解析基础镜像元数据而失败。
DOCKER_BUILDKIT=0 docker build \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  -t "dsh-web:$IMAGE_TAG" \
  image | tail -6

echo
echo "==> 核对镜像内的前端产物与覆盖层一致"
EXPECTED="$(docker run --rm -v "$PWD/image/image-overlay:/o:ro" node:22-bookworm-slim \
  node -e 'console.log(require("/o/manifest.json").frontendIndexSha256)')"
ACTUAL="$(docker run --rm --entrypoint sh "dsh-web:$IMAGE_TAG" -c \
  'sha256sum /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html | cut -d" " -f1')"
echo "  覆盖层: $EXPECTED"
echo "  镜像内: $ACTUAL"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "不一致：镜像没有拿到这份构建" >&2; exit 1; }
echo "  一致 ✓"

echo
echo "==> 把 .env 指向新镜像"
if grep -qE '^DSH_IMAGE=' .env; then
  sed -i "s|^DSH_IMAGE=.*|DSH_IMAGE=dsh-web:${IMAGE_TAG}|" .env
else
  echo "DSH_IMAGE=dsh-web:${IMAGE_TAG}" >> .env
fi
grep -E '^DSH_IMAGE=' .env

echo
echo "现在执行： bin/mt.sh up   （会用新镜像重建租户容器）"
