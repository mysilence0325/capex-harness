import { describe, expect, it } from 'vitest'
import { parseCleanArgs } from '../src/clean.ts'

describe('parseCleanArgs', () => {
  it('defaults to a 90-day dry run', () => {
    expect(parseCleanArgs([])).toEqual({
      olderThanMs: 90 * 24 * 60 * 60 * 1_000,
      apply: false,
      json: false,
      purgeTrash: false,
    })
  })

  it('parses apply, restore, purge, and duration bounds', () => {
    expect(parseCleanArgs(['--older-than', '30d', '--apply', '--json'])).toMatchObject({
      olderThanMs: 30 * 24 * 60 * 60 * 1_000,
      apply: true,
      json: true,
    })
    expect(parseCleanArgs(['--restore=batch'])).toMatchObject({ restore: 'batch' })
    expect(parseCleanArgs(['--purge-trash', '--older-than=1h'])).toMatchObject({
      purgeTrash: true,
      olderThanMs: 3_600_000,
    })
  })

  it('rejects invalid input', () => {
    for (const args of [
      ['--older-than'],
      ['--older-than', '90'],
      ['--restore'],
      ['--restore', 'batch', '--apply'],
      ['--purge-trash', '--apply'],
      ['--unknown'],
    ]) expect(() => parseCleanArgs(args)).toThrow()
  })
})
