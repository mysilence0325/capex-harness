/**
 * The keys this deployment authenticates with, one per purpose.
 *
 * `state/registry.key` used to be a single shared secret covering three unrelated
 * jobs: reading metrics, registering tenant runtimes, and running host maintenance.
 * Anything that held it could do all three, and the metrics token is the one most
 * likely to be handed to somebody else - a Prometheus that scrapes this deployment.
 * A read-only scrape token should not be able to restart every tenant.
 *
 * `state/keys.json` holds one key per purpose. The legacy `registry.key` is still
 * accepted for every purpose, so introducing the file cannot break a running
 * deployment, and removing it is a deliberate act rather than a side effect.
 *
 * @module mt/gateway/keys
 */

'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/** Purposes a key can be issued for. */
const PURPOSES = ['metrics', 'register', 'ops']

/**
 * Read the keys for a state directory.
 *
 * @param stateDir - directory holding `registry.key` and, once generated, `keys.json`.
 * @returns one key per purpose, plus the legacy key each falls back to.
 */
function readKeys(stateDir) {
  const legacyFile = path.join(stateDir, 'registry.key')
  let legacy = ''
  try {
    legacy = fs.readFileSync(legacyFile, 'utf8').trim()
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`mt: cannot read ${legacyFile}: ${error.message}`)
  }

  let stored = {}
  try {
    stored = JSON.parse(fs.readFileSync(path.join(stateDir, 'keys.json'), 'utf8'))
  } catch (error) {
    // No keys.json yet is the normal state before the split: every purpose falls
    // back to the legacy key and behaviour is exactly what it was.
    if (error.code !== 'ENOENT') console.error(`mt: cannot read keys.json: ${error.message}`)
  }

  const keys = { legacy }
  for (const purpose of PURPOSES) {
    keys[purpose] = typeof stored?.[purpose] === 'string' && stored[purpose] !== '' ? stored[purpose] : legacy
  }
  return keys
}

/**
 * Generate the per-purpose keys, leaving any that already exist alone.
 *
 * @param stateDir - directory to write `keys.json` into.
 * @returns the keys now in effect.
 */
function generateKeys(stateDir) {
  const file = path.join(stateDir, 'keys.json')
  let stored = {}
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`mt: cannot read ${file}: ${error.message}`)
  }
  for (const purpose of PURPOSES) {
    if (typeof stored?.[purpose] !== 'string' || stored[purpose] === '') {
      stored[purpose] = crypto.randomBytes(24).toString('base64url')
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  return readKeys(stateDir)
}

module.exports = { PURPOSES, readKeys, generateKeys }
