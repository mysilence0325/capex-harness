import { describe, expect, it } from 'vitest'
import primaryRuntimeLock from '../../primary-runtime/lock.json' with { type: 'json' }
import { hostNodeArchive } from '../host-platform.ts'

const LOCK = primaryRuntimeLock

describe('hostNodeArchive', () => {
  it('selects the locked x64 archive for an x64 daemon', () => {
    const archive = hostNodeArchive('linux/amd64')
    expect(archive.url).toBe(
      `https://nodejs.org/dist/v${LOCK.nodeVersion}/node-v${LOCK.nodeVersion}-${LOCK.targets['linux-x64'].nodeArchive}`,
    )
    expect(archive.sha256).toBe(LOCK.targets['linux-x64'].nodeSha256)
  })

  it('selects the locked arm64 archive for an arm64 daemon', () => {
    const archive = hostNodeArchive('linux/arm64')
    expect(archive.url).toBe(
      `https://nodejs.org/dist/v${LOCK.nodeVersion}/node-v${LOCK.nodeVersion}-${LOCK.targets['linux-arm64'].nodeArchive}`,
    )
    expect(archive.sha256).toBe(LOCK.targets['linux-arm64'].nodeSha256)
  })
})
