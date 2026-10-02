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
  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
    for (const tenant of registry.tenants ?? []) {
      if (typeof tenant?.modelKey === 'string' && tenant.modelKey !== '') map.set(tenant.modelKey, tenant.id)
    }
  } catch (error) {
    console.error(`mt-model-gateway: cannot read the registry, keeping the previous keys: ${error.message}`)
    return undefined
  }
  return map
}

let keys = loadKeys() ?? new Map()
fs.watchFile(REGISTRY, { interval: 2000 }, () => {
  const next = loadKeys()
  if (next !== undefined) keys = next
})

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
      record({
        tenant,
        path: req.url,
        status: response.statusCode ?? 0,
        ms: Date.now() - started,
        ...usageOf(captured),
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
