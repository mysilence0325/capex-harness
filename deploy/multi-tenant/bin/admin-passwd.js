/**
 * Set the administrator console password.
 *
 * Writes `state/admin.json` in the same `scrypt$<salt>$<digest>` form the gateway
 * verifies, so the console never learns the password and the file never holds it.
 * Run this on the control plane; `bin/mt.sh admin-passwd` calls it.
 *
 * Usage: node bin/admin-passwd.js <password> [--user <name>]
 *
 * @module mt/bin/admin-passwd
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const args = process.argv.slice(2)
const password = args[0]
if (password === undefined || password === '') {
  console.error('usage: node bin/admin-passwd.js <password> [--user <name>]')
  process.exit(2)
}

const at = args.indexOf('--user')
const user = at >= 0 ? (args[at + 1] ?? 'admin') : 'admin'
if (!/^[A-Za-z0-9._-]{1,32}$/u.test(user)) {
  console.error('the administrator name may contain letters, digits, dot, underscore and dash')
  process.exit(2)
}

const root = path.resolve(__dirname, '..')
const stateDir = path.join(root, 'state')
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })

const salt = crypto.randomBytes(16).toString('hex')
const digest = crypto.scryptSync(password, salt, 32).toString('hex')
const file = path.join(stateDir, 'admin.json')
fs.writeFileSync(file, `${JSON.stringify({ user, passwordHash: `scrypt$${salt}$${digest}`, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })

console.log(`管理员密码已设置（用户 ${user}），写入 ${path.relative(root, file)}`)

// 改密码同时吊销已登录的管理员会话：签名密钥一换，旧 cookie 就验不过。
// 与租户侧同理——密码被换掉通常正是因为怀疑泄露，留着旧会话等于没换。
if (args.includes('--keep-sessions')) {
  console.log('--keep-sessions：已登录的管理员会话仍然有效')
} else {
  const keyFile = path.join(stateDir, 'admin.key')
  fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 })
  console.log(`已让所有管理员重新登录（轮换了 ${path.relative(root, keyFile)}）`)
}

console.log('控制台入口：https://<控制面地址>:8090/__mt/admin')
