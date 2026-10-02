/**
 * Tenant egress proxy.
 *
 * Tenant containers sit on a bridge network. This host has `ip_forward = 0`, so
 * a container has no route off the machine at all — not even DNS to a public
 * resolver — while it *can* reach any port on the host. This proxy runs in the
 * host's network namespace (so it has the host's egress) and listens on a port
 * the host firewall does not open, which makes it reachable from the tenant
 * bridges and from nowhere else.
 *
 * It is also the tenant egress boundary: destinations inside private address
 * space are refused, so a tenant cannot use the proxy to pivot into the
 * internal network the containers otherwise cannot route to. An optional
 * allowlist narrows that further.
 *
 * @module mt/egress-proxy/server
 */

'use strict'

const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const fs = require('node:fs')
const dns = require('node:dns').promises

const PORT = Number(process.env.MT_EGRESS_PORT ?? 3128)
const BIND = process.env.MT_EGRESS_BIND ?? '0.0.0.0'
/** Optional comma-separated host suffixes; empty means "any public destination". */
const ALLOW = (process.env.MT_EGRESS_ALLOW ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter((entry) => entry !== '')

/**
 * Where the allowlist is kept when it is meant to be editable at runtime.
 *
 * The console changes this setting, and a console that had to recreate this
 * container to apply it would need Docker access it does not have — so the value
 * lives in a file and is re-read when it changes, the same way the model gateway
 * follows the tenant registry. Absent, the environment variable above is the
 * source and nothing is re-read.
 */
const ALLOW_FILE = process.env.MT_EGRESS_ALLOW_FILE ?? ''
let allow = ALLOW
let allowStamp = 0

/** Re-read the allowlist when the file behind it changed. */
function refreshAllow() {
  if (ALLOW_FILE === '') return
  let stat
  try {
    stat = fs.statSync(ALLOW_FILE)
  } catch {
    // No file yet: the environment value stands, which is what an operator who
    // never touched the setting expects.
    return
  }
  if (stat.mtimeMs === allowStamp) return
  allowStamp = stat.mtimeMs
  try {
    allow = fs.readFileSync(ALLOW_FILE, 'utf8')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== '')
    console.log(`mt-egress-proxy: allowlist reloaded (${String(allow.length)} entries)`)
  } catch (error) {
    console.error(`mt-egress-proxy: cannot read ${ALLOW_FILE}: ${error.message}`)
  }
}

/**
 * Whether one address belongs to private, loopback, link-local, or reserved space.
 * @param address - IPv4 or IPv6 literal.
 * @returns true when the proxy must refuse it.
 */
function isInternalAddress(address) {
  const family = net.isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a >= 224) return true
    return false
  }
  if (family === 6) {
    const lower = address.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true
    // IPv4-mapped addresses carry the same reachability as their IPv4 form.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower)
    if (mapped !== null) return isInternalAddress(mapped[1])
    return false
  }
  return true
}

/**
 * Decide whether one destination may be reached through this proxy.
 * @param host - destination hostname or literal.
 * @returns `{ ok: true }` or `{ ok: false, reason }`.
 */
async function judge(host) {
  const bare = host.replace(/^\[/u, '').replace(/\]$/u, '')
  refreshAllow()
  if (allow.length > 0 && !allow.some((entry) => bare.toLowerCase() === entry || bare.toLowerCase().endsWith(`.${entry}`))) {
    return { ok: false, reason: 'not-in-allowlist' }
  }
  let addresses
  try {
    addresses = net.isIP(bare) !== 0
      ? [bare]
      : (await dns.lookup(bare, { all: true })).map((entry) => entry.address)
  } catch (error) {
    return { ok: false, reason: `dns:${error.code ?? error.message}` }
  }
  if (addresses.length === 0) return { ok: false, reason: 'dns:empty' }
  const internal = addresses.find((address) => isInternalAddress(address))
  if (internal !== undefined) return { ok: false, reason: `internal-address:${internal}` }
  return { ok: true }
}

function deny(socket, reason) {
  console.log(`egress deny: ${reason}`)
  socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n` +
    `egress proxy refused this destination: ${reason}\n`)
}

const server = http.createServer()

// HTTPS and anything else tunneled: CONNECT host:port
server.on('connect', (req, clientSocket, head) => {
  const target = req.url ?? ''
  const at = target.lastIndexOf(':')
  const host = at === -1 ? target : target.slice(0, at)
  const port = at === -1 ? '443' : target.slice(at + 1)

  judge(host).then((verdict) => {
    if (!verdict.ok) {
      deny(clientSocket, verdict.reason)
      return
    }
    const upstream = net.connect(Number(port), host, () => {
      console.log(`egress tunnel: ${host}:${port}`)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    const close = () => { clientSocket.destroy(); upstream.destroy() }
    upstream.on('error', close)
    clientSocket.on('error', close)
    clientSocket.on('close', close)
    upstream.on('close', close)
  }).catch(() => { deny(clientSocket, 'judge-failed') })
})

// Plain HTTP through the proxy: an absolute request URI. An `https:` URI is
// forwarded with TLS to the origin, which is what lets a bridge-network service
// (the model gateway) reach the internet without a CONNECT tunnel of its own.
server.on('request', (req, res) => {
  let target
  try {
    target = new URL(req.url ?? '')
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('egress proxy expects an absolute request URI\n')
    return
  }
  judge(target.hostname).then((verdict) => {
    if (!verdict.ok) {
      console.log(`egress deny: ${target.hostname} (${verdict.reason})`)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`egress proxy refused this destination: ${verdict.reason}\n`)
      return
    }
    const secure = target.protocol === 'https:'
    console.log(`egress ${secure ? 'https' : 'http'}: ${target.hostname}${target.pathname}`)
    const transport = secure ? https : http
    const upstream = transport.request({
      host: target.hostname,
      port: target.port === '' ? (secure ? 443 : 80) : Number(target.port),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...req.headers, host: target.host },
      agent: false,
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`egress proxy upstream error: ${error.message}\n`)
    })
    req.pipe(upstream)
  }).catch(() => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('egress proxy judge failed\n')
  })
})

server.listen(PORT, BIND, () => {
  console.log(`egress proxy listening on ${BIND}:${String(PORT)}` +
    (ALLOW.length === 0 ? ' (any public destination)' : ` (allowlist: ${ALLOW.join(', ')})`))
})
