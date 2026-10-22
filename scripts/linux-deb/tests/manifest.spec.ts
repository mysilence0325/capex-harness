import { describe, expect, it } from 'vitest'
import {
  parseDependencyRecords,
  parsePipReport,
  parseRuntimeDownloadManifest,
  renderDependenciesMarkdown,
  verifyDebBuildManifest,
  type DebBuildManifest,
} from '../manifest.ts'

const RECORD_LINE = 'apt\tbuild-essential\t12.8ubuntu1\tubuntu archive\t-\tC toolchain\t0'

function sampleManifest(): DebBuildManifest {
  return {
    schemaVersion: 1,
    package: { name: 'deepseek-harness', version: '0.2.1~alpha.4-1', architecture: 'arm64', maintains: 'Test <t@e.invalid>' },
    repository: { revision: 'a'.repeat(40), dirty: false },
    images: ['ubuntu:20.04'],
    maxGlibc: '2.31',
    glibcFloor: '2.31',
    includesNodeCli: true,
    smoked: true,
    artifact: { file: 'deepseek-harness_0.2.1~alpha.4-1_arm64.deb', sizeBytes: 1024, sha256: 'b'.repeat(64) },
    dependencies: [
      { kind: 'apt', name: 'build-essential', version: '12.8ubuntu1', source: 'ubuntu archive', digest: '-', purpose: 'C toolchain', included: false },
      { kind: 'archive', name: 'node', version: '24.21.0', source: 'https://nodejs.org/dist/v24.21.0/node.tar.gz', digest: 'sha256:cd', purpose: 'CLI runtime', included: true },
    ],
  }
}

describe('parseDependencyRecords', () => {
  it('reads the tab-separated records the container appends', () => {
    expect(parseDependencyRecords(`${RECORD_LINE}\n`)).toEqual([
      { kind: 'apt', name: 'build-essential', version: '12.8ubuntu1', source: 'ubuntu archive', digest: '-', purpose: 'C toolchain', included: false },
    ])
  })

  it('accepts an included record', () => {
    const records = parseDependencyRecords('local\tdsh-node-carrier\t24.21.0\t/work/product/dsh\t-\tclosure\t1')
    expect(records[0]?.included).toBe(true)
  })

  it('ignores blank lines', () => {
    expect(parseDependencyRecords('\n\n')).toEqual([])
  })

  it('rejects a record with the wrong field count', () => {
    expect(() => parseDependencyRecords('apt\tbuild-essential\t12.8')).toThrow('expected 7 tab-separated fields, got 3')
  })

  it('rejects an unknown kind', () => {
    expect(() => parseDependencyRecords('gem\tfoo\t1\tbar\t-\tpurpose\t0')).toThrow('unknown kind')
  })

  it('rejects an invalid inclusion flag', () => {
    expect(() => parseDependencyRecords('apt\tfoo\t1\tbar\t-\tpurpose\ttrue')).toThrow('inclusion flag')
  })
})

describe('parsePipReport', () => {
  it('reads the distributions pip resolved', () => {
    const report = {
      install: [{
        download_info: { url: 'https://files.pythonhosted.org/pydantic-2.12.0.whl', archive_info: { hashes: { sha256: 'c'.repeat(64) } } },
        metadata: { name: 'pydantic', version: '2.12.0' },
      }],
    }
    expect(parsePipReport(report)).toEqual([
      { name: 'pydantic', version: '2.12.0', url: 'https://files.pythonhosted.org/pydantic-2.12.0.whl', sha256: `sha256:${'c'.repeat(64)}` },
    ])
  })

  it('keeps a record without a published digest', () => {
    const report = { install: [{ download_info: { url: 'https://example.invalid/a.whl' }, metadata: { name: 'a', version: '1' } }] }
    expect(parsePipReport(report)[0]?.sha256).toBe('-')
  })

  it('rejects a report without the install table', () => {
    expect(() => parsePipReport({})).toThrow('install must be an array')
  })

  it('rejects an entry without distribution metadata', () => {
    expect(() => parsePipReport({ install: [{ download_info: { url: 'https://example.invalid/a.whl' } }] })).toThrow('metadata must be an object')
  })
})

describe('parseRuntimeDownloadManifest', () => {
  it('reads the identity, Office packages, and package manager archive', () => {
    const manifest = {
      target: 'linux-arm64',
      identity: 'd'.repeat(64),
      office: [{ name: '@deepseek-ai/libreoffice-kit', version: '0.1.5', url: 'https://registry.npmjs.org/k/-/k-0.1.5.tgz', integrity: 'sha512-abc' }],
      pnpm: { name: 'pnpm', version: '11.28.5', url: 'https://registry.npmjs.org/pnpm/-/pnpm-11.28.5.tgz', integrity: 'sha512-def' },
    }
    const parsed = parseRuntimeDownloadManifest(manifest)
    expect(parsed.identity).toBe('d'.repeat(64))
    expect(parsed.office).toHaveLength(1)
    expect(parsed.pnpm.version).toBe('11.28.5')
  })

  it('rejects a non-digest identity', () => {
    expect(() => parseRuntimeDownloadManifest({ target: 'linux-arm64', identity: 'nope', office: [], pnpm: {} }))
      .toThrow('identity must be a lowercase SHA-256 digest')
  })

  it('rejects an entry without a registry URL', () => {
    expect(() => parseRuntimeDownloadManifest({
      target: 'linux-arm64',
      identity: 'd'.repeat(64),
      office: [{ name: 'a', version: '1' }],
      pnpm: { name: 'pnpm', version: '1', url: 'https://example.invalid' },
    })).toThrow('url must be a non-empty string')
  })
})

describe('verifyDebBuildManifest', () => {
  it('round-trips a complete manifest', () => {
    const manifest = sampleManifest()
    expect(verifyDebBuildManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
  })

  it('rejects a manifest whose artifact digest is not a digest', () => {
    const manifest = { ...sampleManifest(), artifact: { file: 'a.deb', sizeBytes: 1, sha256: 'short' } }
    expect(() => verifyDebBuildManifest(manifest)).toThrow('artifact.sha256 must be a lowercase SHA-256 digest')
  })

  it('rejects a manifest without an artifact size', () => {
    const manifest = { ...sampleManifest(), artifact: { file: 'a.deb', sizeBytes: 0, sha256: 'b'.repeat(64) } }
    expect(() => verifyDebBuildManifest(manifest)).toThrow('artifact.sizeBytes must be a positive integer')
  })

  it('rejects an unknown dependency kind inside the manifest', () => {
    const manifest = sampleManifest()
    const broken = { ...manifest, dependencies: [{ ...manifest.dependencies[0], kind: 'gem' }] }
    expect(() => verifyDebBuildManifest(broken)).toThrow('unknown kind')
  })

  it('rejects a non-boolean inclusion flag inside the manifest', () => {
    const manifest = sampleManifest()
    const broken = { ...manifest, dependencies: [{ ...manifest.dependencies[0], included: 'yes' }] }
    expect(() => verifyDebBuildManifest(broken)).toThrow('included must be a boolean')
  })

  it('rejects a manifest missing the glibc floor', () => {
    const { glibcFloor: _omitted, ...manifest } = sampleManifest()
    expect(() => verifyDebBuildManifest(manifest)).toThrow('glibcFloor must be a non-empty string')
  })

  it('rejects a non-object manifest', () => {
    expect(() => verifyDebBuildManifest('not a manifest')).toThrow('manifest must be an object')
  })
})

describe('renderDependenciesMarkdown', () => {
  it('reports package identity, the artifact, and grouped dependencies', () => {
    const markdown = renderDependenciesMarkdown(sampleManifest())
    expect(markdown).toContain('# deepseek-harness 0.2.1~alpha.4-1 dependencies')
    expect(markdown).toContain('## System packages (apt)')
    expect(markdown).toContain('## Locked archives')
    expect(markdown).toContain('| `node` | 24.21.0 |')
    expect(markdown).toContain('glibc: payload requires 2.31, declared target floor 2.31')
  })
})
