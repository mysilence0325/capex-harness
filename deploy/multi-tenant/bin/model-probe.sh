#!/usr/bin/env bash
# 探测一个模型端点的形态，并给出接入本部署所需的配置片段。
#
# 零依赖：只用 python3（局域网里装不了 curl 也能跑）。协议判定、模型列表、流式与函数调用
# 全部由内嵌的 python3 完成，不调用 curl、不调用任何外部命令。
#
# 为什么需要它：租户侧的 DSH 适配器要按端点的协议挑一个（openai-completions 还是
# anthropic-messages），路径也随协议不同（/v1/chat/completions 还是 /v1/messages）。
# 挑错的后果是 404，而 404 在日志里跟"上游挂了"长得一模一样。这里把四条路径都试一遍，
# 直接说出是哪种协议、有哪些模型，并打印对应的 model.patch.yml 片段。
#
# 用法：
#   bin/model-probe.sh <baseURL> [apiKey] [模型id]
#   bin/model-probe.sh http://15.11.40.44:3100 sk-xxxx
#   bin/model-probe.sh http://15.11.40.44:3100 sk-xxxx deepseek-v4-flash
#
# 判定必须带 key：像 api.deepseek.com 这类网关**先鉴权再路由**，不带 key 时任何路径都回
# 401，光看状态码会把每条路径都判成"存在"（这个假阳性我实测踩过）。因此只有在带 key 的
# 真实调用成功（或用协议格式错误明确回 400）时才下结论。
#
# 注意：请在一台【能访问该端点】的机器上运行。部署机如果在别的网段，它 ping 不到
# 15.11.40.44 是正常的，那说明试点必须落在那张网里，或者先打通路由。
set -uo pipefail

BASE="${1:-}"
KEY="${2:-}"
MODEL="${3:-}"
[ -n "$BASE" ] || { echo "用法: bin/model-probe.sh <baseURL> [apiKey] [模型id]" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "需要 python3（Ubuntu 自带）" >&2; exit 1; }

python3 - "$BASE" "$KEY" "$MODEL" <<'PY'
import json
import socket
import sys
import urllib.error
import urllib.request

base = sys.argv[1].rstrip('/')
key = sys.argv[2]
forced_model = sys.argv[3]
TIMEOUT = 20


def call(path, body=None, method='POST', auth='bearer', stream=False, read_bytes=400):
    """发一次请求；返回 (状态码, 前若干字节文本)。状态码 0 表示连不上。"""
    url = base + path
    data = None if body is None else json.dumps(body).encode()
    headers = {'content-type': 'application/json'}
    if key:
        if auth == 'anthropic':
            headers['x-api-key'] = key
            headers['anthropic-version'] = '2023-06-01'
        else:
            headers['authorization'] = 'Bearer ' + key
    if stream:
        headers['accept'] = 'text/event-stream'
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.status, response.read(read_bytes).decode('utf-8', 'replace')
    except urllib.error.HTTPError as error:
        # 4xx/5xx 也带着证据回来：状态码与响应体的一小段。
        return error.code, error.read(read_bytes).decode('utf-8', 'replace')
    except (urllib.error.URLError, socket.timeout, ConnectionError, OSError):
        return 0, ''


def verdict(status):
    if status == 0:
        return '连不上'
    if 200 <= status < 300:
        return '可用'
    if status in (400, 422):
        return '路由到了（请求格式不符）'
    if status in (401, 403):
        return '鉴权被拒（key 不对或不是这种鉴权方式）'
    if status in (404, 405):
        return '不是这条路径'
    return 'HTTP %d' % status


if not key:
    print('== 只做连通性探测（没有给 key，协议一律不判定）')
    status, _ = call('/', method='GET')
    print('  GET %s/ -> %s' % (base, status or '连不上'))
    if status == 0:
        print('  连不上：确认这台机器在能访问该端点的网里（跨网段/未放行都会是这样）')
    print()
    print('  要判定协议与模型，请带上 key 再跑一次：')
    print('    bin/model-probe.sh %s <apiKey>' % base)
    sys.exit(0)

print('== 目标 %s（带 key 的真实调用）' % base)
probes = [
    ('POST /v1/chat/completions（OpenAI）', '/v1/chat/completions', 'POST',
     {'model': 'probe', 'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 1}, 'bearer'),
    ('POST /v1/messages（Anthropic）', '/v1/messages', 'POST',
     {'model': 'probe', 'max_tokens': 1, 'messages': [{'role': 'user', 'content': 'hi'}]}, 'anthropic'),
    ('GET  /v1/models（OpenAI 列表）', '/v1/models', 'GET', None, 'bearer'),
    ('GET  /v1/models（Anthropic 列表）', '/v1/models', 'GET', None, 'anthropic'),
]
for label, path, method, body, auth in probes:
    status, head = call(path, body=body, method=method, auth=auth)
    print('  %-34s %-6s %s' % (label, status or '000', verdict(status)))
    if head.strip():
        print('      %s' % head.strip()[:200])

print()
print('-- 模型列表（上面哪一条 200 就用哪种鉴权，这里原样打印）')
listing = ''
for auth in ('bearer', 'anthropic'):
    status, body = call('/v1/models', method='GET', auth=auth, read_bytes=4096)
    if status and 200 <= status < 300 and body.strip():
        listing = body
        print('  [%s] %s' % (auth, body.strip()[:1000]))
        break
if not listing:
    print('  （取不到列表：这个端点的 /v1/models 可能没开放，需要人给模型 id）')

# 挑一个对话模型：显式给的优先，否则从列表里挑第一个不像向量/重排模型的 id。
model = forced_model
if not model and listing:
    try:
        doc = json.loads(listing)
        items = doc.get('data') or doc.get('models') or []
        if isinstance(items, dict):
            items = [{'id': k} for k in items]
        for item in items:
            mid = (item.get('id') if isinstance(item, dict) else str(item)) or ''
            if any(bad in mid.lower() for bad in ('bge', 'embed', 'rerank', 'reranker')):
                continue
            model = mid
            break
    except Exception:
        pass

print()
print('-- DSH 除了能对话之外还依赖的能力')
if not model:
    print('  ! 没能自动挑出对话模型：把模型 id 作为第三个参数传进来重跑')
    print('    例：bin/model-probe.sh %s <apiKey> deepseek-v4-flash' % base)
else:
    print('  用来测的对话模型 id：%s' % model)
    status, body = call('/v1/chat/completions', body={
        'model': model, 'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 8})
    if status and 200 <= status < 300 and '"choices"' in body:
        print('  ✓ 普通对话调用可用')
    else:
        print('  ✗ 普通对话调用失败：%s' % (body.strip()[:200] or status))

    status, body = call('/v1/chat/completions', stream=True, body={
        'model': model, 'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 8, 'stream': True})
    if 'data:' in body:
        print('  ✓ 流式（SSE）可用')
    else:
        print('  ✗ 流式拿不到 SSE 帧（DSH 会报错）：%s' % (body.strip()[:160] or status))

    status, body = call('/v1/chat/completions', body={
        'model': model,
        'messages': [{'role': 'user', 'content': '调用 probe_tool，参数 x=1'}],
        'max_tokens': 64,
        'tools': [{'type': 'function', 'function': {
            'name': 'probe_tool', 'description': 'probe',
            'parameters': {'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': ['x']}}}],
        'tool_choice': 'auto'})
    if '"tool_calls"' in body:
        print('  ✓ 函数调用（tools）可用 —— DSH 的 agent 循环能跑')
    else:
        print('  ✗ 没看到 tool_calls：%s' % (body.strip()[:200] or status))

print()
print('== 配置片段（填 id 与容量后写进 model.patch.yml）')
print('''
  - id: llm-pi-ai
    config:
      providers:
        internal:
          displayName: 内网模型服务
          api: openai-completions
          baseURL: http://mt-model-gateway:8080/v1     # 指向【网关】，不是内网端点
          apiKeyEnv: DEEPSEEK_API_KEY                  # 租户的占位 key，由 render 注入
          models:
            - id: <上面列出的模型 id>
              name: <界面显示名>
              contextWindow: 131072                    # 128k；不写会按 262144 算，压缩太晚
              maxTokens: 8192                          # 输出上限，写了它同时成为请求默认值
  - id: llm-deepseek
    disabled: true                                     # 隐藏内置卡片（Anthropic 路径 + 指公网）

  真凭据只进部署机的 .env（绝不进 model.env 或租户容器）：
      MT_UPSTREAM_BASE=<内网端点>
      MT_UPSTREAM_API_KEY=<真 key>
''')
PY
