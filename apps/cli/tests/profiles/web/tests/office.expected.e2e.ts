/** Ordinary Web leaves Office authoring composition to its carrier. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { withDefaultWeb } from './default-web-process.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

it('does not mount Office skills, commands, or authoring dependencies in ordinary Web', async (test) => {
  await withDefaultWeb(test, async ({ request }) => {
    const roster = await request('roster')
    for (const name of ['skill-office', 'office-commands', 'tool-workspace-dependencies']) {
      expect(roster.plugins.some(plugin => plugin.name === name)).toBe(false)
    }
  })
})

it('mounts the packaged Office skills and dependency query when a carrier supplies a primary runtime', async (test) => {
  await withDefaultWeb(test, async ({ request }) => {
    const roster = await request('roster')
    for (const name of ['skill-office', 'tool-workspace-dependencies']) {
      expect(roster.plugins.some(plugin => plugin.name === name), name).toBe(true)
    }
  }, {
    async prepare(root) {
      const runtime = join(root, 'runtime')
      await mkdir(join(runtime, 'dependencies', 'python', 'bin'), { recursive: true })
      await writeFile(join(runtime, 'runtime.json'), JSON.stringify({
        desktopVersion: 'test', platform: 'linux', arch: 'arm64', python: '3.12.14', pythonPackages: {},
      }))
    },
    env: root => ({
      DSH_PRIMARY_RUNTIME: join(root, 'runtime'),
      DSH_BUNDLED_OFFICE_SKILLS: join(repoRoot, 'packages/skill/skill-office/assets'),
      DSH_BUNDLED_OFFICE_CLI: '',
      DSH_BUNDLED_OFFICE_NODE: process.execPath,
    }),
  })
})
