/**
 * Mutual exclusion for the tenant registry.
 *
 * Two independent writers change `tenants.json`: `bin/registry.js` from the
 * command line and the administrator console inside the control plane. Both do
 * read-modify-write, so without exclusion a tenant added by one can lose an edit
 * made by the other — the window is small, but a lost password change is not a
 * small outcome.
 *
 * The lock is a file created with `wx`, which fails when it already exists. A
 * holder that dies without releasing would block every later writer, so a lock
 * older than {@link STALE_MS} is taken over and reported. That is a real risk
 * only if a writer is killed mid-write, and the alternative — no timeout — turns
 * one crash into a permanent outage of tenant management.
 *
 * Lives beside the control plane rather than in `bin/` because the gateway image
 * only ships this directory; `bin/registry.js` requires it by path.
 *
 * @module mt/gateway/tenant-lock
 */

'use strict'

const fs = require('node:fs')

/** A lock older than this is assumed abandoned. */
const STALE_MS = 15_000
/** How long to keep trying before giving up. */
const WAIT_MS = 5_000

/** Block the current thread without spinning the CPU. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Take the registry lock.
 *
 * @param registryFile - the file being protected; the lock sits beside it.
 * @param options - timing.
 * @param options.waitMs - how long to keep trying.
 * @param options.staleMs - age at which an existing lock is taken over.
 * @returns a release function.
 * @throws when the lock cannot be taken within the wait, or cannot be created.
 */
function acquire(registryFile, options = {}) {
  const lockFile = `${registryFile}.lock`
  const waitMs = options.waitMs ?? WAIT_MS
  const staleMs = options.staleMs ?? STALE_MS
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const handle = fs.openSync(lockFile, 'wx')
      fs.writeSync(handle, `${String(process.pid)} ${new Date().toISOString()}\n`)
      let released = false
      const release = () => {
        if (released) return
        released = true
        try {
          fs.closeSync(handle)
        } catch {
          /* already closed by process teardown */
        }
        try {
          fs.unlinkSync(lockFile)
        } catch {
          /* another writer already took it over after a stale check */
        }
      }
      process.on('exit', release)
      return release
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let ageMs = 0
      try {
        ageMs = Date.now() - fs.statSync(lockFile).mtimeMs
      } catch {
        // The holder released between our open and our stat: retry immediately.
        continue
      }
      if (ageMs > staleMs) {
        console.error(`${lockFile} is ${String(Math.round(ageMs / 1000))}s old; taking it over`)
        try {
          fs.unlinkSync(lockFile)
        } catch {
          /* someone else got there first */
        }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`another writer holds ${lockFile} (${String(Math.round(ageMs / 1000))}s); retry in a moment`)
      }
      sleep(50)
    }
  }
}

/**
 * Run one read-modify-write under the lock.
 *
 * The document is read inside the lock, so a mutation always applies to the
 * file's current contents rather than to a copy read before the lock was taken.
 *
 * @param registryFile - the file to mutate.
 * @param mutate - receives the parsed document; return the value to hand back.
 * @param options - timing, passed through to {@link acquire}.
 * @returns whatever `mutate` returned.
 */
function update(registryFile, mutate, options = {}) {
  const release = acquire(registryFile, options)
  try {
    const document = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
    const result = mutate(document)
    // Written in place, never renamed: the control plane's watcher holds this
    // inode through a bind mount.
    fs.writeFileSync(registryFile, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    return result
  } finally {
    release()
  }
}

module.exports = { acquire, update, STALE_MS, WAIT_MS }
