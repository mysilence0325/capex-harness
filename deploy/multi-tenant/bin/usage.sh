#!/usr/bin/env bash
# 按租户汇总模型用量。
#
# 数据来自模型网关：它持有真凭据，所以每次请求都能归到具体租户。租户容器里只有
# 占位 key，因此这个账本是可信的——租户绕不过它，除非管理员另外给它一把真 key。
#
# 用法：
#   bin/usage.sh                 汇总所有租户
#   bin/usage.sh --tail 20       另外列出最近 20 条请求明细
#   bin/usage.sh --tenant alpha  只看某个租户
set -uo pipefail
cd "$(dirname "$0")/.."

TENANT=""
TAIL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="$2"; shift 2 ;;
    --tail) TAIL="$2"; shift 2 ;;
    *) echo "用法: bin/usage.sh [--tenant <id>] [--tail <n>]" >&2; exit 2 ;;
  esac
done

if [ ! -f logs/model-usage.jsonl ]; then
  echo "还没有用量记录（logs/model-usage.jsonl 不存在）：租户尚未发起过模型请求。"
  exit 0
fi

docker run --rm -v "$PWD:/w" -w /w -e MT_TENANT="$TENANT" -e MT_TAIL="$TAIL" node:22-bookworm-slim node -e '
const fs = require("node:fs")
const filter = process.env.MT_TENANT || ""
const tail = Number(process.env.MT_TAIL || 0)
const rows = fs.readFileSync("/w/logs/model-usage.jsonl", "utf8").trim().split("\n").filter(Boolean)
  .map((line) => { try { return JSON.parse(line) } catch { return undefined } })
  .filter((row) => row !== undefined && (filter === "" || row.tenant === filter))

const by = new Map()
const failures = []
for (const row of rows) {
  if (row.tenant === "-" || row.status !== 200) { failures.push(row); continue }
  const current = by.get(row.tenant) ?? { calls: 0, input: 0, output: 0, cached: 0, ms: 0 }
  current.calls += 1
  current.input += row.inputTokens || 0
  current.output += row.outputTokens || 0
  current.cached += row.cacheReadTokens || 0
  current.ms += row.ms || 0
  by.set(row.tenant, current)
}

if (by.size === 0) {
  console.log("没有成功的模型调用记录。")
} else {
  console.log("租户      调用   输入token  输出token  命中缓存  平均耗时")
  let totals = { calls: 0, input: 0, output: 0, cached: 0 }
  for (const [tenant, v] of [...by].sort()) {
    console.log(
      tenant.padEnd(10) +
      String(v.calls).padStart(5) +
      String(v.input).padStart(11) +
      String(v.output).padStart(11) +
      String(v.cached).padStart(10) +
      String(Math.round(v.ms / v.calls) + "ms").padStart(10),
    )
    totals.calls += v.calls; totals.input += v.input; totals.output += v.output; totals.cached += v.cached
  }
  console.log("-".repeat(58))
  console.log(
    "合计".padEnd(9) +
    String(totals.calls).padStart(5) +
    String(totals.input).padStart(11) +
    String(totals.output).padStart(11) +
    String(totals.cached).padStart(10),
  )
}

if (failures.length > 0) {
  console.log("")
  console.log("被拒绝或失败的请求 " + failures.length + " 条（未知 key、上游错误等）")
  for (const row of failures.slice(-5)) {
    console.log("  " + row.ts + "  " + (row.tenant || "-") + "  HTTP " + row.status + "  " + (row.note || row.error || ""))
  }
}

if (tail > 0) {
  console.log("")
  console.log("最近 " + tail + " 条明细：")
  for (const row of rows.slice(-tail)) {
    const tokens = row.status === 200 ? "  in=" + (row.inputTokens || 0) + " out=" + (row.outputTokens || 0) : ""
    console.log("  " + row.ts + "  " + String(row.tenant).padEnd(8) + " HTTP " + row.status + "  " + (row.ms || 0) + "ms" + tokens + "  " + row.path)
  }
}
'
