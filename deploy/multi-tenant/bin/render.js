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
  const base = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : profilePatch(tenant)
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
  if (next === base) return false
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

// ---------------------------------------------------------------------------
// compose file
// ---------------------------------------------------------------------------

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
      GATEWAY_API_KEY: \${${envKeyFor(tenant, 'GATEWAY_API_KEY')}:-}
      DEEPSEEK_API_KEY: \${${envKeyFor(tenant, 'DEEPSEEK_API_KEY')}:-}
${limitLines.join('\n')}
    volumes:
      - ./tenants/${tenant.id}/home:/dsh-home
      - ./tenants/${tenant.id}/workspace:/workspace
`
}

// Every tenant publishes its edgePort by routing that port to the gateway, so
// the gateway keeps resolving the tenant from its session cookie.
const compose = `# Generated by bin/render.js from tenants.json — do not edit by hand.
# Re-render and apply with: bin/mt.sh up
services:
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
      TZ: \${TZ:-Asia/Shanghai}
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
