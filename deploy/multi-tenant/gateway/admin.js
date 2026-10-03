/**
 * Administrator console.
 *
 * Served by the control plane at `/__mt/admin` on the same HTTPS entry tenants
 * use, so there is no extra port to open. It is the only surface that changes who
 * exists: everything else a tenant can reach acts on one tenant's own runtime.
 *
 * Two deliberate limits on what it can do. It writes the registry itself —
 * tenants, users, passwords — because that file is the control plane's. It does
 * **not** touch containers: the control plane holds no Docker access, so a
 * start, stop, restart or removal is forwarded to the node agent that registered
 * that tenant. A tenant registered without an agent therefore reports why it
 * cannot be operated here instead of pretending to.
 *
 * @module mt/gateway/admin
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const keys = require('./keys.js')
const http = require('node:http')
const { appendRotated, rotatedFiles } = require('./rotate.js')
/** Where the administrator's own credential lives, separate from any tenant. */
const ADMIN_FILE = (stateDir) => path.join(stateDir, 'admin.json')
const AUDIT_FILE = (logDir) => path.join(logDir, 'admin.jsonl')
const USAGE_FILE = (logDir) => path.join(logDir, 'model-usage.jsonl')

const COOKIE = 'mt_admin'
/** Failed sign-ins from one source before it is refused for a while. */
const MAX_FAILURES = 5
const LOCKOUT_MS = 5 * 60 * 1000
const SESSION_MS = 12 * 60 * 60 * 1000
const ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/u
const USER_PATTERN = /^[A-Za-z0-9._-]{1,32}$/u

/** Constant-time compare that does not leak length through early return. */
function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** `scrypt$<salt hex>$<digest hex>`, the same form bin/registry.js writes. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 32).toString('hex')}`
}

/**
 * Compare a password against a stored hash.
 * @param password - the presented plaintext.
 * @param stored - `scrypt$<salt>$<digest>`.
 * @returns whether they match.
 */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const digest = crypto.scryptSync(password, parts[1], 32).toString('hex')
  return safeEqual(digest, parts[2])
}

/**
 * The administrator console.
 *
 * Owns the administrator credential, its own session cookie, the sign-in
 * throttle, and the console's HTML and JSON endpoints.
 */
class AdminConsole {
  /** Failed sign-in attempts, keyed by source address. */
  failures = new Map()

  /**
   * @param options - wiring the console cannot read for itself.
   * @param options.registryFile - tenants.json, the file the console edits.
   * @param options.stateDir - where the administrator credential lives.
   * @param options.logDir - where the audit and usage logs live.
   * @param options.registryKey - the key node agents authenticate with.
   * @param options.authz - the caller's own read of the live registry.
   */
  constructor(options) {
    this.options = options
  }

  /**
   * The key administrator sessions are signed with.
   *
   * Read from disk on every use rather than cached at construction: rotating the
   * file is how sessions are withdrawn, and a cached copy would keep honouring the
   * old key until the process restarted — which is the one thing revocation must
   * not require. It is 32 bytes on every mint and verify, against a console that
   * sees a handful of requests per minute.
   *
   * Persisted rather than per-process: a standby control plane sharing this
   * directory then accepts sessions the primary signed, which is what makes an
   * active-passive pair possible at all. Same reasoning as the tenant session key
   * in state/session.key.
   */
  get sessionSecret() {
    const file = path.join(this.options.stateDir, 'admin.key')
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file)
      if (existing.length > 0) return existing
    }
    const created = crypto.randomBytes(32)
    fs.writeFileSync(file, created, { mode: 0o600 })
    return created
  }

  /**
   * Replace the administrator credential.
   *
   * Same file and format as `bin/admin-passwd.js` writes, so the console and the
   * command line stay interchangeable: whichever set the password last is the one
   * that works, and neither needs to know about the other.
   *
   * @param user - administrator name.
   * @param passwordHash - the `scrypt$<salt>$<digest>` value to store.
   */
  writeAdmin(user, passwordHash) {
    const file = ADMIN_FILE(this.options.stateDir)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      file,
      `${JSON.stringify({ user, passwordHash, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    )
  }

  /**
   * Every administrator, in the shape that supports more than one.
   *
   * The file started as a single record (`{user, passwordHash}`) and that shape is
   * still read: an upgrade must not lock the existing administrator out of the
   * console. A record with no role is treated as an administrator, because that is
   * what it was before roles existed.
   *
   * @returns the administrator records, oldest first.
   */
  readAdmins() {
    const file = ADMIN_FILE(this.options.stateDir)
    if (!fs.existsSync(file)) return []
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      console.error(`mt-gateway: ${file} is not readable JSON: ${error.message}`)
      return []
    }
    if (Array.isArray(parsed?.users)) {
      return parsed.users
        .filter((entry) => typeof entry?.name === 'string' && entry.name !== '')
        .map((entry) => ({
          name: entry.name,
          passwordHash: entry.passwordHash,
          role: entry.role === 'viewer' ? 'viewer' : 'admin',
          createdAt: entry.createdAt,
        }))
    }
    if (typeof parsed?.user === 'string' && parsed.user !== '') {
      return [{ name: parsed.user, passwordHash: parsed.passwordHash, role: 'admin', createdAt: parsed.updatedAt }]
    }
    return []
  }

  /** One administrator by name, or undefined. */
  adminByName(name) {
    return this.readAdmins().find((entry) => entry.name === name)
  }

  /** What one administrator may do; unknown names get the least. */
  roleOf(name) {
    return this.adminByName(name)?.role ?? 'viewer'
  }

  /**
   * Write the administrator records back, in place.
   *
   * In place rather than by rename: the file is bind-mounted into this container and
   * read by a standby control plane, both of which hold the inode.
   */
  writeAdmins(users) {
    const file = ADMIN_FILE(this.options.stateDir)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      file,
      `${JSON.stringify({ version: 2, users, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    )
  }

  /**
   * Set one administrator's password, leaving the others alone.
   *
   * The command line used to write the whole file, which with more than one
   * administrator would delete the rest — so it goes through here now.
   *
   * @param name - the administrator.
   * @param passwordHash - the `scrypt$…` value to store.
   * @returns whether the administrator exists.
   */
  setAdminPassword(name, passwordHash) {
    const users = this.readAdmins()
    const at = users.findIndex((entry) => entry.name === name)
    if (at < 0) return false
    users[at] = { ...users[at], passwordHash }
    this.writeAdmins(users)
    return true
  }

  /** Add one administrator, or replace the password of an existing one. */
  addAdmin(name, passwordHash, role) {
    const users = this.readAdmins()
    const at = users.findIndex((entry) => entry.name === name)
    if (at < 0) users.push({ name, passwordHash, role, createdAt: new Date().toISOString() })
    else users[at] = { ...users[at], passwordHash, role }
    this.writeAdmins(users)
  }

  /** Remove one administrator. Refuses to remove the last one. */
  removeAdmin(name) {
    const users = this.readAdmins()
    const left = users.filter((entry) => entry.name !== name)
    if (left.length === users.length) return 'missing'
    if (left.length === 0) return 'last'
    // Someone has to be able to administer it; leaving only viewers locks everyone out.
    if (!left.some((entry) => entry.role === 'admin')) return 'last-admin'
    this.writeAdmins(left)
    return 'removed'
  }

  /**
   * Withdraw every administrator session by replacing the signing key.
   *
   * Unlike a tenant password change there is no epoch to bump: the login carries
   * only an expiry and a signature, so the key is the whole of the authority.
   * Changing it signs out every browser, including this process's own — the
   * gateway serves the next request with the new key and the old cookies stop
   * verifying.
   *
   * @returns the previous key's length, for reporting.
   */
  rotateSessionKey() {
    const file = path.join(this.options.stateDir, 'admin.key')
    const previous = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0)
    const created = crypto.randomBytes(32)
    // Written in place, never renamed: the control plane's bind mount holds this
    // inode, and a standby shares the file.
    fs.writeFileSync(file, created, { mode: 0o600 })
    return previous.length
  }

  /** @returns the stored administrator record, or undefined before first use. */
  readAdmin() {
    const file = ADMIN_FILE(this.options.stateDir)
    if (!fs.existsSync(file)) return undefined
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      console.error(`mt-gateway: ${file} is not readable JSON: ${error.message}`)
      return undefined
    }
  }

  /**
   * Set the administrator password.
   * @param password - the new plaintext password.
   * @param user - administrator name, `admin` by default.
   * @returns nothing.
   */
  setPassword(password, user = 'admin') {
    // Goes through the same path as everything else that changes a password.
    //
    // It used to write one record over the whole file, which silently downgraded the
    // multi-administrator form to a single account - anyone calling it to reset one
    // password would delete the others, viewers included. Nothing called it, but the
    // shape was a loaded gun, and MFA is about to add fields to these same records.
    // For a single-administrator file the result is the same as before.
    const hash = hashPassword(password)
    if (!this.setAdminPassword(user, hash)) this.addAdmin(user, hash, 'admin')
  }

  /** @returns whether an administrator password has been set at all. */
  hasAdmin() {
    return this.readAdmin() !== undefined
  }

  /** Append one administrator action, rotating by size like the access log. */
  audit(entry) {
    appendRotated(AUDIT_FILE(this.options.logDir), JSON.stringify({ ts: new Date().toISOString(), ...entry }))
  }

  /**
   * One client's throttle bucket.
   * @param source - the caller's address.
   * @returns the bucket, created on first use.
   */
  bucketFor(source) {
    let bucket = this.failures.get(source)
    if (bucket === undefined) {
      bucket = { count: 0, until: 0 }
      this.failures.set(source, bucket)
    }
    return bucket
  }

  /** @returns seconds this source must wait, or 0 when it may try now. */
  lockedFor(source) {
    const bucket = this.bucketFor(source)
    const remaining = bucket.until - Date.now()
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0
  }

  /** Mint a session value carrying its own expiry and signature. */
  mintSession(name) {
    // 名字签在载荷里：cookie 里只有过期时间的话，服务端就无从知道是哪个管理员，
    // 而角色是按人算的——早先的实现只能去猜一个名字，多用户下就成了"人人都是 admin"。
    const payload = `${String(Date.now() + SESSION_MS)}|${name}`
    const signature = crypto.createHmac('sha256', this.sessionSecret).update(payload).digest('hex')
    return `${payload}.${signature}`
  }

  /**
   * @param value - the cookie value.
   * @returns the administrator name when the session is valid and unexpired.
   */
  verifySession(value) {
    if (typeof value !== 'string') return undefined
    const at = value.lastIndexOf('.')
    if (at <= 0) return undefined
    const payload = value.slice(0, at)
    const expected = crypto.createHmac('sha256', this.sessionSecret).update(payload).digest('hex')
    if (!safeEqual(expected, value.slice(at + 1))) return undefined
    const [expiry, name] = payload.split('|')
    const expires = Number(expiry)
    if (!Number.isFinite(expires) || expires < Date.now()) return undefined
    if (typeof name !== 'string' || name === '') return undefined
    // 这个人必须还存在：删掉一个管理员就等于吊销他的会话。
    return this.adminByName(name) === undefined ? undefined : name
  }

  /** Read a JSON body with a size ceiling. */
  readJson(req, limit = 64 * 1024) {
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
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim() === '') { resolve({}); return }
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(new Error(`body is not JSON: ${error.message}`))
        }
      })
      req.on('error', reject)
    })
  }

  /**
   * Per-tenant model usage, from the model gateway's log.
   *
   * Reads the rotated generations too: after a rotation the current file holds
   * only the newest entries, and totals computed from it alone would appear to
   * reset.
   *
   * @returns a map of tenant id to call count and token totals.
   */
  usageByTenant() {
    const file = USAGE_FILE(this.options.logDir)
    const totals = new Map()
    for (const source of rotatedFiles(file)) {
      let text
      try {
        text = fs.readFileSync(source, 'utf8')
      } catch (error) {
        console.error(`mt-gateway: cannot read ${source}: ${error.message}`)
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
        if (typeof row?.tenant !== 'string' || row.tenant === '') continue
        const current = totals.get(row.tenant) ?? { calls: 0, input: 0, output: 0, cacheRead: 0 }
        current.calls += 1
        current.input += Number(row.inputTokens ?? 0)
        current.output += Number(row.outputTokens ?? 0)
        current.cacheRead += Number(row.cacheReadTokens ?? 0)
        totals.set(row.tenant, current)
      }
    }
    return totals
  }

  /**
   * Ask an agent whether it is alive.
   *
   * Short timeout on purpose: this answers "is the node's agent answering right
   * now", and a hung agent must read as down rather than hold the console's state
   * request open.
   *
   * @param agent - the agent's base URL.
   * @returns the parsed health body, or `{ ok: false }` when it did not answer.
   */
  callHealth(agent) {
    let url
    try {
      url = new URL(`${agent}/health`)
    } catch {
      return Promise.resolve({ ok: false })
    }
    return new Promise((resolve) => {
      const request = http.request({
        host: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        method: 'GET',
        path: url.pathname,
        agent: false,
        timeout: 4000,
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            resolve({ ok: response.statusCode === 200 })
          }
        })
      })
      request.on('timeout', () => { request.destroy(new Error('timeout')) })
      request.on('error', () => resolve({ ok: false }))
      request.end()
    })
  }

  /**
   * Ask a node agent to run one of its allowlisted host operations.
   *
   * The operation name and its parameters travel as JSON; the agent decides what
   * they mean and refuses anything not in its table. The timeout is long because
   * a rolling upgrade legitimately takes minutes, and it is the agent's own
   * per-operation timeout that ends a runaway.
   *
   * @param agent - the agent's base URL.
   * @param op - the operation name.
   * @param params - its parameters.
   * @returns the agent's status and parsed answer.
   */
  callOps(agent, op, params) {
    const payload = JSON.stringify({ op, params })
    const url = new URL(`${agent}/ops`)
    return new Promise((resolve) => {
      const request = http.request({
        host: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        method: 'POST',
        path: url.pathname,
        headers: {
          // 运维密钥。这些调用都是网关替控制台向代理发起的（执行运维、探活），
          // 走的是"能改东西"的那条链路，所以出示运维密钥而不是共用密钥。
          // 代理同时接受旧密钥，因此两端切换的先后都不影响可用性。
          'x-mt-registry-key': keys.readKeys(this.options.stateDir).ops,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        agent: false,
        timeout: 31 * 60 * 1000,
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = { ok: false, error: text.slice(0, 400) }
          }
          resolve({ status: response.statusCode ?? 0, body: parsed })
        })
      })
      request.on('timeout', () => { request.destroy(new Error('agent did not answer in time')) })
      request.on('error', (error) => resolve({ status: 502, body: { ok: false, error: `agent unreachable: ${error.message}` } }))
      request.end(payload)
    })
  }

  /**
   * Ask one tenant's node agent to change that container's state.
   * @param agent - the agent's base URL, as it registered itself.
   * @param tenant - tenant id.
   * @param action - start, stop, restart, or remove.
   * @param body - request body for remove's purge flag.
   * @returns the agent's status and parsed answer.
   */
  callAgent(agent, tenant, action, body) {
    const url = new URL(`${agent}/tenants/${encodeURIComponent(tenant)}/${action}`)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve) => {
      const request = http.request({
        host: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        method: 'POST',
        path: url.pathname,
        headers: {
          // 运维密钥。这些调用都是网关替控制台向代理发起的（执行运维、探活），
          // 走的是"能改东西"的那条链路，所以出示运维密钥而不是共用密钥。
          // 代理同时接受旧密钥，因此两端切换的先后都不影响可用性。
          'x-mt-registry-key': keys.readKeys(this.options.stateDir).ops,
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
        agent: false,
        timeout: 10 * 60 * 1000,
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = { ok: false, error: text.slice(0, 300) }
          }
          resolve({ status: response.statusCode ?? 502, body: parsed })
        })
      })
      request.on('timeout', () => { request.destroy(new Error('agent did not answer in time')) })
      request.on('error', (error) => resolve({ status: 502, body: { ok: false, error: `agent unreachable: ${error.message}` } }))
      request.end(payload)
    })
  }

  /**
   * Ask a node agent to provision, so a new tenant gets its container.
   * @param agent - the agent's base URL.
   * @returns the agent's status and parsed answer.
   */
  callProvision(agent) {
    const url = new URL(`${agent}/provision`)
    return new Promise((resolve) => {
      const request = http.request({
        host: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        method: 'POST',
        path: url.pathname,
        headers: { 'x-mt-registry-key': this.options.registryKey },
        agent: false,
        timeout: 15 * 60 * 1000,
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = { ok: false, error: text.slice(0, 300) }
          }
          resolve({ status: response.statusCode ?? 502, body: parsed })
        })
      })
      request.on('timeout', () => { request.destroy(new Error('agent did not answer in time')) })
      request.on('error', (error) => resolve({ status: 502, body: { ok: false, error: `agent unreachable: ${error.message}` } }))
      request.end()
    })
  }
}

module.exports = { AdminConsole, hashPassword, verifyPassword, ID_PATTERN, USER_PATTERN, COOKIE, MAX_FAILURES, LOCKOUT_MS, SESSION_MS }
