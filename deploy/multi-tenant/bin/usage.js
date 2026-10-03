#!/usr/bin/env node
/**
 * Per-tenant model usage, read from the model gateway's own log.
 *
 * Deliberately without rates. What a token costs is a commercial decision that differs
 * per deployment and changes without the code changing, so this reports what was used
 * and leaves the multiplication to whoever owns the contract. `--csv` exists for that
 * reason: the numbers are meant to be taken away and priced elsewhere.
 *
 * Rotated generations are included. A report that only read the current file would
 * silently shorten its own history the first time the log rotates, which is the kind
 * of quiet wrongness that is worse than no report.
 *
 * Usage:
 *   node bin/usage.js [--days N] [--tenant <id>] [--csv|--json]
 *
 * @module mt/bin/usage
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { rotatedFiles } = require('../gateway/rotate.js')

const ROOT = path.resolve(__dirname, '..')
const LOG_DIR = process.env.MT_LOG_DIR ?? path.join(ROOT, 'logs')

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const days = Number(flag('days') ?? 0)
const only = flag('tenant')
const asCsv = args.includes('--csv')
const asJson = args.includes('--json')

const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined

/** Every usage line across the current file and its rotated generations. */
function* rows() {
  for (const file of rotatedFiles(path.join(LOG_DIR, 'model-usage.jsonl'))) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`读取失败 ${file}: ${error.message}`)
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        yield JSON.parse(line)
      } catch {
        // A torn line from a write in progress; skip it rather than fail the report.
      }
    }
  }
}

const totals = new Map()
let scanned = 0
for (const row of rows()) {
  if (typeof row?.ts !== 'string') continue
  const at = Date.parse(row.ts)
  if (!Number.isFinite(at)) continue
  if (since !== undefined && at < since) continue
  const tenant = typeof row.tenant === 'string' && row.tenant !== '' ? row.tenant : '-'
  if (only !== undefined && tenant !== only) continue
  scanned += 1
  const entry = totals.get(tenant) ?? {
    tenant,
    calls: 0,
    rejected: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    first: row.ts,
    last: row.ts,
    notes: new Map(),
  }
  const status = Number(row.status ?? 0)
  if (status >= 200 && status < 300) {
    entry.calls += 1
    entry.input += Number(row.inputTokens ?? 0)
    entry.output += Number(row.outputTokens ?? 0)
    entry.cacheRead += Number(row.cacheReadTokens ?? 0)
  } else {
    entry.rejected += 1
    if (typeof row.note === 'string') entry.notes.set(row.note, (entry.notes.get(row.note) ?? 0) + 1)
  }
  if (row.ts < entry.first) entry.first = row.ts
  if (row.ts > entry.last) entry.last = row.ts
  totals.set(tenant, entry)
}

const rowsOut = [...totals.values()].sort((a, b) => b.input + b.output - (a.input + a.output))
const window = since === undefined ? '全部时间' : `最近 ${String(days)} 天`

if (asJson) {
  console.log(JSON.stringify({ window, scanned, tenants: rowsOut.map((r) => ({ ...r, notes: Object.fromEntries(r.notes) })) }, null, 2))
  process.exit(0)
}

if (asCsv) {
  console.log('tenant,calls,rejected,input_tokens,output_tokens,cache_read_tokens,total_tokens,first,last')
  for (const row of rowsOut) {
    console.log(
      [row.tenant, row.calls, row.rejected, row.input, row.output, row.cacheRead, row.input + row.output, row.first, row.last].join(','),
    )
  }
  process.exit(0)
}

const num = (value) => value.toLocaleString('en-US')
const pad = (text, width) => String(text).padEnd(width)

console.log(`统计窗口: ${window}    日志条目: ${num(scanned)}`)
console.log('')
console.log(`  ${pad('租户', 12)} ${pad('成功调用', 10)} ${pad('输入 token', 14)} ${pad('输出 token', 14)} ${pad('缓存读', 12)} ${pad('被拒', 6)} 最后活动`)
console.log(`  ${'-'.repeat(12)} ${'-'.repeat(10)} ${'-'.repeat(14)} ${'-'.repeat(14)} ${'-'.repeat(12)} ${'-'.repeat(6)} ${'-'.repeat(19)}`)
let sum = { calls: 0, input: 0, output: 0, cacheRead: 0, rejected: 0 }
for (const row of rowsOut) {
  sum = {
    calls: sum.calls + row.calls,
    input: sum.input + row.input,
    output: sum.output + row.output,
    cacheRead: sum.cacheRead + row.cacheRead,
    rejected: sum.rejected + row.rejected,
  }
  console.log(
    `  ${pad(row.tenant, 12)} ${pad(num(row.calls), 10)} ${pad(num(row.input), 14)} ${pad(num(row.output), 14)} ${pad(num(row.cacheRead), 12)} ${pad(num(row.rejected), 6)} ${row.last.replace('T', ' ').replace(/\..*$/u, '')}`,
  )
}
console.log(`  ${'-'.repeat(12)} ${'-'.repeat(10)} ${'-'.repeat(14)} ${'-'.repeat(14)} ${'-'.repeat(12)} ${'-'.repeat(6)}`)
console.log(
  `  ${pad('合计', 12)} ${pad(num(sum.calls), 10)} ${pad(num(sum.input), 14)} ${pad(num(sum.output), 14)} ${pad(num(sum.cacheRead), 12)} ${pad(num(sum.rejected), 6)}`,
)
console.log('')

const unattributed = totals.get('-')
if (unattributed !== undefined) {
  const reasons = [...unattributed.notes.entries()].map(([note, count]) => `${note}×${String(count)}`).join('、')
  console.log(`  未归属请求 ${num(unattributed.rejected)} 次${reasons === '' ? '' : `（${reasons}）`}`)
  console.log('  这些是拿着不认识或为空的 key 打进来的调用，不属于任何租户；')
  console.log('  持续出现说明有租户把 key 配错了，或者有外部扫描。')
}
console.log('')
console.log('  这里只报用量、不带费率：单价是每个部署自己的商业决定，')
console.log('  要算钱请用 --csv 导出后自行套价。')
