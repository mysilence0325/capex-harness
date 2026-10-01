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
/** Static mapping used when the Docker socket is absent: `alpha=http://ip:port,...` */
const STATIC_TENANTS = process.env.MT_TENANTS ?? ''
const SYNC_INTERVAL_MS = Number(process.env.MT_SYNC_INTERVAL ?? 15) * 1000
const TOKEN_PATTERN = /dsh web:\s*(\S+)/gu

const registryKey = fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : ''
const ca = CA_FILE !== '' && fs.existsSync(CA_FILE) ? fs.readFileSync(CA_FILE) : undefined
const dockerAvailable = fs.existsSync(DOCKER_SOCKET)

if (CONTROL_PLANE === '') {
  console.error('mt-node-agent: MT_CONTROL_PLANE is required (e.g. https://control.example:8090)')
  process.exit(1)
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
    // Only containers on the configured network: falling back to whichever
    // network a container happens to have would make this agent claim runtimes
    // that belong to another node.
    const ip = container.NetworkSettings?.Networks?.[NETWORK]?.IPAddress
    if (typeof ip !== 'string' || ip === '') continue
    // The port comes from the runtime's own printed URL; the image's EXPOSE is
    // only a default and every tenant here overrides it.
    const { port } = await currentRuntime(name)
    if (port === undefined) {
      console.log(`mt-node-agent: ${name} has not printed its URL yet; skipping this pass`)
      continue
    }
    found.set(id, { ip, port, container: name })
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

// ---------------------------------------------------------------------------
// proxy: forward the control plane's requests to the local container
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://agent.invalid')

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, node: NODE_NAME, address: nodeAddress, docker: dockerAvailable, tenants: [...reported.keys()] }))
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
