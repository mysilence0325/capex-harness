/**
 * Prometheus text exposition for the control plane.
 *
 * The deployment already keeps every number here — per-tenant model calls and
 * tokens from the model gateway's usage log, runtime readiness from the live
 * probe, administrative actions from the audit log — but only as JSON behind a
 * console and a handful of commands. This renders the same facts in the format a
 * scraper reads, so alerting does not depend on somebody running doctor.
 *
 * Counters come from the usage log, which is append-only, so they restart at
 * zero only when the log rotates past its generations. Everything derived from
 * the log includes the rotated files for the same reason the console does.
 *
 * @module mt/gateway/metrics
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { rotatedFiles } = require('./rotate.js')

/** Escape a label value for the exposition format. */
function escapeLabel(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n')
}

/** One sample line. */
function sample(name, labels, value) {
  const rendered = Object.entries(labels)
    .filter(([, entry]) => entry !== undefined && entry !== null)
    .map(([key, entry]) => `${key}="${escapeLabel(entry)}"`)
    .join(',')
  return `${name}${rendered === '' ? '' : `{${rendered}}`} ${String(value)}`
}

/** Emit a metric family with its type and help lines. */
function family(lines, name, type, help) {
  if (lines.length === 0) return
  lines.push(`# HELP ${name} ${help}`)
  lines.push(`# TYPE ${name} ${type}`)
}

/**
 * Aggregate one tenant's model usage from the usage log.
 * @param logDir - directory holding model-usage.jsonl and its generations.
 * @returns a map of tenant id to counters.
 */
function usageFromLog(logDir) {
  const totals = new Map()
  for (const file of rotatedFiles(path.join(logDir, 'model-usage.jsonl'))) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      const row0 = typeof row?.tenant === 'string' ? row.tenant : ''
      const status = Number(row.status ?? 0)
      // A request with no tenant (an unknown placeholder key) is not a tenant's
      // traffic: counting it under a pseudo-tenant would put a series in the
      // per-tenant graphs that no tenant owns.
      const tenant = row0 !== '' && row0 !== '-' ? row0 : undefined
      if (tenant === undefined) {
        const current = totals.get('') ?? { ok: 0, rejected: 0, other: 0, input: 0, output: 0, cacheRead: 0, ms: 0, unattributed: 0 }
        current.unattributed += 1
        totals.set('', current)
        continue
      }
      const current = totals.get(tenant) ?? { ok: 0, rejected: 0, other: 0, input: 0, output: 0, cacheRead: 0, ms: 0, unattributed: 0 }
      if (status === 200) {
        current.ok += 1
        current.input += Number(row.inputTokens ?? 0)
        current.output += Number(row.outputTokens ?? 0)
        current.cacheRead += Number(row.cacheReadTokens ?? 0)
        current.ms += Number(row.ms ?? 0)
      } else if (status === 429 || status === 401) {
        current.rejected += 1
      } else {
        current.other += 1
      }
      totals.set(tenant, current)
    }
  }
  return totals
}

/**
 * Newest backup archive's timestamp.
 * @param root - deployment root.
 * @returns epoch seconds, or 0 when there is none.
 */
function lastBackupSeconds(root) {
  const dir = path.join(root, 'backups')
  if (!fs.existsSync(dir)) return 0
  let newest = 0
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith('dsh-mt-') || !entry.endsWith('.tar.gz')) continue
    try {
      const stat = fs.statSync(path.join(dir, entry))
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
    } catch {
      continue
    }
  }
  return newest === 0 ? 0 : Math.floor(newest / 1000)
}

/** Count lines in a rotated log, for administrative action counters. */
function countLogLines(logDir, name) {
  let total = 0
  for (const file of rotatedFiles(path.join(logDir, name))) {
    try {
      total += fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length
    } catch {
      continue
    }
  }
  return total
}

/**
 * Render the whole exposition.
 *
 * @param options - live facts the caller owns.
 * @param options.tenants - one entry per tenant: id, registered, reachable, hasToken, ready, node, limits.
 * @param options.logDir - where the logs live.
 * @param options.root - deployment root, for the backup timestamp.
 * @param options.startedAt - process start, for uptime.
 * @param options.edgePort - the public entry port.
 * @returns the exposition text.
 */
function render({ tenants, logDir, root, startedAt, edgePort, nodes: agents = [] }) {
  const lines = []

  // Node agents. mt_agent_up is whether the control plane can reach one at all;
  // mt_agent_control_plane_configured is whether that agent registers tenants or
  // only serves operations. The second is the one worth alerting on: an agent with
  // no control plane reports healthy and quietly does nothing, until a tenant
  // restarts and the entry point starts answering 303.
  if (agents.length > 0) {
    lines.push('# HELP mt_agent_up Whether the control plane can reach this node agent.')
    lines.push('# TYPE mt_agent_up gauge')
    lines.push('# HELP mt_agent_control_plane_configured Whether this node agent registers tenants (0 = operations only).')
    lines.push('# TYPE mt_agent_control_plane_configured gauge')
    for (const agent of agents) {
      lines.push(sample('mt_agent_up', { node: agent.node }, agent.agent === 'up' ? 1 : 0))
      lines.push(sample('mt_agent_control_plane_configured', { node: agent.node }, agent.controlPlane === true ? 1 : 0))
    }
    lines.push('')
  }
  const usage = usageFromLog(logDir)

  // 每个租户的磁盘占用与配额目标，都来自节点代理的上报。
  //
  // 不在这里量目录：控制面只挂了自己的配置与 state，看不到 tenants/ 与 quota.json。
  // 这点实测过 —— 目录读出来是 ENOENT，指标恒为 0，而"0 字节"看起来像正常值，
  // 不会有人去查。谁看得见就由谁上报。
  const diskUsed = tenants.map((tenant) => sample('mt_tenant_disk_used_bytes', { tenant: tenant.id }, tenant.diskUsed ?? 0))
  if (diskUsed.length > 0) {
    lines.push('# HELP mt_tenant_disk_used_bytes Bytes under the tenant directory, as reported by its node agent')
    lines.push('# TYPE mt_tenant_disk_used_bytes gauge')
    lines.push(...diskUsed)
  }
  const diskLimit = tenants
    .filter((tenant) => (tenant.quotaLimit ?? 0) > 0)
    .map((tenant) => sample('mt_tenant_disk_limit_bytes', { tenant: tenant.id }, tenant.quotaLimit))
  if (diskLimit.length > 0) {
    lines.push('# HELP mt_tenant_disk_limit_bytes Configured quota for the tenant directory, 0 when none')
    lines.push('# TYPE mt_tenant_disk_limit_bytes gauge')
    lines.push(...diskLimit)
  }

  const registered = tenants.map((tenant) => sample('mt_tenant_registered', { tenant: tenant.id }, tenant.registered ? 1 : 0))
  family(lines, 'mt_tenant_registered', 'gauge', 'Whether the control plane has a registered runtime for this tenant (1) or not (0).')
  lines.push(...registered)

  const ready = tenants.map((tenant) => sample('mt_tenant_ready', { tenant: tenant.id }, tenant.ready ? 1 : 0))
  if (ready.length > 0) {
    lines.push('# HELP mt_tenant_ready Whether the tenant answered a live probe with a usable launch token.')
    lines.push('# TYPE mt_tenant_ready gauge')
    lines.push(...ready)
  }

  const hasToken = tenants.map((tenant) => sample('mt_tenant_has_token', { tenant: tenant.id }, tenant.hasToken ? 1 : 0))
  if (hasToken.length > 0) {
    lines.push('# HELP mt_tenant_has_token Whether the registered runtime was registered with a launch token.')
    lines.push('# TYPE mt_tenant_has_token gauge')
    lines.push(...hasToken)
  }

  const nodes = tenants.map((tenant) => sample('mt_tenant_info', { tenant: tenant.id, node: tenant.node ?? 'local' }, 1))
  if (nodes.length > 0) {
    lines.push('# HELP mt_tenant_info Static facts about a tenant; the value is always 1.')
    lines.push('# TYPE mt_tenant_info gauge')
    lines.push(...nodes)
  }

  // A tenant with no traffic yet still deserves a zero, so a graph does not
  // silently lose a series the moment a tenant is added. The empty key holds
  // traffic that named no tenant, reported separately below.
  const ids = new Set([...tenants.map((tenant) => tenant.id), ...usage.keys()])
  ids.delete('')
  const calls = []
  const tokens = []
  const rejected = []
  for (const id of ids) {
    const entry = usage.get(id) ?? { ok: 0, rejected: 0, input: 0, output: 0, cacheRead: 0 }
    calls.push(sample('mt_tenant_model_calls_total', { tenant: id }, entry.ok))
    tokens.push(sample('mt_tenant_model_input_tokens_total', { tenant: id }, entry.input))
    tokens.push(sample('mt_tenant_model_output_tokens_total', { tenant: id }, entry.output))
    tokens.push(sample('mt_tenant_model_cache_read_tokens_total', { tenant: id }, entry.cacheRead))
    rejected.push(sample('mt_tenant_model_rejected_total', { tenant: id }, entry.rejected))
  }
  family(lines, 'mt_tenant_model_calls_total', 'counter', 'Model requests this tenant completed successfully.')
  lines.push(...calls)
  family(lines, 'mt_tenant_model_input_tokens_total', 'counter', 'Prompt tokens this tenant sent.')
  lines.push(...tokens.filter((line) => line.includes('input')))
  family(lines, 'mt_tenant_model_output_tokens_total', 'counter', 'Completion tokens this tenant received.')
  lines.push(...tokens.filter((line) => line.includes('output')))
  family(lines, 'mt_tenant_model_cache_read_tokens_total', 'counter', 'Prompt tokens this tenant read from the provider cache.')
  lines.push(...tokens.filter((line) => line.includes('cache_read')))
  family(lines, 'mt_tenant_model_rejected_total', 'counter', 'Model requests refused for this tenant (rate limit or unknown key).')
  lines.push(...rejected)

  const ceilings = []
  for (const tenant of tenants) {
    if (tenant.limits?.rpm) ceilings.push(sample('mt_tenant_model_limit_rpm', { tenant: tenant.id }, tenant.limits.rpm))
    if (tenant.limits?.dailyTokens) ceilings.push(sample('mt_tenant_model_limit_daily_tokens', { tenant: tenant.id }, tenant.limits.dailyTokens))
  }
  if (ceilings.length > 0) {
    lines.push('# HELP mt_tenant_model_limit_rpm Configured per-minute request ceiling, when set.')
    lines.push('# TYPE mt_tenant_model_limit_rpm gauge')
    lines.push('# HELP mt_tenant_model_limit_daily_tokens Configured daily token ceiling, when set.')
    lines.push('# TYPE mt_tenant_model_limit_daily_tokens gauge')
    lines.push(...ceilings)
  }

  lines.push('# HELP mt_gateway_uptime_seconds Seconds since the control plane started.')
  lines.push('# TYPE mt_gateway_uptime_seconds gauge')
  lines.push(sample('mt_gateway_uptime_seconds', {}, Math.floor((Date.now() - startedAt) / 1000)))

  lines.push('# HELP mt_gateway_tenants Number of tenants in the registry.')
  lines.push('# TYPE mt_gateway_tenants gauge')
  lines.push(sample('mt_gateway_tenants', {}, tenants.length))

  lines.push('# HELP mt_gateway_edge_port The public entry port this control plane serves.')
  lines.push('# TYPE mt_gateway_edge_port gauge')
  lines.push(sample('mt_gateway_edge_port', {}, edgePort))

  lines.push('# HELP mt_gateway_admin_actions_total Administrative actions recorded in the audit log.')
  lines.push('# TYPE mt_gateway_admin_actions_total counter')
  lines.push(sample('mt_gateway_admin_actions_total', {}, countLogLines(logDir, 'admin.jsonl')))

  // Traffic refused before it could be attributed to a tenant: a wrong or
  // missing placeholder key. Worth alerting on, since no tenant will report it.
  lines.push('# HELP mt_model_unattributed_requests_total Model requests refused before a tenant could be identified.')
  lines.push('# TYPE mt_model_unattributed_requests_total counter')
  lines.push(sample('mt_model_unattributed_requests_total', {}, usage.get('')?.unattributed ?? 0))

  lines.push('# HELP mt_backup_last_success_timestamp_seconds Unix time of the newest backup archive; 0 when none exists.')
  lines.push('# TYPE mt_backup_last_success_timestamp_seconds gauge')
  lines.push(sample('mt_backup_last_success_timestamp_seconds', {}, lastBackupSeconds(root)))

  return `${lines.join('\n')}\n`
}

module.exports = { render }
