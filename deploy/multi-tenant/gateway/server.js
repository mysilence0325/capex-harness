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
const net = require('node:net')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const CONFIG_FILE = process.env.MT_TENANTS_FILE ?? '/config/tenants.json'
const STATE_DIR = process.env.MT_STATE_DIR ?? '/state'
const LOG_DIR = process.env.MT_LOG_DIR ?? '/logs'
const EDGE_PORT = Number(process.env.MT_EDGE_PORT ?? 8090)
const BIND_ADDRESS = process.env.MT_BIND_IP ?? '0.0.0.0'
const SESSION_TTL_MS = Number(process.env.MT_SESSION_TTL_HOURS ?? 12) * 3_600_000
const DOCKER_SOCKET = process.env.MT_DOCKER_SOCKET ?? '/var/run/docker.sock'
const TOKEN_CACHE_MS = 10_000
const SESSION_COOKIE = 'mt_session'
const PREFIX = '/__mt'

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
const tenants = new Map(config.tenants.map((tenant) => [tenant.id, tenant]))

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

const tokenCache = new Map()
const addressCache = new Map()
const ADDRESS_CACHE_MS = 30_000

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

/** Authority the tenant runtime sees: the loopback rewrite this gateway applies. */
const tenantAuthority = (tenant) => `127.0.0.1:${tenant.internalPort}`

/** Container name of a tenant runtime (for launch-token, address, and readiness lookups). */
const tenantContainer = (tenant) => tenant.container ?? `mt-dsh-${tenant.id}`

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

function audit(entry) {
  fs.appendFile(path.join(LOG_DIR, 'access.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', () => {})
}

/**
 * Read one container's inspect document.
 * @param container - container name.
 * @returns the parsed inspect document.
 */
function inspectContainer(container) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: DOCKER_SOCKET,
      path: `/containers/${encodeURIComponent(container)}/json`,
      method: 'GET',
      timeout: 10_000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`docker inspect ${container}: HTTP ${String(response.statusCode)}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`docker inspect ${container}: unparsable response (${error.message})`))
        }
      })
    })
    request.on('timeout', () => { request.destroy(new Error(`docker inspect ${container}: timeout`)) })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Current address of one tenant runtime on its compose network.
 *
 * The gateway runs in the host network namespace (this host cannot forward
 * between its physical interface and a bridge, so a published port would never
 * reach a LAN client), which also means Docker's embedded DNS does not apply to
 * it. The address therefore comes from the Docker API, the same source the
 * launch tokens come from.
 *
 * @param tenant - tenant record.
 * @returns the tenant container's IPv4 address on `mt-net`.
 */
async function tenantAddress(tenant) {
  const cached = addressCache.get(tenant.id)
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.ip
  const info = await inspectContainer(tenantContainer(tenant))
  const networks = info?.NetworkSettings?.Networks ?? {}
  const network = networks[tenant.network ?? 'mt-net'] ?? Object.values(networks)[0]
  const ip = network?.IPAddress
  if (typeof ip !== 'string' || ip === '') {
    throw new Error(`tenant ${tenant.id} has no address on its network yet`)
  }
  addressCache.set(tenant.id, { ip, expiresAt: Date.now() + ADDRESS_CACHE_MS })
  return ip
}

// ---------------------------------------------------------------------------
// tenant launch-token lookup through the Docker API
// ---------------------------------------------------------------------------

/**
 * Read one container's combined log stream.
 * @param container - container name.
 * @returns the demultiplexed log text.
 */
function containerLogs(container) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: DOCKER_SOCKET,
      path: `/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&tail=400`,
      method: 'GET',
      timeout: 10_000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`docker logs ${container}: HTTP ${String(response.statusCode)}`))
        return
      }
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const parts = []
        let offset = 0
        // Docker frames non-TTY output as [type:1][pad:3][size:4 BE][payload].
        while (offset + 8 <= buffer.length) {
          const size = buffer.readUInt32BE(offset + 4)
          const start = offset + 8
          const end = start + size
          if (end > buffer.length) break
          parts.push(buffer.subarray(start, end))
          offset = end
        }
        resolve(parts.length > 0 ? Buffer.concat(parts).toString('utf8') : buffer.toString('utf8'))
      })
    })
    request.on('timeout', () => { request.destroy(new Error(`docker logs ${container}: timeout`)) })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Current launch token of a tenant runtime, cached briefly.
 * @param tenant - tenant record.
 * @param fresh - bypass and replace the cached value (a just-used token failed).
 * @returns the token, or undefined when the container has not printed a URL yet.
 */
async function tenantToken(tenant, fresh = false) {
  const cached = tokenCache.get(tenant.id)
  if (!fresh && cached !== undefined && cached.expiresAt > Date.now()) return cached.token
  const logs = await containerLogs(tenantContainer(tenant))
  const matches = [...logs.matchAll(/dsh web:\s*(\S+)/gu)]
  const token = matches.length === 0
    ? undefined
    : new URL(matches[matches.length - 1][1]).searchParams.get('token') ?? undefined
  tokenCache.set(tenant.id, { token, expiresAt: Date.now() + TOKEN_CACHE_MS })
  return token
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

function errorPage(status, message) {
  return htmlPage(`DSH ${String(status)}`, `<h1>${String(status)}</h1><p class="sub">${message}</p>`)
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  res.end(body)
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
      activation = await activateTenant(tenant, refreshing)
    } catch (error) {
      audit({ tenant: tenant.id, user: session.user, url: req.url, status: 502, error: error.message })
      send(res, 502, { 'content-type': 'text/plain; charset=utf-8' }, `activation failed: ${error.message}\n`)
      return
    }
  }

  const headers = { ...req.headers }
  headers.host = tenantAuthority(tenant)
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''
  headers['x-forwarded-proto'] = 'http'
  headers['x-mt-tenant'] = tenant.id
  headers['x-mt-user'] = session.user
  if (activation !== undefined) {
    headers.cookie = withCookie(req.headers.cookie, activation.name, activation.value)
  }

  let address
  try {
    address = await tenantAddress(tenant)
  } catch (error) {
    audit({ tenant: tenant.id, user: session.user, method: req.method, url: req.url, status: 502, error: error.message })
    send(res, 502, { 'content-type': 'text/plain; charset=utf-8' }, `tenant runtime address unavailable: ${error.message}\n`)
    return
  }

  const upstream = http.request({
    host: address,
    port: tenant.internalPort,
    method: req.method,
    path: req.url,
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
      // The browser held a cookie this runtime no longer accepts: force one
      // refresh, then fail instead of looping.
      audit({ tenant: tenant.id, user: session.user, url: req.url, status: 303, note: 'refresh-cookie' })
      const target = new URL(req.url ?? '/', 'http://gateway.invalid')
      target.searchParams.set('mt_refresh', '1')
      send(res, 303, { location: `${target.pathname}${target.search}`, 'cache-control': 'no-store' }, '')
      return
    }

    const responseHeaders = { ...response.headers }
    if (activation !== undefined) {
      const existing = responseHeaders['set-cookie']
      responseHeaders['set-cookie'] = existing === undefined
        ? [activation.setCookie]
        : [...(Array.isArray(existing) ? existing : [existing]), activation.setCookie]
    }
    res.writeHead(status, responseHeaders)
    response.pipe(res)
  })

  upstream.on('error', (error) => {
    audit({ tenant: tenant.id, user: session.user, method: req.method, url: req.url, status: 502, ms: Date.now() - started, error: error.message })
    if (!res.headersSent) {
      send(res, 502, { 'content-type': 'text/plain; charset=utf-8' }, `tenant runtime unreachable: ${error.message}\n`)
    } else {
      res.destroy()
    }
  })

  req.pipe(upstream)
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
      host: address,
      port: tenant.internalPort,
      method: 'GET',
      path,
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
 * @param fresh - re-read the launch token instead of trusting the short cache.
 * @returns the tenant's `Set-Cookie` value and its `name=value` pair, or undefined.
 */
async function activateTenant(tenant, fresh = false) {
  const token = await tenantToken(tenant, fresh)
  if (token === undefined) return undefined
  const address = await tenantAddress(tenant)
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

function handleLogin(req, res) {
  readBody(req).then((body) => {
    const params = new URLSearchParams(body)
    const user = params.get('user') ?? ''
    const password = params.get('password') ?? ''
    const resolved = resolveLogin(
      user,
      params.get('tenant') ?? undefined,
      tenantByAddress(req.headers.host, req.socket.localPort),
    )
    if (resolved.error !== undefined || !checkPassword(resolved.account, password)) {
      audit({ tenant: resolved.tenant?.id ?? '-', user, status: 401, note: 'login-failed' })
      send(res, 401, { 'content-type': 'text/html; charset=utf-8' }, loginPage({ error: '用户名或密码不正确' }))
      return
    }
    audit({ tenant: resolved.tenant.id, user, status: 200, note: 'login-ok' })
    send(res, 303, {
      location: '/',
      'set-cookie': `${SESSION_COOKIE}=${signSession(resolved.tenant.id, user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(SESSION_TTL_MS / 1000))}`,
      'cache-control': 'no-store',
    }, '')
  }).catch(() => {
    send(res, 400, { 'content-type': 'text/html; charset=utf-8' }, loginPage({ error: '请求格式不正确' }))
  })
}

function handleHealth(req, res) {
  Promise.all([...tenants.values()].map(async (tenant) => {
    let token
    try {
      token = await tenantToken(tenant)
    } catch (error) {
      token = undefined
      return { id: tenant.id, container: tenant.container, ready: false, error: error.message }
    }
    return { id: tenant.id, container: tenant.container, ready: token !== undefined }
  })).then((rows) => {
    send(res, 200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify({
      tenants: rows,
      users: [...tenants.values()].flatMap((tenant) => (tenant.users ?? []).map((user) => `${tenant.id}/${user.name}`)),
    }, null, 2))
  })
}

function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://gateway.invalid')
  const localPort = req.socket.localPort

  // Operational endpoint: it enumerates tenants and usernames, so it answers
  // loopback callers only (bin/mt.sh status / smoke / accept all run locally).
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
      'set-cookie': expired,
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
  tenantAddress(tenant).then((address) => {
    const upstream = net.connect(tenant.internalPort, address, () => {
      const headers = { ...req.headers, host: tenantAuthority(tenant) }
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
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
  }).catch(() => {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
}

// ---------------------------------------------------------------------------
// listeners
// ---------------------------------------------------------------------------

/**
 * Listen on one public port and answer with the shared handler.
 *
 * A tenant with its own `edgePort` gets a listener on that exact port so the
 * gateway can resolve the tenant from the port the request arrived on; every
 * tenant is also reachable through the shared entry, where the session cookie
 * decides the tenant.
 *
 * @param port - public port to bind inside the gateway container.
 */
function listen(port) {
  const server = http.createServer(handleRequest)
  server.on('upgrade', handleUpgrade)
  server.on('error', (error) => {
    console.error(`mt-gateway: cannot listen on :${String(port)}: ${error.message}`)
    process.exit(1)
  })
  server.listen(port, BIND_ADDRESS, () => {
    console.log(`mt-gateway listening on ${BIND_ADDRESS}:${String(port)}`)
  })
}

const ports = new Set([EDGE_PORT])
for (const tenant of tenants.values()) {
  if (tenant.edgePort !== undefined && tenant.edgePort !== EDGE_PORT) ports.add(tenant.edgePort)
}
for (const port of ports) listen(port)
console.log(`mt-gateway serving ${String(tenants.size)} tenant(s): ${[...tenants.keys()].join(', ')}`)
