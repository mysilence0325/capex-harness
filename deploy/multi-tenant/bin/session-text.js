/**
 * Print a Session log's decoded text so shell tooling can search it.
 *
 * DSH writes session logs as JSONL, compressed with Zstandard by default, and
 * appends each commit as its own frame. Frame-by-frame decoding keeps this
 * working for logs written across many commits.
 *
 * Usage: node bin/session-text.js <session-log-file>
 */

'use strict'

const fs = require('node:fs')
const zlib = require('node:zlib')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode a multi-frame Zstandard file.
 *
 * Node's one-shot zstd decoder stops after the first frame without reporting
 * it, so a concatenated log would silently lose every later commit. Frames are
 * therefore cut on the frame magic and decoded one at a time.
 *
 * @param buffer - complete file contents.
 * @returns the decoded text.
 */
function decodeZstd(buffer) {
  const offsets = []
  let at = buffer.indexOf(ZSTD_MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)
  }
  if (offsets.length <= 1) return zlib.zstdDecompressSync(buffer).toString('utf8')
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // A torn final frame is normal for an interrupted write; skip it.
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node bin/session-text.js <session-log-file>')
  process.exit(2)
}
const raw = fs.readFileSync(file)
process.stdout.write(file.endsWith('.zstd') ? decodeZstd(raw) : raw.toString('utf8'))
