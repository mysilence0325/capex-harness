#!/usr/bin/env node
/**
 * Withdraw every administrator console session without changing the password.
 *
 * The console session is an expiry plus an HMAC over it, keyed by state/admin.key,
 * so replacing that key invalidates every cookie that was signed with the old one.
 * The gateway reads the key on each request rather than caching it, so this takes
 * effect on the next request — no restart, which is the point: the reason to want
 * this is usually a laptop left somewhere or a session you cannot otherwise reach.
 *
 * The usual way to change the password already rotates the key; this exists for
 * the case where the password is fine and only the sessions must go.
 *
 * `state/admin.key` is shared with a standby control plane, so rotating it here
 * signs administrators out of the standby too. That is the intent: one authority.
 *
 * @module mt/bin/admin-kick
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..')
const stateDir = path.join(root, 'state')
const keyFile = path.join(stateDir, 'admin.key')
const adminFile = path.join(stateDir, 'admin.json')

if (!fs.existsSync(adminFile)) {
  console.error('还没有设置管理员密码（state/admin.json 不存在），先执行 bin/mt.sh admin-passwd')
  process.exit(1)
}

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
const had = fs.existsSync(keyFile) ? fs.readFileSync(keyFile).length : 0
fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 })

console.log(`已轮换 ${path.relative(root, keyFile)}（原 ${had} 字节）`)
console.log('所有管理员会话立即失效；密码没有变，用原密码重新登录即可。')
