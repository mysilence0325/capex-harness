/**
 * Sign-in throttling.
 *
 * Counts failures per key and refuses a key that has exceeded its budget for a
 * while. Used by both sign-in surfaces — the tenant page and the administrator
 * console — so the two cannot drift apart in policy.
 *
 * Counters live in memory only: a restart clears them, which is acceptable
 * because the budget is small and the window short. Nothing here identifies a
 * caller; it only slows one down.
 *
 * @module mt/gateway/throttle
 */

'use strict'

/** Failures from one source or against one account before it is refused. */
const DEFAULT_MAX_FAILURES = 5
/** How long a refused key stays refused. */
const DEFAULT_LOCKOUT_MS = 5 * 60 * 1000

class Throttle {
  /** Failure counters, keyed by whatever the caller considers a subject. */
  buckets = new Map()

  /**
   * @param options - policy.
   * @param options.maxFailures - failures allowed before a lockout.
   * @param options.lockoutMs - how long the lockout lasts.
   * @param options.name - label used in log lines.
   */
  constructor({ maxFailures = DEFAULT_MAX_FAILURES, lockoutMs = DEFAULT_LOCKOUT_MS, name = 'throttle' } = {}) {
    this.maxFailures = maxFailures
    this.lockoutMs = lockoutMs
    this.name = name
  }

  /** @returns the counter for one key, created on first use. */
  bucketFor(key) {
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      bucket = { count: 0, until: 0 }
      this.buckets.set(key, bucket)
    }
    return bucket
  }

  /**
   * @param key - the subject being limited.
   * @returns seconds it must wait, or 0 when it may try now.
   */
  retryAfter(key) {
    const bucket = this.bucketFor(key)
    const remaining = bucket.until - Date.now()
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0
  }

  /**
   * Record one failure, starting a lockout once the budget is spent.
   * @param key - the subject being limited.
   * @returns seconds of lockout now in effect, or 0 while still under budget.
   */
  fail(key) {
    const bucket = this.bucketFor(key)
    bucket.count += 1
    if (bucket.count < this.maxFailures) return 0
    bucket.count = 0
    bucket.until = Date.now() + this.lockoutMs
    return Math.ceil(this.lockoutMs / 1000)
  }

  /** Forget one key's failures, after a sign-in that succeeded. */
  succeed(key) {
    this.buckets.delete(key)
  }
}

module.exports = { Throttle, DEFAULT_MAX_FAILURES, DEFAULT_LOCKOUT_MS }
