#!/usr/bin/env bash
# 端到端冒烟：用给定的 DSH 镜像与模型端点，真的跑一次对话。
#
# 这是三个测试里的第三步——它回答"DSH 在这台机器 + 这个模型端点上到底能不能用"。
# 前两步是 bin/preflight.sh（宿主能力）与 bin/model-probe.sh（端点协议与模型）。
#
# 用法：
#   bin/dsh-smoke.sh <镜像> <端点> <APIKEY> <模型id> [--network <模式>] [--expect <文本>] [--keep]
#   bin/dsh-smoke.sh dsh-web:local-20261011T0102 http://15.11.40.44:3100 sk-xxx deepseek-v4-flash --expect 可用
#   bin/dsh-smoke.sh dsh-web:local-20261011T0102 http://mt-mock-model:8080 x mock-cheap --network mt-net --expect MULTITENANT-OK
#
# 它不经控制面、不需要租户注册：直接用一个一次性容器跑
#   dsh --profile headless --patch <覆盖层> "<任务>"
# 覆盖层把模型指向你给的端点（真 key 只经环境变量进容器），并把默认模型改成它。
#
# `--network` 默认 host：容器直接用宿主网络，能到宿主能到的任何地址（内网端点就是这样，而
# bridge 容器在这类机器上往往没有外网路由）。要访问 mt-net 上的假模型就传 --network mt-net，
# 端点写容器名（http://mt-mock-model:8080）。
#
# `--expect` 是可选的强断言：只有**模型打印出来的回答**里出现这段文本才算通过。任务文本本身
# 不要包含它——否则提示词被回显时会假通过（假模型正是会回显问题的，所以它那条用
# MULTITENANT-OK 这种只可能来自模型回复的标记）。
#
# 注意：判据看的是 headless 运行**打印出来的回答**，不去 grep 会话文件——会话文件是 zstd
# 压缩的，按文本搜索并不可靠（这条一开始写错过）。
set -uo pipefail

IMAGE=""; BASE=""; KEY=""; MODEL=""; NETWORK="host"; EXPECT=""; KEEP=no
usage() {
  echo "用法: bin/dsh-smoke.sh <镜像> <端点> <APIKEY> <模型id> [--network host|mt-net] [--expect <文本>] [--keep]" >&2
  echo "  模型 id 先用 bin/model-probe.sh 查确切拼写（列表里给的多半是显示名）" >&2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --network) NETWORK="${2:-}"; shift 2 ;;
    --expect)  EXPECT="${2:-}"; shift 2 ;;
    --keep)    KEEP=yes; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "未知参数: $1" >&2; usage; exit 2 ;;
    *)
      if [ -z "$IMAGE" ]; then IMAGE="$1"
      elif [ -z "$BASE" ]; then BASE="$1"
      elif [ -z "$KEY" ]; then KEY="$1"
      elif [ -z "$MODEL" ]; then MODEL="$1"
      else echo "多余参数: $1" >&2; usage; exit 2
      fi
      shift ;;
  esac
done
[ -n "$IMAGE" ] && [ -n "$BASE" ] && [ -n "$KEY" ] && [ -n "$MODEL" ] && [ -n "$NETWORK" ] || { usage; exit 2; }
BASE="${BASE%/}"
WORK="$(mktemp -d "/tmp/dsh-smoke.XXXXXX")"
# 任务文本刻意不含期望词（见头部说明）。
TASK="请用一句话说明你收到了这条消息。"

echo "== 前置检查"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "  ✗ 本机没有镜像 $IMAGE" >&2
  echo "    离线导入：在有该镜像的机器上 docker save $IMAGE | gzip > dsh.tar.gz，再 docker load -i dsh.tar.gz" >&2
  exit 1
fi
echo "  ✓ 镜像 $IMAGE 在本机"
echo "  ✓ 网络模式 $NETWORK；端点 $BASE；模型 $MODEL"

mkdir -p "$WORK/home" "$WORK/ws"
cat > "$WORK/smoke-model.yml" <<YAML
# 只把这个端点的模型挂上去，并把默认模型指过去；内置卡片关掉，免得它去公网。
# baseURL 指向端点本身（冒烟测试不经模型网关），路径按 OpenAI 兼容约定补 /v1。
- id: llm-pi-ai
  config:
    providers:
      internal:
        displayName: 内网模型服务
        api: openai-completions
        baseURL: ${BASE}/v1
        apiKeyEnv: SMOKE_KEY
        models:
          - id: ${MODEL}
            contextWindow: 131072
            maxTokens: 8192
- id: llm-deepseek
  disabled: true
- id: agent-default-model
  config:
    provider: internal
    model: ${MODEL}
YAML

# 用数组而不是 shell 函数：`timeout` 只能 exec 真正的可执行文件，不能调用函数。
RUN=(docker run --rm --name "dsh-smoke-$$" --network "$NETWORK"
  -v "$WORK/home":/dsh-home -v "$WORK/ws":/workspace -v "$WORK/smoke-model.yml":/smoke-model.yml:ro
  -e DSH_HOME=/dsh-home -e HOME=/root -e SMOKE_KEY="$KEY"
  -e DSH_TELEMETRY_DISABLED=1 -e TZ=Asia/Shanghai -e DSH_PERMISSION_MODE=danger-full-access
  -w /workspace "$IMAGE")

echo
echo "== 先确认 profile 能组装（不改任何东西，只打印合成的插件树）"
DUMP="$("${RUN[@]}" dsh --profile headless --dump-default-config 2>&1)"; DUMP_CODE=$?
printf '%s\n' "$DUMP" | head -25 | sed 's/^/    /'
if [ "$DUMP_CODE" = 0 ]; then
  echo "  ✓ profile 组装成功（上面能看到 llm-pi-ai 这一行就对了）"
else
  echo "  ✗ profile headless 组装失败：镜像里可能没有这个档；把上面的报错贴出来" >&2
fi

echo
echo "== 跑一条真实任务（超时 180 秒）"
OUT="$(timeout 180 "${RUN[@]}" dsh --profile headless --patch /smoke-model.yml "$TASK" 2>&1)"
CODE=$?
printf '%s\n' "$OUT" | sed 's/^/    /'

echo
echo "== 判据"
PASSED=yes
case "$CODE" in
  0)   echo "  ✓ 进程正常退出（0）" ;;
  124) echo "  ✗ 超时：端点没回、或流式一直不结束"; PASSED=no ;;
  *)   echo "  ✗ 退出码 $CODE（上面是它的输出）"; PASSED=no ;;
esac
if [ -n "$EXPECT" ]; then
  case "$OUT" in
    *"$EXPECT"*) echo "  ✓ 回答里出现了期望内容：$EXPECT" ;;
    *) echo "  ✗ 回答里没有出现期望内容：$EXPECT"; PASSED=no ;;
  esac
else
  echo "  · 没有给 --expect，只要求有回答（上面就是模型打印出来的东西）"
fi
LOGS="$(find "$WORK/home/sessions" -name 'session*.jsonl*' 2>/dev/null | head -3)"
if [ -n "$LOGS" ]; then
  echo "  ✓ 会话已落盘："
  printf '%s\n' "$LOGS" | sed 's/^/      /'
else
  echo "  ✗ 没有会话文件：$WORK/home/sessions 是空的 → 请求多半没走到模型"; PASSED=no
fi

echo
echo "== 收尾"
if [ "$KEEP" = yes ]; then
  echo "  临时目录保留：$WORK（home/、ws/、smoke-model.yml 都在里面）"
elif [ "$PASSED" = yes ]; then
  rm -rf "$WORK"
  echo "  已清理 $WORK（要留着排查就加 --keep）"
else
  echo "  保留 $WORK 供排查：里面是这次用的 profile 覆盖层与会话日志"
fi
if [ "$PASSED" = yes ]; then
  echo "  判据全过：这台机器 + 这个镜像 + 这个端点能支撑 DSH；接下来才谈多租户那套。"
  exit 0
fi
echo "  有判据没过（见上面 ✗）。" >&2
exit 1
