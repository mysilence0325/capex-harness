#!/usr/bin/env node
/**
 * Manage the console's administrators and their roles.
 *
 * There used to be exactly one, written as a single record. There are now several,
 * with a role each, and the file is read by the console through the same code this
 * uses — so the two can never disagree about the format.
 *
 * Roles:
 *   admin   everything
 *   viewer  read-only: state, history, disk report, backup list, current configuration
 *
 * The console hides what a viewer cannot do; the gateway refuses it. Both matter,
 * and only the second is a permission.
 *
 * Usage:
 *   node bin/admin-users.js list
 *   node bin/admin-users.js add <name> [--role admin|viewer] [--password <pw>]
 *   node bin/admin-users.js passwd <name> [--password <pw>] [--keep-sessions]
 *   node bin/admin-users.js remove <name>
 *
 * Without --password a random one is generated and printed once.
 *
 * @module mt/bin/admin-users
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { AdminConsole, hashPassword } = require('../gateway/admin.js')

const root = path.resolve(__dirname, '..')
const stateDir = path.join(root, 'state')
const args = process.argv.slice(2)
const command = args[0] ?? 'list'

const flag = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,32}$/u

if (command !== 'list' && !NAME_PATTERN.test(args[1] ?? '')) {
  console.error('管理员名字只能用字母、数字、点、下划线和短横线（1-32 位）')
  process.exit(2)
}

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
const admin = new AdminConsole({ stateDir, logDir: path.join(root, 'logs'), registryFile: path.join(root, 'tenants.json'), registryKey: '' })

/** Rotate the session key so every signed-in administrator is signed out. */
function revokeSessions() {
  if (args.includes('--keep-sessions')) {
    console.log('--keep-sessions：已登录的管理员会话仍然有效')
    return
  }
  // 与租户侧同理：密码被换掉通常正是因为怀疑泄露，留着旧会话等于没换。
  fs.writeFileSync(path.join(stateDir, 'admin.key'), crypto.randomBytes(32), { mode: 0o600 })
  console.log('已让所有管理员重新登录（轮换了 state/admin.key）')
}

if (command === 'list') {
  const users = admin.readAdmins()
  if (users.length === 0) {
    console.log('还没有管理员。先执行: bin/mt.sh admin-passwd')
    process.exit(0)
  }
  console.log('  名字            角色     创建时间')
  for (const user of users) {
    console.log(`  ${user.name.padEnd(15)} ${user.role.padEnd(8)} ${user.createdAt ?? '—'}`)
  }
  process.exit(0)
}

if (command === 'add' || command === 'passwd') {
  const name = args[1]
  const existing = admin.adminByName(name)
  if (command === 'passwd' && existing === undefined) {
    console.error(`没有管理员 ${name}（用 bin/mt.sh admin-add 添加）`)
    process.exit(1)
  }
  const role = flag('role') ?? existing?.role ?? 'admin'
  if (role !== 'admin' && role !== 'viewer') {
    console.error('--role 只能是 admin 或 viewer')
    process.exit(2)
  }
  const password = flag('password') ?? crypto.randomBytes(9).toString('base64url')
  admin.addAdmin(name, hashPassword(password), role)
  console.log(`管理员 ${name}（角色 ${role}）已${existing === undefined ? '添加' : '更新'}密码`)
  console.log(`  密码: ${password}${flag('password') === undefined ? '（只显示这一次）' : ''}`)
  revokeSessions()
  process.exit(0)
}

if (command === 'remove') {
  const outcome = admin.removeAdmin(args[1])
  if (outcome === 'missing') {
    console.error(`没有管理员 ${args[1]}`)
    process.exit(1)
  }
  if (outcome === 'last') {
    console.error('这是最后一个管理员，删了就没人能进控制台了')
    process.exit(1)
  }
  if (outcome === 'last-admin') {
    console.error('删掉后就没有管理员角色了（只剩只读账号），控制台将无法管理')
    process.exit(1)
  }
  console.log(`已删除管理员 ${args[1]}`)
  revokeSessions()
  process.exit(0)
}

console.error(`未知命令 ${command}；可用: list | add | passwd | remove`)
process.exit(2)
