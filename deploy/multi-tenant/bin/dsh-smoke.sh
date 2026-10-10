#!/usr/bin/env bash
# 端到端冒烟：用给定的 DSH 镜像与模型端点，真的跑一次对话。
#
# 这是三个测试里的第三步——它回答"DSH 在这台机器 + 这个模型端点上到底能不能用"。
# 前两步是 bin/preflight.sh（宿主能力）与 bin/model-probe.sh（端点协议与模型）。
#
# 用法：
#   bin/dsh-smoke.sh <DSH镜像> <模型端点> <APIKEY> <模型id> [--keep]
#   bin/dsh-smoke.sh dsh-web:0.2.0-rc.2 http://15.11.40.44:3100 sk-xxx deepseek-v4-flash
#
# 它不经控制面、不需要租户注册：直接用一个一次性容器跑
#   dsh --profile headless --patch <覆盖层> "只回答两个字：可用"
# 覆盖层把模型指向你给的端点（真 key 只经环境变量进容器），并把默认模型改成它。
# 判据有三层：进程退出码、打印出来的回答、以及落进 $DSH_HOME/sessions 的会话文件。
#
# 注意：headless 这一档会把工作区当作它的 cwd，测试本身不碰你的部署目录；失败时
# 临时目录会保留下来供排查（成功后才删，除非给了 --keep）。
set -uo pipefail

IMAGE="${1:-}"; BASE="${2:-}"; KEY="${3:-}"; MODEL="${4:-}"; KEEP="${5:-}"
[ -n "$IMAGE" ] && [ -n "$BASE" ] && [ -n "$KEY" ] && [ -n "$MODEL" ] || {
  echo "用法: bin/dsh-smoke.sh <DSH镜像> <模型端点> <APIKEY> <模型id> [--keep]" >&2
  echo "  模型 id 先用 bin/model-probe.sh 查确切拼写（列表里给的多半是显示名）" >&2
  exit 2
}
BASE="${BASE%/}"
WORK="$(mktemp -d "/tmp/dsh-smoke.XXXXXX")"
TASK="只回答两个字：可用"

echo "== 前置检查"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "  ✗ 本机没有镜像 $IMAGE" >&2
  echo "    离线导入：在有该镜像的机器上 docker save $IMAGE | gzip > dsh.tar.gz，再 docker load -i dsh.tar.gz" >&2
  exit 1
fi
echo "  ✓ 镜像 $IMAGE 在本机"

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
RUN=(docker run --rm --name "dsh-smoke-$$"
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
case "$CODE" in
  0) echo "  ✓ 进程正常退出（0）" ;;
  124) echo "  ✗ 超时：端点没回、或流式一直不结束" ;;
  *) echo "  ✗ 退出码 $CODE（上面是它的输出）" ;;
esac
case "$OUT" in
  *可用*) echo "  ✓ 回答里出现了预期内容" ;;
  *)      echo "  ? 回答里没看到预期内容，按上面的原始输出判断" ;;
esac
LOGS="$(find "$WORK/home/sessions" -name 'session*.jsonl*' 2>/dev/null | head -3)"
if [ -n "$LOGS" ]; then
  echo "  ✓ 会话已落盘："
  printf '%s\n' "$LOGS" | sed 's/^/      /'
  if grep -rq "可用" "$WORK/home/sessions" 2>/dev/null; then echo "      （日志里也能搜到回答，说明是模型真回的）"; fi
else
  echo "  ✗ 没有会话文件：$WORK/home/sessions 是空的 → 请求多半没走到模型"
fi

echo
echo "== 收尾"
if [ "$KEEP" = "--keep" ]; then
  echo "  临时目录保留：$WORK（home/、ws/、smoke-model.yml 都在里面）"
elif [ "$CODE" = 0 ]; then
  rm -rf "$WORK"
  echo "  已清理 $WORK（要留着排查就加 --keep）"
else
  echo "  保留 $WORK 供排查：里面是这次用的 profile 覆盖层与会话日志"
fi
echo "  上面三条判据都通过，就说明这台机器 + 这个端点能支撑 DSH；接下来才谈多租户那套。"
