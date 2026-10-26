/** Build the small authenticated network installer from an existing payload deb. */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  deepseekHarnessInstallerPackage,
  installerDataFiles,
  installerPostinst,
  renderInstallerControl,
  type InstallerPayload,
} from './installer.ts'
import {
  DEB_ARCHITECTURE,
  DEB_PACKAGE_NAME,
  debianArtifactName,
  deepseekHarnessPackage,
} from './debian.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..')
const DEFAULT_IMAGE = 'ubuntu20.04-amd64'

/** Inputs for one network-installer build. */
export interface InstallerBuildOptions {
  readonly repo: string
  readonly packagePath: string
  readonly out: string
  readonly work: string
  readonly url: string
  readonly user: string
  readonly passwordFile: string
  readonly maintainer: string
  readonly revision: string
  readonly image: string
  readonly dryRun: boolean
}

/** Public result of one network-installer build. */
export interface InstallerBuildResult {
  readonly artifactPath: string
  readonly sizeBytes: number
  readonly sha256: string
}

interface InstallerCommandOptions extends InstallerBuildOptions {
  readonly help: boolean
}

function readProductVersion(repo: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    throw new Error('installer: package.json has no version field')
  }
  const version = manifest.version
  if (typeof version !== 'string' || version === '') throw new Error('installer: package.json has no version field')
  return version
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => {
      resolvePromise()
    })
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

function parseCommandOptions(argv: readonly string[]): InstallerCommandOptions {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      package: { type: 'string' },
      out: { type: 'string' },
      work: { type: 'string' },
      url: { type: 'string' },
      user: { type: 'string' },
      'password-file': { type: 'string' },
      maintainer: { type: 'string' },
      revision: { type: 'string' },
      image: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (!values.help && values.package === undefined) throw new Error('installer: --package is required')
  const packagePath = values.package === undefined ? '' : resolve(values.package)
  if (!values.help && !existsSync(packagePath)) throw new Error(`installer: payload package not found: ${packagePath}`)
  const out = resolve(values.out ?? dirname(packagePath))
  return {
    repo: resolve(values.repo ?? REPOSITORY_ROOT),
    packagePath,
    out,
    work: resolve(values.work ?? join(out, '.installer-work')),
    url: values.url ?? '',
    user: values.user ?? '',
    passwordFile: values['password-file'] === undefined ? '' : resolve(values['password-file']),
    maintainer: values.maintainer ?? 'Capex Harness packaging <dsh@localhost>',
    revision: values.revision ?? '',
    image: values.image ?? DEFAULT_IMAGE,
    dryRun: values['dry-run'],
    help: values.help,
  }
}

function printHelp(): void {
  process.stdout.write([
    'Usage: build-installer --package <payload.deb> --url <http-url>',
    '                       --user <username> --password-file <root-only-file>',
    '',
    'Options:',
    '  --package <file>        Existing arm64 capex-harness payload deb',
    '  --url <url>             Exact internal HTTP URL for that payload',
    '  --user <name>           HTTP authentication user',
    '  --password-file <file>  File containing only the HTTP password',
    '  --out <dir>             Output directory; defaults beside the payload',
    '  --work <dir>            Staging directory; defaults to <out>/.installer-work',
    '  --maintainer <text>     Debian Maintainer field',
    '  --revision <text>       Optional Debian revision',
    '  --image <name>          amd64 packaging image (default: ubuntu20.04-amd64)',
    '  --dry-run               Print the packaging step without running it',
    '  -h, --help              Show this help',
    '',
  ].join('\n'))
}

function readPassword(path: string): string {
  const value = readFileSync(path, 'utf8').replace(/\r?\n$/u, '')
  if (value === '') throw new Error('installer: password file is empty')
  return value
}

function writeMode(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode })
}

function runPackagingContainer(options: InstallerBuildOptions, artifactName: string, payload: InstallerPayload): void {
  const reportDir = join(options.work, 'installer-report')
  rmSync(reportDir, { recursive: true, force: true })
  mkdirSync(reportDir, { recursive: true })
  const args = [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--volume',
    `${options.repo}:/repo:ro`,
    '--volume',
    `${options.work}:/work`,
    '--volume',
    `${options.out}:/out`,
    '--env',
    'DSH_INSTALLER_ROOT=/work/installer-root',
    '--env',
    `DSH_INSTALLER_NAME=${artifactName}`,
    '--env',
    `DSH_PAYLOAD_NAME=${basename(options.packagePath)}`,
    '--env',
    `DSH_PAYLOAD_PACKAGE=${DEB_PACKAGE_NAME}`,
    '--env',
    `DSH_PAYLOAD_VERSION=${payload.version}`,
    '--env',
    `DSH_PAYLOAD_ARCH=${DEB_ARCHITECTURE}`,
    '--env',
    `DSH_PAYLOAD_SIZE=${String(payload.sizeBytes)}`,
    '--env',
    `DSH_PAYLOAD_SHA256=${payload.sha256}`,
    options.image,
    'bash',
    '/repo/scripts/linux-deb/container-installer.sh',
  ]
  console.log(`\n### package network installer (${artifactName})`)
  if (options.dryRun) {
    console.log(`[dry-run] docker ${args.join(' ')}`)
    return
  }
  const result = spawnSync('docker', args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`installer: packaging failed with exit status ${String(result.status)}`)
}

/**
 * Build the small network installer from an existing payload deb.
 * @param options - Payload source, hidden credentials, and output settings.
 * @returns The generated installer artifact and its digest.
 */
export async function buildInstaller(options: InstallerBuildOptions): Promise<InstallerBuildResult> {
  const productVersion = readProductVersion(options.repo)
  const payloadMetadata = deepseekHarnessPackage(productVersion, {
    maintainer: options.maintainer,
    revision: options.revision,
  })
  const expectedPayloadName = debianArtifactName(payloadMetadata)
  if (basename(options.packagePath) !== expectedPayloadName) {
    throw new Error(`installer: expected payload ${expectedPayloadName}, got ${basename(options.packagePath)}`)
  }
  const payloadSize = statSync(options.packagePath).size
  const payloadHash = await sha256File(options.packagePath)
  const installerMetadata = deepseekHarnessInstallerPackage(productVersion, {
    maintainer: options.maintainer,
    revision: options.revision,
  })
  const installerName = debianArtifactName(installerMetadata)
  const payload: InstallerPayload = {
    architecture: DEB_ARCHITECTURE,
    filename: expectedPayloadName,
    password: readPassword(options.passwordFile),
    sha256: payloadHash,
    sizeBytes: payloadSize,
    url: options.url,
    user: options.user,
    version: payloadMetadata.version,
  }
  const root = join(options.work, 'installer-root')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'DEBIAN'), { recursive: true })
  writeMode(join(root, 'DEBIAN/control'), renderInstallerControl(productVersion, options), 0o644)
  writeMode(join(root, 'DEBIAN/postinst'), installerPostinst(), 0o755)
  for (const file of installerDataFiles(payload)) {
    writeMode(join(root, file.path.slice(1)), file.content, file.mode)
  }
  mkdirSync(options.out, { recursive: true })
  runPackagingContainer(options, installerName, payload)
  if (options.dryRun) {
    return { artifactPath: join(options.out, installerName), sizeBytes: 0, sha256: '' }
  }
  const artifactPath = join(options.out, installerName)
  const sizeBytes = statSync(artifactPath).size
  const sha256 = await sha256File(artifactPath)
  const report = {
    schemaVersion: 1,
    package: {
      name: installerMetadata.name,
      version: installerMetadata.version,
      architecture: installerMetadata.architecture,
    },
    payload: {
      file: payload.filename,
      version: payload.version,
      architecture: payload.architecture,
      sizeBytes: payload.sizeBytes,
      sha256: payload.sha256,
      url: payload.url,
      user: payload.user,
    },
    artifact: { file: installerName, sizeBytes, sha256 },
  }
  writeFileSync(join(options.out, 'installer-manifest.json'), `${JSON.stringify(report, undefined, 2)}\n`)
  const reportOut = join(options.out, 'build-report')
  mkdirSync(reportOut, { recursive: true })
  copyFileSync(join(options.work, 'installer-report/control.txt'), join(reportOut, 'installer-control.txt'))
  copyFileSync(join(options.work, 'installer-report/contents.txt'), join(reportOut, 'installer-contents.txt'))
  const checksumFiles = [
    payload.filename,
    installerName,
    'installer-manifest.json',
    'manifest.json',
    'DEPENDENCIES.md',
    'verify-on-target.sh',
  ].filter(name => existsSync(join(options.out, name)))
  const checksumLines: string[] = []
  for (const name of checksumFiles) checksumLines.push(`${await sha256File(join(options.out, name))}  ${name}`)
  writeFileSync(join(options.out, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`)
  console.log(`installer: ${artifactPath}`)
  console.log(`installer size: ${String(sizeBytes)} bytes  sha256: ${sha256}`)
  return { artifactPath, sizeBytes, sha256 }
}

async function main(): Promise<void> {
  const options = parseCommandOptions(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (options.url === '' || options.user === '' || options.passwordFile === '') {
    throw new Error('installer: --url, --user, and --password-file are required')
  }
  await buildInstaller(options)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
