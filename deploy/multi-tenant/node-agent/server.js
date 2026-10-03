/**
 * Node agent: the piece that lets one control plane drive tenants on many machines.
 *
 * A tenant container has no reachable address from outside its own host: bridges
 * are unpublished, and on hosts with `net.ipv4.ip_forward = 0` a published port
 * would not be reachable from the LAN anyway. The control plane therefore cannot
 * talk to a remote tenant directly.
 *
 * This agent runs in the node's host network namespace, so it can do both halves:
 * reach the control plane over the LAN, and reach the node's own containers the
 * way the host does. It
 *
 *   1. discovers the tenant runtimes on this node (Docker API when the socket is
 *      mounted, otherwise a static mapping from the environment),
 *   2. registers each one with the control plane as
 *      `http://<node>:<port>/proxy/<tenant>`, re-registering whenever a
 *      container's address or launch token changes, and
 *   3. forwards the control plane's proxied requests to the local container,
 *      preserving the Host header the control plane chose (DSH derives its
 *      cookie name from it).
 *
 * It is deliberately the privileged half: it holds the Docker socket and the
 * registry key. The control plane holds neither.
 *
 * @module mt/node-agent/server
 */

'use strict'

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const PORT = Number(process.env.MT_AGENT_PORT ?? 3199)
const BIND = process.env.MT_AGENT_BIND ?? '0.0.0.0'
const NODE_NAME = process.env.MT_NODE_NAME ?? 'node'
/** Address the control plane uses to reach this agent. */
const NODE_ADDRESS = process.env.MT_NODE_ADDRESS ?? ''
const CONTROL_PLANE = (process.env.MT_CONTROL_PLANE ?? '').replace(/\/+$/u, '')
const KEY_FILE = process.env.MT_REGISTRY_KEY_FILE ?? '/key/registry.key'
const CA_FILE = process.env.MT_CONTROL_PLANE_CA ?? ''
const DOCKER_SOCKET = process.env.MT_DOCKER_SOCKET ?? '/var/run/docker.sock'
const NETWORK = process.env.MT_NETWORK ?? 'mt-net'
const CONTAINER_PREFIX = process.env.MT_CONTAINER_PREFIX ?? 'mt-dsh-'
/**
 * Label carrying the tenant id on its container.
 *
 * Discovery keys on this rather than on the container name because an orchestrator
 * renames containers: a Swarm service's tasks are `<stack>_<service>.<slot>.<id>`,
 * while a label survives the renaming. The name prefix stays as a fallback for
 * containers that predate the label.
 */
const TENANT_LABEL = process.env.MT_TENANT_LABEL ?? 'mt.tenant'
/**
 * Directory holding the node's copy of this project, used to provision tenants.
 *
 * Empty disables provisioning on this node. The agent does not reimplement
 * container creation: it runs that directory's `bin/mt.sh up`, the same entry an
 * operator uses, so a tenant's profile patch and container come from one code
 * path whether a human or the control plane asked for it.
 */
const PROJECT_DIR = process.env.MT_PROJECT_DIR ?? ''
/**
 * Whether this node renders from a copy of the registry it pulls from the
 * control plane. A worker node sets this; the control plane's own host must not,
 * or provisioning would overwrite the authoritative registry with the node copy.
 */
const REGISTRY_SYNC = ['1', 'true', 'yes'].includes((process.env.MT_REGISTRY_SYNC ?? '').toLowerCase())
/** Path the script reaches this agent at; used to build the provisioned tenant's URL. */
const SPAWN_TIMEOUT_MS = Number(process.env.MT_PROVISION_TIMEOUT ?? 600) * 1000
/** Static mapping used when the Docker socket is absent: `alpha=http://ip:port,...` */
const STATIC_TENANTS = process.env.MT_TENANTS ?? ''
const SYNC_INTERVAL_MS = Number(process.env.MT_SYNC_INTERVAL ?? 15) * 1000
const TOKEN_PATTERN = /dsh web:\s*(\S+)/gu

const registryKey = fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : ''
const ca = CA_FILE !== '' && fs.existsSync(CA_FILE) ? fs.readFileSync(CA_FILE) : undefined
const dockerAvailable = fs.existsSync(DOCKER_SOCKET)

// Without a control plane this agent still serves its operations endpoint, which
// is what the control host needs: its own tenants register directly, so having the
// agent register them again would route their traffic through a second hop for no
// benefit. It discovers and registers only when told where to report.
if (CONTROL_PLANE === '') {
  console.log('mt-node-agent: no MT_CONTROL_PLANE; serving operations only (no discovery or registration)')
}
if (registryKey === '') {
  console.error(`mt-node-agent: no registry key at ${KEY_FILE}; copy it from the control plane`)
  process.exit(1)
}

/**
 * One Docker API call over the socket.
 * @param method - HTTP method.
 * @param path - Docker API path.
 * @returns parsed JSON, or undefined for an empty body.
 */
function docker(method, path) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: DOCKER_SOCKET, path, method, timeout: 10_000 }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`docker ${path}: HTTP ${String(response.statusCode)}`))
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`docker ${path}: ${error.message}`))
        }
      })
    })
    request.on('timeout', () => { request.destroy(new Error(`docker ${path}: timeout`)) })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Demultiplex one container's log stream.
 * @param container - container name.
 * @param sinceSeconds - Unix seconds; only lines after it are read.
 * @returns the log text.
 */
function containerLogs(container, sinceSeconds) {
  // The API wants a Unix timestamp here: given RFC3339 it answers HTTP 500
  // ("strconv.ParseInt ... invalid syntax"). The CLI converts before calling, so
  // its `--since` works while a direct API call with the same string does not.
  const query = `stdout=1&stderr=1&tail=200${sinceSeconds === undefined ? '' : `&since=${String(sinceSeconds)}`}`
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: DOCKER_SOCKET,
      path: `/containers/${encodeURIComponent(container)}/logs?${query}`,
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
 * Launch token and bound port a container printed during its current run.
 *
 * The runtime prints its own URL, which is the only authoritative source for the
 * port it actually bound: an image's `EXPOSE` names the default, not the port a
 * tenant's profile patch selects.
 *
 * Reading only lines since the container's start matters too: container logs
 * survive a restart, and the previous run's line is still in them.
 *
 * @param container - container name.
 * @returns the token and port, either possibly undefined while starting.
 */
async function currentRuntime(container) {
  let sinceSeconds
  try {
    const info = await docker('GET', `/containers/${encodeURIComponent(container)}/json`)
    const startedAt = info?.State?.StartedAt
    if (typeof startedAt === 'string' && startedAt !== '') {
      const parsed = Date.parse(startedAt)
      if (!Number.isNaN(parsed)) sinceSeconds = Math.floor(parsed / 1000)
    }
  } catch {
    sinceSeconds = undefined
  }
  const logs = await containerLogs(container, sinceSeconds)
  const matches = [...logs.matchAll(TOKEN_PATTERN)]
  if (matches.length === 0) return {}
  try {
    const url = new URL(matches[matches.length - 1][1])
    return { token: url.searchParams.get('token') ?? undefined, port: Number(url.port) || undefined }
  } catch {
    return {}
  }
}

/**
 * Tenant id one container belongs to, if any.
 * @param container - entry from the container list.
 * @param name - the container's name without its leading slash.
 * @returns the tenant id, or undefined when this container is not a tenant runtime.
 */
function tenantOf(container, name) {
  const labelled = container.Labels?.[TENANT_LABEL]
  if (typeof labelled === 'string' && labelled !== '') return labelled
  return name.startsWith(CONTAINER_PREFIX) ? name.slice(CONTAINER_PREFIX.length) : undefined
}

/**
 * Container name for one tenant, whether or not it is running.
 *
 * Discovery lists running containers only — a stopped runtime must not stay
 * registered as reachable — but the lifecycle endpoints have to act on a
 * stopped container too, so they look it up separately.
 *
 * @param tenant - tenant id.
 * @returns the container name, or undefined when this node has none.
 */
async function containerOf(tenant) {
  const containers = await docker('GET', '/containers/json?all=1')
  for (const container of containers ?? []) {
    const name = String(container.Names?.[0] ?? '').replace(/^\//u, '')
    if (tenantOf(container, name) === tenant) return name
  }
  return undefined
}

// ---------------------------------------------------------------------------
// provisioning and lifecycle
//
// The control plane deliberately holds no Docker access, so it cannot create the
// container a new tenant needs. This agent can, and it does so by running the
// node's own `bin/mt.sh up` rather than reimplementing container creation:
// that path already renders the tenant's profile patch (its port and its
// Host/Origin trust entry) and starts the container, and it is the same path an
// operator uses by hand. Nothing here invents a second provisioning rule.
// ---------------------------------------------------------------------------

/** Run one fixed command in the project directory. */
function runProject(args) {
  return new Promise((resolve) => {
    const child = spawn(PROJECT_DIR === '' ? 'true' : 'bash', PROJECT_DIR === '' ? [] : [path.join(PROJECT_DIR, 'bin', 'mt.sh'), ...args], {
      cwd: PROJECT_DIR === '' ? undefined : PROJECT_DIR,
      env: { ...process.env, MT_NODE_NAME: NODE_NAME, MT_NETWORK: NETWORK, MT_CONTAINER_NAME_PREFIX: process.env.MT_CONTAINER_NAME_PREFIX ?? 'mt-' },
      timeout: 10 * 60 * 1000,
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', (error) => resolve({ ok: false, output: `${output}\n${error.message}` }))
    child.on('close', (code) => resolve({ ok: code === 0, code, output }))
  })
}

/**
 * Fetch the registry from the control plane and write it here.
 *
 * Off by default, and that default matters: an agent running on the control
 * plane's own host would otherwise overwrite the authoritative registry with the
 * node-facing copy it just fetched — which is stripped of password hashes, so
 * every login would start failing. A worker node opts in with
 * `MT_REGISTRY_SYNC=1`; the control plane's own host never does, because the
 * registry it renders from is already the authoritative one.
 *
 * @returns the control plane's answer text.
 */
function syncRegistry() {
  if (!REGISTRY_SYNC) {
    return Promise.reject(new Error('registry sync is disabled on this agent (set MT_REGISTRY_SYNC=1 on a node that renders from a copy)'))
  }
  const url = new URL(`${CONTROL_PLANE}/__mt/registry/tenants`)
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.request({
      host: url.hostname,
      port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
      method: 'GET',
      path: url.pathname,
      headers: { 'x-mt-registry-key': registryKey },
      ca,
      agent: false,
      timeout: 15_000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode !== 200) {
          reject(new Error(`control plane refused the registry: HTTP ${String(response.statusCode)} ${text.slice(0, 160)}`))
          return
        }
        const destination = process.env.MT_REGISTRY_FILE ?? path.join(PROJECT_DIR, 'tenants.json')
        fs.writeFileSync(destination, `${text.trimEnd()}\n`, { mode: 0o600 })
        resolve(text)
      })
    })
    request.on('timeout', () => { request.destroy(new Error('timeout')) })
    request.on('error', reject)
    request.end()
  })
}

/** Read one JSON body with a size ceiling. */
function readJsonBody(req, limit = 64 * 1024) {
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
 * Tenant runtimes on this node.
 * @returns a map of tenant id to `{ ip, port }` of its local container.
 */
async function discover() {
  const found = new Map()
  if (!dockerAvailable) {
    for (const entry of STATIC_TENANTS.split(',').map((item) => item.trim()).filter(Boolean)) {
      const at = entry.indexOf('=')
      if (at > 0) {
        const url = new URL(entry.slice(at + 1))
        found.set(entry.slice(0, at), { ip: url.hostname, port: Number(url.port) })
      }
    }
    return found
  }
  const containers = await docker('GET', '/containers/json')
  for (const container of containers ?? []) {
    const name = String(container.Names?.[0] ?? '').replace(/^\//u, '')
    const id = tenantOf(container, name)
    if (id === undefined) continue
    // Any network this deployment owns: an isolated tenant has one of its own
    // (`mt-net-<tenant>`), so looking at a single configured name would drop it
    // from discovery and take it off the control plane.
    const networks = container.NetworkSettings?.Networks ?? {}
    let address
    for (const [networkName, network] of Object.entries(networks)) {
      if (networkName !== NETWORK && !networkName.startsWith(`${NETWORK}-`)) continue
      if (typeof network?.IPAddress === 'string' && network.IPAddress !== '') {
        address = network.IPAddress
        break
      }
    }
    if (address === undefined) continue
    // The port comes from the runtime's own printed URL; the image's EXPOSE is
    // only a default and every tenant here overrides it.
    const { port } = await currentRuntime(name)
    if (port === undefined) {
      console.log(`mt-node-agent: ${name} has not printed its URL yet; skipping this pass`)
      continue
    }
    found.set(id, { ip: address, port, container: name })
  }
  return found
}

/** What the control plane was last told, keyed by tenant id. */
const reported = new Map()

/**
 * Post one tenant's runtime to the control plane.
 * @param tenant - tenant id.
 * @param target - local base URL of the container.
 * @param token - current launch token.
 * @param nodeAddress - address the control plane should use for this agent.
 * @returns whether the control plane accepted it.
 */
function register(tenant, target, token, nodeAddress) {
  const body = JSON.stringify({
    tenant,
    endpoint: `http://${nodeAddress}:${String(PORT)}/proxy/${tenant}`,
    token,
    node: NODE_NAME,
    local: target,
    // Where to reach this agent for lifecycle actions. The control plane holds no
    // Docker access, so a restart or a stop it wants done has to come back here.
    agent: `http://${nodeAddress}:${String(PORT)}`,
  })
  const url = new URL(`${CONTROL_PLANE}/__mt/registry/register`)
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve) => {
    const request = transport.request({
      host: url.hostname,
      port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
      method: 'POST',
      path: url.pathname,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-mt-registry-key': registryKey },
      ca,
      agent: false,
      timeout: 10_000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const ok = response.statusCode === 200 && text.includes('"ok":true')
        if (!ok) console.error(`mt-node-agent: register ${tenant} refused: HTTP ${String(response.statusCode)} ${text.slice(0, 160)}`)
        resolve(ok)
      })
    })
    request.on('timeout', () => { request.destroy(new Error('timeout')) })
    request.on('error', (error) => {
      console.error(`mt-node-agent: register ${tenant} failed: ${error.message}`)
      resolve(false)
    })
    request.end(body)
  })
}

/**
 * Discover, compare with what was reported, and re-register what changed.
 * @param nodeAddress - address the control plane should use for this agent.
 * @param force - re-register every tenant even when nothing changed.
 */
async function sync(nodeAddress, force = false) {
  let found
  try {
    found = await discover()
  } catch (error) {
    console.error(`mt-node-agent: discovery failed: ${error.message}`)
    return
  }
  for (const [tenant, runtime] of found) {
    const target = `http://${runtime.ip}:${String(runtime.port)}`
    let token
    try {
      // Read the token from the container discovery actually found: its name is
      // whatever this host named it, not necessarily the name convention.
      token = dockerAvailable ? (await currentRuntime(runtime.container)).token : undefined
    } catch (error) {
      console.error(`mt-node-agent: token lookup for ${tenant} failed: ${error.message}`)
    }
    const signature = `${target}|${token ?? ''}`
    if (!force && reported.get(tenant) === signature) continue
    // A runtime that has not printed its token yet would be registered unusable,
    // so wait for the next pass instead.
    if (dockerAvailable && (token === undefined || token === '')) {
      console.log(`mt-node-agent: ${tenant} has not printed a launch token yet; will retry`)
      continue
    }
    if (await register(tenant, target, token, nodeAddress)) {
      reported.set(tenant, signature)
      console.log(`mt-node-agent: registered ${tenant} -> ${target}`)
    }
  }
}

/** Resolve the address the control plane should use for this agent. */
function resolveNodeAddress() {
  if (NODE_ADDRESS !== '') return NODE_ADDRESS
  const os = require('node:os')
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

const nodeAddress = resolveNodeAddress()

/**
 * Operations the control plane may ask this node to run.
 *
 * A fixed table rather than a command endpoint, and that is the whole point: the
 * control plane is reachable by anyone who can sign in to the console, so an
 * endpoint that ran what it was told would turn a stolen administrator session
 * into code execution on every node. Each entry names one script and one argv,
 * and its parameters are validated here before anything is spawned. Nothing is
 * passed through a shell.
 *
 * `timeoutMs` is per operation because they are not alike: listing backups is
 * instant, a rolling upgrade recreates every tenant container in turn.
 */
const OPS = {
  'disk-report': {
    script: 'bin/disk.sh',
    argv: () => ['report'],
    timeoutMs: 60_000,
  },
  'disk-prune-images': {
    script: 'bin/disk.sh',
    argv: () => ['prune-images', '--yes'],
    timeoutMs: 300_000,
  },
  'disk-prune-sessions': {
    script: 'bin/disk.sh',
    argv: (params) => [
      'prune-sessions',
      '--older-than', String(params.olderThan),
      '--archive',
      ...(params.dryRun === true ? ['--dry-run'] : []),
      ...(params.tenant === undefined ? [] : ['--tenant', params.tenant]),
    ],
    // Days, not a free string: find's -mtime takes a number and nothing else.
    validate: (params) => {
      if (!Number.isInteger(params.olderThan) || params.olderThan < 0 || params.olderThan > 3650) {
        return 'olderThan 必须是 0..3650 的整数天'
      }
      if (params.tenant !== undefined && !isTenantId(params.tenant)) return 'tenant 不是合法的租户 id'
      return undefined
    },
    timeoutMs: 600_000,
  },
  backup: {
    script: 'bin/backup.sh',
    argv: () => [],
    timeoutMs: 900_000,
  },
  restore: {
    script: 'bin/restore.sh',
    argv: (params) => [path.join(PROJECT_DIR, 'backups', params.archive)],
    // Only an archive already in this node's backup directory, by exact name: a
    // path built from operator input is how a restore becomes "unpack anything
    // as root".
    validate: (params) => (typeof params.archive === 'string' && /^dsh-mt-[0-9]{8}T[0-9]{6}Z\.tar\.gz$/u.test(params.archive)
      ? undefined
      : 'archive 必须是本节点 backups/ 里的归档文件名'),
    timeoutMs: 900_000,
  },
  upgrade: {
    script: 'bin/upgrade.sh',
    argv: (params) => [
      '--image', params.image,
      ...(params.tenants === undefined ? [] : ['--tenants', params.tenants]),
    ],
    validate: (params) => {
      if (typeof params.image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,200}$/u.test(params.image)) {
        return 'image 不是合法的镜像引用'
      }
      if (params.tenants !== undefined && !/^([a-z0-9][a-z0-9-]{0,30})(,[a-z0-9][a-z0-9-]{0,30})*$/u.test(params.tenants)) {
        return 'tenants 必须是逗号分隔的租户 id'
      }
      return undefined
    },
    timeoutMs: 1_800_000,
  },
}

/**
 * Settings the console may read, and the only one it may write.
 *
 * An explicit list rather than "the .env": that file holds the model API key, and
 * a console endpoint that returns it would hand every administrator a credential
 * the deployment is built to keep inside one container. Anything not named here is
 * invisible to the console by construction.
 */
const CONFIG_READABLE = [
  'MT_EGRESS_ALLOW',
  'MT_UPSTREAM_BASE',
  'MT_BACKUP_KEEP',
  'MT_BACKUP_INTERVAL_SECONDS',
  'MT_LOG_MAX_SIZE',
  'MT_LOG_MAX_FILE',
  'MT_TENANT_NETWORKS',
  'MT_EDGE_PORT',
  'MT_HTTP_PORT',
  'MT_EGRESS_PORT',
]

/** Read those settings from the node's .env. */
function readConfig() {
  const file = path.join(PROJECT_DIR, '.env')
  const values = {}
  if (!fs.existsSync(file)) return values
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (!CONFIG_READABLE.includes(key)) continue
    values[key] = line.slice(at + 1).trim()
  }
  return values
}

/**
 * Set the egress allowlist and reload the proxy.
 *
 * Comma-separated host suffixes, which is what the proxy compares against; empty
 * means "any public destination". The value reaches `.env`, then the proxy is
 * recreated from it — the two steps are fixed here rather than taken as input.
 */
function setEgressAllow(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9.,:_-]{0,500}$/u.test(value)) {
    return { status: 400, body: { ok: false, error: '出口白名单只能包含字母、数字、点、逗号、冒号、下划线和短横线' } }
  }
  // A file the proxy re-reads, not an environment variable: the proxy would need
  // recreating for an environment change, and neither this agent nor the console
  // can do that. Written in place so a watcher holds the same inode.
  const file = path.join(PROJECT_DIR, 'state', 'egress-allow.txt')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, value, { mode: 0o600 })
  const count = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '').length
  return {
    status: 200,
    body: {
      ok: true,
      value,
      output: count === 0
        ? '出口白名单已清空：租户可以访问任意公网地址（私网仍然拒绝）。'
        : `出口白名单已设为 ${String(count)} 条：${value}。出口代理会在下次请求时自动读取，无需重启。`,
    },
  }
}

/** Tenant ids are constrained at creation; this repeats the rule before use. */
function isTenantId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/u.test(value)
}

/**
 * Run one allowlisted operation.
 *
 * @param name - an OPS key.
 * @param params - the operation's parameters, validated before spawning.
 * @returns the exit status and the combined output, truncated for transport.
 */
function runOp(name, params) {
  return new Promise((resolve) => {
    const op = OPS[name]
    if (op === undefined) {
      resolve({ status: 400, body: { ok: false, error: `未知操作 ${name}` } })
      return
    }
    if (PROJECT_DIR === '') {
      resolve({ status: 503, body: { ok: false, error: 'this agent has no MT_PROJECT_DIR, so it cannot run operations' } })
      return
    }
    const rejected = op.validate?.(params)
    if (rejected !== undefined) {
      resolve({ status: 400, body: { ok: false, error: rejected } })
      return
    }
    let argv
    try {
      argv = op.argv(params)
    } catch (error) {
      resolve({ status: 400, body: { ok: false, error: `参数无效：${error.message}` } })
      return
    }

    // One mutating operation at a time, decided here rather than by whoever called:
    // the agent is the only place that knows what is actually running.
    let marker
    if (MUTATING_OPS.has(name)) {
      const busy = busyWith()
      if (busy !== undefined) {
        const seconds = Number.isFinite(busy.startedAt) ? Math.round((Date.now() - busy.startedAt) / 1000) : undefined
        resolve({
          status: 409,
          body: {
            ok: false,
            busy: true,
            error: `正在执行 ${String(busy.op)}${seconds === undefined ? '' : `（已 ${String(seconds)} 秒）`}，请等它结束再执行 ${name}`,
          },
        })
        return
      }
      marker = { op: name, pid: process.pid, startedAt: Date.now() }
      running = marker
      writeMarker(marker)
    }

    // No shell: argv is passed straight to the script, so a parameter can never
    // become a second command however it is written.
    const child = spawn('bash', [path.join(PROJECT_DIR, op.script), ...argv], {
      cwd: PROJECT_DIR,
      env: { ...process.env, MT_NODE_NAME: NODE_NAME },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk) => {
      // Bounded: an upgrade prints a lot, and the control plane has to carry it.
      if (output.length < 200_000) output += chunk.toString()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      output += `\n[${name} 超时，已终止]`
    }, op.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ status: 500, body: { ok: false, error: error.message } })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // Release the mutex here rather than at every exit path: this fires for a
      // clean exit, a failure and the timeout kill alike.
      if (marker !== undefined) {
        running = undefined
        writeMarker(undefined)
      }
      const ok = code === 0
      console.log(`mt-node-agent: op ${name} ${ok ? 'ok' : `exit ${String(code)}`}`)
      resolve({
        status: ok ? 200 : 500,
        body: { ok, code, op: name, output: output.length > 200_000 ? `${output.slice(0, 200_000)}\n[输出已截断]` : output },
      })
    })
  })
}

/**
 * Operations that change something, and therefore may not run at the same time.
 *
 * Two administrators pressing upgrade and prune inside the same minute is not a
 * hypothetical: both walk the tenant set, and one recreating containers while the
 * other pauses them to archive is how a backup ends up half a rebuild. Read-only
 * operations are deliberately absent — an operator must be able to read a disk
 * report while an upgrade is running.
 */
const MUTATING_OPS = new Set(['disk-prune-images', 'disk-prune-sessions', 'backup', 'restore', 'upgrade'])

/** The mutating operation currently running, if any. */
let running

const runMarker = () => path.join(PROJECT_DIR === '' ? '.' : PROJECT_DIR, 'state/ops-running.json')

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(runMarker(), 'utf8'))
  } catch (error) {
    // No marker, or one that cannot be read: either way nothing is known to be
    // running, which is the state that lets work proceed.
    if (error.code !== 'ENOENT') console.error(`mt-node-agent: unreadable operation marker: ${error.message}`)
    return undefined
  }
}

function writeMarker(value) {
  try {
    if (value === undefined) fs.rmSync(runMarker(), { force: true })
    else fs.writeFileSync(runMarker(), `${JSON.stringify(value)}\n`, { mode: 0o600 })
  } catch (error) {
    console.error(`mt-node-agent: cannot write the operation marker: ${error.message}`)
  }
}

/**
 * What mutating operation is in flight, if any.
 *
 * Kept in memory and mirrored to a file: a child process outlives this agent's
 * restart, so the marker is what stops a second one from starting on top of it, and
 * what lets the agent say what was interrupted rather than pretending nothing was.
 */
function busyWith() {
  if (running !== undefined) return running
  const marker = readMarker()
  if (marker === undefined) return undefined
  if (Number.isInteger(marker.pid) && marker.pid !== process.pid && !fs.existsSync(`/proc/${String(marker.pid)}`)) {
    writeMarker(undefined)
    return undefined
  }
  return marker
}

/** Whether a request carries this agent's registry key. */
function authorized(req) {
  const presented = req.headers['x-mt-registry-key']
  return typeof presented === 'string' && presented !== '' && presented === registryKey
}

/**
 * Pull the registry from the control plane, then (optionally) provision.
 *
 * Provisioning runs the node's own `bin/mt.sh up`, which renders each assigned
 * tenant's profile patch and starts its container. Discovery picks the new
 * runtime up on the next pass and registers it, so nothing here reports it.
 *
 * @param provision - whether to run `up` after syncing, or only sync.
 * @returns an HTTP status and body for the caller.
 */
async function handleProvision(provision) {
  if (REGISTRY_SYNC) {
    try {
      await syncRegistry()
    } catch (error) {
      return { status: 502, body: { ok: false, error: `registry sync failed: ${error.message}` } }
    }
  }
  if (!provision) return { status: 200, body: { ok: true, synced: REGISTRY_SYNC } }
  const result = await runProject(['up'])
  // A tenant is usable once discovery has seen it and the control plane has
  // accepted the registration, which happens after `up` returns.
  await sync(nodeAddress, true).catch(() => {})
  return {
    status: result.ok ? 200 : 500,
    body: { ok: result.ok, exit: result.code, tail: result.output.split('\n').slice(-25).join('\n') },
  }
}

/**
 * Change one tenant's container state on this node.
 *
 * `remove` also takes the tenant's data when asked, which is the only operation
 * here that cannot be undone.
 *
 * @param tenant - tenant id.
 * @param action - start, stop, restart, or remove.
 * @param req - the request, read for `remove`'s purge flag.
 * @returns an HTTP status and body for the caller.
 */
async function handleLifecycle(tenant, action, req) {
  if (!/^[a-z][a-z0-9-]{1,30}$/u.test(tenant)) {
    return { status: 400, body: { ok: false, error: 'invalid tenant id' } }
  }
  const found = await discover()
  const runtime = found.get(tenant)
  // A stopped container is absent from discovery but still this node's to manage.
  const existing = runtime?.container ?? await containerOf(tenant)
  const container = existing ?? `${process.env.MT_CONTAINER_NAME_PREFIX ?? 'mt-'}dsh-${tenant}`

  if (action === 'remove') {
    const body = await readJsonBody(req).catch(() => ({}))
    const purge = body?.purge === true
    const home = process.env.MT_DATA_ROOT === undefined ? undefined : path.join(process.env.MT_DATA_ROOT, 'tenants', tenant)
    if (home !== undefined && !home.startsWith(path.join(process.env.MT_DATA_ROOT, 'tenants') + path.sep)) {
      return { status: 400, body: { ok: false, error: 'refusing to remove a path outside the tenant data root' } }
    }
    if (existing !== undefined) await runProject(['remove', tenant, ...(purge ? ['--purge'] : [])])
    else if (purge && home !== undefined) fs.rmSync(home, { recursive: true, force: true })
    reported.delete(tenant)
    return { status: 200, body: { ok: true, tenant, purged: purge } }
  }

  // `start` is `up` for the whole node: compose starts whatever is stopped and
  // leaves running tenants alone, so a stopped tenant needs no discovery entry.
  if (action === 'start' && existing === undefined && runtime === undefined) {
    const result = await runProject(['up'])
    await sync(nodeAddress, true).catch(() => {})
    return { status: result.ok ? 200 : 500, body: { ok: result.ok, tail: result.output.split('\n').slice(-15).join('\n') } }
  }
  if (existing === undefined) {
    return { status: 404, body: { ok: false, error: `tenant ${tenant} has no runtime on node ${NODE_NAME}` } }
  }
  if (action === 'start') {
    const result = await runProject(['up'])
    await sync(nodeAddress, true).catch(() => {})
    return { status: result.ok ? 200 : 500, body: { ok: result.ok, tail: result.output.split('\n').slice(-15).join('\n') } }
  }
  if (action === 'stop') {
    await stopContainer(container)
    reported.delete(tenant)
    await sync(nodeAddress, true).catch(() => {})
    return { status: 200, body: { ok: true, tenant, action: 'stop' } }
  }
  const result = await runProject(['restart', tenant])
  await sync(nodeAddress, true).catch(() => {})
  return { status: result.ok ? 200 : 500, body: { ok: result.ok, tenant, action, tail: result.output.split('\n').slice(-15).join('\n') } }
}

/**
 * Stop one container through the Docker API.
 * @param container - container name.
 * @returns nothing; a container that is already gone is not an error.
 */
function stopContainer(container) {
  return new Promise((resolve) => {
    const request = http.request({
      socketPath: DOCKER_SOCKET,
      path: `/containers/${encodeURIComponent(container)}/stop?t=10`,
      method: 'POST',
      timeout: 20_000,
    }, (response) => { response.resume(); response.on('end', resolve) })
    request.on('timeout', () => { request.destroy(); resolve() })
    request.on('error', () => resolve())
    request.end()
  })
}

// ---------------------------------------------------------------------------
// proxy: forward the control plane's requests to the local container
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://agent.invalid')

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, node: NODE_NAME, address: nodeAddress, docker: dockerAvailable, provision: PROJECT_DIR !== '', tenants: [...reported.keys()], busy: busyWith() ?? null }))
    return
  }

  // Lifecycle: the control plane holds no Docker access, so anything that
  // changes a container here arrives through this agent.
  const lifecycle = /^\/tenants\/([^/]+)\/(start|stop|restart|remove)$/u.exec(url.pathname)
  if (lifecycle !== null) {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'bad registry key' }))
      return
    }
    const [, tenant, action] = lifecycle
    handleLifecycle(tenant, action, req).then((outcome) => {
      res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(outcome.body))
    }).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: error.message }))
    })
    return
  }

  // Allowlisted host operations, for the console's maintenance sections. The
  // operation name selects a fixed script and argv; nothing here is interpreted.
  if (url.pathname === '/ops') {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'bad registry key' }))
      return
    }
    readJsonBody(req).catch(() => ({})).then((body) => {
      const name = typeof body?.op === 'string' ? body.op : ''
      const params = typeof body?.params === 'object' && body.params !== null ? body.params : {}
      // Two settings operations answer in-process rather than through a script:
      // they are a read of a fixed key list and a write of one validated value.
      // Recreating the proxy stays inside the operation rather than being a step
      // the caller could aim somewhere else.
      if (name === 'backup-list') {
        // A read of the backup directory, not a script: naming the archives and
        // their sizes is all this needs, and the names are exactly what the
        // restore operation validates against.
        const dir = path.join(PROJECT_DIR, 'backups')
        let entries = []
        try {
          entries = fs.readdirSync(dir)
            .filter((entry) => /^dsh-mt-[0-9]{8}T[0-9]{6}Z\.tar\.gz$/u.test(entry))
            .map((entry) => {
              const stat = fs.statSync(path.join(dir, entry))
              return { entry, bytes: stat.size, at: stat.mtime.toISOString() }
            })
            .sort((left, right) => right.at.localeCompare(left.at))
        } catch (error) {
          return { status: 200, body: { ok: true, output: `读不到备份目录：${error.message}` } }
        }
        const text = entries.length === 0
          ? '还没有备份归档。'
          : entries.map((row) => `${row.entry}  ${(row.bytes / 1048576).toFixed(1)} MB  ${row.at}`).join('\n')
        return { status: 200, body: { ok: true, output: text, backups: entries.map((row) => row.entry) } }
      }
      if (name === 'config-get') {
        return { status: 200, body: { ok: true, output: JSON.stringify(readConfig(), null, 2) } }
      }
      if (name === 'config-set-egress-allow') return Promise.resolve(setEgressAllow(params.value))
      return runOp(name, params)
    }).then((outcome) => {
      res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(outcome.body))
    }).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: error.message }))
    })
    return
  }

  if (url.pathname === '/provision' || url.pathname === '/registry/sync') {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'bad registry key' }))
      return
    }
    if (PROJECT_DIR === '') {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'this agent has no MT_PROJECT_DIR, so it cannot provision' }))
      return
    }
    if (url.pathname === '/registry/sync' && !REGISTRY_SYNC) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'registry sync is disabled on this agent (MT_REGISTRY_SYNC is not set)' }))
      return
    }
    handleProvision(url.pathname === '/provision').then((outcome) => {
      res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(outcome.body, null, 2))
    }).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: error.message }))
    })
    return
  }

  if (url.pathname === '/sync') {
    sync(nodeAddress, url.searchParams.get('force') === '1').then(() => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, tenants: [...reported.keys()] }))
    }).catch((error) => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`${error.message}\n`)
    })
    return
  }

  const match = /^\/proxy\/([^/]+)(\/.*)?$/u.exec(url.pathname)
  if (match === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found\n')
    return
  }
  const tenant = match[1]
  const rest = match[2] === undefined || match[2] === '' ? '/' : match[2]
  discover().then((found) => {
    const runtime = found.get(tenant)
    if (runtime === undefined) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`tenant ${tenant} has no runtime on node ${NODE_NAME}\n`)
      return
    }
    const upstream = http.request({
      host: runtime.ip,
      port: runtime.port,
      method: req.method,
      path: `${rest}${url.search}`,
      // Keep the Host the control plane chose: DSH derives its cookie name from it.
      headers: { ...req.headers, host: req.headers.host },
      agent: false,
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`node agent: upstream ${runtime.ip}:${String(runtime.port)} failed: ${error.message}\n`)
      } else {
        res.destroy()
      }
    })
    req.pipe(upstream)
  }).catch((error) => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`node agent: discovery failed: ${error.message}\n`)
  })
})

// WebSocket and other upgrades take the same path, byte for byte.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://agent.invalid')
  const match = /^\/proxy\/([^/]+)(\/.*)?$/u.exec(url.pathname)
  if (match === null) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    return
  }
  const tenant = match[1]
  const rest = match[2] === undefined || match[2] === '' ? '/' : match[2]
  discover().then((found) => {
    const runtime = found.get(tenant)
    if (runtime === undefined) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    const upstream = net.connect(runtime.port, runtime.ip, () => {
      const lines = [`${req.method} ${rest}${url.search} HTTP/1.1`]
      for (const [name, value] of Object.entries(req.headers)) {
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
    socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n')
  })
})

server.listen(PORT, BIND, () => {
  console.log(`mt-node-agent listening on ${BIND}:${String(PORT)} as node "${NODE_NAME}" (${nodeAddress})`)
  console.log(`mt-node-agent control plane ${CONTROL_PLANE}, docker discovery ${dockerAvailable ? 'on' : 'off (static mapping)'}`)
  sync(nodeAddress).catch((error) => { console.error(`mt-node-agent: first sync failed: ${error.message}`) })
  setInterval(() => { sync(nodeAddress).catch(() => {}) }, SYNC_INTERVAL_MS)
})
