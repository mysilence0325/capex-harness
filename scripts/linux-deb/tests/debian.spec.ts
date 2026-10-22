import { describe, expect, it } from 'vitest'
import {
  DEB_ARCHITECTURE,
  DEB_DEPENDS,
  DEB_INSTALL_ROOT,
  DEB_PACKAGE_NAME,
  debianArtifactName,
  debianVersion,
  deepseekHarnessPackage,
  renderControlFile,
} from '../debian.ts'

describe('debianVersion', () => {
  it('turns a prerelease separator into the ordering tilde', () => {
    expect(debianVersion('0.2.1-alpha.4')).toBe('0.2.1~alpha.4')
  })

  it('appends the revision to a release version', () => {
    expect(debianVersion('1.2.3')).toBe('1.2.3')
    expect(debianVersion('1.2.3', '1')).toBe('1.2.3-1')
  })

  it('accepts a v prefix and a custom revision', () => {
    expect(debianVersion('v0.2.1-rc.1', '7')).toBe('0.2.1~rc.1-7')
  })

  it('trims surrounding whitespace', () => {
    expect(debianVersion(' 0.2.1-alpha.4\n')).toBe('0.2.1~alpha.4')
  })

  it('rejects an empty version', () => {
    expect(() => debianVersion('   ')).toThrow('the product version is empty')
  })

  it('rejects an upstream version that does not start with a digit', () => {
    expect(() => debianVersion('alpha.4')).toThrow('is not a Debian upstream version')
  })

  it('rejects characters Debian does not allow in a version', () => {
    expect(() => debianVersion('0.2.1-alpha 4')).toThrow('is not a Debian upstream version')
  })

  it('rejects an invalid revision', () => {
    expect(() => debianVersion('0.2.1', '1 beta')).toThrow('is not a Debian revision')
  })
})

describe('renderControlFile', () => {
  const metadata = deepseekHarnessPackage('0.2.1-alpha.4', { maintainer: 'Test <test@example.invalid>' })

  it('names the package, version, architecture, and maintainer', () => {
    const control = renderControlFile(metadata)
    expect(control).toContain(`Package: ${DEB_PACKAGE_NAME}\n`)
    expect(control).toContain('Version: 0.2.1~alpha.4\n')
    expect(control).toContain(`Architecture: ${DEB_ARCHITECTURE}\n`)
    expect(control).toContain('Maintainer: Test <test@example.invalid>\n')
  })

  it('declares the runtime dependencies the payload needs', () => {
    const control = renderControlFile(metadata)
    expect(control).toContain(`Depends: ${DEB_DEPENDS.join(', ')}\n`)
    expect(control).toContain('Recommends: bubblewrap, git\n')
  })

  it('indents the long description and represents blank lines with a lone dot', () => {
    const control = renderControlFile(metadata)
    const lines = control.split('\n')
    const start = lines.findIndex(line => line.startsWith('Description: '))
    const continuation = lines.slice(start + 1, -1)
    expect(continuation[0]).toBe(' Capex Harness runs a plugin-composed agent loop from a configuration')
    expect(continuation).toContain(' .')
    expect(continuation.every(line => line.startsWith(' '))).toBe(true)
  })

  it('ends the control file with one newline', () => {
    const control = renderControlFile(metadata)
    expect(control.endsWith('\n')).toBe(true)
    expect(control.endsWith('\n\n')).toBe(false)
  })

  it('rejects a synopsis that spans lines', () => {
    expect(() => renderControlFile({ ...metadata, shortDescription: 'two\nlines' })).toThrow('must be a single line')
  })
})

describe('debianArtifactName', () => {
  it('follows the Debian file naming convention', () => {
    const metadata = deepseekHarnessPackage('0.2.1-alpha.4', { maintainer: 'Test <test@example.invalid>' })
    expect(debianArtifactName(metadata)).toBe('capex-harness_0.2.1~alpha.4_arm64.deb')
  })
})

describe('payload layout', () => {
  it('installs under the declared prefix', () => {
    expect(DEB_INSTALL_ROOT).toBe('/usr/lib/capex-harness')
  })
})
