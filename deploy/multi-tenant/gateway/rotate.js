/**
 * Append-only JSONL logs with a size ceiling.
 *
 * The gateway's own logs — access, administration — are written here rather than
 * to stdout, because they carry per-tenant attribution the container log cannot.
 * That also means Docker's log options do not bound them, so this module does:
 * when a file would exceed its ceiling it is shifted to `.1`, `.2` and so on, and
 * the oldest is dropped. The policy names and defaults match the container log
 * options (`MT_LOG_MAX_SIZE`, `MT_LOG_MAX_FILE`) so one deployment setting
 * describes both.
 *
 * Readers must include the shifted files; `rotatedFiles` lists them oldest first.
 *
 * @module mt/gateway/rotate
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Parse a Docker-style size (`10m`, `512k`, `1g`, or bytes). */
function parseSize(value, fallback) {
  if (typeof value !== 'string') return fallback
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/iu.exec(value.trim())
  if (match === null) return fallback
  const scale = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[match[2].toLowerCase()]
  return Math.floor(Number(match[1]) * scale)
}

/**
 * Ceiling for one log file.
 * @param fallback - value to use when the environment says nothing.
 * @returns the ceiling in bytes.
 */
function maxBytesFromEnv(fallback = 10 * 1024 * 1024) {
  return parseSize(process.env.MT_LOG_MAX_SIZE, fallback)
}

/**
 * How many shifted files to keep beside the current one.
 * @param fallback - value to use when the environment says nothing.
 * @returns the number of shifted files.
 */
function maxFilesFromEnv(fallback = 3) {
  const parsed = Number(process.env.MT_LOG_MAX_FILE ?? fallback)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Every file holding this log's data, oldest first.
 *
 * A reader that only opens the current file silently loses everything written
 * before the last rotation, so totals computed from a log take their input from
 * here.
 *
 * @param file - the current file.
 * @param maxFiles - how many shifted files exist at most.
 * @returns existing paths, oldest first, ending with the current file when present.
 */
function rotatedFiles(file, maxFiles = maxFilesFromEnv()) {
  const paths = []
  for (let index = maxFiles; index >= 1; index -= 1) {
    const shifted = `${file}.${String(index)}`
    if (fs.existsSync(shifted)) paths.push(shifted)
  }
  if (fs.existsSync(file)) paths.push(file)
  return paths
}

/**
 * Shift the log one generation when it is full.
 * @param file - the current file.
 * @param maxFiles - how many shifted files to keep.
 */
function shift(file, maxFiles) {
  fs.rmSync(`${file}.${String(maxFiles)}`, { force: true })
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const from = `${file}.${String(index)}`
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${String(index + 1)}`)
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`)
}

/**
 * Append one line, rotating first when the file is at its ceiling.
 *
 * A write that fails must never take the caller down: an audit line is important
 * but not worth losing a request over, so failures are reported and swallowed.
 *
 * @param file - the file to append to.
 * @param line - one line, without its terminator.
 * @param options - ceilings.
 * @param options.maxBytes - size at which the file is shifted.
 * @param options.maxFiles - how many shifted files to keep.
 */
function appendRotated(file, line, options = {}) {
  const maxBytes = options.maxBytes ?? maxBytesFromEnv()
  const maxFiles = options.maxFiles ?? maxFilesFromEnv()
  const entry = `${line}\n`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      size = 0
    }
    // A single entry larger than the ceiling would rotate forever; write it and
    // let the next entry start a fresh file.
    if (size > 0 && size + Buffer.byteLength(entry) > maxBytes) shift(file, maxFiles)
    fs.appendFileSync(file, entry, { mode: 0o600 })
  } catch (error) {
    console.error(`${path.basename(file)}: cannot append: ${error.message}`)
  }
}

module.exports = { appendRotated, rotatedFiles, maxBytesFromEnv, maxFilesFromEnv, parseSize }
