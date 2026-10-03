#!/usr/bin/env node
/**
 * Move one tenant out of this deployment, or bring one in.
 *
 * Built as a separate script rather than another branch of `registry.js` because the
 * registry file is the thing that must not be corrupted: this reads and writes it
 * with the same lock and the same serialisation, but a mistake here cannot break the
 * command that every other operation goes through.
 *
 * What travels, and why:
 *   tenants/<id>/   the tenant's own data.
 *   TENANT.json     the registry entry, including the users' password hashes, so the
 *                   same people keep the same passwords after a move.
 *   ENV.json        the tenant's environment values (model credentials, user list).
 *                   Secrets, which is why the archive is written 0600 and says so.
 *   MANIFEST.txt    what this is and how to bring it back.
 *
 * Importing allocates fresh ports, service and container names, hosts and model key:
 * a tenant moved onto a host that already runs one must not collide with it. The
 * password hashes travel; the ports do not.
 *
 * Usage:
 *   node bin/tenant-transfer.js export <id> [--out <path>]
 *   node bin/tenant-transfer.js import <archive> --as <id> [--title <text>]
 *
 * @module mt/bin/tenant-transfer
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { acquire } = require('../gateway/tenant-lock.js')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'tenants.json')
const ENV_FILE = path.join(ROOT, '.env')
const NAME_PREFIX = (process.env.MT_CONTAINER_NAME_PREFIX ?? 'mt-').trim()
const ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/u

const [command, ...args] = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const stamp = () => new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, 'Z')

acquire(FILE)
const registry = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { tenants: [] }
registry.tenants ??= []
const save = () => fs.writeFileSync(FILE, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 })

/** Highest port already in use for one key, so a new tenant does not collide. */
function nextPort(key, base) {
  const used = registry.tenants.map((tenant) => Number(tenant[key]) || 0).filter((port) => port > 0)
  return used.length === 0 ? base : Math.max(...used) + 1
}

/** The environment keys that belong to one tenant, by prefix convention. */
function tenantEnvKeys(id) {
  const prefix = `MT_${id.toUpperCase().replace(/-/gu, '_')}_`
  return fs.existsSync(ENV_FILE)
    ? fs
        .readFileSync(ENV_FILE, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith(prefix))
    : []
}

if (command === 'export') {
  const id = args[0]
  if (!ID_PATTERN.test(id ?? '')) {
    console.error('usage: tenant-transfer.js export <id> [--out <path>]')
    process.exit(2)
  }
  const tenant = registry.tenants.find((entry) => entry.id === id)
  if (tenant === undefined) {
    console.error(`no such tenant: ${id}`)
    process.exit(1)
  }

  const work = fs.mkdtempSync(path.join(ROOT, 'state', 'export-'))
  fs.writeFileSync(path.join(work, 'TENANT.json'), JSON.stringify(tenant, null, 2) + '\n', { mode: 0o600 })
  fs.writeFileSync(
    path.join(work, 'ENV.json'),
    JSON.stringify({ keys: tenantEnvKeys(id) }, null, 2) + '\n',
    { mode: 0o600 },
  )
  fs.writeFileSync(
    path.join(work, 'MANIFEST.txt'),
    [
      `DSH 多租户：租户 ${id} 的移交归档`,
      `导出时间    : ${new Date().toISOString()}`,
      `来源主机    : ${require('node:os').hostname()}`,
      `租户标题    : ${tenant.title ?? id}`,
      `用户        : ${(tenant.users ?? []).map((user) => user.name).join(', ')}`,
      '',
      '包含内容:',
      `  tenants/${id}/        租户自己的数据`,
      '  TENANT.json          注册表条目（含用户口令哈希，所以口令不变）',
      '  ENV.json             该租户的环境变量（含模型凭据）',
      '',
      '导入方式（在目标机器上）:',
      `  bin/mt.sh import <本归档> --as <新租户名>`,
      '  bin/mt.sh render && bin/mt.sh up',
      '',
      '注意：',
      '  - 归档里有口令哈希与模型凭据，按机密文件保管（本文件权限 0600）。',
      '  - 导入会分配新的端口、服务名、容器名与模型 key，不会与目标机器上已有的租户冲突。',
      '  - 口令哈希随归档走：同一个用户用同一个口令即可登录。',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )

  const out = flag('out') ?? path.join(ROOT, 'exports', `${id}-${stamp()}.tar.gz`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const tar = spawnSync(
    'tar',
    [
      '-czf', out,
      '--exclude=workspace/node_modules',
      '-C', work, 'TENANT.json', 'ENV.json', 'MANIFEST.txt',
      '-C', ROOT, path.join('tenants', id),
    ],
    { stdio: 'inherit' },
  )
  fs.rmSync(work, { recursive: true, force: true })
  if (tar.status !== 0) {
    console.error('打包失败')
    process.exit(1)
  }
  fs.chmodSync(out, 0o600)
  const size = fs.statSync(out).size
  console.log(`已导出租户 ${id} → ${out}（${Math.round(size / 1024)} KB）`)
  console.log('  归档含口令哈希与模型凭据，请按机密文件保管（权限已设为 0600）')
  console.log(`  导入：bin/mt.sh import ${path.basename(out)} --as <新租户名>`)
  process.exit(0)
}

if (command === 'import') {
  const archive = args[0]
  const id = flag('as')
  if (archive === undefined || !ID_PATTERN.test(id ?? '')) {
    console.error('usage: tenant-transfer.js import <archive> --as <id> [--title <text>]')
    process.exit(2)
  }
  if (!fs.existsSync(archive)) {
    console.error(`找不到归档: ${archive}`)
    process.exit(1)
  }
  if (registry.tenants.some((entry) => entry.id === id)) {
    console.error(`租户已存在: ${id}（换一个 --as 名字，或先 bin/mt.sh remove ${id}）`)
    process.exit(1)
  }

  const work = fs.mkdtempSync(path.join(ROOT, 'state', 'import-'))
  const untar = spawnSync('tar', ['-xzf', archive, '-C', work], { stdio: 'inherit' })
  if (untar.status !== 0) {
    console.error('解包失败')
    process.exit(1)
  }
  const incoming = JSON.parse(fs.readFileSync(path.join(work, 'TENANT.json'), 'utf8'))
  const env = JSON.parse(fs.readFileSync(path.join(work, 'ENV.json'), 'utf8'))

  // 数据目录：从归档里的 tenants/<原名>/ 挪到 tenants/<新名>/
  const original = incoming.id
  const source = path.join(work, 'tenants', original)
  const target = path.join(ROOT, 'tenants', id)
  if (fs.existsSync(target)) {
    console.error(`目标数据目录已存在: tenants/${id}，先清理再导入`)
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(source, target)

  const importedPort = nextPort('internalPort', 3181)
  // 租户自己的数据里也记着它的 web 端口（profiles/web/cordis.patch.yml 的 port）。
  // 只改注册表的话，容器会继续按来源机器的旧端口监听，而控制面按新端口代理——
  // 统一入口返回 502，看起来像"容器没起来"，其实是端口对不上。
  const patchFile = path.join(target, 'home', 'profiles', 'web', 'cordis.patch.yml')
  let portRewritten = false
  if (fs.existsSync(patchFile)) {
    const before = fs.readFileSync(patchFile, 'utf8')
    const occurrences = (before.match(/^\s*port:\s*\d+\s*$/gmu) ?? []).length
    const after = before.replace(/^(\s*port:\s*)\d+\s*$/mu, `$1${String(importedPort)}`)
    if (after !== before) {
      fs.writeFileSync(patchFile, after)
      // 读回来确认，而不是假定替换成功
      const check = fs.readFileSync(patchFile, 'utf8')
      portRewritten = check !== before
      if (occurrences > 1) console.log(`  注意：该文件里有 ${String(occurrences)} 处 port:，只改了第一处`)
    }
  } else {
    console.log('  注意：没有找到 cordis.patch.yml，端口可能仍需手工对齐')
  }

  const tenant = {
    ...incoming,
    id,
    title: flag('title') ?? `${incoming.title ?? original}（移入）`,
    node: flag('node') ?? 'local',
    internalPort: importedPort,
    // 入口端口：目标机器上的租户各自持有一个，重新分配，不沿用来源机器的。
    edgePort: nextPort('edgePort', 8091),
    service: `dsh-${id}`,
    container: `${NAME_PREFIX}dsh-${id}`,
    hosts: [`${id}.dsh.local`],
    // 模型 key 不沿用：它标识的是"哪个租户在向模型网关调用"，必须与目标机器的
    // 注册表一致，所以删掉让 ensureModelKeys/`bin/mt.sh model` 重新签发。
  }
  delete tenant.modelKey
  registry.tenants.push(tenant)
  save()

  // 环境变量：前缀换成新租户名
  const oldPrefix = `MT_${String(original).toUpperCase().replace(/-/gu, '_')}_`
  const newPrefix = `MT_${id.toUpperCase().replace(/-/gu, '_')}_`
  const lines = (env.keys ?? []).map((line) => line.replace(oldPrefix, newPrefix))
  if (lines.length > 0) {
    const current = fs.readFileSync(ENV_FILE, 'utf8')
    fs.writeFileSync(ENV_FILE, `${current.replace(/\n*$/u, '\n')}\n${lines.join('\n')}\n`, { mode: 0o600 })
  }
  fs.rmSync(work, { recursive: true, force: true })

  console.log(`已导入租户 ${id}（来自 ${original}）`)
  console.log(`  端口: 内部 ${String(tenant.internalPort)}，入口 ${String(tenant.edgePort)}`)
  console.log(`  用户: ${(tenant.users ?? []).map((user) => user.name).join(', ')}（口令不变）`)
  console.log(`  环境变量: 写入 ${String(lines.length)} 行（前缀 ${newPrefix}）`)
  console.log('  接下来:')
  console.log('    bin/mt.sh render && bin/mt.sh up     # 建立并启动这个租户')
  console.log('    bin/mt.sh model                      # 为它签发模型 key')
  process.exit(0)
}

console.error('usage: tenant-transfer.js export <id> | import <archive> --as <id>')
process.exit(2)
