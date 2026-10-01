/**
 * Build a Docker image overlay from this checkout's built artifacts.
 *
 * The deployed image installs DSH from npm; this overlay replaces the installed
 * files with the ones built from THIS source tree, so the deployment serves the
 * locally modified code (for example a different browser target).
 *
 * Output layout mirrors the container install path, so the image needs exactly
 * one COPY:
 *
 *   image-overlay/node_modules/@deepseek-ai/<pkg>/lib/**        (every package with a build)
 *   image-overlay/node_modules/@deepseek-ai/dsh-web-frontend/dist/**
 *   image-overlay/manifest.json                                 (what went in)
 *
 * Usage:
 *   node bin/make-image-overlay.mjs --src <checkout> --out <dir> [--maps] [--all-lib]
 *
 *   --maps     include *.js.map (bigger, better browser stack traces)
 *   --all-lib  copy every built package's lib/, not only client/browser faces
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

function flag(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const SRC = resolve(flag('src') ?? '.')
const OUT = resolve(flag('out') ?? 'image-overlay')
const WITH_MAPS = process.argv.includes('--maps')
const ALL_LIB = process.argv.includes('--all-lib')

if (!existsSync(join(SRC, 'package.json'))) {
  console.error(`not a checkout: ${SRC}`)
  process.exit(1)
}

/** Every workspace package directory that has a package.json. */
function workspaceDirs() {
  const found = []
  const roots = ['packages', 'apps', 'vendor', 'native']
  for (const root of roots) {
    const rootPath = join(SRC, root)
    if (!existsSync(rootPath)) continue
    const walk = (dir, depth) => {
      if (depth > 3) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const child = join(dir, entry.name)
        if (existsSync(join(child, 'package.json'))) found.push(child)
        walk(child, depth + 1)
      }
    }
    walk(rootPath, 0)
  }
  return found
}

const SKIP_SUFFIX = ['.tsbuildinfo']
const isSkipped = (file) =>
  SKIP_SUFFIX.some((suffix) => file.endsWith(suffix)) || (!WITH_MAPS && file.endsWith('.map'))

const packages = []
let bytes = 0
const skipped = []
const natives = []

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'node_modules', '@deepseek-ai'), { recursive: true })

for (const dir of workspaceDirs()) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  const name = manifest.name
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) continue

  // `lib/` is the Node/browser build output; `apps/web` publishes `dist/` instead.
  const sources = []
  if (existsSync(join(dir, 'lib'))) sources.push(['lib', join(dir, 'lib')])
  if (existsSync(join(dir, 'dist'))) sources.push(['dist', join(dir, 'dist')])
  if (sources.length === 0) {
    skipped.push(name)
    continue
  }

  packages.push({ name, dir: relative(SRC, dir), files: [] })
  const record = packages[packages.length - 1]

  for (const [facet, from] of sources) {
    const target = join(OUT, 'node_modules', name, facet)
    const filter = (source) => {
      if (isSkipped(source)) return false
      if (source.endsWith('.node')) {
        natives.push(relative(SRC, source))
        return false
      }
      const stats = statSync(source)
      if (stats.isFile()) bytes += stats.size
      return true
    }
    cpSync(from, target, { recursive: true, filter })
    record.files.push(facet)
  }
}

/** Content proof: the served shell entry must equal the local build's. */
const frontendIndex = join(OUT, 'node_modules', '@deepseek-ai/dsh-web-frontend', 'dist', 'index.html')
const indexHash = existsSync(frontendIndex)
  ? createHash('sha256').update(readFileSync(frontendIndex)).digest('hex')
  : undefined

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
  source: SRC,
  builtAt: new Date().toISOString(),
  withSourceMaps: WITH_MAPS,
  packages: packages.length,
  approxBytes: bytes,
  frontendIndexSha256: indexHash,
  entries: packages.map((entry) => ({ name: entry.name, dir: entry.dir, facets: entry.files })),
}, null, 2) + '\n')

console.log(`overlay: ${packages.length} package(s), ${(bytes / 1048576).toFixed(1)} MiB`)
console.log(`index.html sha256: ${indexHash ?? '(no frontend dist found)'}`)
if (natives.length > 0) console.log(`skipped ${natives.length} native binaries (platform-specific)`)
if (!ALL_LIB && skipped.length > 0) console.log(`skipped ${skipped.length} package(s) with no build output`)
