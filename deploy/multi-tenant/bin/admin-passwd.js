#!/usr/bin/env node
/**
 * Set the console's administrator password.
 *
 * Kept as its own command because it is the documented first-run step and the way
 * back in when a password is lost. It delegates to `bin/admin-users.js`: with more
 * than one administrator, writing the whole file here would delete the others.
 *
 * Usage:
 *   node bin/admin-passwd.js <password> [--user <name>] [--role admin|viewer] [--keep-sessions]
 *
 * The first invocation creates the administrator; later ones change its password.
 *
 * @module mt/bin/admin-passwd
 */

'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const args = process.argv.slice(2)
const password = args[0]
if (password === undefined || password === '' || password.startsWith('--')) {
  console.error('usage: node bin/admin-passwd.js <password> [--user <name>] [--role admin|viewer] [--keep-sessions]')
  process.exit(2)
}

const at = args.indexOf('--user')
const user = at >= 0 ? (args[at + 1] ?? 'admin') : 'admin'
// Everything after the password except the --user pair, forwarded as-is.
const rest = []
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === '--user') {
    i += 1
    continue
  }
  rest.push(args[i])
}

const outcome = spawnSync(
  process.execPath,
  [path.join(__dirname, 'admin-users.js'), 'passwd', user, '--password', password, ...rest],
  { stdio: 'inherit' },
)
process.exit(outcome.status ?? 1)
