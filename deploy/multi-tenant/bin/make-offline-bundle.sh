#!/usr/bin/env bash
# 组装离线部署包：三个镜像 + 干净的部署目录 + 前端覆盖层 + 清单 + 校验和 + 分卷。
#
#   bin/make-offline-bundle.sh --payload /tmp/payload/deploy-multi-tenant \
#     --overlay /home/dsh-mt/image-overlay-20261010T182508.tar.gz \
#     --out /home/dsh-mt --commit "$(git rev-parse HEAD)"
#
# 只做四件事：把镜像导出成 tar.gz、把给定目录原样收进 deploy/、写清单与校验和、切分卷。
# 它**不碰**部署实例：--payload 必须是没有 .env/state/tenants.json 的干净副本（见下面的检查），
# 免得把运行中的口令与状态打进包里。
set -euo pipefail

die() { echo "$*" >&2; exit 1; }

PAYLOAD=""
OVERLAY=""
OUT="$(pwd)"
VOLUME_SIZE="1500M"
SITE="15.11.70.37"
BASE_PATH="/ai/harness"
KEY_LOGIN_FROM="15.11.40.44"
UPSTREAM="http://15.11.40.44:3100"
COMMIT=""
NODE_IMAGE="node:22-bookworm-slim"
CARRIER_IMAGE="dsh-web:0.2.0-rc.2"
RUNTIME_IMAGE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --payload)         PAYLOAD="${2:-}"; shift 2 ;;
    --overlay)         OVERLAY="${2:-}"; shift 2 ;;
    --out)             OUT="${2:-}"; shift 2 ;;
    --volume-size)     VOLUME_SIZE="${2:-}"; shift 2 ;;
    --site)            SITE="${2:-}"; shift 2 ;;
    --base-path)       BASE_PATH="${2:-}"; shift 2 ;;
    --key-login-from)  KEY_LOGIN_FROM="${2:-}"; shift 2 ;;
    --upstream)        UPSTREAM="${2:-}"; shift 2 ;;
    --commit)          COMMIT="${2:-}"; shift 2 ;;
    --node-image)      NODE_IMAGE="${2:-}"; shift 2 ;;
    --carrier-image)   CARRIER_IMAGE="${2:-}"; shift 2 ;;
    --runtime-image)   RUNTIME_IMAGE="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[ -n "$PAYLOAD" ] || die "缺少 --payload <干净的 deploy/multi-tenant 目录>"
[ -d "$PAYLOAD" ] || die "找不到 --payload 目录: $PAYLOAD"
command -v docker >/dev/null 2>&1 || die "找不到 docker（打包机必须能跑 docker save）"
command -v split >/dev/null 2>&1 || die "找不到 split"
command -v sha256sum >/dev/null 2>&1 || die "找不到 sha256sum"

# 干净的副本：这些是运行实例的东西，进包就是泄密或让目标机状态错乱。
for forbidden in .env local.env model.env tenants.json tenants state logs backups \
                 .acceptance-credentials.json entry-urls.txt docker-compose.yml; do
  [ -e "$PAYLOAD/$forbidden" ] && die "--payload 里出现了运行实例的文件: $forbidden（请用 git archive 导出的干净副本）"
done

# 运行时镜像必须是**本地源码构建的那一个**（镜像里有 /opt/dsh-local-build/SOURCE 标记，
# doctor 也是这么认的）。刻意不读 .env.example 的 DSH_IMAGE：那里是示例值（发行版载体），
# 照着它打出来的包会让目标机跑另一份代码——而且从包里看不出来。
if [ -z "$RUNTIME_IMAGE" ]; then
  # `|| true`：没有匹配时 grep 会失败，而 set -o pipefail + set -e 会让脚本在给出
  # 下面那条提示之前就静默退出（提示正是要告诉人"先去发布一个镜像"）。
  RUNTIME_IMAGE="$(docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' \
    | grep -E '^dsh-web:local-' | sort -k2 | tail -1 | awk '{print $1}' || true)"
  [ -n "$RUNTIME_IMAGE" ] || die "本机没有 dsh-web:local-* 镜像（先用 bin/publish-image.sh 发布），或用 --runtime-image 指定"
fi
for image in "$NODE_IMAGE" "$CARRIER_IMAGE" "$RUNTIME_IMAGE"; do
  docker image inspect "$image" >/dev/null 2>&1 || die "本机没有镜像 $image（docker images 看一下）"
done
docker run --rm --entrypoint sh "$RUNTIME_IMAGE" -c 'test -f /opt/dsh-local-build/SOURCE' >/dev/null 2>&1 \
  || die "$RUNTIME_IMAGE 里没有 /opt/dsh-local-build/SOURCE：它不是本地源码构建的镜像，装上去跑的是另一份代码"
echo "==> 运行时镜像: $RUNTIME_IMAGE（已确认是本地源码构建）"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="dsh-offline-$STAMP"
BUNDLE="$OUT/$NAME"
[ -e "$BUNDLE" ] && die "输出目录已存在: $BUNDLE"
mkdir -p "$BUNDLE/images" "$BUNDLE/deploy"

image_field() { printf '%s' "$1" | sed 's/[/:]/_/g'; }

echo "==> 导出镜像（gzip -1：这几块内容压缩比有限，快速打包比极限压缩重要）"
for image in "$NODE_IMAGE" "$CARRIER_IMAGE" "$RUNTIME_IMAGE"; do
  file="$(image_field "$image").tar.gz"
  start="$(date +%s)"
  docker save "$image" | gzip -1 > "$BUNDLE/images/$file"
  printf '    %-40s %5sMB  %ss\n' "$file" "$(( $(stat -c%s "$BUNDLE/images/$file") / 1024 / 1024 ))" "$(( $(date +%s) - start ))"
done

echo "==> 收进部署目录（原样复制 --payload；构建产物不进包）"
( cd "$PAYLOAD" && tar --exclude='image-overlay*' --exclude='*.log' --exclude='__pycache__' -cf - . ) \
  | ( cd "$BUNDLE/deploy" && tar -xf - )
[ -f "$BUNDLE/deploy/离线部署手册.md" ] || die "payload 里没有 离线部署手册.md——包不完整"

# 安装脚本也放到包根：现场的人不需要先 cd 进 deploy/ 才能开始。
[ -f "$BUNDLE/deploy/bin/install-offline.sh" ] || die "payload 里没有 bin/install-offline.sh——包不完整"
cp "$BUNDLE/deploy/bin/install-offline.sh" "$BUNDLE/install-offline.sh"
chmod +x "$BUNDLE/install-offline.sh"
# 可执行位也补一遍：git 检出的脚本可能是 644（Windows 上根本没有这个位），
# 而手册让人直接跑 `bin/mt.sh`。
chmod +x "$BUNDLE"/deploy/bin/*.sh "$BUNDLE"/deploy/bin/*.py "$BUNDLE"/deploy/bin/*.mjs 2>/dev/null || true

if [ -n "$OVERLAY" ]; then
  [ -f "$OVERLAY" ] || die "找不到 --overlay 文件: $OVERLAY"
  mkdir -p "$BUNDLE/overlay"
  cp "$OVERLAY" "$BUNDLE/overlay/"
  echo "==> 覆盖层: $(basename "$OVERLAY")"
fi

echo "==> 写清单"
{
  printf '{\n'
  printf '  "bundle": "%s",\n' "$NAME"
  printf '  "createdAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "commit": "%s",\n' "${COMMIT:-unknown}"
  printf '  "site": "%s",\n' "$SITE"
  printf '  "basePath": "%s",\n' "$BASE_PATH"
  printf '  "keyLoginFrom": "%s",\n' "$KEY_LOGIN_FROM"
  printf '  "upstream": "%s",\n' "$UPSTREAM"
  printf '  "deployDir": "deploy",\n'
  first=1
  for image in "$NODE_IMAGE" "$CARRIER_IMAGE" "$RUNTIME_IMAGE"; do
    file="$(image_field "$image").tar.gz"
    id="$(docker image inspect "$image" --format '{{.Id}}')"
    [ "$first" -eq 1 ] || printf ',\n'
    first=0
    printf '  "image_%s": { "ref": "%s", "id": "%s", "file": "images/%s" }' "$(image_field "$image")" "$image" "$id" "$file"
  done
  printf '\n}\n'
} > "$BUNDLE/MANIFEST.json"

# 安装脚本读清单里那几个唯一字段，用 grep/sed 比引一个 JSON 解析器可靠（目标机不保证有 python3）。
for key in site basePath keyLoginFrom upstream deployDir; do
  grep -q "\"$key\"" "$BUNDLE/MANIFEST.json" || die "清单缺少字段 $key"
done
for image in "$NODE_IMAGE" "$CARRIER_IMAGE" "$RUNTIME_IMAGE"; do
  grep -q "\"image_$(image_field "$image")\"" "$BUNDLE/MANIFEST.json" || die "清单缺少镜像字段"
done

cat > "$BUNDLE/先读我.txt" <<TXT
DSH 多租户离线部署包 $NAME

一、先校验再解开（在目标机上，就着收到的传输文件做）：
      sha256sum -c SHA256SUMS.bundle       # 一个 .tar 或几个 .part，都在这个文件里
      cat dsh-offline-*.tar.part* > dsh-offline-$STAMP.tar   # 没有 part* 就跳过这一行
      tar xf dsh-offline-$STAMP.tar

二、再安装（在解开的 $NAME/ 目录里）：
      ./install-offline.sh --dest /data/dsh-mt
   它做四件事：校验文件、导入三个镜像、把 deploy/ 铺到 --dest、生成 .env（并告诉你还差什么）。
   它也认 --check-only：只校验、不改任何东西（部署前门禁）。

三、然后照手册走：
      deploy/离线部署手册.md       ← 从第 4 节"配置"开始，一步一条命令、每步有期望输出

本包目标站点：$SITE，入口前缀 $BASE_PATH，模型端点 $UPSTREAM
不含真模型密钥（现场粘贴）、不含租户名单（deploy/tenants.csv.example 是模板）。
TXT

echo "==> 包内校验和（相对包根，安装脚本直接 sha256sum -c 用）"
( cd "$BUNDLE" && find . -type f ! -name SHA256SUMS -print0 | sort -z \
    | xargs -0 sha256sum | sed 's|\./||' > SHA256SUMS )

# 每卷上限：整数 + K/M/G 后缀（`1.5G` 这类小数直接拒绝，省得算错了才发现）。
volume_bytes() {
  local text="$1" number suffix
  case "$text" in
    *[kK]) number="${text%[kK]}"; suffix=1024 ;;
    *[mM]) number="${text%[mM]}"; suffix=$((1024 * 1024)) ;;
    *[gG]) number="${text%[gG]}"; suffix=$((1024 * 1024 * 1024)) ;;
    *)     number="$text"; suffix=1 ;;
  esac
  case "$number" in
    ''|*[!0-9]*) die "--volume-size 只支持整数加 K/M/G 后缀（例如 1500M、2G）：$text" ;;
  esac
  echo $((number * suffix))
}
VOLUME_BYTES="$(volume_bytes "$VOLUME_SIZE")"

echo "==> 打 tar（不再压缩：成员已经是 gzip）"
( cd "$OUT" && tar -cf "$NAME.tar" "$NAME" )
TAR_BYTES="$(stat -c%s "$OUT/$NAME.tar")"
if [ "$TAR_BYTES" -le "$VOLUME_BYTES" ]; then
  # 装得下就不分卷：多一个"先合并再解"的步骤，只有一个文件的传输没任何好处。
  ( cd "$OUT" && sha256sum "$NAME.tar" > SHA256SUMS.bundle )
  echo "    整包 $((TAR_BYTES / 1024 / 1024))MB 未超过每卷上限 $VOLUME_SIZE，不分卷：$NAME.tar"
else
  echo "    整包 $((TAR_BYTES / 1024 / 1024))MB 超过每卷上限 $VOLUME_SIZE，按 $VOLUME_SIZE 分卷"
  ( cd "$OUT" && split -b "$VOLUME_SIZE" -d -a 2 "$NAME.tar" "$NAME.tar.part" )
  ( cd "$OUT" && sha256sum "$NAME".tar.part* > SHA256SUMS.bundle )
  rm -f "$OUT/$NAME.tar"
fi

echo
echo "==> 完成：$OUT"
ls -1 "$OUT" | grep "$NAME" | sed 's/^/    /'
echo "    体积：$(du -sh "$BUNDLE" | cut -f1)（未压缩）"
echo
echo "下一步（把包搬到目标机）："
if [ "$TAR_BYTES" -le "$VOLUME_BYTES" ]; then
  echo "    1) 把 $NAME.tar 与 SHA256SUMS.bundle 一起拷贝过去（不分卷）"
  echo "    2) 目标机: sha256sum -c SHA256SUMS.bundle && tar xf $NAME.tar"
else
  echo "    1) 把全部 $NAME.tar.part* 与 SHA256SUMS.bundle 一起拷贝过去"
  echo "    2) 目标机: sha256sum -c SHA256SUMS.bundle && cat $NAME.tar.part* > $NAME.tar && tar xf $NAME.tar"
fi
echo "    3) 目标机: cd $NAME && ./install-offline.sh --dest /data/dsh-mt"
