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
const path = require('node:path')

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
 * Splice the shared model block into one tenant patch, preserving everything the
 * tenant's own settings UI may have written outside the marked block.
 * @param patchFile - the tenant's profile patch path.
 * @param tenant - tenant record, for the base patch text.
 * @param entries - shared model entries, or undefined to only strip a stale block.
 * @returns whether the file changed.
 */
function spliceModelBlock(patchFile, tenant, entries) {
  const existed = fs.existsSync(patchFile)
  const base = existed ? fs.readFileSync(patchFile, 'utf8') : profilePatch(tenant)
  const kept = []
  let skipping = false
  for (const line of base.split('\n')) {
    if (line === MARK_BEGIN) { skipping = true; continue }
    if (line === MARK_END) { skipping = false; continue }
    if (!skipping) kept.push(line)
  }
  const body = kept.join('\n').trimEnd()
  const next = entries === undefined
    ? body + '\n'
    : `${body}\n\n${MARK_BEGIN}\n${entries}\n${MARK_END}\n`
  // A missing file must always be written: without this, a tenant whose model
  // block is empty gets no patch at all and DSH falls back to the profile
  // template, listening on its default port instead of the assigned one.
  if (next === base && existed) return false
  fs.writeFileSync(patchFile, next, { mode: 0o600 })
  return true
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
for (const tenant of tenants) {
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

function tenantService(tenant) {
  const limits = tenant.limits ?? {}
  const limitLines = []
  if (limits.memory) limitLines.push(`    mem_limit: ${String(limits.memory)}`)
  if (limits.cpus) limitLines.push(`    cpus: ${String(limits.cpus)}`)
  limitLines.push(`    pids_limit: ${String(limits.pids ?? 512)}`)

  return `  ${tenant.service ?? `dsh-${tenant.id}`}:
    image: \${DSH_IMAGE:-dsh-web:0.2.0-rc.2}
    container_name: mt-dsh-${tenant.id}
    restart: unless-stopped
    networks: [mt-net]
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
${credentialLine('GATEWAY_API_KEY', envKeyFor(tenant, 'GATEWAY_API_KEY'))}${literalEnvLine('HTTPS_PROXY', envValues.get('MT_EGRESS_PROXY'))}${literalEnvLine('HTTP_PROXY', envValues.get('MT_EGRESS_PROXY'))}${literalEnvLine('NO_PROXY', envValues.get('MT_NO_PROXY') ?? DEFAULT_NO_PROXY)}${limitLines.join('\n')}
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
    container_name: mt-egress-proxy
    restart: unless-stopped
    # Host networking because this host has net.ipv4.ip_forward=0: a container on
    # a bridge has no route off the machine, so a proxy that tenants could reach
    # on the bridge would have no egress itself. The listen port is deliberately
    # absent from the host firewall, which is what keeps it container-only.
    network_mode: host
    environment:
      MT_EGRESS_PORT: \${MT_EGRESS_PORT:-3128}
      MT_EGRESS_BIND: \${MT_EGRESS_BIND:-0.0.0.0}
      MT_EGRESS_ALLOW: \${MT_EGRESS_ALLOW:-}

  model-gateway:
    build: ./model-gateway
    image: mt-model-gateway:local
    container_name: mt-model-gateway
    restart: unless-stopped
    # On the tenant network, so it needs no host port of its own; it reaches the
    # internet through the egress proxy like everything else here.
    networks: [mt-net]
    environment:
      MT_PORT: "8080"
      MT_UPSTREAM_BASE: \${MT_UPSTREAM_BASE:-https://api.deepseek.com}
      # 真凭据只到这里。为空时网关拒绝启动（doctor 会报），租户容器永远拿不到它。
      MT_UPSTREAM_KEY: \${MT_UPSTREAM_API_KEY:-}
      MT_EGRESS_PROXY: \${MT_EGRESS_PROXY:-}
      MT_REGISTRY: /config/tenants.json
      MT_LOG_DIR: /logs
      TZ: \${TZ:-Asia/Shanghai}
    volumes:
      - ./tenants.json:/config/tenants.json:ro
      - ./logs:/logs

  gateway:
    build: ./gateway
    image: mt-gateway:local
    container_name: mt-gateway
    restart: unless-stopped
    # Host networking on purpose. This host has net.ipv4.ip_forward=0, so a
    # bridge-network port mapping is unreachable from the LAN (every other
    # stack on this machine has the same problem). The control plane therefore
    # listens on the host's own ports, while tenant containers stay on mt-net
    # with no published port at all: the gateway resolves their addresses
    # through the Docker API.
    network_mode: host
    environment:
      MT_EDGE_PORT: \${MT_EDGE_PORT:-8090}
      MT_BIND_IP: \${MT_BIND_IP:-0.0.0.0}
      MT_SESSION_TTL_HOURS: \${MT_SESSION_TTL_HOURS:-12}
${gatewayTlsLines}      TZ: \${TZ:-Asia/Shanghai}
    volumes:
      - ./tenants.json:/config/tenants.json:ro
      - ./state:/state
      - ./logs:/logs
      # Read-only mount used only to resolve each tenant's address and current
      # launch token, and to report readiness. The gateway is the trusted
      # control plane.
      - /var/run/docker.sock:/var/run/docker.sock:ro

${tenants.map(tenantService).join('\n')}
networks:
  mt-net:
    name: mt-net
    driver: bridge
`

fs.writeFileSync(path.join(ROOT, 'docker-compose.yml'), compose)
fs.chmodSync(path.join(ROOT, 'docker-compose.yml'), 0o600)

// Humans and ops scripts both need the entry list; keep it next to the compose
// file so `bin/mt.sh url` never has to parse it again.
const entryLines = [`\${IP}:\${MT_EDGE_PORT:-8090}/   统一登录入口（所有租户）`]
for (const tenant of tenants) {
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
