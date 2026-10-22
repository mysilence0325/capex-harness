/** The Web product ships no settings page for a tool it does not mount. */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

it('leaves the web-search settings page unmounted', () => {
  const rows = loadOverlayPatches('offline-posture', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
    .filter(row => row.id === 'ui-settings-web-search')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.disabled).toBe(true)
})
