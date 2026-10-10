#!/usr/bin/env bash
# 探测一个模型端点的形态，并给出接入本部署所需的配置片段。
#
# 为什么需要它：租户侧的 DSH 适配器要按端点的协议挑一个（openai-completions 还是
# anthropic-messages），路径也随协议不同（/v1/chat/completions 还是 /v1/messages）。
# 挑错的后果是 404，而 404 在日志里跟"上游挂了"长得一模一样。这里把四条路径都试一遍，
# 直接说出是哪种协议、有哪些模型，并打印对应的 model.patch.yml 片段。
#
# 用法：
#   bin/model-probe.sh <baseURL> [apiKey]
#   bin/model-probe.sh http://15.11.40.44:3100 sk-xxxx
#
# 只用 curl。判定必须带 key：像 api.deepseek.com 这类网关**先鉴权再路由**，不带 key 时
# 任何路径都回 401，光看状态码会把每条路径都判成"存在"（这个假阳性我实测踩过）。
# 因此只有在带 key 的真实调用成功（或用协议格式错误明确回 400）时才下结论。
#
# 注意：请在一台【能访问该端点】的机器上运行。部署机如果在别的网段，它 ping 不到
# 15.11.40.44 是正常的，那说明试点必须落在那张网里，或者先打通路由。
set -uo pipefail

BASE="${1:-}"
KEY="${2:-}"
[ -n "$BASE" ] || { echo "用法: bin/model-probe.sh <baseURL> [apiKey]" >&2; exit 2; }
BASE="${BASE%/}"
if [ -z "$KEY" ]; then
  echo "== 只做连通性探测（没有给 key，协议一律不判定）"
  CODE="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null || echo 000)"
  echo "  GET $BASE/ -> HTTP $CODE"
  [ "$CODE" = 000 ] && echo "  连不上：确认这台机器在能访问该端点的网里（跨网段/未放行都会是这样）"
  echo
  echo "  要判定协议与模型，请带上 key 再跑一次："
  echo "    bin/model-probe.sh $BASE <apiKey>"
  exit 0
fi

# 一条候选路径：返回 2xx 或明确的协议错误（400/422，说明路由到了但请求不合法）才算存在。
probe() {
  local label="$1" path="$2" style="$3" body="$4" method="${5:-POST}"
  local args=(-sS -m 20 -o /tmp/probe-body.txt -w '%{http_code}' -X "$method" "$BASE$path" -H 'content-type: application/json')
  if [ "$style" = anthropic ]; then
    args+=(-H 'anthropic-version: 2023-06-01' -H "x-api-key: $KEY")
  else
    args+=(-H "Authorization: Bearer $KEY")
  fi
  [ -n "$body" ] && args+=(-d "$body")
  local code first
  code="$(curl "${args[@]}" 2>/dev/null || echo 000)"
  first="$(head -c 200 /tmp/probe-body.txt 2>/dev/null | tr -d '\n')"
  case "$code" in
    2*)       verdict="可用" ;;
    400|422)  verdict="路由到了（请求格式不符）" ;;
    401|403)  verdict="鉴权被拒（key 不对或不是这种鉴权方式）" ;;
    404|405)  verdict="不是这条路径" ;;
    000)      verdict="连不上" ;;
    *)        verdict="HTTP $code" ;;
  esac
  printf '  %-34s %-6s %s\n' "$label" "$code" "$verdict"
  [ -n "$first" ] && printf '      %s\n' "$first"
  rm -f /tmp/probe-body.txt
}

echo "== 目标 $BASE（带 key 的真实调用）"
probe "POST /v1/chat/completions（OpenAI）" /v1/chat/completions openai '{"model":"probe","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
probe "POST /v1/messages（Anthropic）"     /v1/messages         anthropic '{"model":"probe","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'
probe "GET  /v1/models（OpenAI 列表）"     /v1/models           openai '' GET
probe "GET  /v1/models（Anthropic 列表）"  /v1/models           anthropic '' GET

echo
echo "-- 模型列表（上面哪一条 200 就用哪种鉴权，这里原样打印）"
for style in openai anthropic; do
  if [ "$style" = anthropic ]; then
    LIST="$(curl -sS -m 15 -H "x-api-key: $KEY" -H 'anthropic-version: 2023-06-01' "$BASE/v1/models" 2>/dev/null)"
  else
    LIST="$(curl -sS -m 15 -H "Authorization: Bearer $KEY" "$BASE/v1/models" 2>/dev/null)"
  fi
  case "$LIST" in
    *'"data"'*|*'"models"'*|*'"id"'*)
      echo "  [$style] $(printf '%s' "$LIST" | head -c 1000)"
      break ;;
  esac
done

echo
echo "== 结论与配置"
cat <<'TXT'
  若 /v1/chat/completions 存在 → OpenAI 兼容，model.patch.yml 用：
      - id: llm-pi-ai
        config:
          providers:
            internal:
              displayName: 内网模型服务
              api: openai-completions
              baseURL: http://mt-model-gateway:8080/v1     # 注意：指向【网关】，不是内网端点
              apiKeyEnv: DEEPSEEK_API_KEY                  # 租户的占位 key，由 render 注入
              models:
                - id: <上面列出的模型 id>

  若 /v1/messages 存在 → Anthropic Messages 兼容，model.patch.yml 用：
      - id: llm-pi-ai
        config:
          providers:
            internal:
              displayName: 内网模型服务
              api: anthropic-messages
              baseURL: http://mt-model-gateway:8080
              apiKeyEnv: DEEPSEEK_API_KEY
              models:
                - id: <上面列出的模型 id>

  两种接法都要在部署机上把真凭据交给模型网关（只进 .env，绝不进 model.env 或租户）：
      MT_UPSTREAM_BASE=<内网端点>
      MT_UPSTREAM_API_KEY=<真 key>
  然后： bin/mt.sh model    （渲染 → 应用到全部租户 → 重启 → 等就绪）

  租户侧的 baseURL 始终指向 mt-model-gateway：真 key 只存在于网关，租户拿的是占位 key，
  这样"谁用了多少"才计得准，也才有唯一的出网与限额点。
TXT

echo
echo "== 出口代理会不会拦"
if [ -n "${MT_EGRESS_PROXY:-}" ]; then
  HOST_ONLY="$(printf '%s' "$BASE" | sed 's|^https\{0,1\}://||; s|[:/].*$||')"
  echo "  MT_EGRESS_PROXY=$MT_EGRESS_PROXY，目标主机 $HOST_ONLY"
  echo "  出口代理默认拒绝私网/回环目标；内网端点若落在 10./172.16-31./192.168./127./169.254. 段会被拒，"
  echo "  那时把该端点加进 MT_NO_PROXY（模型网关直连）或 MT_EGRESS_ALLOW。"
else
  echo "  未设置 MT_EGRESS_PROXY（模型网关将直连上游）"
fi
