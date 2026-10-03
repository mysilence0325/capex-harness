#!/usr/bin/env node
/**
 * Enrol or remove an administrator's TOTP factor.
 *
 * Two steps on purpose. `setup` stores a secret that does nothing yet; `confirm`
 * requires a code generated from it. An administrator who mistypes the secret into their
 * authenticator runs setup again and has lost nothing - where a one-step enrolment would
 * have locked them out of their own account.
 *
 * `confirm` is also the only moment recovery codes are shown, because only their hashes
 * are kept. They are printed once and never again.
 *
 * @module mt/bin/admin-mfa
 */

'use strict'

const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const { AdminConsole } = require(path.join(ROOT, 'gateway', 'admin.js'))
const mfa = require(path.join(ROOT, 'gateway', 'mfa.js'))

const STATE_DIR = process.env.MT_STATE_DIR ?? path.join(ROOT, 'state')
const console_ = new AdminConsole({ stateDir: STATE_DIR })

const argv = process.argv.slice(2)
const command = argv[0]
const name = argv[1]
const rest = argv.slice(2)

/** @returns the value after a flag, if present. */
function flag(name_) {
  const at = rest.indexOf(name_)
  return at >= 0 ? rest[at + 1] : undefined
}

/** @returns the six-digit code the user supplied, if any. */
function codeArg() {
  return flag('--code')
}

if (command === 'setup') {
  if (name === undefined) {
    console.error('用法: bin/admin-mfa.js setup <管理员名>')
    process.exit(2)
  }
  if (console_.adminByName(name) === undefined) {
    console.error(`没有这个管理员: ${name}`)
    process.exit(1)
  }
  const secret = mfa.generateSecret()
  console_.setMfaPending(name, secret)
  console.log(`已为 ${name} 生成密钥（尚未生效，需要 confirm 确认）`)
  console.log('')
  console.log(`  密钥: ${secret}`)
  console.log(`  链接: ${mfa.otpauthUri(secret, name)}`)
  console.log('')
  console.log('把它加进验证器应用（或直接扫上面的链接），然后用它当前的六位码确认：')
  console.log(`  bin/mt.sh admin-mfa confirm ${name} --code <六位码>`)
  process.exit(0)
}

if (command === 'confirm') {
  if (name === undefined) {
    console.error('用法: bin/admin-mfa.js confirm <管理员名> --code <六位码>')
    process.exit(2)
  }
  const secret = console_.mfaSecret(name)
  if (typeof secret !== 'string' || secret === '') {
    console.error(`${name} 没有待确认的密钥，先跑 setup`)
    process.exit(1)
  }
  const code = codeArg()
  if (code === undefined) {
    console.error('需要 --code <六位码>')
    process.exit(2)
  }
  if (!mfa.verifyTotp(secret, code)) {
    console.error('验证码不正确。确认设备时间准确，然后用当前的码重试。')
    process.exit(1)
  }
  const codes = mfa.generateRecoveryCodes(10)
  if (!console_.confirmMfa(name, codes.map((one) => mfa.hashRecoveryCode(one)))) {
    console.error('确认失败')
    process.exit(1)
  }
  console.log(`MFA 已为 ${name} 生效`)
  console.log('')
  console.log('恢复码（只显示这一次，请立刻存到安全的地方；每个只能用一次）：')
  for (const one of codes) console.log(`  ${one}`)
  process.exit(0)
}

if (command === 'status') {
  const rows = console_.readAdmins()
  if (rows.length === 0) {
    console.log('  还没有管理员')
    process.exit(0)
  }
  for (const entry of rows) {
    const active = console_.mfaActive(entry.name)
    const state = active ? '已开启' : (entry.mfa?.secret ? '待确认' : '未开启')
    const left = console_.mfaRecovery(entry.name).length
    console.log(`  ${entry.name.padEnd(16)} ${entry.role.padEnd(8)} ${state}${active ? `（恢复码剩 ${left} 个）` : ''}`)
  }
  process.exit(0)
}

if (command === 'remove') {
  if (name === undefined) {
    console.error('用法: bin/admin-mfa.js remove <管理员名> --yes')
    process.exit(2)
  }
  // Closing a security factor should not be something a single mistyped command does.
  if (!rest.includes('--yes')) {
    console.error(`这会关闭 ${name} 的两步验证，也一并作废其余恢复码。确认请加 --yes。`)
    process.exit(1)
  }
  if (!console_.clearMfa(name)) {
    console.error(`没有这个管理员: ${name}`)
    process.exit(1)
  }
  console.log(`已为 ${name} 关闭 MFA`)
  process.exit(0)
}

console.error('用法: bin/admin-mfa.js setup|confirm|status|remove <管理员名> [--code <六位码>] [--yes]')
process.exit(2)
