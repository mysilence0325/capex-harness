/**
 * DSH multi-tenant control plane.
 *
 * Serves one public entry for every tenant: login, session, tenant routing,
 * DSH browser-cookie activation, and an HTTP + WebSocket reverse proxy to the
 * tenant's isolated runtime container.
 *
 * Why a dedicated activation step exists: DSH mints its browser cookie only on
 * `GET /?token=<per-process launch token>`, and the cookie is bound to the Host
 * authority it was minted for. This gateway proxies every tenant request with
 * `Host: 127.0.0.1:<tenant port>`, so each tenant has its own authority (and
 * therefore its own cookie name) while the browser keeps using one origin.
 *
 * @module mt/gateway/server
 */

'use strict'

const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Throttle } = require('./throttle.js')
const { appendRotated } = require('./rotate.js')
const {
  AdminConsole, hashPassword, verifyPassword, ID_PATTERN, USER_PATTERN,
  COOKIE: ADMIN_COOKIE, MAX_FAILURES, LOCKOUT_MS, SESSION_MS,
} = require('./admin.js')
// Aliased: this file already has a loginPage, the tenant sign-in page.
const { loginPage: adminLoginPage, consolePage: adminConsolePage, statusTag } = require('./admin-page.js')

const CONFIG_FILE = process.env.MT_TENANTS_FILE ?? '/config/tenants.json'
const STATE_DIR = process.env.MT_STATE_DIR ?? '/state'
const LOG_DIR = process.env.MT_LOG_DIR ?? '/logs'
/**
 * Read a port from the environment, refusing anything that is not one.
 *
 * A compose interpolation that did not happen arrives here as literal text, and
 * `server.listen(NaN)` reports a range error far from its cause.
 *
 * @param name - environment variable name.
 * @param fallback - port to use when the variable is unset.
 * @returns a usable port number.
 */
function envPort(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`mt-gateway: ${name} is not a port number: ${JSON.stringify(raw)}`)
    process.exit(1)
  }
  return port
}

const EDGE_PORT = envPort('MT_EDGE_PORT', 8090)
/**
 * Whether to open one listener per tenant's dedicated entry port.
 *
 * On by default. `MT_EDGE_LISTEN=0` serves the shared entry only, which is what
 * a standby control plane needs: it shares a host with the instance it stands in
 * for, so every dedicated port is already taken.
 */
const EDGE_LISTEN = (process.env.MT_EDGE_LISTEN ?? '1') !== '0'
const BIND_ADDRESS = process.env.MT_BIND_IP ?? '0.0.0.0'
const SESSION_TTL_MS = Number(process.env.MT_SESSION_TTL_HOURS ?? 12) * 3_600_000
const SESSION_COOKIE = 'mt_session'
const PREFIX = '/__mt'

/**
 * TLS material for the public listeners.
 *
 * Both files must exist; `bin/make-cert.sh` writes a self-signed pair, and a
 * deployment with its own CA only has to replace the two files. Without them the
 * public ports stay plain HTTP, which keeps an unconfigured stack working.
 */
const TLS_OPTIONS = (() => {
  const cert = process.env.MT_TLS_CERT
  const key = process.env.MT_TLS_KEY
  if (cert === undefined || key === undefined) return undefined
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    console.error(`mt-gateway: TLS certificate or key missing (${cert}, ${key}); serving plain HTTP`)
    return undefined
  }
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) }
})()

/**
 * Loopback-only plain-HTTP port for operations.
 *
 * With TLS on, the public ports speak HTTPS, so the scripts that run on this
 * machine (health, smoke, acceptance, model checks) need an unencrypted local
 * entry that no browser ever uses.
 */
const OPS_PORT = TLS_OPTIONS === undefined ? undefined : envPort('MT_HTTP_PORT', 8099)

/**
 * Read the tenant registry.
 *
 * The file is rewritten in place by bin/registry.js (write, not rename), so a
 * bind-mounted copy inside this container stays the same inode and the watcher
 * below sees every change.
 *
 * @returns the registry keyed by tenant id.
 */
function loadRegistry() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  const loaded = new Map()
  for (const tenant of config.tenants ?? []) {
    if (typeof tenant?.id !== 'string' || !Number.isInteger(tenant?.internalPort)) {
      throw new Error(`tenant entry needs an id and an internalPort: ${JSON.stringify(tenant?.id)}`)
    }
    loaded.set(tenant.id, tenant)
  }
  return loaded
}

/** Current registry. Replaced as a whole on reload, never mutated in place. */
let tenants = loadRegistry()

/**
 * Read the registry document as it is on disk.
 * @returns the parsed tenants.json (the whole file, not the id-keyed map).
 */
function loadRegistryFile() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
}

fs.mkdirSync(STATE_DIR, { recursive: true })
fs.mkdirSync(LOG_DIR, { recursive: true })

/** Signing key for gateway session cookies; persisted so restarts keep sessions. */
const sessionSecret = (() => {
  const file = path.join(STATE_DIR, 'session.key')
  if (fs.existsSync(file)) return fs.readFileSync(file)
  const created = crypto.randomBytes(32)
  fs.writeFileSync(file, created, { mode: 0o600 })
  return created
})()

/**
 * Shared key that authorizes a runtime registration.
 *
 * A node posts its tenants' endpoints and launch tokens here; without this key
 * any container that can reach the gateway could claim a tenant and intercept
 * its traffic.
 */
const registryKey = (() => {
  const file = path.join(STATE_DIR, 'registry.key')
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing !== '') return existing
    console.error(`mt-gateway: ${file} is empty; regenerating it`)
  }
  const created = crypto.randomBytes(32).toString('base64url')
  fs.writeFileSync(file, `${created}\n`, { mode: 0o600 })
  return created
})()

/** Runtime endpoints and launch tokens, keyed by tenant id. */
const RUNTIMES_FILE = path.join(STATE_DIR, 'runtimes.json')

/**
 * Read the runtime table.
 *
 * The gateway no longer inspects containers: it proxies to whatever a node
 * registered, which is what lets the control plane and the runtimes live on
 * different machines.
 *
 * @returns the table, empty when nothing has registered yet.
 */
function loadRuntimes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIMES_FILE, 'utf8'))
    return new Map(Object.entries(parsed.runtimes ?? {}))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`mt-gateway: cannot read the runtime table: ${error.message}`)
    }
    return new Map()
  }
}

let runtimes = loadRuntimes()

/**
 * Persist the runtime table.
 *
 * Written to a temporary file and renamed: a reader must never see a truncated
 * table, and a truncated table means every tenant looks unregistered after a
 * restart. Nothing watches this inode (unlike the bind-mounted tenants.json), so
 * the rename is safe here.
 */
function saveRuntimes() {
  const body = JSON.stringify({
    runtimes: Object.fromEntries([...runtimes].sort(([left], [right]) => left.localeCompare(right))),
  }, null, 2)
  const temporary = `${RUNTIMES_FILE}.tmp`
  fs.writeFileSync(temporary, `${body}\n`, { mode: 0o600 })
  fs.renameSync(temporary, RUNTIMES_FILE)
}


// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const base64url = (buffer) => Buffer.from(buffer).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/**
 * Cookie name DSH derives for one request authority.
 * @param authority - `host` or `host:port` DSH sees as the Host header.
 * @returns the exact cookie name DSH expects for that authority.
 */
function dshCookieName(authority) {
  return 'dsh-auth-' + base64url(crypto.createHash('sha256').update(authority).digest())
}

/**
 * Authority the tenant runtime sees as its Host header.
 *
 * A stable name per tenant rather than `127.0.0.1:<port>`: DSH derives its
 * cookie name from this string, so two runtimes that happened to use the same
 * loopback port on different hosts would otherwise share a cookie name. The
 * name also makes a runtime's location irrelevant to the browser session.
 *
 * Lower-cased deliberately: DSH normalizes the authority it sees (a Host header
 * is case-insensitive) before deriving the cookie name, so an id with capitals
 * would give the two sides different names.
 */
const tenantAuthority = (tenant) => `dsh-${String(tenant.id).toLowerCase()}.internal`

function parseCookies(header) {
  const out = new Map()
  if (!header) return out
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    out.set(segment.slice(0, at).trim(), segment.slice(at + 1).trim())
  }
  return out
}

function signSession(tenantId, user) {
  const payload = base64url(Buffer.from(JSON.stringify({
    t: tenantId,
    u: user,
    exp: Date.now() + SESSION_TTL_MS,
  }), 'utf8'))
  const signature = base64url(crypto.createHmac('sha256', sessionSecret).update(payload).digest())
  return `${payload}.${signature}`
}

function verifySession(value) {
  if (typeof value !== 'string') return undefined
  const [payload, signature] = value.split('.')
  if (!payload || !signature) return undefined
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest()
  const actual = Buffer.from(signature.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return undefined
  let decoded
  try {
    decoded = JSON.parse(Buffer.from(payload.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
  } catch {
    /* a malformed session cookie is simply not a session */
    return undefined
  }
  if (typeof decoded?.t !== 'string' || typeof decoded?.u !== 'string') return undefined
  if (typeof decoded.exp !== 'number' || decoded.exp < Date.now()) return undefined
  const tenant = tenants.get(decoded.t)
  if (tenant === undefined) return undefined
  return { tenant, user: decoded.u, expiresAt: decoded.exp }
}

/** Constant-time password check against the tenant's stored scrypt hash. */
function checkPassword(user, password) {
  const stored = user?.passwordHash
  if (typeof stored !== 'string') return false
  const [scheme, salt, digest] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !digest) return false
  const expected = Buffer.from(digest, 'hex')
  const actual = crypto.scryptSync(password, salt, expected.length)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

/** Resolve the tenant a request addresses, from its host or its dedicated edge port. */
function tenantByAddress(hostHeader, localPort) {
  const host = String(hostHeader ?? '').split(':')[0].toLowerCase()
  for (const tenant of tenants.values()) {
    if (tenant.edgePort !== undefined && tenant.edgePort === localPort) return tenant
    if (Array.isArray(tenant.hosts) && tenant.hosts.some((entry) => entry.toLowerCase() === host)) {
      return tenant
    }
  }
  return undefined
}

/**
 * Append one audit line.
 *
 * Rotated by size: this log carries per-tenant attribution, so it cannot go to
 * the container log, and Docker's own log options therefore do not bound it.
 */
function audit(entry) {
  appendRotated(path.join(LOG_DIR, 'access.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }))
}

/**
 * Registered runtime of one tenant.
 * @param tenant - tenant record.
 * @returns the entry, or undefined when the tenant has not registered.
 */
function runtimeOf(tenant) {
  return runtimes.get(tenant.id)
}

/**
 * Where to send one tenant's traffic.
 *
 * The gateway never inspects containers: a node registers an endpoint and the
 * gateway proxies to it, so the control plane and the runtimes can live on
 * different machines. The endpoint may carry a path — a node agent serves
 * `http://<node>:3199/proxy/<tenant>` — and that prefix has to be prepended to
 * every proxied request, or the request lands on the agent's root instead of the
 * tenant.
 *
 * A tenant that has not registered is a configuration state, not an outage, and
 * is reported as such.
 *
 * @param tenant - tenant record.
 * @returns the upstream host, port, and path prefix (empty when the endpoint has none).
 */
function tenantAddress(tenant) {
  const entry = runtimeOf(tenant)
  if (entry === undefined) {
    throw Object.assign(new Error(`tenant ${tenant.id} has not registered a runtime`), { code: 'MT_NOT_REGISTERED' })
  }
  let url
  try {
    url = new URL(entry.endpoint)
  } catch {
    throw Object.assign(new Error(`tenant ${tenant.id} registered an invalid endpoint: ${String(entry.endpoint)}`), { code: 'MT_BAD_ENDPOINT' })
  }
  return {
    host: url.hostname,
    port: Number(url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : url.port),
    prefix: url.pathname.replace(/\/+$/u, ''),
  }
}

// ---------------------------------------------------------------------------
// launch tokens
// ---------------------------------------------------------------------------

/**
 * Current launch token of a tenant runtime.
 *
 * The token is printed by the runtime at startup; the node that started the
 * container reads it and registers it here. The gateway cannot read it itself,
 * which is the point: it holds no Docker access.
 *
 * @param tenant - tenant record.
 * @returns the token, or undefined when the registration carries none yet.
 */
function tenantToken(tenant) {
  return runtimeOf(tenant)?.token
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

const PAGE_STYLE = `
  :root { color-scheme: light dark }
  body { font: 15px/1.6 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f6f7f9; color: #1b1d21 }
  main { width: min(92vw, 380px); background: #fff; padding: 32px; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.08) }
  h1 { font-size: 19px; margin: 0 0 4px }
  p.sub { margin: 0 0 22px; color: #6b7280; font-size: 13px }
  label { display: block; font-size: 13px; margin-bottom: 6px }
  input, select { width: 100%; box-sizing: border-box; padding: 9px 11px; margin-bottom: 16px; border: 1px solid #d5d8de; border-radius: 8px; font: inherit }
  button { width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #1b1d21; color: #fff; font: inherit; cursor: pointer }
  .err { background: #fdecec; color: #a11; padding: 9px 11px; border-radius: 8px; font-size: 13px; margin-bottom: 16px }
  ul { padding-left: 18px; color: #444; font-size: 13px }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e8eaee }
    main { background: #1e2126; box-shadow: none }
    input, select { background: #16181c; color: inherit; border-color: #333941 }
    button { background: #e8eaee; color: #16181c }
    .err { background: #3a1d1d; color: #ffb4b4 }
  }
`

function htmlPage(title, body) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${PAGE_STYLE}</style></head>
<body><main>${body}</main></body></html>`
}

function loginPage({ error } = {}) {
  return htmlPage('DSH 登录', `
    <h1>DeepSeek Harness</h1>
    <p class="sub">使用管理员分配的用户名登录</p>
    ${error ? `<div class="err">${error}</div>` : ''}
    <form method="post" action="${PREFIX}/login">
      <label for="user">用户名</label>
      <input id="user" name="user" autocomplete="username" autofocus>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password">
      <button type="submit">登录</button>
    </form>`)
}

/**
 * Render one error page.
 * @param status - HTTP status to show as the heading.
 * @param message - headline sentence.
 * @param detail - optional second line; may contain markup.
 * @returns the page HTML.
 */
function errorPage(status, message, detail = '') {
  const extra = detail === '' ? '' : `<p class="sub">${detail}</p>`
  return htmlPage(`DSH ${String(status)}`, `<h1>${String(status)}</h1><p class="sub">${message}</p>${extra}`)
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
}

/**
 * Add `Secure` to cookies when the request arrived over TLS.
 *
 * DSH decides its own cookie attributes and does not know it is behind a TLS
 * terminator, so the gateway is the only place that can mark the browser cookie
 * as HTTPS-only.
 *
 * @param value - one Set-Cookie value or a list of them.
 * @param overTls - whether the request that produced it arrived over TLS.
 * @returns the same value, with `Secure` present on every cookie.
 */
function secureCookies(value, overTls) {
  if (!overTls || value === undefined) return value
  const list = Array.isArray(value) ? value : [value]
  return list.map((cookie) => (/(^|;\s*)secure(;|$)/iu.test(cookie) ? cookie : `${cookie}; Secure`))
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/** Proxy one authenticated request to its tenant runtime with the loopback Host rewrite. */
async function proxyRequest(req, res, session) {
  const tenant = session.tenant
  const started = Date.now()
  const requestUrl = new URL(req.url ?? '/', 'http://gateway.invalid')
  const cookieName = dshCookieName(tenantAuthority(tenant))
  const presented = parseCookies(req.headers.cookie).get(cookieName)
  // `mt_refresh=1` means the previous attempt presented a cookie the tenant
  // refused: refresh it once, then give up rather than loop.
  const refreshing = requestUrl.searchParams.get('mt_refresh') === '1'

  let activation
  if (presented === undefined || refreshing) {
    try {
      activation = await activateTenant(tenant)
    } catch (error) {
      audit({ tenant: tenant.id, user: session.user, url: req.url, status: 502, error: error.message })
      send(res, 502, { 'content-type': 'text/plain; charset=utf-8' }, `activation failed: ${error.message}\n`)
      return
    }
  }

  const headers = { ...req.headers }
  headers.host = tenantAuthority(tenant)
  // DSH's fence compares an attached Origin's host against the Host header, so
  // rewriting one without the other makes every browser POST and every
  // WebSocket upgrade fail with 403 while curl (no Origin) succeeds. The scheme
  // is not compared, but keep it looking like the authority it now claims.
  if (headers.origin !== undefined) headers.origin = `http://${tenantAuthority(tenant)}`
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''
  headers['x-forwarded-proto'] = 'http'
  headers['x-mt-tenant'] = tenant.id
  headers['x-mt-user'] = session.user
  if (activation !== undefined) {
    headers.cookie = withCookie(req.headers.cookie, activation.name, activation.value)
  }

  let address
  try {
    address = tenantAddress(tenant)
  } catch (error) {
    audit({ tenant: tenant.id, user: session.user, method: req.method, url: req.url, status: 503, error: error.message })
    const unregistered = error.code === 'MT_NOT_REGISTERED'
    send(res, 503, { 'content-type': 'text/html; charset=utf-8' }, unregistered
      ? errorPage(503, `租户 ${tenant.id} 的运行时还没有注册。`,
        `在运行它的机器上执行 <code>bin/mt.sh register ${tenant.id}</code>，然后刷新本页。`)
      : errorPage(503, '租户运行时地址无效。', `${String(error.message)}`))
    return
  }

  const sendUpstream = () => {
    const upstream = http.request({
      host: address.host,
      port: address.port,
      method: req.method,
      // An endpoint may carry a path prefix (a node agent serves
      // /proxy/<tenant>); dropping it would send the request to the agent's root.
      path: `${address.prefix}${req.url}`,
      headers,
      // No upstream keep-alive: a pooled socket the tenant closes while idle
      // surfaces as ECONNRESET on the next request, which is noise for a proxy
      // that already opens one connection per client request.
      agent: false,
    }, (response) => {
      const status = response.statusCode ?? 502
      audit({ tenant: tenant.id, user: session.user, method: req.method, url: req.url, status, ms: Date.now() - started })

      if (status === 401) {
        response.resume()
        if (activation !== undefined) {
          // We just completed the exchange and the runtime still refused it.
          audit({ tenant: tenant.id, user: session.user, url: req.url, status: 503, note: 'activation-rejected' })
          send(res, 503, { 'content-type': 'text/html; charset=utf-8' },
            errorPage(503, '租户运行时拒绝了激活，可能仍在启动中。请稍后刷新重试。'))
          return
        }
        if (refreshing) {
          // One refresh already happened and the runtime refused again. The usual
          // cause is a launch token from a previous run: DSH mints a new one on
          // every start, so the registration has to be refreshed too. Report it
          // instead of redirecting again, which would loop forever.
          audit({ tenant: tenant.id, user: session.user, url: req.url, status: 503, note: 'refresh-rejected' })
          send(res, 503, { 'content-type': 'text/html; charset=utf-8' },
            errorPage(503, `租户 ${tenant.id} 拒绝了本次访问。`,
              '运行时的启动 token 可能已过期（它每次启动都会变）。在运行它的机器上执行 ' +
              `<code>bin/mt.sh register ${tenant.id}</code> 重新注册，然后刷新本页。`))
          return
        }
        // The browser held a cookie this runtime no longer accepts: force one
        // refresh, then fail instead of looping.
        audit({ tenant: tenant.id, user: session.user, url: req.url, status: 303, note: 'refresh-cookie' })
        const target = new URL(req.url ?? '/', 'http://gateway.invalid')
        target.searchParams.set('mt_refresh', '1')
        send(res, 303, { location: `${target.pathname}${target.search}`, 'cache-control': 'no-store' }, '')
        return
      }

      const responseHeaders = { ...response.headers }
      const existing = responseHeaders['set-cookie']
      const delivered = activation === undefined
        ? existing
        : (existing === undefined
          ? [activation.setCookie]
          : [...(Array.isArray(existing) ? existing : [existing]), activation.setCookie])
      if (delivered !== undefined) {
        responseHeaders['set-cookie'] = secureCookies(delivered, req.socket.encrypted === true)
      }
      res.writeHead(status, responseHeaders)
      response.pipe(res)
    })

    upstream.on('error', (error) => {
      // The endpoint comes from the runtime table, so a failure here means the
      // registered runtime is not answering — most often because its container
      // was recreated and the node has not re-registered the new address yet.
      audit({ tenant: tenant.id, user: session.user, method: req.method, url: req.url, status: 502, ms: Date.now() - started, error: error.message })
      if (!res.headersSent) {
        send(res, 502, { 'content-type': 'text/plain; charset=utf-8' },
          `tenant runtime unreachable at ${address.host}:${String(address.port)}: ${error.message}\n` +
          `check the registration with bin/mt.sh runtimes\n`)
      } else {
        res.destroy()
      }
    })

    req.pipe(upstream)
  }

  sendUpstream()
}

/** Replace or append one cookie in a Cookie header value. */
function withCookie(header, name, value) {
  const kept = []
  for (const segment of String(header ?? '').split(';')) {
    const trimmed = segment.trim()
    if (trimmed === '' || trimmed.startsWith(`${name}=`)) continue
    kept.push(trimmed)
  }
  kept.push(`${name}=${value}`)
  return kept.join('; ')
}

/** One small buffered GET against a tenant runtime. */
function tenantRequest(tenant, address, path) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: address.host,
      port: address.port,
      method: 'GET',
      path: `${address.prefix}${path}`,
      headers: { host: tenantAuthority(tenant) },
      agent: false,
      timeout: 10_000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers }) })
    })
    request.on('timeout', () => { request.destroy(new Error('tenant activation timed out')) })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Complete DSH's launch-token exchange from inside the gateway.
 *
 * DSH mints its browser cookie only on `GET /?token=...`. Doing that exchange
 * here means the browser never has to follow a redirect: the cookie the tenant
 * returns is handed to the browser on the response to its own request. That
 * keeps login working for every HTTP client, not just ones with generous
 * redirect handling.
 *
 * @param tenant - tenant record.
 * @returns the tenant's `Set-Cookie` value and its `name=value` pair, or undefined.
 */
async function activateTenant(tenant) {
  const token = tenantToken(tenant)
  if (token === undefined) return undefined
  const address = tenantAddress(tenant)
  const response = await tenantRequest(tenant, address, `/?token=${encodeURIComponent(token)}`)
  const raw = response.headers['set-cookie']
  const setCookie = Array.isArray(raw) ? raw[0] : raw
  if (typeof setCookie !== 'string' || setCookie === '') return undefined
  const pair = setCookie.split(';')[0]
  const at = pair.indexOf('=')
  if (at === -1) return undefined
  return { setCookie, name: pair.slice(0, at), value: pair.slice(at + 1) }
}

/**
 * Decide which tenant a login belongs to.
 *
 * The form asks for a username only. The tenant comes from, in order: an
 * explicit `tenant` field (kept for scripts and old bookmarks), the address the
 * request arrived on (a dedicated edge port or hostname), or the single tenant
 * that owns the username.
 *
 * @param user - submitted username.
 * @param explicit - submitted `tenant` field, when present.
 * @param hinted - tenant implied by the request address, when any.
 * @returns the tenant and account, or an error message for the form.
 */
function resolveLogin(user, explicit, hinted) {
  const owner = (tenant) => (tenant?.users ?? []).find((entry) => entry.name === user)
  if (explicit !== undefined && explicit !== '') {
    const tenant = tenants.get(explicit)
    const account = owner(tenant)
    if (tenant === undefined || account === undefined) return { error: '用户名或密码不正确' }
    return { tenant, account }
  }
  if (hinted !== undefined) {
    const account = owner(hinted)
    if (account === undefined) {
      return { error: `用户名或密码不正确（此入口属于 ${hinted.id}）` }
    }
    return { tenant: hinted, account }
  }
  const matches = [...tenants.values()].filter((tenant) => owner(tenant) !== undefined)
  if (matches.length === 0) return { error: '用户名或密码不正确' }
  if (matches.length > 1) {
    // Ambiguous only when the same username exists in several tenants; those
    // tenants each have a dedicated entry that resolves it.
    return { error: `用户名 ${user} 在多个租户下存在，请改用该租户的专属入口登录` }
  }
  return { tenant: matches[0], account: owner(matches[0]) }
}

/**
 * Sign-in budgets for the tenant page.
 *
 * The account budget is the tight one: five wrong passwords for one username
 * anywhere starts a five minute refusal. The source budget is deliberately
 * looser, because a whole office can share one address and one mistyped password
 * should not lock out everyone behind it.
 */
const loginByUser = new Throttle({ name: 'login-account', maxFailures: 5, lockoutMs: 5 * 60 * 1000 })
const loginBySource = new Throttle({ name: 'login-source', maxFailures: 20, lockoutMs: 10 * 60 * 1000 })

function handleLogin(req, res) {
  readBody(req).then((body) => {
    const params = new URLSearchParams(body)
    const user = params.get('user') ?? ''
    const password = params.get('password') ?? ''
    const source = req.socket.remoteAddress ?? 'unknown'
    // Two budgets, because they stop different attacks: per account stops
    // guessing one password from anywhere, per source stops spraying many
    // accounts from one place. The source budget is the looser of the two so that
    // one careless user behind a shared address does not lock out their
    // colleagues.
    const locked = Math.max(loginByUser.retryAfter(user.toLowerCase()), loginBySource.retryAfter(source))
    if (locked > 0) {
      audit({ tenant: '-', user, status: 429, note: 'login-throttled', source })
      send(res, 429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': String(locked) },
        loginPage({ error: `尝试次数过多，请 ${String(locked)} 秒后再试` }))
      return
    }
    const resolved = resolveLogin(
      user,
      params.get('tenant') ?? undefined,
      tenantByAddress(req.headers.host, req.socket.localPort),
    )
    if (resolved.error !== undefined || !checkPassword(resolved.account, password)) {
      const userLock = loginByUser.fail(user.toLowerCase())
      const sourceLock = loginBySource.fail(source)
      audit({
        tenant: resolved.tenant?.id ?? '-', user, status: 401, note: 'login-failed', source,
        ...(userLock > 0 ? { lockedAccountSeconds: userLock } : {}),
        ...(sourceLock > 0 ? { lockedSourceSeconds: sourceLock } : {}),
      })
      send(res, 401, { 'content-type': 'text/html; charset=utf-8' }, loginPage({ error: '用户名或密码不正确' }))
      return
    }
    loginByUser.succeed(user.toLowerCase())
    loginBySource.succeed(source)
    audit({ tenant: resolved.tenant.id, user, status: 200, note: 'login-ok' })
    send(res, 303, {
      location: '/',
      'set-cookie': secureCookies(
        `${SESSION_COOKIE}=${signSession(resolved.tenant.id, user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(SESSION_TTL_MS / 1000))}`,
        req.socket.encrypted === true,
      ),
      'cache-control': 'no-store',
    }, '')
  }).catch(() => {
    send(res, 400, { 'content-type': 'text/html; charset=utf-8' }, loginPage({ error: '请求格式不正确' }))
  })
}

function handleHealth(req, res) {
  Promise.all([...tenants.values()].map(async (tenant) => {
    const entry = runtimeOf(tenant)
    if (entry === undefined) {
      return { id: tenant.id, registered: false, hasToken: false, ready: false }
    }
    // A registration without a launch token cannot complete an activation, so
    // reporting it ready would send the operator looking in the wrong place: the
    // first login gets the 401 → refresh → 503 page instead.
    const hasToken = typeof entry.token === 'string' && entry.token !== ''
    let reachable = false
    try {
      // A runtime answers 401 without its cookie, which is proof enough that it
      // is listening. The endpoint comes from the node's registration.
      const address = tenantAddress(tenant)
      const response = await tenantRequest(tenant, address, '/')
      reachable = response.status > 0
    } catch {
      reachable = false
    }
    return {
      id: tenant.id,
      node: entry.node ?? 'local',
      endpoint: entry.endpoint,
      registered: true,
      reachable,
      hasToken,
      ready: reachable && hasToken,
      registeredAt: entry.registeredAt,
    }
  })).then((rows) => {
    send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({
      tenants: rows,
      users: [...tenants.values()].flatMap((tenant) => (tenant.users ?? []).map((user) => `${tenant.id}/${user.name}`)),
    }, null, 2))
  })
}

/**
 * Accept one node's registration of a tenant runtime.
 *
 * This is the only way the gateway learns where a tenant runs, which is what
 * lets the control plane and the runtimes live on different machines. The body
 * carries the endpoint the gateway should proxy to and the launch token the
 * runtime printed; the caller is authenticated by the shared registry key, so a
 * container that can reach the gateway cannot claim a tenant.
 *
 * @param req - HTTP request carrying the JSON body.
 * @param res - HTTP response.
 */
function handleRegister(req, res) {
  const presented = req.headers['x-mt-registry-key']
  // An empty configured key must never authenticate: timingSafeEqual over two
  // empty buffers is true, which would let anyone who can reach the port claim a
  // tenant.
  if (registryKey === '' || typeof presented !== 'string' || !timingSafeEqualString(presented, registryKey)) {
    audit({ tenant: '-', user: '-', status: 401, note: 'registry-key-rejected', url: req.url })
    send(res, 401, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: 'bad registry key' }))
    return
  }
  readJsonBody(req, (error, body) => {
    if (error !== undefined) {
      send(res, 400, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: error.message }))
      return
    }
    const action = new URL(req.url ?? '/', 'http://gateway.invalid').pathname.endsWith('/unregister') ? 'unregister' : 'register'
    const id = typeof body?.tenant === 'string' ? body.tenant : ''
    if (!tenants.has(id)) {
      send(res, 404, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: `no such tenant: ${id}` }))
      return
    }
    // 拒绝指向自己的 endpoint：网关是 host 网络，代理到自己会让请求无限套娃。
    const ownAuthorities = new Set([`127.0.0.1:${String(EDGE_PORT)}`, `localhost:${String(EDGE_PORT)}`])
    if (OPS_PORT !== undefined) {
      ownAuthorities.add(`127.0.0.1:${String(OPS_PORT)}`)
      ownAuthorities.add(`localhost:${String(OPS_PORT)}`)
    }
    if (action === 'unregister') {
      runtimes.delete(id)
      saveRuntimes()
      audit({ tenant: id, user: '-', status: 200, note: 'runtime-unregistered', node: body?.node })
      console.log(`mt-gateway: runtime unregistered: ${id}`)
      send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: true, tenant: id }))
      return
    }
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
    let parsed
    try {
      parsed = new URL(endpoint)
    } catch {
      send(res, 400, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: `endpoint must be an http(s) URL: ${JSON.stringify(endpoint)}` }))
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      send(res, 400, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: `unsupported endpoint scheme: ${parsed.protocol}` }))
      return
    }
    if (ownAuthorities.has(parsed.host)) {
      // The gateway runs in the host network namespace, so an endpoint naming its
      // own port would make it proxy to itself: the loopback session cookie would
      // validate again and the request would recurse.
      send(res, 400, { 'content-type': 'application/json; charset=utf-8' },
        JSON.stringify({ ok: false, error: `endpoint must not point back at the gateway itself: ${parsed.host}` }))
      return
    }
    const previous = runtimes.get(id)
    const endpointChanged = previous !== undefined && previous.endpoint !== endpoint
    const token = typeof body?.token === 'string' ? body.token : ''
    if (token === '' && (previous === undefined || endpointChanged)) {
      // Registering a runtime with no launch token is not usable, and carrying
      // one across an endpoint change would hand the new endpoint a live token
      // for the tenant it just claimed.
      send(res, 400, { 'content-type': 'application/json; charset=utf-8' },
        JSON.stringify({ ok: false, error: 'registration needs a launch token (the runtime may still be starting)' }))
      return
    }
    runtimes.set(id, {
      endpoint,
      token: token === '' ? previous.token : token,
      node: typeof body?.node === 'string' && body.node !== '' ? body.node : 'local',
      authority: tenantAuthority(tenants.get(id)),
      // Where the console sends lifecycle actions. Omitted rather than kept when
      // a registration carries none: a later registration by hand must not leave
      // a stale agent address behind, or the console would try to restart a
      // container through an agent that no longer reports this tenant.
      ...(typeof body?.agent === 'string' && body.agent !== '' ? { agent: body.agent } : {}),
      registeredAt: new Date().toISOString(),
    })
    saveRuntimes()
    audit({ tenant: id, user: '-', status: 200, note: previous === undefined ? 'runtime-registered' : 'runtime-updated', node: runtimes.get(id).node, endpoint })
    console.log(`mt-gateway: runtime ${previous === undefined ? 'registered' : 'updated'}: ${id} -> ${endpoint}`)
    send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: true, tenant: id, endpoint }))
  })
}

/**
 * Constant-time comparison of two strings of possibly different lengths.
 * @param left - presented value.
 * @param right - expected value.
 * @returns whether they are equal.
 */
function timingSafeEqualString(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Read and parse a small JSON request body.
 * @param req - HTTP request.
 * @param done - called with an error, or with the parsed body.
 */
function readJsonBody(req, done) {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > 65_536) {
      req.destroy()
      done(new Error('body too large'))
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try {
      done(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
    } catch (error) {
      done(new Error(`body is not JSON: ${error.message}`))
    }
  })
  req.on('error', (error) => { done(error) })
}

/**
 * Administrator console state.
 *
 * Held here rather than inside the handler so the sign-in throttle and the
 * session secret live as long as the process does.
 */
const admin = new AdminConsole({
  registryFile: CONFIG_FILE,
  stateDir: STATE_DIR,
  logDir: LOG_DIR,
  registryKey,
})

/** Read a form-encoded body. */
function readForm(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })
}

/**
 * Whether a mutation may be trusted as this console's own page.
 *
 * The session cookie is already SameSite=Strict, which keeps a cross-site form
 * from carrying it; this is the second lock, matching the tenant path's fence:
 * when the browser states an Origin it must be the authority the request arrived
 * on.
 *
 * @param req - the request.
 * @returns whether the request is same-origin.
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** Parse the console cookie value. */
function adminCookie(req) {
  return parseCookies(req.headers.cookie).get(ADMIN_COOKIE)
}

/** Set or clear the console cookie. */
function adminCookieHeader(value, encrypted, maxAgeSeconds) {
  const attributes = [
    `${ADMIN_COOKIE}=${value}`,
    `Path=${PREFIX}/admin`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(maxAgeSeconds)}`,
  ]
  if (encrypted) attributes.push('Secure')
  return attributes.join('; ')
}

/**
 * Build the tenant table the console renders.
 *
 * Status is probed now rather than cached: an administrator looking at this page
 * wants to know whether the runtime answers at this moment.
 *
 * @returns one entry per tenant in the registry.
 */
async function adminState() {
  const usage = admin.usageByTenant()
  const rows = await Promise.all([...tenants.values()].map(async (tenant) => {
    const entry = runtimeOf(tenant)
    let reachable = false
    let hasToken = false
    if (entry !== undefined) {
      hasToken = typeof entry.token === 'string' && entry.token !== ''
      try {
        const response = await tenantRequest(tenant, tenantAddress(tenant), '/')
        reachable = response.status > 0
      } catch {
        reachable = false
      }
    }
    const probe = entry === undefined ? undefined : { ready: reachable && hasToken, reachable, hasToken }
    return {
      id: tenant.id,
      title: tenant.title ?? '',
      users: (tenant.users ?? []).map((user) => user.name),
      node: entry?.node ?? tenant.node ?? 'local',
      edgePort: tenant.edgePort,
      hosts: tenant.hosts ?? [],
      agent: typeof entry?.agent === 'string' ? entry.agent : undefined,
      status: statusTag(probe),
      usage: usage.get(tenant.id) ?? { calls: 0, input: 0, output: 0, cacheRead: 0 },
    }
  }))
  rows.sort((left, right) => left.id.localeCompare(right.id))
  const origin = EDGE_ORIGIN === undefined ? '' : EDGE_ORIGIN
  return { tenants: rows, edgePort: EDGE_PORT, origin }
}

/** The address a browser used to reach the console, for display only. */
let EDGE_ORIGIN

/**
 * One console action.
 *
 * Registry edits happen here; anything that changes a container is forwarded to
 * the node agent that registered that tenant, because this process has no Docker
 * access at all.
 *
 * @param body - the parsed request body.
 * @returns an answer the page renders.
 */
async function adminAction(body) {
  const action = typeof body?.action === 'string' ? body.action : ''
  const id = typeof body?.tenant === 'string' ? body.tenant : ''

  if (action === 'add') {
    if (!ID_PATTERN.test(id)) return { ok: false, error: '租户 id 只能用小写字母、数字和短横线，且以字母开头' }
    const user = typeof body?.user === 'string' ? body.user : ''
    if (!USER_PATTERN.test(user)) return { ok: false, error: '用户名只能包含字母、数字、点、下划线和短横线' }
    const document = admin.readRegistry()
    if ((document.tenants ?? []).some((tenant) => tenant.id === id)) return { ok: false, error: `租户 ${id} 已存在` }
    const internalPorts = (document.tenants ?? []).map((tenant) => tenant.internalPort).filter(Number.isInteger)
    const edgePorts = (document.tenants ?? []).map((tenant) => tenant.edgePort).filter(Number.isInteger)
    const password = crypto.randomBytes(9).toString('base64url')
    const tenantNode = typeof body?.node === 'string' && body.node !== '' ? body.node : 'local'
    document.tenants = [...(document.tenants ?? []), {
      id,
      title: typeof body?.title === 'string' && body.title !== '' ? body.title : id,
      node: tenantNode,
      internalPort: internalPorts.length === 0 ? 3181 : Math.max(...internalPorts) + 1,
      service: `dsh-${id}`,
      container: `mt-dsh-${id}`,
      hosts: [`${id}.dsh.local`],
      users: [{ name: user, passwordHash: hashPassword(password) }],
      modelKey: `sk-mt-${id}-${crypto.randomBytes(18).toString('base64url')}`,
      limits: { memory: '2g', cpus: '1.5', pids: 512 },
      edgePort: edgePorts.length === 0 ? 8091 : Math.max(...edgePorts) + 1,
    }]
    admin.writeRegistry(document)
    admin.audit({ action: 'add', tenant: id, user, node: tenantNode, result: 'registry-written' })
    // The container comes from the node that will run it. Any agent on that node
    // will do: they all render from the same registry.
    const agent = await agentForNode(tenantNode)
    if (agent === undefined) {
      return {
        ok: true,
        password,
        message: `已写入注册表，但没有找到 ${tenantNode} 节点的代理，容器未创建。在该节点执行 bin/mt.sh up 即可开通。初始密码：${password}`,
      }
    }
    const answer = await admin.callProvision(agent)
    admin.audit({ action: 'provision', tenant: id, node: tenantNode, agent, status: answer.status })
    if (answer.body?.ok !== true) {
      return { ok: false, password, error: `注册表已写入，但节点开通失败：${String(answer.body?.error ?? answer.body?.tail ?? answer.status).slice(0, 300)}` }
    }
    return { ok: true, password, message: `租户 ${id} 已创建并开通` }
  }

  const document = admin.readRegistry()
  const tenant = (document.tenants ?? []).find((entry) => entry.id === id)
  if (tenant === undefined) return { ok: false, error: `没有租户 ${id}` }

  if (action === 'passwd') {
    const user = typeof body?.user === 'string' ? body.user : ''
    const target = (tenant.users ?? []).find((entry) => entry.name === user)
    if (target === undefined) return { ok: false, error: `租户 ${id} 没有用户 ${user}` }
    const password = crypto.randomBytes(9).toString('base64url')
    target.passwordHash = hashPassword(password)
    admin.writeRegistry(document)
    admin.audit({ action: 'passwd', tenant: id, user, result: 'registry-written' })
    return { ok: true, password, message: `${id}/${user} 的密码已重置` }
  }

  if (action === 'remove') {
    const purge = body?.purge === true
    const entry = runtimeOf(tenant)
    if (entry !== undefined && typeof entry.agent === 'string') {
      const answer = await admin.callAgent(entry.agent, id, 'remove', { purge })
      admin.audit({ action: 'remove', tenant: id, agent: entry.agent, purge, status: answer.status })
      if (answer.body?.ok !== true) return { ok: false, error: `节点拒绝删除：${String(answer.body?.error ?? answer.status)}` }
    }
    document.tenants = (document.tenants ?? []).filter((entry2) => entry2.id !== id)
    admin.writeRegistry(document)
    admin.audit({ action: 'remove', tenant: id, result: 'registry-written', purge })
    return { ok: true, message: `已删除 ${id}${purge ? '（含数据）' : '（数据保留在磁盘上）'}` }
  }

  if (['start', 'stop', 'restart'].includes(action)) {
    const entry = runtimeOf(tenant)
    if (entry === undefined || typeof entry.agent !== 'string') {
      return { ok: false, error: `租户 ${id} 不是通过节点代理注册的，无法在这里操作容器。请在它的节点上执行 bin/mt.sh ${action} ${id}` }
    }
    const answer = await admin.callAgent(entry.agent, id, action, undefined)
    admin.audit({ action, tenant: id, agent: entry.agent, status: answer.status })
    if (answer.body?.ok !== true) {
      return { ok: false, error: `节点返回：${String(answer.body?.error ?? answer.body?.tail ?? answer.status).slice(0, 300)}` }
    }
    return { ok: true, message: `${id} 已${action === 'stop' ? '停止' : action === 'start' ? '启动' : '重启'}` }
  }

  return { ok: false, error: `未知操作：${action}` }
}

/**
 * Any agent on one node.
 * @param node - node name.
 * @returns the agent base URL, or undefined when no tenant there registered one.
 */
async function agentForNode(node) {
  for (const tenant of tenants.values()) {
    const entry = runtimeOf(tenant)
    if (entry === undefined || typeof entry.agent !== 'string') continue
    if ((entry.node ?? 'local') === node) return entry.agent
  }
  return undefined
}

/**
 * Serve the administrator console.
 *
 * @param req - the request.
 * @param res - the response.
 * @param url - the parsed request URL.
 * @returns nothing; the response is ended here.
 */
async function handleAdmin(req, res, url) {
  const encrypted = req.socket.encrypted === true
  const path = url.pathname.slice(`${PREFIX}/admin`.length)
  const remote = req.socket.remoteAddress ?? 'unknown'
  const session = admin.verifySession(adminCookie(req))

  if (path === '' || path === '/') {
    if (session === undefined) {
      send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        adminLoginPage({ configured: admin.hasAdmin() }))
      return
    }
    send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      adminConsolePage({ user: session }))
    return
  }

  if (path === '/login' && req.method === 'POST') {
    const locked = admin.lockedFor(remote)
    if (locked > 0) {
      admin.audit({ action: 'login', tenant: '-', user: '-', result: 'throttled', source: remote })
      send(res, 429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        adminLoginPage({ locked, configured: admin.hasAdmin() }))
      return
    }
    const form = await readForm(req).catch(() => new URLSearchParams())
    const stored = admin.readAdmin()
    const ok = stored !== undefined
      && String(form.get('user') ?? '') === stored.user
      && verifyPassword(String(form.get('password') ?? ''), stored.passwordHash)
    if (!ok) {
      const bucket = admin.bucketFor(remote)
      bucket.count += 1
      if (bucket.count >= MAX_FAILURES) {
        bucket.until = Date.now() + LOCKOUT_MS
        bucket.count = 0
      }
      admin.audit({ action: 'login', tenant: '-', user: String(form.get('user') ?? ''), result: 'rejected', source: remote })
      send(res, 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        adminLoginPage({ error: '用户名或密码不正确', configured: admin.hasAdmin() }))
      return
    }
    admin.bucketFor(remote).count = 0
    admin.audit({ action: 'login', tenant: '-', user: stored.user, result: 'ok', source: remote })
    send(res, 303, {
      location: `${PREFIX}/admin`,
      'set-cookie': adminCookieHeader(admin.mintSession(), encrypted, Math.floor(SESSION_MS / 1000)),
      'cache-control': 'no-store',
    }, '')
    return
  }

  if (path === '/logout' && req.method === 'POST') {
    send(res, 303, {
      location: `${PREFIX}/admin`,
      'set-cookie': adminCookieHeader('', encrypted, 0),
      'cache-control': 'no-store',
    }, '')
    return
  }

  if (session === undefined) {
    send(res, 401, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: 'not signed in' }))
    return
  }

  if (path === '/api/state' && req.method === 'GET') {
    EDGE_ORIGIN = req.headers.host === undefined ? undefined : req.headers.host.split(':')[0]
    send(res, 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      JSON.stringify(await adminState()))
    return
  }

  if (path === '/api/tenant' && req.method === 'POST') {
    if (!sameOrigin(req)) {
      admin.audit({ action: 'mutation', tenant: '-', user: session, result: 'cross-origin', source: remote })
      send(res, 403, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: 'cross-origin request refused' }))
      return
    }
    const body = await admin.readJson(req).catch((error) => ({ __error: error.message }))
    if (body.__error !== undefined) {
      send(res, 400, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: body.__error }))
      return
    }
    const answer = await adminAction(body)
    send(res, answer.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      JSON.stringify(answer))
    return
  }

  send(res, 404, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: 'not found' }))
}

function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://gateway.invalid')
  const localPort = req.socket.localPort

  // The administrator console answers before the tenant session logic: it has its
  // own credential and must not be redirected into a tenant's sign-in page.
  if (url.pathname === `${PREFIX}/admin` || url.pathname.startsWith(`${PREFIX}/admin/`)) {
    handleAdmin(req, res, url).catch((error) => {
      console.error(`mt-gateway: admin console failed: ${error.message}`)
      if (!res.headersSent) send(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, 'admin console error\n')
    })
    return
  }

  // Operational endpoint: it enumerates tenants and usernames, so it answers
  // loopback callers only (bin/mt.sh status / smoke / accept all run locally).
  // Node-facing: a node reports where one tenant runtime is and which launch
  // token it printed. Key-authenticated, because claiming a tenant would let the
  // caller intercept that tenant's traffic.
  if (url.pathname === `${PREFIX}/registry/register` || url.pathname === `${PREFIX}/registry/unregister`) {
    if (req.method !== 'POST') {
      send(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' }, 'method not allowed\n')
      return
    }
    handleRegister(req, res)
    return
  }
  if (url.pathname === `${PREFIX}/registry/tenants`) {
    // A node pulls the registry here before provisioning its tenants, so the
    // control plane stays the single owner of which tenants exist and where.
    // Password hashes are stripped: a node needs a tenant's placement and ports
    // to build its container, never its credentials.
    if (typeof req.headers['x-mt-registry-key'] !== 'string' || !timingSafeEqualString(req.headers['x-mt-registry-key'], registryKey)) {
      send(res, 401, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: 'bad registry key' }))
      return
    }
    const document = loadRegistryFile()
    document.tenants = (document.tenants ?? []).map((tenant) => ({
      ...tenant,
      users: (tenant.users ?? []).map((user) => ({ name: user.name })),
    }))
    send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(document, null, 2))
    return
  }
  if (url.pathname === `${PREFIX}/registry` && req.method === 'GET') {
    const presented = req.headers['x-mt-registry-key']
    const remote = req.socket.remoteAddress ?? ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!loopback && (typeof presented !== 'string' || !timingSafeEqualString(presented, registryKey))) {
      send(res, 401, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ ok: false, error: 'bad registry key' }))
      return
    }
    // Launch tokens are deliberately omitted: this listing is readable from any
    // local process on a host-networked gateway, and a token is a credential.
    const safe = Object.fromEntries([...runtimes].sort(([left], [right]) => left.localeCompare(right))
      .map(([id, entry]) => [id, { endpoint: entry.endpoint, node: entry.node, authority: entry.authority, registeredAt: entry.registeredAt, hasToken: typeof entry.token === 'string' && entry.token !== '' }]))
    send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({ runtimes: safe }, null, 2))
    return
  }
  if (url.pathname === `${PREFIX}/health`) {
    const remote = req.socket.remoteAddress ?? ''
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found\n')
      return
    }
    handleHealth(req, res)
    return
  }
  if (url.pathname === `${PREFIX}/login` && req.method === 'POST') {
    handleLogin(req, res)
    return
  }
  // Logout is complete: the gateway session AND every tenant's DSH cookie this
  // browser may hold are expired together, so switching users cannot inherit a
  // previous tenant's session. Reachable at /__mt/logout from anywhere.
  if (url.pathname === `${PREFIX}/logout` || url.pathname === `${PREFIX}/switch`) {
    const cookies = parseCookies(req.headers.cookie)
    const session = verifySession(cookies.get(SESSION_COOKIE))
    const expired = [`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]
    for (const tenant of tenants.values()) {
      expired.push(`${dshCookieName(tenantAuthority(tenant))}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
    }
    audit({
      tenant: session?.tenant.id ?? '-',
      user: session?.user ?? '-',
      url: req.url,
      status: 303,
      note: 'logout',
    })
    send(res, 303, {
      location: `${PREFIX}/`,
      'set-cookie': secureCookies(expired, req.socket.encrypted === true),
      'cache-control': 'no-store',
    }, '')
    return
  }

  const cookies = parseCookies(req.headers.cookie)
  const session = verifySession(cookies.get(SESSION_COOKIE))

  if (session === undefined) {
    if (url.pathname !== `${PREFIX}/` && url.pathname !== '/') {
      send(res, 303, { location: `${PREFIX}/`, 'cache-control': 'no-store' }, '')
      return
    }
    send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, loginPage())
    return
  }

  // A logged-in browser is pinned to its own tenant: asking for another
  // tenant's host or dedicated port is refused rather than routed.
  const addressed = tenantByAddress(req.headers.host, localPort)
  if (addressed !== undefined && addressed.id !== session.tenant.id) {
    audit({ tenant: session.tenant.id, user: session.user, url: req.url, status: 403, note: 'cross-tenant' })
    send(res, 403, { 'content-type': 'text/html; charset=utf-8' },
      errorPage(403, `当前登录身份属于租户 <b>${session.tenant.id}</b>，无权访问 <b>${addressed.id}</b>。`))
    return
  }

  if (url.pathname === `${PREFIX}/`) {
    send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, htmlPage('DSH', `
      <h1>${session.tenant.title ?? session.tenant.id}</h1>
      <p class="sub">已登录：${session.user} @ ${session.tenant.id}</p>
      <p><a href="/">进入 ${session.tenant.id}</a></p>
      <p><a href="${PREFIX}/logout">退出登录 / 切换用户</a></p>
      <p class="sub" style="margin-top:22px">直接访问 <code>${PREFIX}/logout</code> 可在任何页面退出。</p>`))
    return
  }

  proxyRequest(req, res, session).catch((error) => {
    audit({ tenant: session.tenant.id, user: session.user, url: req.url, status: 502, error: String(error.message ?? error) })
    if (!res.headersSent) {
      send(res, 502, { 'content-type': 'text/plain; charset=utf-8' }, `proxy failure: ${String(error.message ?? error)}\n`)
    } else {
      res.destroy()
    }
  })
}

// ---------------------------------------------------------------------------
// WebSocket and other upgrade traffic (DSH Remote streams, HMR)
// ---------------------------------------------------------------------------

function handleUpgrade(req, socket, head) {
  const cookies = parseCookies(req.headers.cookie)
  const session = verifySession(cookies.get(SESSION_COOKIE))
  if (session === undefined) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return
  }
  const tenant = session.tenant
  let address
  try {
    address = tenantAddress(tenant)
  } catch (error) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
    return
  }
  const upstream = net.connect(address.port, address.host, () => {
    const headers = { ...req.headers, host: tenantAuthority(tenant) }
    // Same Host/Origin pairing as the HTTP path: the upgrade carries the
    // browser's Origin too, and the fence refuses a mismatch.
    if (headers.origin !== undefined) headers.origin = `http://${tenantAuthority(tenant)}`
    const lines = [`${req.method} ${address.prefix}${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head?.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  const close = () => { socket.destroy(); upstream.destroy() }
  upstream.on('error', close)
  socket.on('error', close)
  socket.on('close', close)
  upstream.on('close', close)
}

// ---------------------------------------------------------------------------
// listeners
// ---------------------------------------------------------------------------

/** Listening servers by port, so a reload can add one without dropping others. */
const listeners = new Map()

/**
 * Listen on one public port and answer with the shared handler.
 *
 * A tenant with its own `edgePort` gets a listener on that exact port so the
 * gateway can resolve the tenant from the port the request arrived on; every
 * tenant is also reachable through the shared entry, where the session cookie
 * decides the tenant. Public ports speak HTTPS once TLS material is present;
 * the operations port is plain HTTP bound to loopback.
 *
 * @param port - port to bind inside the gateway container.
 * @param options - `plain` forces HTTP, `bind` overrides the listen address.
 */
function listen(port, options = {}) {
  if (listeners.has(port)) return
  const plain = options.plain === true
  const bind = options.bind ?? BIND_ADDRESS
  const server = plain || TLS_OPTIONS === undefined
    ? http.createServer(handleRequest)
    : https.createServer(TLS_OPTIONS, handleRequest)
  server.on('upgrade', handleUpgrade)
  server.on('error', (error) => {
    console.error(`mt-gateway: cannot listen on :${String(port)}: ${error.message}`)
    process.exit(1)
  })
  server.listen(port, bind, () => {
    const scheme = plain || TLS_OPTIONS === undefined ? 'http' : 'https'
    console.log(`mt-gateway listening on ${scheme}://${bind}:${String(port)}`)
  })
  listeners.set(port, server)
}

/**
 * Apply the registry to the live gateway.
 *
 * Adding or removing a tenant must not disturb the tenants already being used,
 * so this never restarts the process: it swaps the registry, opens a listener
 * for a new edge port, closes one whose tenant is gone, and forgets the runtime
 * registration of a tenant that no longer exists.
 *
 * @param reason - why this ran, for the audit line.
 */
function applyRegistry(reason) {
  let next
  try {
    next = loadRegistry()
  } catch (error) {
    // Keep serving the previous registry: a half-written file must not take the
    // control plane down.
    console.error(`mt-gateway: registry reload failed, keeping the previous one: ${error.message}`)
    return
  }

  const added = [...next.keys()].filter((id) => !tenants.has(id))
  const removed = [...tenants.keys()].filter((id) => !next.has(id))
  tenants = next

  const wanted = new Set([EDGE_PORT])
  // Per-tenant entry ports are optional. A deployment that only uses the shared
  // entry turns them off, and a standby control plane on the same host must:
  // every port here is already held by the instance it stands in for.
  if (EDGE_LISTEN) {
    for (const tenant of tenants.values()) {
      if (tenant.edgePort !== undefined && tenant.edgePort !== EDGE_PORT) wanted.add(tenant.edgePort)
    }
  }
  if (OPS_PORT !== undefined) wanted.add(OPS_PORT)
  for (const port of wanted) listen(port, port === OPS_PORT ? { plain: true, bind: '127.0.0.1' } : {})
  for (const [port, server] of listeners) {
    if (wanted.has(port)) continue
    server.close()
    listeners.delete(port)
    console.log(`mt-gateway stopped listening on :${String(port)}`)
  }

  // Prune every row whose tenant is gone, not only the ones removed while this
  // process was running: a tenant deleted between restarts, or one that a
  // restore brought back, would otherwise leave a row pointing at a dead
  // endpoint and a stale token that doctor would report as a mismatch.
  let runtimeChanged = false
  for (const id of [...runtimes.keys()]) {
    if (tenants.has(id)) continue
    runtimes.delete(id)
    runtimeChanged = true
  }
  if (runtimeChanged) saveRuntimes()

  if (added.length > 0 || removed.length > 0) {
    console.log(`mt-gateway registry ${reason}: +${added.join(',') || '-'} -${removed.join(',') || '-'} (now ${String(tenants.size)})`)
    audit({ tenant: '-', user: '-', status: 0, note: 'registry-reload', added: added.join(','), removed: removed.join(',') })
  }
}

applyRegistry('boot')
// Polling instead of fs.watch: the registry arrives through a bind mount, whose
// watch semantics differ across kernels.
fs.watchFile(CONFIG_FILE, { interval: 2000 }, () => { applyRegistry('reload') })
const registeredCount = [...tenants.keys()].filter((id) => runtimes.has(id)).length
console.log(`mt-gateway serving ${String(tenants.size)} tenant(s): ${[...tenants.keys()].join(', ')}` +
  ` — ${String(registeredCount)} registered runtime(s)`)
console.log(TLS_OPTIONS === undefined
  ? 'mt-gateway public ports are plain HTTP (no TLS certificate yet)'
  : `mt-gateway public ports are HTTPS, ops entry http://127.0.0.1:${String(OPS_PORT)}`)
