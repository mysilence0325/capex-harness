#!/usr/bin/env bash
# 把内网模型接进这套部署：探测端点 → 写 .env（上游地址与真 key）→ 写 model.patch.yml
# （租户侧的模型目录）→ 应用（重建模型网关、重建租户容器）→ 用真实模型自检一次。
#
#   bin/model-setup.sh --key sk-xxxx                     # 正常使用
#   bin/model-setup.sh --key sk-xxxx --check-only        # 只探测端点与 key，不改任何文件
#   bin/model-setup.sh --key sk-xxxx --no-restart        # 只渲染，不重建租户容器（稍后自己重启）
#   bin/model-setup.sh                                   # 不给 --key 就用 .env 里已有的那个
#
# 每个被改动的文件都会先备份成 *.before-model-<UTC 时间戳>，回退就是把备份拷回去。
set -uo pipefail
cd "$(dirname "$0")/.."

KEY=""; BASE="http://15.11.40.44:3100"; CHECK_ONLY=no; NO_RESTART=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key)         KEY="${2:-}"; shift 2 ;;
    --base)        BASE="${2:-}"; shift 2 ;;
    --check-only)  CHECK_ONLY=yes; shift ;;
    --no-restart)  NO_RESTART=yes; shift ;;
    -h|--help)     sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[ -f tenants.json ] || { echo "这里不像部署目录（缺 tenants.json）" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "需要 python3" >&2; exit 1; }
[ -n "$KEY" ] || KEY="$(grep '^MT_UPSTREAM_API_KEY=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' ')"
[ -n "$KEY" ] || { echo "缺 --key <内网模型 key>（.env 里也没有 MT_UPSTREAM_API_KEY）" >&2; exit 2; }
BASE="${BASE%/}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PREFIX="${MT_CONTAINER_NAME_PREFIX:-mt-}"

echo "== 1/5 探测内网端点：$BASE/v1/models"
MODELS="$(python3 - "$BASE" "$KEY" <<'PY'
import json, sys, urllib.request
base, key = sys.argv[1], sys.argv[2]
req = urllib.request.Request(base + "/v1/models", headers={"Authorization": "Bearer " + key})
try:
    with urllib.request.urlopen(req, timeout=15) as response:
        document = json.loads(response.read().decode("utf-8"))
    for entry in document.get("data", []):
        if isinstance(entry, dict) and entry.get("id"):
            print(entry["id"])
except Exception as error:
    print("ERR:" + str(error))
PY
)"
PROBE_OK=yes
case "$MODELS" in
  ERR:*)
    PROBE_OK=no
    echo "  !! 探测失败：${MODELS#ERR:}"
    echo "     可能原因：这台机器到 $BASE 不通、key 不对、或端点要求不同的路径。"
    echo "     仍然继续，用默认的两个对话模型；跑完自检会告诉你是哪一步不通。"
    ;;
  *) echo "  端点报告可用模型：$(printf '%s' "$MODELS" | tr '\n' ' ')" ;;
esac
# 只要对话模型：bge-* / *embed* / *rerank* / *whisper* / *tts* 是向量化、重排、语音那一类，
# 写进 DSH 的模型目录会被当 chat 调用而报错。
CHAT="$(printf '%s\n' "$MODELS" | grep -v '^ERR:' | grep -viE '^(bge|embed|rerank|whisper|tts)' | awk 'NF' || true)"
if [ -z "$CHAT" ]; then
  CHAT="$(printf '%s\n' 'deepseek-v4-flash' 'GLM 5.3 Flash')"
  [ "$PROBE_OK" = yes ] && echo "  !! 端点没报告任何对话模型，用默认的两个：$(printf '%s' "$CHAT" | tr '\n' ' ')"
fi
echo "  将写入租户模型目录的对话模型：$(printf '%s' "$CHAT" | tr '\n' ' ')"

if [ "$CHECK_ONLY" = yes ]; then
  echo
  echo "== --check-only：以上只是探测，没有改动任何文件"
  exit 0
fi

echo
echo "== 2/5 写 .env（备份 .env.before-model-$STAMP）"
cp -a .env ".env.before-model-$STAMP"
python3 - "$BASE" "$KEY" <<'PY'
import pathlib, sys
base, key = sys.argv[1], sys.argv[2]
path = pathlib.Path(".env")
lines = path.read_text().splitlines(True)
want = {"MT_UPSTREAM_BASE": base, "MT_UPSTREAM_API_KEY": key}
seen = set()
out = []
for line in lines:
    stripped = line.strip()
    if stripped == "" or stripped.startswith("#") or "=" not in stripped:
        out.append(line)
        continue
    name = stripped.split("=", 1)[0].strip()
    if name in want:
        out.append("%s=%s\n" % (name, want[name]))
        seen.add(name)
    else:
        out.append(line)
for name, value in want.items():
    if name not in seen:
        out.append("%s=%s\n" % (name, value))
path.write_text("".join(out))
PY
chmod 600 .env
echo "  MT_UPSTREAM_BASE=$BASE"
echo "  MT_UPSTREAM_API_KEY=${KEY:0:8}…（真 key 只进模型网关，不进任何租户容器）"

echo
echo "== 3/5 写 model.patch.yml（备份 model.patch.yml.before-model-$STAMP）"
[ -f model.patch.yml ] && cp -a model.patch.yml "model.patch.yml.before-model-$STAMP"
{
  echo "# 内网模型服务：租户只拿占位 key，经本部署的模型网关转发（真 key 在 .env）"
  echo "- id: llm-pi-ai"
  echo "  config:"
  echo "    providers:"
  echo "      dsh-intranet:"
  echo "        displayName: 内网模型服务"
  echo "        api: openai-completions"
  echo "        baseURL: http://${PREFIX}model-gateway:8080/v1"
  echo "        apiKeyEnv: GATEWAY_API_KEY"
  echo "        models:"
  while IFS= read -r model; do
    [ -n "$model" ] || continue
    printf '          - id: %s\n' "$model"
    printf '            name: %s\n' "$model"
    printf '            contextWindow: 131072\n'
    printf '            maxTokens: 8192\n'
  done <<< "$CHAT"
} > model.patch.yml
echo "  写了 $(grep -c '          - id:' model.patch.yml) 个对话模型"

echo
echo "== 4/5 应用：bin/mt.sh up（重建模型网关；渲染租户 profile patch）"
bin/mt.sh up 2>&1 | grep -E 'applied the shared model block|model\.patch\.yml|rendered|已注册|入口' | tail -8 || true

if [ "$NO_RESTART" = no ] && [ -x bin/repair-tenant-rpc.sh ]; then
  echo
  echo "== 5/5 重建租户容器（让新 patch 生效）并重新登记启动 token"
  bin/repair-tenant-rpc.sh fix --all 2>&1 | grep -E '^==>|RPC (通|不通)' | tail -30
elif [ "$NO_RESTART" = yes ]; then
  echo
  echo "== 5/5 按 --no-restart 跳过重建：稍后自己执行 bin/repair-tenant-rpc.sh fix --all"
else
  echo
  echo "== 5/5 缺少 bin/repair-tenant-rpc.sh：请手动重建租户容器，例如"
  echo "     ${COMPOSE:-docker-compose} up -d --force-recreate --no-deps <租户的 service>"
fi

echo
echo "== 自检（真实模型；第一个租户）"
TENANT="$(python3 -c 'import json;print(json.load(open("tenants.json"))["tenants"][0]["id"])')"
USER="$(python3 -c 'import json;print(json.load(open("tenants.json"))["tenants"][0]["users"][0]["name"])')"
CRED="$(python3 - "$TENANT" <<'PY'
import json, sys
try:
    document = json.load(open(".acceptance-credentials.json", encoding="utf-8"))
    print(document.get("tenants", {}).get(sys.argv[1], {}).get("password", ""))
except Exception:
    print("")
PY
)"
if [ -n "$CRED" ]; then
  bin/model-check.sh --tenant "$TENANT" --user "$USER" --password "$CRED" 2>&1 | tail -14
else
  echo "  （没有 .acceptance-credentials.json 里 $TENANT 的口令，跳过自检）"
  echo "   先跑 bin/make-acceptance-credentials.sh --rotate --admin-password '<至少8位>'"
fi

echo
echo "回退：cp -a .env.before-model-$STAMP .env && cp -a model.patch.yml.before-model-$STAMP model.patch.yml"
echo "      然后 bin/mt.sh up && bin/repair-tenant-rpc.sh fix --all"
echo "全量复验：bin/acceptance.sh | tail -3"
