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
  sessionSecret

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
    // Persisted rather than per-process: a standby control plane sharing this
    // directory then accepts sessions the primary signed, which is what makes an
    // active-passive pair possible at all. Same reasoning as the tenant session
    // key in state/session.key.
    this.sessionSecret = (() => {
      const file = path.join(options.stateDir, 'admin.key')
      if (fs.existsSync(file)) {
        const existing = fs.readFileSync(file)
        if (existing.length > 0) return existing
      }
      const created = crypto.randomBytes(32)
      fs.writeFileSync(file, created, { mode: 0o600 })
      return created
    })()
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
    const file = ADMIN_FILE(this.options.stateDir)
    fs.writeFileSync(file, `${JSON.stringify({ user, passwordHash: hashPassword(password), updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
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
  mintSession() {
    const payload = String(Date.now() + SESSION_MS)
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
    const expires = Number(payload)
    if (!Number.isFinite(expires) || expires < Date.now()) return undefined
    return this.readAdmin()?.user ?? 'admin'
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
          'x-mt-registry-key': this.options.registryKey,
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
