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
console.log('控制台入口：https://<控制面地址>:8090/__mt/admin')
