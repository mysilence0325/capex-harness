/**
 * TOTP for administrator sign-in, from the standard library only.
 *
 * RFC 6238 over RFC 4226: HMAC-SHA1 of a time counter, truncated to six digits, on a
 * thirty-second step. `node:crypto` has everything this needs, and an authentication
 * factor is a poor place to add a dependency to an air-gapped deployment.
 *
 * @module mt/gateway/mfa
 */

'use strict'

const crypto = require('node:crypto')

/** Digits in a generated code. */
const DIGITS = 6

/** Seconds per step. */
const STEP_SECONDS = 30

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Base32 without padding, the encoding authenticator apps expect.
 * @param buffer - bytes to encode.
 * @returns the encoded string.
 */
function base32Encode(buffer) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * @param text - base32 string, case and padding insensitive.
 * @returns the decoded bytes, or undefined when the text is not base32.
 */
function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  if (clean === '' || /[^A-Z2-7]/.test(clean)) return undefined
  let bits = 0
  let value = 0
  const out = []
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** @returns a fresh 160-bit secret in base32, the length RFC 4226 recommends. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20))
}

/**
 * One code for a counter value.
 * @param secret - base32 secret.
 * @param counter - the step counter.
 * @returns the code, or undefined when the secret is unusable.
 */
function hotp(secret, counter) {
  const key = base32Decode(secret)
  if (key === undefined) return undefined
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = crypto.createHmac('sha1', key).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

/**
 * The code for a moment in time.
 * @param secret - base32 secret.
 * @param at - milliseconds since the epoch; defaults to now.
 * @returns the code.
 */
function totp(secret, at = Date.now()) {
  return hotp(secret, Math.floor(at / 1000 / STEP_SECONDS))
}

/**
 * Check a code, allowing one step either side.
 *
 * The window exists because phone clocks drift and people type slowly; one step is the
 * common compromise and keeps a stolen code usable for at most ninety seconds.
 *
 * @param secret - base32 secret.
 * @param code - the digits the user typed.
 * @param at - milliseconds since the epoch; defaults to now.
 * @returns whether the code matches.
 */
function verifyTotp(secret, code, at = Date.now()) {
  const wanted = String(code ?? '').replace(/\D/g, '')
  if (wanted.length !== DIGITS) return false
  const step = Math.floor(at / 1000 / STEP_SECONDS)
  for (const offset of [0, -1, 1]) {
    const candidate = hotp(secret, step + offset)
    if (candidate === undefined) return false
    // Constant-time: a timing signal on a six-digit code is a real signal.
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(wanted))) return true
  }
  return false
}

/**
 * The URI an authenticator app scans.
 * @param secret - base32 secret.
 * @param account - the administrator name.
 * @param issuer - what the app shows as the service.
 * @returns the otpauth URI.
 */
function otpauthUri(secret, account, issuer = 'DSH 多租户控制台') {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) })
  return `otpauth://totp/${label}?${query.toString()}`
}

/**
 * Recovery codes, shown once and stored hashed.
 * @param count - how many to make.
 * @returns the plaintext codes.
 */
function generateRecoveryCodes(count = 10) {
  const codes = []
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase()
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`)
  }
  return codes
}

/**
 * @param code - a recovery code as typed.
 * @returns its stored form. Hashed, not encrypted: nothing needs to read it back, and a
 * file that leaks should not hand over working codes.
 */
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex')
}

module.exports = {
  DIGITS,
  STEP_SECONDS,
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  verifyTotp,
  otpauthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
}
