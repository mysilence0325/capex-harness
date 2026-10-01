/**
 * Tenant registry maintenance for the DSH multi-tenant deployment.
 *
 * `tenants.json` is the single source of truth for which tenants exist, who may
 * log into them, and how much of the host each may use. This script edits it
 * without hand-written JSON surgery.
 *
 * Usage:
 *   node bin/registry.js list
 *   node bin/registry.js add <id> --user <name> [--title <text>] [--edge-port <n>] [--no-edge-port] [--password <pw>]
 *   node bin/registry.js passwd <id> <user> [--password <pw>]
 *   node bin/registry.js remove <id>
 *
 * `add` allocates the internal port and, unless --no-edge-port is given, a
 * dedicated entry port automatically, so bin/mt.sh add needs only an id.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'tenants.json')

const registry = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, 'utf8'))
  : { tenants: [] }
registry.tenants ??= []

const save = () => fs.writeFileSync(FILE, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 })

/**
 * Hash a password the way the gateway verifies it.
 * @param password - the plaintext password.
 * @returns `scrypt$<salt hex>$<digest hex>`.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const digest = crypto.scryptSync(password, salt, 32).toString('hex')
  return `scrypt$${salt}$${digest}`
}

function flag(args, name) {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

function requireTenant(id) {
  const tenant = registry.tenants.find((entry) => entry.id === id)
  if (tenant === undefined) {
    console.error(`no such tenant: ${id}`)
    process.exit(1)
  }
  return tenant
}

function nextPort(key, base) {
  const used = registry.tenants.map((tenant) => tenant[key]).filter(Number.isInteger)
  return used.length === 0 ? base : Math.max(...used) + 1
}

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case 'list': {
    for (const tenant of registry.tenants) {
      const users = tenant.users.map((user) => user.name).join(', ')
      console.log(`${tenant.id}\t内部端口=${String(tenant.internalPort)}\t入口端口=${String(tenant.edgePort ?? '-')}\t用户=${users}\t主机=${(tenant.hosts ?? []).join(',') || '-'}`)
    }
    break
  }

  case 'add': {
    const id = args[0]
    if (!/^[a-z][a-z0-9-]{1,30}$/u.test(id ?? '')) {
      console.error('usage: registry.js add <id> --user <name> [--title <text>] [--edge-port <n>] [--password <pw>]')
      process.exit(1)
    }
    if (registry.tenants.some((tenant) => tenant.id === id)) {
      console.error(`tenant already exists: ${id}`)
      process.exit(1)
    }
    const user = flag(args, 'user') ?? 'admin'
    const password = flag(args, 'password') ?? crypto.randomBytes(9).toString('base64url')
    const tenant = {
      id,
      title: flag(args, 'title') ?? id,
      internalPort: Number(flag(args, 'internal-port') ?? nextPort('internalPort', 3181)),
      // Compose service name (proxy target) and container name (log lookup).
      service: `dsh-${id}`,
      container: `mt-dsh-${id}`,
      hosts: [`${id}.dsh.local`],
      users: [{ name: user, passwordHash: hashPassword(password) }],
      limits: { memory: flag(args, 'memory') ?? '2g', cpus: flag(args, 'cpus') ?? '1.5', pids: 512 },
    }
    const edgePort = flag(args, 'edge-port')
    if (edgePort !== undefined) {
      tenant.edgePort = Number(edgePort)
    } else if (!args.includes('--no-edge-port')) {
      // Every tenant gets its own entry port by default: it makes the tenant
      // reachable without typing a username on the shared entry, and it lets a
      // shared username be disambiguated by the address it arrived on.
      tenant.edgePort = nextPort('edgePort', 8091)
    }
    registry.tenants.push(tenant)
    save()
    console.log(`added tenant ${id}`)
    console.log(`  user:     ${user}`)
    console.log(`  password: ${password}`)
    const clash = registry.tenants.find((entry) => entry !== tenant
      && entry.users.some((candidate) => candidate.name === user))
    if (clash !== undefined) {
      console.warn(`  warning: user "${user}" also exists in tenant ${clash.id}.`)
      console.warn(`  The shared login entry resolves the tenant by username, so a shared name`)
      console.warn(`  must log in through its own dedicated entry (edge port or hostname).`)
    }
    break
  }

  case 'passwd': {
    const tenant = requireTenant(args[0])
    const user = tenant.users.find((entry) => entry.name === args[1])
    if (user === undefined) {
      console.error(`tenant ${tenant.id} has no user ${String(args[1])}`)
      process.exit(1)
    }
    const password = flag(args, 'password') ?? crypto.randomBytes(9).toString('base64url')
    user.passwordHash = hashPassword(password)
    save()
    console.log(`updated ${tenant.id}/${user.name}`)
    console.log(`  password: ${password}`)
    break
  }

  case 'remove': {
    const tenant = requireTenant(args[0])
    registry.tenants = registry.tenants.filter((entry) => entry !== tenant)
    save()
    console.log(`removed tenant ${tenant.id} from the registry`)
    console.log(`its data stays under tenants/${tenant.id}/ — delete that directory to erase it`)
    break
  }

  default:
    console.error('usage: registry.js <list|add|passwd|remove> [...]')
    process.exit(2)
}
