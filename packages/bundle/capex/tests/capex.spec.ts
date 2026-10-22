import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const patches = loadOverlayPatches('capex-test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))

describe('Capex offline composition', () => {
  it.each([
    'authorization',
    'deepseek-account',
    'llm-deepseek-account',
    'account-controller',
    'ui-settings-account',
    'web-search-deepseek',
    'web-deepseek-api',
    'web-fetch-http',
    'tool-web',
  ])('disables %s', id => {
    expect(patches).toContainEqual(expect.objectContaining({ id, disabled: true }))
  })

  it('keeps the local credential provider needed for Web authentication', () => {
    expect(patches.find(row => row.id === 'credentials')).toBeUndefined()
  })

  it('mounts the local identity and maintenance surfaces', () => {
    expect(patches).toContainEqual(expect.objectContaining({ insert: expect.arrayContaining([
      expect.objectContaining({ id: 'local-user', name: '@deepseek-ai/dsh-local-user' }),
      expect.objectContaining({ id: 'desktop-open', name: '@deepseek-ai/dsh-client-ui-desktop-open' }),
      expect.objectContaining({ id: 'storage-maintenance', name: '@deepseek-ai/dsh-storage-maintenance' }),
      expect.objectContaining({ id: 'ui-settings-storage', name: '@deepseek-ai/dsh-client-ui-settings-storage' }),
    ]) }))
  })
})
