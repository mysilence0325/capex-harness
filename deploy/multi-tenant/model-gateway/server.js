/**
 * Model gateway: the only holder of the real model credential.
 *
 * A tenant container runs an agent with full permissions in it, so any
 * credential in that container is a credential the tenant has. Before this
 * gateway existed every tenant received the administrator's own key through
 * `env_file`, readable with one `env` call and exfiltratable through the egress
 * proxy.
 *
 * Tenants now hold a per-tenant placeholder key. This service maps that key to
 * the tenant, replaces it with the real one, and forwards the request upstream.
 * The upstream call goes through the egress proxy (an absolute-URI HTTP request
 * to it), which is how a bridge-network container reaches the internet on a host
 * with `ip_forward = 0`; it also means no second host port has to be exposed.
 *
 * It does not interpret the API: any path and body pass through untouched, so
 * the DeepSeek Messages API, file uploads, and streaming responses all work the
 * same way. The one thing it reads is token usage, for per-tenant accounting.
 *
 * @module mt/model-gateway/server
 */

'use strict'

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
// Copied into this image from gateway/rotate.js: one rotation policy for every
// log the deployment writes, rather than a second copy that could drift.
const { appendRotated } = require('./rotate.js')

const PORT = Number(process.env.MT_PORT ?? 8080)
const UPSTREAM_BASE = (process.env.MT_UPSTREAM_BASE ?? 'https://api.deepseek.com').replace(/\/+$/u, '')
const UPSTREAM_KEY = process.env.MT_UPSTREAM_KEY ?? ''
const EGRESS_PROXY = process.env.MT_EGRESS_PROXY ?? ''
const REGISTRY = process.env.MT_REGISTRY ?? '/config/tenants.json'
const LOG_DIR = process.env.MT_LOG_DIR ?? '/logs'

if (UPSTREAM_KEY === '') {
  console.error('mt-model-gateway: MT_UPSTREAM_KEY is empty; refusing to start')
  process.exit(1)
}

const [egressHost, egressPort] = (() => {
  if (EGRESS_PROXY === '') return [undefined, undefined]
  const url = new URL(EGRESS_PROXY)
  return [url.hostname, Number(url.port === '' ? 3128 : url.port)]
})()

/** Placeholder key to tenant id, reloaded when the registry changes. */
function loadKeys() {
  const map = new Map()
  const found = new Map()
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
    for (const tenant of registry.tenants ?? []) {
      if (typeof tenant?.modelKey === 'string' && tenant.modelKey !== '') map.set(tenant.modelKey, tenant.id)
      const limits = tenant?.modelLimits
      if (limits !== undefined && limits !== null) found.set(tenant.id, limits)
    }
  } catch (error) {
    console.error(`mt-model-gateway: cannot read the registry, keeping the previous keys: ${error.message}`)
    return undefined
  }
  return { keys: map, limits: found }
}

const initial = loadKeys() ?? { keys: new Map(), limits: new Map() }
let keys = initial.keys
/** Per-tenant ceilings, from the registry so they are data rather than code. */
let limits = initial.limits
fs.watchFile(REGISTRY, { interval: 2000 }, () => {
  const next = loadKeys()
  if (next === undefined) return
  keys = next.keys
  limits = next.limits
})

// ---------------------------------------------------------------------------
// per-tenant ceilings
//
// A tenant that exhausts the upstream quota makes the deployment unusable for
// everyone else, so the gateway that already sees every call is where the limit
// belongs. Counters are in memory: a restart resets them, which is acceptable
// because a ceiling exists to stop a runaway, not to bill precisely (the usage
// log does that).
// ---------------------------------------------------------------------------

/** Request counts per tenant within the current minute window. */
const minuteWindows = new Map()
/** Token counts per tenant for the current day. */
const dayWindows = new Map()

/** Environment default for tenants whose registry entry sets no ceiling. */
const DEFAULT_RPM = Number(process.env.MT_MODEL_DEFAULT_RPM ?? 0)
const DEFAULT_DAILY_TOKENS = Number(process.env.MT_MODEL_DEFAULT_DAILY_TOKENS ?? 0)

/**
 * Ceilings in effect for one tenant.
 * @param tenant - tenant id.
 * @returns requests per minute and tokens per day, 0 meaning unlimited.
 */
function limitsFor(tenant) {
  const entry = limits.get(tenant) ?? {}
  return {
    rpm: Number.isFinite(Number(entry.rpm)) && Number(entry.rpm) > 0 ? Number(entry.rpm) : DEFAULT_RPM,
    dailyTokens: Number.isFinite(Number(entry.dailyTokens)) && Number(entry.dailyTokens) > 0 ? Number(entry.dailyTokens) : DEFAULT_DAILY_TOKENS,
  }
}

/** Today, in the deployment's timezone, as a stable key. */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Whether one more request may proceed.
 *
 * Counts the request as it allows it: a request that fails upstream still spent
 * an attempt, and counting only successes would let a failing client retry
 * without bound.
 *
 * @param tenant - tenant id.
 * @returns undefined when allowed, or the reason to refuse.
 */
function admit(tenant) {
  const ceiling = limitsFor(tenant)
  const now = Date.now()
  if (ceiling.rpm > 0) {
    let window = minuteWindows.get(tenant)
    if (window === undefined || now - window.startedAt >= 60_000) {
      window = { startedAt: now, count: 0 }
      minuteWindows.set(tenant, window)
    }
    if (window.count >= ceiling.rpm) {
      return { kind: 'rpm', limit: ceiling.rpm, retryAfter: Math.ceil((window.startedAt + 60_000 - now) / 1000) }
    }
    window.count += 1
  }
  if (ceiling.dailyTokens > 0) {
    const day = today()
    let window = dayWindows.get(tenant)
    if (window === undefined || window.day !== day) {
      window = { day, tokens: 0 }
      dayWindows.set(tenant, window)
    }
    if (window.tokens >= ceiling.dailyTokens) {
      return { kind: 'daily-tokens', limit: ceiling.dailyTokens, retryAfter: 0 }
    }
  }
  return undefined
}

/**
 * Add one response's token usage to a tenant's day.
 * @param tenant - tenant id.
 * @param inputTokens - prompt tokens reported by the provider.
 * @param outputTokens - completion tokens reported by the provider.
 */
function chargeTokens(tenant, inputTokens, outputTokens) {
  const day = today()
  let window = dayWindows.get(tenant)
  if (window === undefined || window.day !== day) {
    window = { day, tokens: 0 }
    dayWindows.set(tenant, window)
  }
  window.tokens += Number(inputTokens ?? 0) + Number(outputTokens ?? 0)
}

fs.mkdirSync(LOG_DIR, { recursive: true })
const usageFile = path.join(LOG_DIR, 'model-usage.jsonl')

/**
 * Record one request and the token usage it reported.
 *
 * Rotated by size on the same policy as the control plane's own logs: this file
 * is read for per-tenant accounting and would otherwise grow without bound.
 * Readers must include the shifted generations (see gateway/rotate.js).
 *
 * @param entry - fields to append as one JSON line.
 */
function record(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  console.log(line)
  try {
    appendRotated(usageFile, line)
  } catch (error) {
    console.error(`mt-model-gateway: cannot append usage: ${error.message}`)
  }
}

/**
 * Pull the largest token counts out of a response body.
 *
 * Messages API streams report usage across several events (`message_start`
 * carries the input side, `message_delta` the output side), so the maximum of
 * each field is what the request actually cost. The body is left untouched.
 *
 * @param text - captured response text.
 * @returns token counts, zero when absent.
 */
function usageOf(text) {
  const numbers = (name) => {
    let largest = 0
    for (const match of text.matchAll(new RegExp(`"${name}"\\s*:\\s*(\\d+)`, 'gu'))) {
      largest = Math.max(largest, Number(match[1]))
    }
    return largest
  }
  return {
    inputTokens: numbers('input_tokens'),
    outputTokens: numbers('output_tokens'),
    cacheReadTokens: numbers('cache_read_input_tokens'),
    cacheWriteTokens: numbers('cache_creation_input_tokens'),
  }
}

/** How much of a response is kept for usage extraction; long streams are common. */
const CAPTURE_LIMIT = 262_144

const server = http.createServer((req, res) => {
  const started = Date.now()

  if (req.url === '/__health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, tenants: new Set(keys.values()).size, upstream: UPSTREAM_BASE }))
    return
  }

  const presented = req.headers['x-api-key']
  const tenant = typeof presented === 'string' ? keys.get(presented) : undefined
  if (tenant === undefined) {
    record({ tenant: '-', path: req.url, status: 401, note: 'unknown-or-missing-key' })
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'unknown model key for this deployment' },
    }))
    return
  }

  const refused = admit(tenant)
  if (refused !== undefined) {
    // 429 rather than 403: the tenant is recognized and may try again later. The
    // message names which ceiling so the tenant can tell "slow down" apart from
    // "you are out of budget for today".
    record({ tenant, path: req.url, status: 429, note: `limit-${refused.kind}`, limit: refused.limit })
    const message = refused.kind === 'rpm'
      ? `model requests for this tenant are limited to ${String(refused.limit)} per minute`
      : `this tenant has used its ${String(refused.limit)} token budget for today`
    res.writeHead(429, {
      'content-type': 'application/json; charset=utf-8',
      ...(refused.retryAfter > 0 ? { 'retry-after': String(refused.retryAfter) } : {}),
    })
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message } }))
    return
  }

  const target = new URL(`${UPSTREAM_BASE}${req.url ?? '/'}`)
  const headers = { ...req.headers, host: target.host, 'x-api-key': UPSTREAM_KEY }
  const transport = egressHost === undefined ? (target.protocol === 'https:' ? https : http) : http
  const options = egressHost === undefined
    ? {
        host: target.hostname,
        port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        agent: false,
      }
    : {
        host: egressHost,
        port: egressPort,
        method: req.method,
        // Through a forward proxy the request line carries the absolute URI.
        path: target.href,
        headers,
        agent: false,
      }

  const upstream = transport.request(options, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers)
    let captured = ''
    response.on('data', (chunk) => {
      if (captured.length < CAPTURE_LIMIT) captured += chunk.toString('utf8')
    })
    response.on('end', () => {
      const usage = usageOf(captured)
      chargeTokens(tenant, usage.inputTokens, usage.outputTokens)
      record({
        tenant,
        path: req.url,
        status: response.statusCode ?? 0,
        ms: Date.now() - started,
        ...usage,
      })
    })
    response.pipe(res)
  })

  // Long model streams are normal; this only stops a connection that never
  // produces anything at all.
  upstream.setTimeout(900_000, () => {
    upstream.destroy(new Error('upstream timeout'))
  })

  upstream.on('error', (error) => {
    record({ tenant, path: req.url, status: 502, ms: Date.now() - started, error: error.message })
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `model gateway upstream error: ${error.message}` },
      }))
    } else {
      res.destroy()
    }
  })

  req.pipe(upstream)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`mt-model-gateway listening on :${String(PORT)} -> ${UPSTREAM_BASE}` +
    (egressHost === undefined ? ' (direct)' : ` via egress proxy ${egressHost}:${String(egressPort)}`) +
    `, ${String(new Set(keys.values()).size)} tenant key(s)`)
})
