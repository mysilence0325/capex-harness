/**
 * Build the arm64 Debian package for dsh inside an emulated container.
 *
 * The build host only needs Docker and network access: every toolchain,
 * interpreter, wheel, and resource archive is materialized inside the target
 * architecture, so the delivered package installs on an offline arm64 machine
 * without a system Node.js or CPython. Each stage records its own marker under
 * the work directory, and `--stage` reruns one stage without repeating the
 * others.
 *
 * Preparation runs twice against the same work tree. The JavaScript phase runs
 * in a container for the daemon's own architecture, because bundlers load
 * native bindings that emulation cannot execute; the payload phase then runs
 * inside the arm64 container and consumes the artifacts that phase produced.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import primaryRuntimeLock from '../primary-runtime/lock.json' with { type: 'json' }
import { DEB_INSTALL_ROOT, debianArtifactName, deepseekHarnessPackage, renderControlFile } from './debian.ts'
import { desktopPackageFiles, type PackageFile } from './desktop.ts'
import { assertGlibcFloor, compareGlibcVersions, maxGlibcVersion, parseVersionInfoDump } from './glibc.ts'
import { hostNodeArchive } from './host-platform.ts'
import {
  parseDependencyRecords,
  parsePipReport,
  parseRuntimeDownloadManifest,
  renderDependenciesMarkdown,
  type DebBuildManifest,
  type DependencyRecord,
} from './manifest.ts'
import { payloadCommandFiles } from './wrappers.ts'

const PLUGIN_DIR = import.meta.dirname
const REPOSITORY_ROOT = resolve(PLUGIN_DIR, '..', '..')
const LOCK = primaryRuntimeLock
const LINUX_TARGET = 'linux-arm64'
const LINUX_LOCK = LOCK.targets[LINUX_TARGET]

/** Debian architecture and the container platform it is built for. */
const PLATFORM = 'linux/arm64'

/** Directory the JavaScript phase keeps its build-host toolchain in. */
const HOST_ROOT = '/work/build-host'

/** Build image: the oldest Ubuntu LTS that still carries the toolchain this build needs. */
const DEFAULT_BASE_IMAGE = 'ubuntu:20.04'
/** glibc the base image provides; every locally compiled addon inherits it. */
const BASE_IMAGE_GLIBC = '2.31'
/** Image used when the operator asks for a glibc floor below {@link BASE_IMAGE_GLIBC}. */
const DEFAULT_NATIVES_IMAGE = 'quay.io/pypa/manylinux_2_28_aarch64'
/** Host path of the arm64 emulator the daemon needs on a non-arm64 host. */
const DEFAULT_EMULATOR = '/usr/bin/qemu-aarch64-static'
/** Default floor: Ubuntu 20.04 and every newer Ubuntu or Kylin desktop release. */
const DEFAULT_GLIBC_FLOOR = BASE_IMAGE_GLIBC
/** Placeholder Maintainer identity; operators override it with `--maintainer`. */
const DEFAULT_MAINTAINER = 'Capex Harness packaging <dsh@localhost>'
/** `uv` version the repository pins for wheel builds. */
const UV_VERSION = '0.11.23'

const EMULATION_HELP = [
  'The Docker daemon cannot run linux/arm64 containers, so the arm64 payload cannot be built here.',
  'Register the emulator once on the build host, then rerun this command:',
  '  docker create --name dsh-binfmt tonistiigi/binfmt:latest',
  '  docker cp dsh-binfmt:/usr/bin/qemu-aarch64 /usr/bin/qemu-aarch64-static',
  '  docker rm -f dsh-binfmt',
  "  printf '%s' ':qemu-aarch64:M::\\x7f\\x45\\x4c\\x46\\x02\\x01\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x02\\x00\\xb7\\x00:"
    + '\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\x00\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xff\\xfe\\xff\\xff\\xff'
    + ":/usr/bin/qemu-aarch64-static:POC' > /proc/sys/fs/binfmt_misc/register",
  'Kernels without the binfmt_misc F flag need that registration plus the emulator mounted into every container,',
  'which this builder does with --emulator.',
].join('\n')

/** Build stages the operator can run individually from the work directory. */
const STAGES = ['all', 'prepare', 'natives', 'package', 'reports'] as const

type StageSelection = (typeof STAGES)[number]

interface BuildOptions {
  readonly repo: string
  readonly out: string
  readonly work: string
  readonly cache: string
  readonly stage: StageSelection
  readonly baseImage: string
  readonly jsImage: string
  readonly nativesImage: string
  readonly emulator: string
  readonly network: string
  readonly glibcFloor: string
  readonly maintainer: string
  readonly revision: string
  readonly npmRegistry: string
  readonly pipIndex: string
  readonly aptMirror: string
  readonly jsAptMirror: string
  readonly nodeUrl: string
  readonly pythonUrl: string
  readonly pythonOnly: boolean
  readonly skipSmoke: boolean
  readonly clean: boolean
  readonly dryRun: boolean
}

function readProductVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    throw new Error('deb: package.json has no version field')
  }
  const version = manifest.version
  if (typeof version !== 'string' || version === '') throw new Error('deb: package.json has no version field')
  return version
}

/** Package manager version the repository pins; the build container installs exactly it. */
const LOCK_PNPM_VERSION = readPnpmVersion()

function readPnpmVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('packageManager' in manifest)) {
    throw new Error('deb: package.json has no packageManager field')
  }
  const packageManager = manifest.packageManager
  if (typeof packageManager !== 'string' || !packageManager.startsWith('pnpm@')) {
    throw new Error('deb: package.json packageManager must pin pnpm')
  }
  return packageManager.slice('pnpm@'.length)
}

function parseOptions(argv: readonly string[]): BuildOptions {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      out: { type: 'string' },
      work: { type: 'string' },
      cache: { type: 'string' },
      stage: { type: 'string' },
      'base-image': { type: 'string' },
      'js-image': { type: 'string' },
      'natives-image': { type: 'string' },
      emulator: { type: 'string' },
      network: { type: 'string' },
      'glibc-floor': { type: 'string' },
      maintainer: { type: 'string' },
      revision: { type: 'string' },
      'npm-registry': { type: 'string' },
      'pip-index': { type: 'string' },
      'apt-mirror': { type: 'string' },
      'js-apt-mirror': { type: 'string' },
      'node-url': { type: 'string' },
      'python-url': { type: 'string' },
      'python-only': { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
      clean: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  const stage = values.stage ?? 'all'
  if (!(STAGES as readonly string[]).includes(stage)) {
    throw new Error(`deb: --stage must be one of ${STAGES.join(', ')}, got ${stage}`)
  }
  const glibcFloor = values['glibc-floor'] ?? DEFAULT_GLIBC_FLOOR
  if (!/^\d+\.\d+$/u.test(glibcFloor)) throw new Error(`deb: --glibc-floor must be major.minor, got ${glibcFloor}`)
  const work = resolve(values.work ?? join(REPOSITORY_ROOT, 'dist', 'deb-work'))
  return {
    repo: resolve(values.repo ?? process.cwd()),
    out: resolve(values.out ?? join(REPOSITORY_ROOT, 'dist', 'deb')),
    work,
    cache: resolve(values.cache ?? join(work, 'cache')),
    stage: stage as StageSelection,
    baseImage: values['base-image'] ?? DEFAULT_BASE_IMAGE,
    jsImage: values['js-image'] ?? DEFAULT_BASE_IMAGE,
    nativesImage: values['natives-image'] ?? DEFAULT_NATIVES_IMAGE,
    emulator: values.emulator ?? DEFAULT_EMULATOR,
    network: values.network ?? '',
    glibcFloor,
    maintainer: values.maintainer ?? DEFAULT_MAINTAINER,
    revision: values.revision ?? '',
    npmRegistry: values['npm-registry'] ?? '',
    pipIndex: values['pip-index'] ?? '',
    aptMirror: values['apt-mirror'] ?? '',
    jsAptMirror: values['js-apt-mirror'] ?? '',
    nodeUrl: values['node-url'] ?? '',
    pythonUrl: values['python-url'] ?? '',
    pythonOnly: values['python-only'],
    skipSmoke: values['skip-smoke'],
    clean: values.clean,
    dryRun: values['dry-run'],
  }
}

/**
 * Confirm a daemon is reachable.
 * @returns The daemon's own Docker platform, e.g. `linux/amd64`.
 */
function requireDocker(): string {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], { encoding: 'utf8' })
  if (result.error !== undefined) {
    throw new Error(`deb: docker is required to build the arm64 package: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`deb: docker could not reach a daemon:\n${result.stderr.trim()}`)
  }
  const platform = result.stdout.trim()
  console.log(`docker: ${platform}`)
  return platform
}

function emulatorMount(options: BuildOptions): readonly string[] {
  return existsSync(options.emulator) ? ['--volume', `${options.emulator}:${options.emulator}:ro`] : []
}

/**
 * Container download caches the host keeps between runs.
 *
 * Every stage starts a fresh container, so package archives, package-manager
 * caches, and the packager's runtime downloads would otherwise be fetched again
 * on every run. Mounting them keeps the download cost to the first build.
 */
const DOWNLOAD_CACHES = [
  ['apt-archives', '/var/cache/apt/archives'],
  ['apt-lists', '/var/lib/apt/lists'],
  ['pkg', '/root/.pkg-cache'],
  ['pip', '/root/.cache/pip'],
  ['npm', '/root/.npm'],
  ['uv', '/root/.cache/uv'],
] as const

/**
 * Create and mount the download caches.
 * @param options - Build options naming the cache root.
 * @returns Docker arguments mounting every cache into the container.
 */
function cacheMounts(options: BuildOptions): readonly string[] {
  const mounts: string[] = []
  for (const [name, target] of DOWNLOAD_CACHES) {
    const host = join(options.cache, name)
    mkdirSync(host, { recursive: true })
    mounts.push('--volume', `${host}:${target}`)
  }
  return mounts
}

function requireArm64Emulation(options: BuildOptions): void {
  const args = ['run', '--rm', '--platform', PLATFORM, ...emulatorMount(options), options.baseImage, 'uname', '-m']
  if (options.dryRun) {
    console.log(`[dry-run] docker ${args.join(' ')}`)
    return
  }
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status === 0 && result.stdout.trim() === 'aarch64') {
    console.log(`emulation: ${options.baseImage} reports aarch64`)
    return
  }
  throw new Error(`${EMULATION_HELP}\n\n${result.stdout.trim()}${result.stderr.trim()}`)
}

function gitState(repo: string): { readonly revision: string; readonly dirty: boolean } {
  const revision = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (revision.status !== 0) {
    console.log('deb: the source tree is not a Git checkout; the manifest records a copied revision')
    return { revision: 'uncommitted-copy', dirty: true }
  }
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
  return { revision: revision.stdout.trim(), dirty: status.stdout.trim() !== '' }
}

function writeBuildInputs(options: BuildOptions, productVersion: string): string {
  const controlDir = join(options.work, 'control')
  const packageRoot = join(controlDir, 'root')
  const scriptDir = join(options.work, 'scripts')
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(scriptDir, { recursive: true })
  const metadata = deepseekHarnessPackage(productVersion, {
    maintainer: options.maintainer,
    revision: options.revision,
  })
  writeFileSync(join(controlDir, 'control'), renderControlFile(metadata))
  const commands: readonly PackageFile[] = payloadCommandFiles({ pythonOnly: options.pythonOnly })
    .map(command => ({ path: command.path, content: command.content, executable: true }))
  const runtimeFiles: readonly PackageFile[] = [
    { path: `${DEB_INSTALL_ROOT}/share/office-convert.mjs`, source: 'office-convert.mjs' },
  ]
  // The menu entry and its launcher run the bundled Node.js CLI, which a
  // python-only package does not carry, so that variant ships no shortcut.
  const packageFiles: readonly PackageFile[] = options.pythonOnly
    ? commands
    : [...commands, ...runtimeFiles, ...desktopPackageFiles()]
  for (const file of packageFiles) {
    const target = join(packageRoot, file.path)
    mkdirSync(dirname(target), { recursive: true })
    if (file.source === undefined) writeFileSync(target, file.content ?? '')
    else copyFileSync(join(PLUGIN_DIR, file.source), target)
    if (file.executable === true) chmodSync(target, 0o755)
  }
  for (const script of ['container-prepare.sh', 'container-natives.sh', 'container-package.sh']) {
    const content = readFileSync(join(PLUGIN_DIR, script), 'utf8').replaceAll('\r\n', '\n')
    writeFileSync(join(scriptDir, script), content)
  }
  return debianArtifactName(metadata)
}

interface StageInvocation {
  readonly label: string
  readonly script: string
  readonly image: string
  readonly environment: Readonly<Record<string, string>>
  readonly estimate: string
  /** Container platform; the arm64 payload is the default and the only one that needs emulation. */
  readonly platform?: string
}

function runStage(options: BuildOptions, invocation: StageInvocation): void {
  const args = [
    'run', '--rm', '--platform', invocation.platform ?? PLATFORM,
    ...(options.network === '' ? [] : ['--network', options.network]),
    ...(invocation.platform === undefined || invocation.platform === PLATFORM ? emulatorMount(options) : []),
    ...cacheMounts(options),
    '--volume', `${options.repo}:/repo:ro`,
    '--volume', `${options.work}:/work`,
    '--volume', `${options.out}:/out`,
  ]
  for (const [name, value] of Object.entries(invocation.environment)) {
    args.push('--env', `${name}=${value}`)
  }
  args.push('--workdir', '/work', invocation.image, 'bash', `/work/scripts/${invocation.script}`)
  console.log(`\n### ${invocation.label} (${invocation.estimate})`)
  if (options.dryRun) {
    console.log(`[dry-run] docker ${args.join(' ')}`)
    return
  }
  const result = spawnSync('docker', args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`deb: ${invocation.label} failed with exit status ${result.status}; rerun the same command to resume`)
  }
}

function stageEnvironment(options: BuildOptions, artifactName: string): Record<string, string> {
  const pythonFile = `cpython-${LOCK.pythonVersion}+${LOCK.pythonRelease}-${LINUX_LOCK.pythonTarget}-install_only_stripped.tar.gz`
  return {
    DSH_REPO: '/repo',
    DSH_SRC: '/work/src',
    DSH_PRODUCT: '/work/product',
    DSH_STATE: '/work/state',
    DSH_DOWNLOADS: '/work/downloads',
    DSH_DIST: '/work/dist',
    DSH_REPORT: '/work/report',
    DSH_TOOLS: '/work/tools',
    DSH_STORE: '/work/store',
    DSH_OVERRIDES: '/work/natives',
    DSH_DEB_ROOT: '/work/deb-root',
    DSH_ARTIFACT: '/work/artifact',
    DSH_INSTALL_ROOT: DEB_INSTALL_ROOT,
    DSH_CONTROL: '/work/control/control',
    DSH_ROOT_FILES: '/work/control/root',
    DSH_DEB_NAME: artifactName,
    DSH_PYTHON_ONLY: options.pythonOnly ? '1' : '0',
    DSH_SKIP_SMOKE: options.skipSmoke ? '1' : '0',
    DSH_NODE_VERSION: LOCK.nodeVersion,
    DSH_NODE_URL: options.nodeUrl === ''
      ? `https://nodejs.org/dist/v${LOCK.nodeVersion}/node-v${LOCK.nodeVersion}-${LINUX_LOCK.nodeArchive}`
      : options.nodeUrl,
    DSH_NODE_SHA256: LINUX_LOCK.nodeSha256,
    DSH_PYTHON_VERSION: LOCK.pythonVersion,
    DSH_PYTHON_URL: options.pythonUrl === ''
      ? `https://github.com/astral-sh/python-build-standalone/releases/download/${LOCK.pythonRelease}/${encodeURIComponent(pythonFile)}`
      : options.pythonUrl,
    DSH_PYTHON_SHA256: LINUX_LOCK.pythonSha256,
    DSH_PNPM_VERSION: LOCK_PNPM_VERSION,
    DSH_UV_VERSION: UV_VERSION,
    DSH_NPM_REGISTRY: options.npmRegistry,
    DSH_PIP_INDEX: options.pipIndex,
    DSH_APT_MIRROR: options.aptMirror,
  }
}

function readTabbed(path: string, fields: number): readonly (readonly string[])[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map((line, index) => {
      const parts = line.split('\t')
      if (parts.length !== fields) {
        throw new Error(`${path}: line ${index + 1} has ${parts.length} fields, expected ${fields}`)
      }
      return parts
    })
}

function dedupe(records: readonly DependencyRecord[]): readonly DependencyRecord[] {
  const seen = new Set<string>()
  const unique: DependencyRecord[] = []
  for (const record of records) {
    const key = record.source.includes('://')
      ? `${record.kind}|${record.source}`
      : `${record.kind}|${record.name}|${record.version}|${record.source}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(record)
  }
  return unique
}

function pipDependencyRecords(path: string): readonly DependencyRecord[] {
  if (!existsSync(path)) return []
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return parsePipReport(value)
    .filter(distribution => !distribution.url.startsWith('file:'))
    .map(distribution => ({
      kind: 'pypi' as const,
      name: distribution.name,
      version: distribution.version,
      source: distribution.url,
      digest: distribution.sha256,
      purpose: 'Installed into the bundled CPython for the Python SDK',
      included: true,
    }))
}

function resourceDependencyRecords(work: string): readonly DependencyRecord[] {
  const path = join(work, 'product', 'dsh', 'runtime', LINUX_TARGET, 'downloads.json')
  if (!existsSync(path)) return []
  const manifest = parseRuntimeDownloadManifest(JSON.parse(readFileSync(path, 'utf8')))
  return [
    ...manifest.office.map(archive => ({
      kind: 'archive' as const,
      name: archive.name,
      version: archive.version,
      source: archive.url,
      digest: archive.integrity,
      purpose: 'Office sidecar seeded into the shipped resource cache',
      included: true,
    })),
    {
      kind: 'archive' as const,
      name: manifest.pnpm.name,
      version: manifest.pnpm.version,
      source: manifest.pnpm.url,
      digest: manifest.pnpm.integrity,
      purpose: 'Package manager inside the seeded authoring environment',
      included: true,
    },
  ]
}

function primaryRuntimeDependencyRecords(): readonly DependencyRecord[] {
  return [...LINUX_LOCK.wheels, ...LOCK.wheels].map((wheel) => {
    const filename = wheel.url.split('/').at(-1) ?? wheel.url
    const [name = filename, version = '-'] = filename.split('-')
    return {
      kind: 'archive' as const,
      name,
      version,
      source: wheel.url,
      digest: `sha256:${wheel.sha256}`,
      purpose: 'Python library inside the seeded authoring environment',
      included: true,
    }
  })
}

function imageDependencyRecords(images: readonly string[]): readonly DependencyRecord[] {
  return images.map(image => ({
    kind: 'image' as const,
    name: image,
    version: '-',
    source: `docker.io/library/${image}`,
    digest: '-',
    purpose: 'Container image the build stages ran in',
    included: false,
  }))
}

function assertArtifact(options: BuildOptions): DebBuildManifest['artifact'] {
  const rows = readTabbed(join(options.work, 'report', 'artifact.tsv'), 3)
  const row = rows[0]
  if (row === undefined) throw new Error('deb: the package stage recorded no artifact')
  const [file, sizeText, sha256] = row
  if (file === undefined || sizeText === undefined || sha256 === undefined) {
    throw new Error('deb: the artifact record is incomplete')
  }
  const source = join(options.work, 'artifact', file)
  if (!existsSync(source)) throw new Error(`deb: the package stage did not write ${source}`)
  const bytes = readFileSync(source)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== sha256) {
    throw new Error(`deb: ${file} changed after packaging: expected ${sha256}, got ${actual}`)
  }
  return { file, sizeBytes: bytes.byteLength, sha256 }
}

function collectManifest(
  options: BuildOptions,
  artifact: DebBuildManifest['artifact'],
  images: readonly string[],
  maxGlibc: string,
): DebBuildManifest {
  const records = dedupe([
    ...parseDependencyRecords(readFileSync(join(options.work, 'report', 'deps.tsv'), 'utf8')),
    ...pipDependencyRecords(join(options.work, 'report', 'pypi-download.json')),
    ...resourceDependencyRecords(options.work),
    ...primaryRuntimeDependencyRecords(),
    ...imageDependencyRecords(images),
  ])
  const metadata = deepseekHarnessPackage(readProductVersion(), {
    maintainer: options.maintainer,
    revision: options.revision,
  })
  const state = gitState(options.repo)
  return {
    schemaVersion: 1,
    package: {
      name: metadata.name,
      version: metadata.version,
      architecture: metadata.architecture,
      maintains: metadata.maintainer,
    },
    repository: state,
    images,
    maxGlibc,
    glibcFloor: options.glibcFloor,
    includesNodeCli: !options.pythonOnly,
    smoked: !options.skipSmoke,
    artifact,
    dependencies: records,
  }
}

function writeReports(
  options: BuildOptions,
  manifest: DebBuildManifest,
  entries: ReturnType<typeof parseVersionInfoDump>,
): void {
  mkdirSync(options.out, { recursive: true })
  copyFileSync(join(options.work, 'artifact', manifest.artifact.file), join(options.out, manifest.artifact.file))
  writeFileSync(join(options.out, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(options.out, 'DEPENDENCIES.md'), renderDependenciesMarkdown(manifest))
  const verifySource = join(PLUGIN_DIR, 'verify-on-target.sh')
  const verifyTarget = join(options.out, 'verify-on-target.sh')
  writeFileSync(verifyTarget, readFileSync(verifySource, 'utf8').replaceAll('\r\n', '\n'))
  chmodSync(verifyTarget, 0o755)
  const reportDir = join(options.out, 'build-report')
  mkdirSync(reportDir, { recursive: true })
  for (const name of ['control.txt', 'deb-control.txt', 'deb-contents.txt', 'smoke.txt', 'version-info.txt', 'deps.tsv', 'artifact.tsv', 'resources.tsv', 'pypi-download.json']) {
    const source = join(options.work, 'report', name)
    if (existsSync(source)) copyFileSync(source, join(reportDir, name))
  }
  console.log(`\npayload files checked for glibc: ${entries.length}`)
  console.log(`dependency records: ${manifest.dependencies.length}`)
  console.log(`package: ${join(options.out, manifest.artifact.file)}`)
  console.log(`size: ${manifest.artifact.sizeBytes} bytes  sha256: ${manifest.artifact.sha256}`)
  console.log(`glibc: payload requires ${manifest.maxGlibc}, declared floor ${manifest.glibcFloor}`)
  console.log('copy the .deb and verify-on-target.sh to the arm64 machine and run the script there.')
}

function main(): void {
  const options = parseOptions(process.argv.slice(2))
  const productVersion = readProductVersion()
  const metadata = deepseekHarnessPackage(productVersion, {
    maintainer: options.maintainer,
    revision: options.revision,
  })
  console.log(`deb: ${metadata.name} ${metadata.version} for ${metadata.architecture}`)
  console.log(`deb: repository ${options.repo}`)
  console.log(`deb: work ${options.work}`)
  console.log(`deb: dependency cache ${options.cache} (kept between runs)`)
  console.log(`deb: output ${options.out}`)
  rmSync(options.out, { recursive: true, force: true })
  if (options.clean) rmSync(options.work, { recursive: true, force: true })
  mkdirSync(options.work, { recursive: true })
  mkdirSync(options.out, { recursive: true })
  mkdirSync(join(options.work, 'report'), { recursive: true })
  const artifactName = writeBuildInputs(options, productVersion)
  const environment = stageEnvironment(options, artifactName)
  const rebuildNatives = compareGlibcVersions(options.glibcFloor, BASE_IMAGE_GLIBC) < 0
  const runPrepare = options.stage === 'all' || options.stage === 'prepare'
  const runNatives = (options.stage === 'all' && rebuildNatives) || options.stage === 'natives'
  const runPackage = options.stage === 'all' || options.stage === 'package'
  const runReports = options.stage === 'all' || options.stage === 'reports'
  if (rebuildNatives && options.stage === 'all') {
    console.log(`deb: rebuilding the glibc-linked addons on ${options.nativesImage} for floor ${options.glibcFloor}`)
  }
  const needsDocker = runPrepare || runNatives || runPackage
  const hostPlatform = needsDocker ? requireDocker() : PLATFORM
  if (needsDocker) requireArm64Emulation(options)
  if (runPrepare) {
    const hostNode = hostNodeArchive(hostPlatform)
    runStage(options, {
      label: `build JavaScript artifacts on ${hostPlatform}`,
      script: 'container-prepare.sh',
      image: options.jsImage,
      platform: hostPlatform,
      environment: {
        ...environment,
        DSH_PHASE: 'js',
        DSH_HOST_ROOT: HOST_ROOT,
        DSH_HOST_NODE_URL: hostNode.url,
        DSH_HOST_NODE_SHA256: hostNode.sha256,
        // An Ubuntu port mirror serves only the target architecture, so the
        // JavaScript phase needs the native archive the mirror serves beside it.
        DSH_APT_MIRROR: options.jsAptMirror === '' ? options.aptMirror : options.jsAptMirror,
      },
      estimate: 'installs the workspace and bundles every package on the build host, without emulation',
    })
    runStage(options, {
      label: 'prepare payload',
      script: 'container-prepare.sh',
      image: options.baseImage,
      environment: { ...environment, DSH_PHASE: 'payload' },
      estimate: 'installs the workspace, builds artifacts, and seeds the resource cache; the longest stage',
    })
  }
  if (runNatives) {
    runStage(options, {
      label: 'rebuild glibc-linked addons',
      script: 'container-natives.sh',
      image: options.nativesImage,
      environment,
      estimate: 'compiles the flock addon and node-pty against glibc 2.28',
    })
  }
  if (runPackage) {
    runStage(options, {
      label: 'assemble and smoke-test the package',
      script: 'container-package.sh',
      image: options.baseImage,
      environment,
      estimate: 'relocates the payload, records glibc symbols, builds the .deb, and installs it',
    })
  }
  if (!runReports) {
    console.log('\ndeb: stopping after the requested stage; rerun with --stage reports to write the artifact and reports')
    return
  }
  const dump = readFileSync(join(options.work, 'report', 'version-info.txt'), 'utf8')
  const entries = parseVersionInfoDump(dump)
  if (entries.length === 0) throw new Error('deb: the payload recorded no ELF files; the package stage did not run')
  assertGlibcFloor(entries, options.glibcFloor)
  const highest = entries
    .map(entry => maxGlibcVersion(entry.output))
    .filter((version): version is string => version !== undefined)
    .reduce<string | undefined>((left, right) => (left === undefined || compareGlibcVersions(right, left) > 0 ? right : left), undefined)
  const artifact = assertArtifact(options)
  const images = [...new Set([options.baseImage, ...(runPrepare ? [options.jsImage] : []), ...(runNatives ? [options.nativesImage] : [])])]
  const manifest = collectManifest(options, artifact, images, highest ?? options.glibcFloor)
  writeReports(options, manifest, entries)
}

main()
