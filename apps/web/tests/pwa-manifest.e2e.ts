import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    icons: [{
      src: 'favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it('uses the configured product title in the initial document', async () => {
  const record: unknown = JSON.parse(await readFile(join(REPO_ROOT, '.dsh-build', 'client-build-environment.json'), 'utf8'))
  if (!isRecord(record) || !isRecord(record.environment)) {
    throw new TypeError('client build record must contain an environment object')
  }
  const title = record.environment.DSH_CLIENT_TITLE
  if (title !== undefined && typeof title !== 'string') throw new TypeError('DSH_CLIENT_TITLE must be a string')
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain(`<title>${title ?? 'DSH Local Build'}</title>`)
})

it('ships the brand favicon under both document media queries', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  const light = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  const dark = await readFile(join(DIST_ROOT, 'favicon-dark.svg'), 'utf8')
  expect(light).not.toContain('<style>')
  // The Capex symbol carries its own palette, so no theme swap is needed.
  expect(light).toContain('stop-color="#087CF4"')
  expect(light).toContain('id="c-cut"')
  expect(dark).toBe(light)
})
