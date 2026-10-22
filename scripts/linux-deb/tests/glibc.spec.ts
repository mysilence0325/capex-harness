import { describe, expect, it } from 'vitest'
import {
  assertGlibcFloor,
  compareGlibcVersions,
  glibcViolations,
  maxGlibcVersion,
  parseVersionInfoDump,
  VERSION_INFO_MARKER,
} from '../glibc.ts'

const LIBRARY_SECTION = [
  "Version needs section '.gnu.version_r' contains 2 entries:",
  ' Addr: 0x000000000000  Offset: 0x000010  Link: 6 (.dynstr)',
  '  000000: Version: 1  File: libc.so.6  Cnt: 2',
  '  0x0010:   Name: GLIBC_2.17  Flags: none  Version: 3',
  '  0x0020:   Name: GLIBC_2.28  Flags: none  Version: 4',
  '  0x0030: Version: 1  File: libstdc++.so.6  Cnt: 1',
  '  0x0040:   Name: GLIBCXX_3.4.21  Flags: none  Version: 5',
].join('\n')

describe('parseVersionInfoDump', () => {
  it('splits one capture into per-file entries', () => {
    const dump = [
      `${VERSION_INFO_MARKER}/usr/lib/capex-harness/node/bin/node`,
      'Version needs section',
      `${VERSION_INFO_MARKER}/usr/lib/capex-harness/dsh/runtime/node/pty.node`,
      'nothing here',
      '',
    ].join('\n')
    const entries = parseVersionInfoDump(dump)
    expect(entries.map(entry => entry.path)).toEqual([
      '/usr/lib/capex-harness/node/bin/node',
      '/usr/lib/capex-harness/dsh/runtime/node/pty.node',
    ])
    expect(entries[0]?.output).toBe('Version needs section')
    expect(entries[1]?.output).toBe('nothing here')
  })

  it('ignores text before the first marker', () => {
    expect(parseVersionInfoDump('noise without entries')).toEqual([])
  })

  it('keeps a blank line the file itself printed', () => {
    const dump = `${VERSION_INFO_MARKER}/node\nfirst\n\n${VERSION_INFO_MARKER}/pty.node\nsecond\n`
    expect(parseVersionInfoDump(dump).map(entry => entry.output)).toEqual(['first\n', 'second'])
  })
})

describe('maxGlibcVersion', () => {
  it('reports the highest glibc symbol and ignores other libraries', () => {
    expect(maxGlibcVersion(LIBRARY_SECTION)).toBe('2.28')
  })

  it('orders double-digit minor versions numerically', () => {
    expect(maxGlibcVersion('Name: GLIBC_2.9\nName: GLIBC_2.10')).toBe('2.10')
  })

  it('returns undefined when no glibc symbol is referenced', () => {
    expect(maxGlibcVersion('  0x0010:   Name: GLIBCXX_3.4.21  Flags: none')).toBeUndefined()
  })
})

describe('compareGlibcVersions', () => {
  it('orders by numeric component', () => {
    expect(compareGlibcVersions('2.28', '2.31')).toBeLessThan(0)
    expect(compareGlibcVersions('2.31', '2.28')).toBeGreaterThan(0)
    expect(compareGlibcVersions('2.28', '2.28')).toBe(0)
  })

  it('treats a missing component as zero', () => {
    expect(compareGlibcVersions('2.28', '2.28.0')).toBe(0)
  })
})

describe('glibcViolations', () => {
  it('names the files above the floor', () => {
    const entries = [
      { path: '/usr/lib/capex-harness/node/bin/node', output: 'Name: GLIBC_2.28' },
      { path: '/usr/lib/capex-harness/dsh/pty.node', output: 'Name: GLIBC_2.31' },
    ]
    expect(glibcViolations(entries, '2.28')).toEqual([
      { path: '/usr/lib/capex-harness/dsh/pty.node', required: '2.31' },
    ])
  })

  it('accepts a payload at the floor', () => {
    const entries = [{ path: '/node', output: 'Name: GLIBC_2.28' }]
    expect(glibcViolations(entries, '2.28')).toEqual([])
  })
})

describe('assertGlibcFloor', () => {
  it('passes silently when every file fits the floor', () => {
    expect(() => {
      assertGlibcFloor([{ path: '/node', output: 'Name: GLIBC_2.28' }], '2.31')
    }).not.toThrow()
  })

  it('lists the offending files and the rebuild advice', () => {
    const entries = [{ path: '/usr/lib/capex-harness/dsh/pty.node', output: 'Name: GLIBC_2.31' }]
    expect(() => {
      assertGlibcFloor(entries, '2.28')
    }).toThrow(/GLIBC_2\.31[\s\S]*--glibc-floor/u)
  })
})
