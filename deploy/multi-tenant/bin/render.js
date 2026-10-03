/**
 * Render the multi-tenant deployment from one registry.
 *
 * Reads `tenants.json` + `.env`, then writes:
 *   docker-compose.yml                        — gateway + one service per tenant
 *   tenants/<id>/home/profiles/web/*.yml      — that tenant's profile patch (created once)
 *   tenants/<id>/home, tenants/<id>/workspace — that tenant's private DSH_HOME and workspace
 *
 * The generated compose is a build artifact: edit `tenants.json`, then rerun
 * `bin/mt.sh render`. Existing tenant homes are never overwritten unless
 * `--force-patch` is passed, so a tenant's own settings survive a redeploy.
 *
 * Usage: node bin/render.js [--force-patch]
 */

'use strict'

const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const keys = require('../gateway/keys.js')

const ROOT = path.resolve(__dirname, '..')
const ARGV = process.argv.slice(2)
const FORCE_PATCH = ARGV.includes('--force-patch')

/** `--only <id>`: touch one tenant's patch (the acceptance run uses this). */
function flagValue(name) {
  const at = ARGV.indexOf(`--${name}`)
  return at === -1 ? undefined : ARGV[at + 1]
}
const ONLY = flagValue('only')
/** `--model-block <file>`: use another model declaration for this render. */
const MODEL_BLOCK_FILE = flagValue('model-block')

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'tenants.json'), 'utf8'))
const tenants = registry.tenants ?? []

if (tenants.length === 0) {
  console.error('tenants.json declares no tenants')
  process.exit(1)
}

const envKeyFor = (tenant, suffix) =>
  `MT_${tenant.id.toUpperCase().replaceAll('-', '_')}_${suffix}`

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

const ids = new Set()
const ports = new Set()
const edgePorts = new Set()
for (const tenant of tenants) {
  if (!/^[a-z][a-z0-9-]{1,30}$/u.test(tenant.id ?? '')) {
    console.error(`tenant id must be lowercase alphanumeric with dashes: ${JSON.stringify(tenant.id)}`)
    process.exit(1)
  }
  if (ids.has(tenant.id)) {
    console.error(`duplicate tenant id: ${tenant.id}`)
    process.exit(1)
  }
  ids.add(tenant.id)
  if (!Number.isInteger(tenant.internalPort)) {
    console.error(`tenant ${tenant.id} needs an integer internalPort`)
    process.exit(1)
  }
  if (ports.has(tenant.internalPort)) {
    console.error(`duplicate internalPort: ${String(tenant.internalPort)}`)
    process.exit(1)
  }
  ports.add(tenant.internalPort)
  if (tenant.edgePort !== undefined) {
    if (!Number.isInteger(tenant.edgePort)) {
      console.error(`tenant ${tenant.id}: edgePort must be an integer`)
      process.exit(1)
    }
    if (edgePorts.has(tenant.edgePort)) {
      console.error(`duplicate edgePort: ${String(tenant.edgePort)}`)
      process.exit(1)
    }
    edgePorts.add(tenant.edgePort)
  }
  if (!Array.isArray(tenant.users) || tenant.users.length === 0) {
    console.error(`tenant ${tenant.id} needs at least one user`)
    process.exit(1)
  }
  for (const user of tenant.users) {
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(user.name ?? '')) {
      console.error(`tenant ${tenant.id}: invalid user name ${JSON.stringify(user.name)}`)
      process.exit(1)
    }
    if (typeof user.passwordHash !== 'string' || !user.passwordHash.startsWith('scrypt$')) {
      console.error(`tenant ${tenant.id}/${user.name}: passwordHash must be scrypt$<salt>$<digest>`)
      process.exit(1)
    }
  }
}

// 分用途密钥：首次渲染时生成，并把代理需要的两把写成文件挂给它。
//
// 代理入站 /ops 用运维密钥、出站注册用注册密钥。网关替控制台调代理时也出示运维密钥，
// 所以控制台在拆分后照常工作——但前提是这两端都能读到各自的密钥文件。
//
// 注意常量名是 ROOT（大写）：写成 root 会让渲染直接崩溃，而崩溃的表现是
// "compose 没更新"，看起来像渲染没跑，不像代码写错了。
const KEY_STATE_DIR = path.join(ROOT, 'state')
keys.generateKeys(KEY_STATE_DIR)
for (const purpose of ['ops', 'register']) {
  fs.writeFileSync(path.join(KEY_STATE_DIR, `${purpose}.key`), `${keys.readKeys(KEY_STATE_DIR)[purpose]}\n`, {
    mode: 0o600,
  })
}

const edgePort = Number(process.env.MT_EDGE_PORT ?? 8090)
if (edgePorts.has(edgePort)) {
  console.error(`tenant edgePort ${String(edgePort)} collides with MT_EDGE_PORT`)
  process.exit(1)
}

// The shared login entry has no tenant field: it resolves the tenant from the
// username. A name used by several tenants is therefore only reachable through
// those tenants' dedicated entries — allowed, but the operator must know.
const userOwners = new Map()
for (const tenant of tenants) {
  for (const user of tenant.users) {
    userOwners.set(user.name, [...(userOwners.get(user.name) ?? []), tenant.id])
  }
}
const sharedUsers = [...userOwners.entries()].filter(([, owners]) => owners.length > 1)

const MODEL_PATCH_FILE = MODEL_BLOCK_FILE === undefined
  ? path.join(ROOT, 'model.patch.yml')
  : path.resolve(ROOT, MODEL_BLOCK_FILE)
const MODEL_ENV_FILE = path.join(ROOT, 'model.env')
const MARK_BEGIN = '# >>> dsh-mt model config (maintained by bin/render.js, do not edit this line) >>>'
const MARK_END = '# <<< dsh-mt model config <<<'
const TRUST_BEGIN = '# >>> dsh-mt host trust (maintained by bin/render.js, do not edit this line) >>>'
const TRUST_END = '# <<< dsh-mt host trust <<<'

/**
 * Shared model declaration every tenant receives, when it is filled in.
 * @returns the YAML entries to append, or undefined while the template is untouched.
 */
function sharedModelEntries() {
  if (!fs.existsSync(MODEL_PATCH_FILE)) return undefined
  const text = fs.readFileSync(MODEL_PATCH_FILE, 'utf8')
  if (text.includes('CHANGE-ME')) return undefined
  const entries = text.split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim()
  return entries === '' ? undefined : entries
}

/**
 * Splice one generated block into a tenant patch, preserving everything the
 * tenant's own settings UI may have written outside the marked block.
 *
 * The block is delimited by comment lines, so re-rendering replaces it in place
 * and never duplicates it. A missing file is always written: a tenant whose
 * blocks are both empty would otherwise get no patch at all and DSH would fall
 * back to the profile template, listening on its default port instead of the
 * assigned one.
 *
 * @param patchFile - the tenant's profile patch path.
 * @param tenant - tenant record, for the base patch text when the file is new.
 * @param markBegin - opening marker line.
 * @param markEnd - closing marker line.
 * @param block - YAML to place between the markers, or undefined to strip a stale block.
 * @returns whether the file changed.
 */
function spliceBlock(patchFile, tenant, markBegin, markEnd, block) {
  const existed = fs.existsSync(patchFile)
  const base = existed ? fs.readFileSync(patchFile, 'utf8') : profilePatch(tenant)
  const kept = []
  let skipping = false
  for (const line of base.split('\n')) {
    if (line === markBegin) { skipping = true; continue }
    if (line === markEnd) { skipping = false; continue }
    if (!skipping) kept.push(line)
  }
  const body = kept.join('\n').trimEnd()
  const next = block === undefined
    ? body + '\n'
    : `${body}\n\n${markBegin}\n${block}\n${markEnd}\n`
  if (next === base && existed) return false
  fs.writeFileSync(patchFile, next, { mode: 0o600 })
  return true
}

/** The model block, spliced with the shared entries from model.patch.yml. */
function spliceModelBlock(patchFile, tenant, entries) {
  return spliceBlock(patchFile, tenant, MARK_BEGIN, MARK_END, entries)
}

/**
 * The Host/Origin trust block.
 *
 * DSH's fence rejects any non-loopback request authority it was not told about,
 * answering 403 to `/api/*` — so a tenant whose patch lacks this block loads the
 * UI but cannot call a single API. It is a spliced block rather than part of the
 * base patch so existing tenants pick it up on the next render without losing
 * the settings their own UI wrote.
 *
 * @param patchFile - the tenant's profile patch path.
 * @param tenant - tenant record.
 * @returns whether the file changed.
 */
function spliceTrustBlock(patchFile, tenant) {
  const block = `- id: connection
  config:
    trustedHosts:
      - ${tenantAuthorityName(tenant)}`
  return spliceBlock(patchFile, tenant, TRUST_BEGIN, TRUST_END, block)
}

// ---------------------------------------------------------------------------
// per-tenant directories and profile patch
// ---------------------------------------------------------------------------

/**
 * The patch each tenant home starts with.
 *
 * `webserver.host: 0.0.0.0` is what makes a bridge-networked tenant reachable
 * from the gateway container: DSH's CLI refuses `--host 0.0.0.0` because that
 * would expose a remote-code-execution surface on a host network, while here
 * the port is reachable only inside the compose network, behind the gateway.
 *
 * @param tenant - tenant record from the registry.
 * @returns the YAML patch text.
 */
/**
 * Authority DSH sees as its own Host for this tenant.
 *
 * A stable name rather than `127.0.0.1:<port>`: DSH derives its browser cookie
 * name from this string, so two runtimes that happened to use the same loopback
 * port on different hosts would otherwise share a cookie name. The gateway
 * sends exactly this as the Host header.
 */
const tenantAuthorityName = (tenant) => `dsh-${tenant.id}.internal`

function profilePatch(tenant) {
  return `# Generated by bin/render.js from tenants.json — tenant "${tenant.id}".
# After first creation this is the tenant's own profile patch: DSH's settings UI
# writes here, so later renders leave it alone (use --force-patch to regenerate).
#
# webserver.host 0.0.0.0 is required for the control plane to reach this runtime
# over the compose network. No port of this container is published on the host;
# the gateway is the only published entry.
- id: webserver
  config:
    host: 0.0.0.0
    port: ${String(tenant.internalPort)}
`
}

const modelEntries = sharedModelEntries()
const createdPatches = []
const modelApplied = []
const trustApplied = []
const remoteTenants = []
/**
 * Which machine this render is for.
 *
 * The control plane renders for `local`; a worker node sets `MT_NODE_NAME` to its
 * own name and renders the tenants assigned to it (plus the node-local helpers),
 * which is how a node creates its own containers instead of an operator starting
 * them by hand.
 */
const THIS_NODE = process.env.MT_NODE_NAME ?? 'local'
const isControlPlane = THIS_NODE === 'local'
/**
 * Docker network the tenant runtimes join.
 *
 * Configurable so several nodes can share one development host, and so a Swarm
 * deployment can name its overlay instead of the compose bridge.
 */
const NETWORK_NAME = process.env.MT_NETWORK ?? 'mt-net'
/**
 * Whether the network already exists on this host.
 *
 * Compose refuses a network it did not create unless it is declared external.
 * Set MT_NETWORK_EXTERNAL=1 on a host where the network is managed elsewhere —
 * a pre-created bridge on a shared machine, or an overlay in a Swarm.
 */
const NETWORK_EXTERNAL = (process.env.MT_NETWORK_EXTERNAL ?? '') !== ''
/**
 * Interface name for this network's bridge.
 *
 * Kernel interface names are limited to fifteen characters, and the default
 * `br-<id>` is regenerated whenever the network is recreated — taking the
 * firewall rules that reference it out of effect without any error. Pinning it
 * is what makes those rules survive a rebuild.
 */
const bridgeName = () => (envValues.get('MT_BRIDGE_NAME') ?? process.env.MT_BRIDGE_NAME ?? 'mtdocker0').trim()
/**
 * Explicit subnet for the main network, when the operator sets one.
 *
 * Docker otherwise takes it from its default address pools, and on a machine
 * where other stacks have used them up the network cannot be created at all —
 * which is what a fresh install hits on a shared host, and what a from-scratch
 * rehearsal of the rebuild runbook actually hit. The isolated tenant networks
 * always carry an explicit subnet; this lets the main one as well. Left unset in
 * an existing deployment so its network is not renumbered.
 */
/**
 * The project's path on the host, which is not where this renderer sees it: it
 * runs in a container with the project at /w, while the host — and the Docker
 * daemon that resolves bind-mount sources — has it at its real path.
 *
 * Read lazily, like the other settings that come from .env: that map is filled
 * further down this file, and a constant here would read it before it exists.
 */
const hostRoot = () => (envValues.get('MT_HOST_PROJECT_DIR') ?? process.env.MT_HOST_PROJECT_DIR ?? ROOT).trim()
const networkSubnet = () => (envValues.get('MT_NETWORK_SUBNET') ?? process.env.MT_NETWORK_SUBNET ?? '').trim()
/**
 * Prefix for the container names this host creates.
 *
 * Container names are local to a host (the control plane addresses tenants by
 * what a node registered, never by container name), so two nodes sharing one
 * Docker daemon — a test setup, or a machine hosting more than one role — need
 * distinct names to avoid colliding on the shared helpers.
 */
const NAME_PREFIX = process.env.MT_CONTAINER_NAME_PREFIX ?? 'mt-'

/** Whether this node runs the tenant. */
const isLocalTenant = (tenant) => (tenant.node ?? 'local') === THIS_NODE

for (const tenant of tenants) {
  // A tenant assigned elsewhere keeps its data and its containers there; this
  // host only needs its registry entry, so it must not create a second home or a
  // compose service that would start a duplicate runtime.
  if (!isLocalTenant(tenant)) {
    remoteTenants.push(tenant.id)
    continue
  }
  const home = path.join(ROOT, 'tenants', tenant.id, 'home')
  const workspace = path.join(ROOT, 'tenants', tenant.id, 'workspace')
  const profileDir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(workspace, { recursive: true })
  if (ONLY !== undefined && tenant.id !== ONLY) continue
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  if (FORCE_PATCH) {
    fs.writeFileSync(patchFile, profilePatch(tenant), { mode: 0o600 })
    createdPatches.push(tenant.id)
  }
  if (spliceModelBlock(patchFile, tenant, modelEntries)) modelApplied.push(tenant.id)
  // 老租户的 patch 里可能没有信任块：渲染时补上，缺了它 DSH 会对所有 /api/* 回 403。
  if (spliceTrustBlock(patchFile, tenant)) trustApplied.push(tenant.id)
}

// ---------------------------------------------------------------------------
// .env keys each tenant needs
// ---------------------------------------------------------------------------

const envFile = path.join(ROOT, '.env')
if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, '# Generated by bin/render.js — fill in model credentials.\n', { mode: 0o600 })
let envText = fs.readFileSync(envFile, 'utf8')
const addedKeys = []
for (const tenant of tenants) {
  const block = [
    envKeyFor(tenant, 'GATEWAY_API_KEY'),
    envKeyFor(tenant, 'DEEPSEEK_API_KEY'),
  ]
  let append = ''
  for (const key of block) {
    if (!new RegExp(`^${key}=`, 'mu').test(envText)) {
      append += `${key}=\n`
      addedKeys.push(key)
    }
  }
  if (append !== '') {
    envText += `\n# 租户 ${tenant.id} 的模型凭据（可用 bin/mt.sh key ${tenant.id} <value> 写入）\n${append}`
  }
}
if (addedKeys.length > 0) fs.writeFileSync(envFile, envText, { mode: 0o600 })

/** TLS material for the gateway, present once bin/make-cert.sh has run. */
const TLS_CERT_FILE = path.join(ROOT, 'state', 'tls', 'server.crt')
const TLS_KEY_FILE = path.join(ROOT, 'state', 'tls', 'server.key')
const TLS_READY = fs.existsSync(TLS_CERT_FILE) && fs.existsSync(TLS_KEY_FILE)

/**
 * Hosts a tenant reaches directly.
 *
 * The egress proxy refuses private addresses, which is what keeps a tenant out
 * of the internal network, so anything this deployment runs itself must bypass
 * it: `mock-model` is the acceptance harness's stand-in provider, and
 * `mt-model-gateway` is where tenant model calls actually go.
 */
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,mock-model,mt-model-gateway'
/** Port the egress proxy listens on. Read lazily: `.env` is parsed further down. */
const egressPort = () => Number(envValues.get('MT_EGRESS_PORT') ?? '3128')

/** Where tenants send model requests: the gateway that holds the real credential. */
const MODEL_GATEWAY_URL = 'http://mt-model-gateway:8080'

// ---------------------------------------------------------------------------
// compose file
// ---------------------------------------------------------------------------

/** Values from .env, for deciding which per-tenant overrides are actually set. */
const envValues = new Map()
for (const line of (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '').split('\n')) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#') || !trimmed.includes('=')) continue
  const at = trimmed.indexOf('=')
  envValues.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim())
}

/**
 * Emit a container environment line only when the tenant has its own value.
 *
 * `environment` wins over `env_file` in compose, so an unconditional line with an
 * empty default would override the shared credential a tenant inherits from
 * model.env. Omitting the line leaves env_file in charge.
 *
 * @param name - container variable name.
 * @param tenantVar - .env key holding this tenant's own value, if any.
 * @returns one indented compose line, or an empty string.
 */
function credentialLine(name, tenantVar) {
  return envValues.get(tenantVar) ? `      ${name}: \${${tenantVar}}\n` : ''
}

/**
 * Emit a literal environment line, or nothing when the value is unset.
 *
 * An empty proxy variable is not the same as an absent one: DSH reports a
 * rejected proxy value, so the line is omitted until the deployment sets it.
 *
 * @param name - container variable name.
 * @param value - literal value from .env.
 * @returns one indented compose line, or an empty string.
 */
function literalEnvLine(name, value) {
  return value ? `      ${name}: ${value}\n` : ''
}

/**
 * Cap on a container's own stdout log.
 *
 * `json-file` is the default driver and it has no size limit, so a container
 * that starts printing — a crash loop, a chatty tool, the proxy's one line per
 * request — grows until the disk is full. This host's root filesystem has about
 * 12 GB free and shares it with everything else.
 *
 * DSH itself writes almost nothing to stdout (it logs to its session files), so
 * the cap mostly protects against the pathological case. Sizes come from .env so
 * a deployment with many tenants can set a smaller budget per container.
 */
function loggingBlock(indent = '    ') {
  const size = envValues.get('MT_LOG_MAX_SIZE') ?? '10m'
  const files = envValues.get('MT_LOG_MAX_FILE') ?? '3'
  return `${indent}logging:
${indent}  driver: json-file
${indent}  options:
${indent}    max-size: "${size}"
${indent}    max-file: "${files}"
`
}

/**
 * Ceilings for the logs the services write themselves.
 *
 * Docker's log options do not reach a file a service writes through a bind mount,
 * so the access, administration and model-usage logs are rotated by the processes
 * that write them, on the same policy and from the same .env values as the
 * container logs.
 */
const selfLogEnv = () => `      MT_LOG_MAX_SIZE: \${MT_LOG_MAX_SIZE:-10m}
      MT_LOG_MAX_FILE: \${MT_LOG_MAX_FILE:-3}`

/**
 * Tenants that get a bridge of their own instead of sharing the main network.
 *
 * Tenants on one bridge can reach each other's ports: it is layer-2 forwarding,
 * which this host does not pass through iptables, and changing that sysctl would
 * affect every bridge on the machine. A tenant listed here is placed on its own
 * network, where it cannot reach — or even resolve — a tenant on another one.
 *
 * `MT_TENANT_NETWORKS` takes a comma-separated list of tenant ids or `all`, so a
 * single tenant can be moved first and the rest later with the same code.
 */
const ISOLATED_TENANTS = (() => {
  const raw = (envValues.get('MT_TENANT_NETWORKS') ?? process.env.MT_TENANT_NETWORKS ?? '').trim()
  if (raw === '') return new Set()
  if (raw === 'all') return new Set(tenants.map((tenant) => tenant.id))
  return new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))
})()
/**
 * The private network one isolated tenant lives on.
 *
 * The subnet comes from the tenant id's hash rather than its position, so adding
 * or removing a tenant does not renumber the others — renumbering would force
 * those containers to be recreated. A collision between two ids moves to the next
 * free third octet, which is deterministic because the ids are walked in order.
 */
function tenantNetwork(tenant, taken) {
  const digest = crypto.createHash('sha256').update(tenant.id).digest()
  let octet = digest[0]
  while (taken.has(octet)) octet = (octet + 1) % 256
  taken.add(octet)
  return {
    name: `${NETWORK_NAME}-${tenant.id}`,
    subnet: `10.98.${String(octet)}.0/24`,
    // Interface names are capped at fifteen characters.
    bridge: `mtbr${digest.subarray(1, 5).toString('hex')}`,
    gateway: `10.98.${String(octet)}.1`,
  }
}

const TENANT_NETWORKS = new Map()
{
  const taken = new Set()
  for (const tenant of [...tenants].sort((left, right) => left.id.localeCompare(right.id))) {
    if (ISOLATED_TENANTS.has(tenant.id)) TENANT_NETWORKS.set(tenant.id, tenantNetwork(tenant, taken))
  }
}

/** Network one tenant's container joins. */
const networkOf = (tenant) => TENANT_NETWORKS.get(tenant.id)?.name ?? NETWORK_NAME

/**
 * Egress proxy address as this tenant reaches it.
 *
 * An isolated tenant's bridge has its own gateway address, so one deployment-wide
 * value would point at a network the tenant is not on.
 */
const egressFor = (tenant) => {
  const network = TENANT_NETWORKS.get(tenant.id)
  return network === undefined ? envValues.get('MT_EGRESS_PROXY') : `http://${network.gateway}:${String(egressPort())}`
}

function tenantService(tenant) {
  const limits = tenant.limits ?? {}
  const limitLines = []
  if (limits.memory) limitLines.push(`    mem_limit: ${String(limits.memory)}`)
  if (limits.cpus) limitLines.push(`    cpus: ${String(limits.cpus)}`)
  limitLines.push(`    pids_limit: ${String(limits.pids ?? 512)}`)
  // 块设备吞吐上限（可选，**实测在本机不生效**，默认关闭）。
  //
  // 为什么不用相对权重：权重是 CFQ 的公平性设置，本机跑 deadline 调度器，配了等于没配。
  //
  // 为什么限速也不留在默认里：实测过，限制在每一层都正确落下了——Docker 记录了配置、
  // 容器 cgroup 里就是 `253:2 52428800`、设备号也对——但容器里写 200MB 仍然是 908MB/s
  // （不限速时 800MB/s）。原因是 cgroup v1 的块设备限速只在**回写**时生效，而回写发生在
  // flusher/kworker 的 cgroup 里，不是容器自己的。也就是说：配了、看得见、不管用。
  // 一个"看起来生效、实则无效"的限制比没有限制更糟，所以保持默认关闭，并把结论写在这里，
  // 免得以后有人打开它还以为租户被限住了。
  //
  // 值是 Docker 的 `<设备>:<速率>`（长格式 path+rate 由下面生成），因为要限制哪块盘随机器而异。
  const diskWrite = String(limits.diskWriteBps ?? (envValues.get('MT_TENANT_DISK_WRITE_BPS') ?? process.env.MT_TENANT_DISK_WRITE_BPS ?? '')).trim()
  const diskRead = String(limits.diskReadBps ?? (envValues.get('MT_TENANT_DISK_READ_BPS') ?? process.env.MT_TENANT_DISK_READ_BPS ?? '')).trim()
  // compose 的 schema 要长格式（path + rate）；短字符串 "[设备:速率]" 是旧格式，会被拒。
  const asEntry = (spec) => {
    const at = spec.lastIndexOf(':')
    return at <= 0
      ? undefined
      : { path: spec.slice(0, at).trim(), rate: spec.slice(at + 1).trim() }
  }
  const writeEntry = diskWrite === '' ? undefined : asEntry(diskWrite)
  const readEntry = diskRead === '' ? undefined : asEntry(diskRead)
  if (writeEntry !== undefined || readEntry !== undefined) limitLines.push('    blkio_config:')
  for (const [key, entry] of [['device_write_bps', writeEntry], ['device_read_bps', readEntry]]) {
    if (entry === undefined) continue
    limitLines.push(`      ${key}:\n        - path: ${entry.path}\n          rate: ${entry.rate}`)
  }

  return `  ${tenant.service ?? `dsh-${tenant.id}`}:
    image: \${DSH_IMAGE:-dsh-web:0.2.0-rc.2}
    container_name: ${NAME_PREFIX}dsh-${tenant.id}
    restart: unless-stopped
    networks: [${networkOf(tenant)}]
    # A node agent discovers tenant runtimes by this label, not by container
    # name: an orchestrator renames containers (a Swarm task is
    # <stack>_<service>.<slot>.<id>) while a label survives.
    labels:
      mt.tenant: "${tenant.id}"
    working_dir: /workspace
    command: ["dsh", "web", "--no-open"]
${fs.existsSync(MODEL_ENV_FILE) ? '    env_file:\n      - ./model.env\n' : ''}    environment:
      DSH_HOME: /dsh-home
      # This host's kernel (3.10, no user namespaces) cannot run DSH's own file
      # sandbox, so the container itself is the isolation boundary.
      DSH_PERMISSION_MODE: \${DSH_PERMISSION_MODE:-danger-full-access}
      DSH_TELEMETRY_DISABLED: "1"
      TZ: \${TZ:-Asia/Shanghai}
${tenant.modelKey === undefined
  ? '      # !! 没有 modelKey：执行 bin/mt.sh up（会先补发占位 key），否则模型调用不可用\n'
  : `      # 占位 key：模型网关按它识别租户并换成真凭据，真 key 不进容器\n      DEEPSEEK_API_KEY: ${tenant.modelKey}\n`}      # 模型请求发往网关而不是公网；本机 ip_forward=0，容器本来也出不去
      DEEPSEEK_BASE_URL: ${MODEL_GATEWAY_URL}/anthropic
${credentialLine('GATEWAY_API_KEY', envKeyFor(tenant, 'GATEWAY_API_KEY'))}${literalEnvLine('HTTPS_PROXY', egressFor(tenant))}${literalEnvLine('HTTP_PROXY', egressFor(tenant))}${literalEnvLine('NO_PROXY', envValues.get('MT_NO_PROXY') ?? DEFAULT_NO_PROXY)}${limitLines.join('\n')}
${loggingBlock()}
    volumes:
      - ./tenants/${tenant.id}/home:/dsh-home
      - ./tenants/${tenant.id}/workspace:/workspace
`
}

// Every tenant publishes its edgePort by routing that port to the gateway, so
// the gateway keeps resolving the tenant from its session cookie.
/**
 * Gateway environment lines for TLS.
 *
 * Written as its own template literal: inside the outer compose template a
 * `\${...}` escape yields the literal `${...}` compose interpolates, and getting
 * that escape wrong embeds a stray backslash that stops compose from
 * substituting — which is how the ops port once reached the container as text.
 */
const gatewayTlsLines = TLS_READY
  ? `      # state/tls 里已有证书：公开端口走 HTTPS，另开一个 loopback 明文端口给运维脚本
      MT_TLS_CERT: /state/tls/server.crt
      MT_TLS_KEY: /state/tls/server.key
      MT_HTTP_PORT: \${MT_HTTP_PORT:-8099}
`
  : ''

const compose = `# Generated by bin/render.js from tenants.json — do not edit by hand.
# Re-render and apply with: bin/mt.sh up
services:
  egress-proxy:
    build: ./egress-proxy
    image: mt-egress-proxy:local
    container_name: ${NAME_PREFIX}egress-proxy
    restart: unless-stopped
    # Host networking because this host has net.ipv4.ip_forward=0: a container on
    # a bridge has no route off the machine, so a proxy that tenants could reach
    # on the bridge would have no egress itself. The listen port is deliberately
    # absent from the host firewall, which is what keeps it container-only.
    network_mode: host
    # The allowlist is edited from the console, which cannot recreate this
    # container, so the proxy re-reads this file when it changes rather than
    # taking the value from its environment.
    volumes:
      - ./state:/state
    environment:
      MT_EGRESS_PORT: \${MT_EGRESS_PORT:-3128}
      MT_EGRESS_BIND: \${MT_EGRESS_BIND:-0.0.0.0}
      MT_EGRESS_ALLOW: \${MT_EGRESS_ALLOW:-}
      MT_EGRESS_ALLOW_FILE: /state/egress-allow.txt
${loggingBlock()}
  model-gateway:
    # Context is the project root so the image can share the control plane's
    # log-rotation module instead of carrying a second copy that could drift; the
    # root .dockerignore keeps tenant data and credentials out of the payload.
    build:
      context: .
      dockerfile: model-gateway/Dockerfile
    image: mt-model-gateway:local
    container_name: ${NAME_PREFIX}model-gateway
    restart: unless-stopped
    # On every tenant network, so it needs no host port of its own and stays
    # reachable from an isolated tenant; it reaches the internet through the
    # egress proxy like everything else here.
    networks: [${[NETWORK_NAME, ...new Set([...TENANT_NETWORKS.values()].map((network) => network.name))].join(', ')}]
    environment:
      MT_PORT: "8080"
      MT_UPSTREAM_BASE: \${MT_UPSTREAM_BASE:-https://api.deepseek.com}
      # 真凭据只到这里。为空时网关拒绝启动（doctor 会报），租户容器永远拿不到它。
      MT_UPSTREAM_KEY: \${MT_UPSTREAM_API_KEY:-}
      MT_EGRESS_PROXY: \${MT_EGRESS_PROXY:-}
      MT_REGISTRY: /config/tenants.json
      MT_LOG_DIR: /logs
${selfLogEnv()}
      TZ: \${TZ:-Asia/Shanghai}
${loggingBlock()}
    volumes:
      - ./tenants.json:/config/tenants.json:ro
      - ./logs:/logs

${isControlPlane ? `  backup:
    # A scheduled backup is only worth having if nobody has to remember it. This
    # runs the same bin/backup.sh an operator runs by hand, so there is one
    # backup implementation rather than two that drift. It needs the Docker
    # socket because a consistent snapshot pauses the tenant runtimes while the
    # archive is written.
    image: \${MT_NODE_IMAGE:-node:22-bookworm-slim}
    container_name: ${NAME_PREFIX}backup
    restart: unless-stopped
    working_dir: /project
    # No network at all: it talks to the local Docker socket and the local disk,
    # and asking compose for a default network would consume one of the host's
    # scarce address pools for nothing.
    network_mode: none
    environment:
      MT_BACKUP_INTERVAL_SECONDS: \${MT_BACKUP_INTERVAL_SECONDS:-86400}
      MT_BACKUP_KEEP: \${MT_BACKUP_KEEP:-7}
      # Session retention, read by bin/retention-loop.sh. Empty keeps sessions
      # forever; a number makes the loop pack older ones into backups/ and remove
      # them, before each backup.
      MT_SESSION_RETENTION_DAYS: \${MT_SESSION_RETENTION_DAYS:-}
      TZ: \${TZ:-Asia/Shanghai}
${loggingBlock()}
    volumes:
      - .:/project
      - ./backups:/project/backups
      - /var/run/docker.sock:/var/run/docker.sock
      - /usr/bin/docker:/usr/bin/docker:ro
    # Double dollar is compose's escape for a single literal one, so the loop
    # reads both settings from its own environment rather than from this file.
    entrypoint: ["bash", "/project/bin/retention-loop.sh"]

  node-agent:
    # The console's lifecycle and maintenance operations have nowhere to run: the
    # control plane is a container with no Docker access and no project directory.
    # This is the host-side actor they go through, and it is a service rather than
    # something an operator remembers to start, because "the buttons are disabled
    # because nobody started the agent" is not a state anyone should have to debug.
    #
    # It accepts a fixed list of named operations (see node-agent/server.js) — it
    # is deliberately not a command endpoint, since the console is reachable by
    # whoever holds an administrator session.
    build: ./node-agent
    image: mt-node-agent:local
    container_name: ${NAME_PREFIX}node-agent
    restart: unless-stopped
    # Host networking: it must reach the control plane and be reachable by it, and
    # this host cannot route bridge-published ports.
    network_mode: host
    environment:
      MT_NODE_NAME: \${MT_NODE_NAME:-local}
      MT_NODE_ADDRESS: \${MT_NODE_ADDRESS:-}
      MT_CONTROL_PLANE: \${MT_CONTROL_PLANE:-}
      MT_CONTROL_PLANE_CA: \${MT_CONTROL_PLANE_CA:-}
      MT_REGISTRY_KEY_FILE: /key/registry.key
      # 入站运维与出站注册各用一把；两把都接受旧共用密钥作为回退。
      MT_OPS_KEY_FILE: /key/ops.key
      MT_REGISTER_KEY_FILE: /key/register.key
      MT_NETWORK: \${MT_NETWORK:-mt-net}
      MT_CONTAINER_NAME_PREFIX: \${MT_CONTAINER_NAME_PREFIX:-mt-}
      MT_PROJECT_DIR: ${hostRoot()}
      MT_DATA_ROOT: /project
      MT_AGENT_PORT: \${MT_AGENT_PORT:-3199}
      TZ: \${TZ:-Asia/Shanghai}
${loggingBlock()}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./state:/key:ro
      # The project at its own host path, not at /project: compose resolves
      # relative bind mounts to absolute paths and hands them to the host daemon,
      # which knows nothing about a /project inside this container. Mounting it
      # where the host has it is what makes docker-compose up from in here create
      # containers that actually start.
      - ${hostRoot()}:${hostRoot()}
      # The scripts call docker and docker-compose, so the agent needs the same
      # two binaries the host has. Without them disk-prune-images and upgrade
      # fail in ways that read like a missing image rather than a missing tool —
      # which is exactly how the first rolling upgrade through the console failed.
      - /usr/bin/docker:/usr/bin/docker:ro
      - /usr/local/bin/docker-compose:/usr/local/bin/docker-compose:ro

  gateway:
    build: ./gateway
    image: mt-gateway:local
    container_name: ${NAME_PREFIX}gateway
    restart: unless-stopped
    # Host networking on purpose. This host has net.ipv4.ip_forward=0, so a
    # bridge-network port mapping is unreachable from the LAN (every other
    # stack on this machine has the same problem). The control plane therefore
    # listens on the host's own ports, while tenant containers stay on mt-net
    # with no published port at all: it proxies to whatever a node registered.
    network_mode: host
    environment:
      MT_EDGE_PORT: \${MT_EDGE_PORT:-8090}
      MT_BIND_IP: \${MT_BIND_IP:-0.0.0.0}
      MT_SESSION_TTL_HOURS: \${MT_SESSION_TTL_HOURS:-12}
      MT_LOG_DIR: /logs
      MT_DEPLOY_ROOT: /project
      # This node's agent, for the console's maintenance operations. Empty means
      # those operations report that no agent is running rather than failing oddly.
      MT_NODE_AGENT_URL: \${MT_NODE_AGENT_URL:-}
${selfLogEnv()}
${gatewayTlsLines}      TZ: \${TZ:-Asia/Shanghai}
${loggingBlock()}
    volumes:
      # Read-write, unlike every other consumer: the administrator console edits
      # this file (adding tenants, setting passwords). It is the control plane's
      # own registry, and the console is the control plane's administrative
      # surface. Rewritten in place, never renamed, so this container's own
      # watcher keeps seeing the same inode.
      - ./tenants.json:/config/tenants.json
      - ./state:/state
      - ./logs:/logs
      # Read-only, and only for the metrics endpoint's newest-backup timestamp:
      # an alert on backups stopping needs the control plane to see them.
      - ./backups:/project/backups:ro
    # A wedged control plane refuses nothing and serves nothing, which looks
    # exactly like a network problem from outside. The health endpoint probes
    # every registered runtime, so Docker can restart the process instead of
    # leaving it silently dead.
    healthcheck:
      test: ["CMD", "node", "-e", "const p=process.env.MT_HTTP_PORT||process.env.MT_EDGE_PORT||8090;require('node:http').get('http://127.0.0.1:'+p+'/__mt/health',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s

` : ''}${tenants.filter(isLocalTenant).map(tenantService).join('\n')}
networks:
  ${NETWORK_NAME}:
    name: ${NETWORK_NAME}
${NETWORK_EXTERNAL ? '    external: true' : `    driver: bridge
    driver_opts:
      # Docker would otherwise name the bridge br-<network id>, which changes
      # whenever the network is recreated. The firewall rules that keep tenants
      # off the host's ports are keyed by that interface name, so after a rebuild
      # they would silently stop applying. A pinned name keeps them valid.
      com.docker.network.bridge.name: ${bridgeName()}${networkSubnet() === '' ? '' : `
    # Explicit subnet: on a machine whose default Docker address pools are used
    # up by other stacks, a network without one cannot be created at all.
    ipam:
      config:
        - subnet: ${networkSubnet()}`}`}
${[...TENANT_NETWORKS.values()].map((network) => `  ${network.name}:
    name: ${network.name}
    driver: bridge
    # Explicit subnet: this host's default Docker address pools are exhausted by
    # other stacks, so a network without one cannot be created at all.
    ipam:
      config:
        - subnet: ${network.subnet}
    driver_opts:
      # Same reasoning as the main bridge: the host-port rules are keyed by this
      # interface name and must survive a rebuild.
      com.docker.network.bridge.name: ${network.bridge}`).join('\n')}
`

fs.writeFileSync(path.join(ROOT, 'docker-compose.yml'), compose)
fs.chmodSync(path.join(ROOT, 'docker-compose.yml'), 0o600)

// Humans and ops scripts both need the entry list; keep it next to the compose
// file so `bin/mt.sh url` never has to parse it again.
const entryLines = [`\${IP}:\${MT_EDGE_PORT:-8090}/   统一登录入口（所有租户）`]
for (const tenant of tenants) {
  if (!isLocalTenant(tenant)) continue
  if (tenant.edgePort !== undefined) {
    entryLines.push(`\${IP}:${String(tenant.edgePort)}/   ${tenant.id} 专属入口`)
  }
  for (const host of tenant.hosts ?? []) {
    entryLines.push(`${host}:\${MT_EDGE_PORT:-8090}/   ${tenant.id}（客户端 hosts 需指向本机）`)
  }
}
fs.writeFileSync(path.join(ROOT, 'entry-urls.txt'), entryLines.join('\n') + '\n')

console.log(`rendered docker-compose.yml for ${String(tenants.length)} tenant(s): ${tenants.map((t) => t.id).join(', ')}`)
if (createdPatches.length > 0) console.log(`created profile patches for: ${createdPatches.join(', ')}`)
if (remoteTenants.length > 0) {
  console.log(`tenants on other nodes (no local container, their agent registers them): ${remoteTenants.join(', ')}`)
}
if (trustApplied.length > 0) {
  console.log(`updated the host-trust block for: ${trustApplied.join(', ')} (restart those tenants to take effect)`)
}
if (modelEntries === undefined) {
  console.log('model.patch.yml is absent or still contains CHANGE-ME: tenants use the built-in provider cards only')
} else if (modelApplied.length > 0) {
  console.log(`applied the shared model block to: ${modelApplied.join(', ')} (restart tenants to take effect)`)
}
if (addedKeys.length > 0) {
  console.log(`added empty .env key(s): ${addedKeys.join(', ')}`)
  console.log('fill them in (bin/mt.sh key <tenant> <value>), otherwise tenants start without model credentials')
}
for (const [name, owners] of sharedUsers) {
  console.warn(`warning: user "${name}" exists in ${owners.join(' and ')}; it must log in through a dedicated entry`)
}
