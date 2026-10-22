/**
 * Dependency inventory and build manifest of one `.deb`.
 *
 * The container build appends tab-separated records while it installs each
 * dependency; the builder validates those records, merges the archives it
 * resolved itself, and writes both a machine-readable manifest and a readable
 * dependency report next to the package.
 */

/** Kind of dependency a record describes. */
export const DEPENDENCY_KINDS = ['apt', 'npm', 'pypi', 'archive', 'image', 'local'] as const

/** One dependency of the delivered package. */
export interface DependencyRecord {
  /** Source ecosystem the dependency comes from. */
  readonly kind: (typeof DEPENDENCY_KINDS)[number]
  /** Package, archive, or image name. */
  readonly name: string
  /** Exact version, or `-` when the source names none. */
  readonly version: string
  /** Registry specifier, download URL, or local path that identifies the source. */
  readonly source: string
  /** Published digest, or `-` when the source publishes none. */
  readonly digest: string
  /** Why the build needs the dependency. */
  readonly purpose: string
  /** Whether the bytes ship inside the package. */
  readonly included: boolean
}

/** The built package file and its digest. */
export interface DebArtifactRecord {
  /** File name of the built package. */
  readonly file: string
  /** Size of the file in bytes. */
  readonly sizeBytes: number
  /** SHA-256 of the file, as lowercase hexadecimal. */
  readonly sha256: string
}

/** Machine-readable result of one package build. */
export interface DebBuildManifest {
  /** Manifest layout version. */
  readonly schemaVersion: 1
  /** Package identity recorded by Debian tooling. */
  readonly package: {
    readonly name: string
    readonly version: string
    readonly architecture: string
    readonly maintains: string
  }
  /** Source revision the payload was built from. */
  readonly repository: {
    readonly revision: string
    readonly dirty: boolean
  }
  /** Images the build ran in, in execution order. */
  readonly images: readonly string[]
  /** Highest glibc symbol version the delivered payload requires. */
  readonly maxGlibc: string
  /** glibc symbol version the operator declared for the target. */
  readonly glibcFloor: string
  /** Whether the Node.js CLI payload is part of this package. */
  readonly includesNodeCli: boolean
  /** Whether the container build ran the installed-package smoke tests. */
  readonly smoked: boolean
  /** Built package file. */
  readonly artifact: DebArtifactRecord
  /** Every dependency the build resolved, sorted by kind and name. */
  readonly dependencies: readonly DependencyRecord[]
}

const INCLUDED_TRUE = '1'
const INCLUDED_FALSE = '0'
const FIELD_COUNT = 7

/** One distribution resolved from the Python SDK's dependency closure. */
export interface PipDistribution {
  /** Distribution name as published on PyPI. */
  readonly name: string
  /** Exact published version. */
  readonly version: string
  /** Download URL reported by pip. */
  readonly url: string
  /** SHA-256 reported by pip, or `-` when the report carries no digest. */
  readonly sha256: string
}

/** One locked npm tarball recorded by the packaged runtime's download manifest. */
export interface RuntimeNpmArchiveRecord {
  /** Published package name. */
  readonly name: string
  /** Exact published version. */
  readonly version: string
  /** Registry tarball URL. */
  readonly url: string
  /** Published integrity string, or `-` when the manifest carries none. */
  readonly integrity: string
}

/** Validated `downloads.json` carried beside the packaged runtime. */
export interface RuntimeDownloadManifest {
  /** Runtime target the manifest was built for. */
  readonly target: string
  /** Cache identity the packaged runtime recomputes at startup. */
  readonly identity: string
  /** Office sidecar packages. */
  readonly office: readonly RuntimeNpmArchiveRecord[]
  /** Package manager the authoring environment installs with. */
  readonly pnpm: RuntimeNpmArchiveRecord
}

function assertRecord(value: unknown, subject: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`)
  }
}

function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function requireString(record: Record<string, unknown>, key: string, subject: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') throw new Error(`${subject}: ${key} must be a non-empty string`)
  return value
}

function isDependencyKind(value: string): value is DependencyRecord['kind'] {
  return (DEPENDENCY_KINDS as readonly string[]).includes(value)
}

function isTable(value: unknown, subject: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${subject} must be an array`)
  return value.map((entry: unknown, index) => {
    assertRecord(entry, `${subject}[${index}]`)
    return entry
  })
}

function npmArchiveRecord(value: unknown, subject: string): RuntimeNpmArchiveRecord {
  assertRecord(value, subject)
  return {
    name: requireString(value, 'name', subject),
    version: requireString(value, 'version', subject),
    url: requireString(value, 'url', subject),
    integrity: typeof value.integrity === 'string' && value.integrity !== '' ? value.integrity : '-',
  }
}

/**
 * Read the `downloads.json` manifest carried beside the packaged runtime.
 * @param value - Parsed JSON value.
 * @returns Validated target, cache identity, Office packages, and package manager archive.
 * @throws When the manifest is not the shape the packaged runtime expects.
 */
export function parseRuntimeDownloadManifest(value: unknown): RuntimeDownloadManifest {
  assertRecord(value, 'downloads.json')
  const identity = requireString(value, 'identity', 'downloads.json')
  if (!/^[a-f0-9]{64}$/u.test(identity)) throw new Error('downloads.json: identity must be a lowercase SHA-256 digest')
  return {
    target: requireString(value, 'target', 'downloads.json'),
    identity,
    office: isTable(value.office, 'downloads.json: office').map((entry, index) =>
      npmArchiveRecord(entry, `downloads.json: office[${index}]`)),
    pnpm: npmArchiveRecord(value.pnpm, 'downloads.json: pnpm'),
  }
}

/**
 * Read a `pip download --report` document.
 * @param value - Parsed JSON value.
 * @returns Distributions that pip resolved, in report order.
 * @throws When an entry lacks the download URL or distribution metadata the report promises.
 */
export function parsePipReport(value: unknown): readonly PipDistribution[] {
  assertRecord(value, 'pip report')
  return isTable(value.install, 'pip report: install').map((entry, index) => {
    const subject = `pip report: install[${index}]`
    const download = entry.download_info
    const metadata = entry.metadata
    assertRecord(download, `${subject}.download_info`)
    assertRecord(metadata, `${subject}.metadata`)
    const archiveInfo = download.archive_info
    let sha256 = '-'
    if (archiveInfo !== undefined) {
      assertRecord(archiveInfo, `${subject}.archive_info`)
      const hashes = archiveInfo.hashes
      if (hashes !== undefined) {
        assertRecord(hashes, `${subject}.archive_info.hashes`)
        const digest = hashes.sha256
        if (typeof digest === 'string' && digest !== '') sha256 = `sha256:${digest}`
      }
    }
    return {
      name: requireString(metadata, 'name', `${subject}.metadata`),
      version: requireString(metadata, 'version', `${subject}.metadata`),
      url: requireString(download, 'url', `${subject}.download_info`),
      sha256,
    }
  })
}

/**
 * Parse the tab-separated dependency records the container build appends.
 * @param text - Record text; blank lines are ignored.
 * @returns Validated records in file order.
 * @throws When a line has the wrong field count, an unknown kind, or an invalid inclusion flag.
 */
export function parseDependencyRecords(text: string): readonly DependencyRecord[] {
  const records: DependencyRecord[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue
    const fields = line.split('\t')
    if (fields.length !== FIELD_COUNT) {
      throw new Error(`dependency record ${index + 1}: expected ${FIELD_COUNT} tab-separated fields, got ${fields.length}`)
    }
    const [kind, name, version, source, digest, purpose, included] = fields
    if (kind === undefined || name === undefined || version === undefined || source === undefined
      || digest === undefined || purpose === undefined || included === undefined) {
      throw new Error(`dependency record ${index + 1}: incomplete`)
    }
    if (!isDependencyKind(kind)) {
      throw new Error(`dependency record ${index + 1}: unknown kind ${JSON.stringify(kind)}`)
    }
    if (included !== INCLUDED_TRUE && included !== INCLUDED_FALSE) {
      throw new Error(`dependency record ${index + 1}: inclusion flag must be ${INCLUDED_TRUE} or ${INCLUDED_FALSE}`)
    }
    records.push({ kind, name, version, source, digest, purpose, included: included === INCLUDED_TRUE })
  }
  return records
}

/**
 * Validate a persisted manifest without trusting its file contents.
 * @param value - Parsed JSON value.
 * @returns The validated manifest.
 * @throws When a field is missing or has an unexpected type.
 */
export function verifyDebBuildManifest(value: unknown): DebBuildManifest {
  assertRecord(value, 'manifest')
  const record: Record<string, unknown> = value
  if (record.schemaVersion !== 1) throw new Error('manifest: schemaVersion must be 1')
  const packageRecord = record.package
  const repositoryRecord = record.repository
  const artifactRecord = record.artifact
  assertRecord(packageRecord, 'manifest: package')
  assertRecord(repositoryRecord, 'manifest: repository')
  assertRecord(artifactRecord, 'manifest: artifact')
  const images = record.images
  if (!Array.isArray(images) || images.some(entry => typeof entry !== 'string')) {
    throw new Error('manifest: images must be a string array')
  }
  const dependencies = record.dependencies
  if (!Array.isArray(dependencies)) throw new Error('manifest: dependencies must be an array')
  const sizeBytes = artifactRecord.sizeBytes
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error('manifest: artifact.sizeBytes must be a positive integer')
  }
  if (!isHexDigest(artifactRecord.sha256)) {
    throw new Error('manifest: artifact.sha256 must be a lowercase SHA-256 digest')
  }
  const includeNodeCli = record.includesNodeCli
  if (typeof includeNodeCli !== 'boolean') throw new Error('manifest: includesNodeCli must be a boolean')
  const smoked = record.smoked
  if (typeof smoked !== 'boolean') throw new Error('manifest: smoked must be a boolean')
  const dependencyRecords = dependencies.map((entry, index) => parseManifestDependency(entry, index))
  return {
    schemaVersion: 1,
    package: {
      name: requireString(packageRecord, 'name', 'manifest: package'),
      version: requireString(packageRecord, 'version', 'manifest: package'),
      architecture: requireString(packageRecord, 'architecture', 'manifest: package'),
      maintains: requireString(packageRecord, 'maintains', 'manifest: package'),
    },
    repository: {
      revision: requireString(repositoryRecord, 'revision', 'manifest: repository'),
      dirty: repositoryRecord.dirty === true,
    },
    images: images.map(entry => (typeof entry === 'string' ? entry : '')),
    maxGlibc: requireString(record, 'maxGlibc', 'manifest'),
    glibcFloor: requireString(record, 'glibcFloor', 'manifest'),
    includesNodeCli: includeNodeCli,
    smoked,
    artifact: {
      file: requireString(artifactRecord, 'file', 'manifest: artifact'),
      sizeBytes,
      sha256: artifactRecord.sha256,
    },
    dependencies: dependencyRecords,
  }
}

function parseManifestDependency(value: unknown, index: number): DependencyRecord {
  const subject = `manifest: dependencies[${index}]`
  assertRecord(value, subject)
  const kind = requireString(value, 'kind', subject)
  if (!isDependencyKind(kind)) throw new Error(`${subject}: unknown kind ${JSON.stringify(kind)}`)
  const included = value.included
  if (typeof included !== 'boolean') throw new Error(`${subject}: included must be a boolean`)
  return {
    kind,
    name: requireString(value, 'name', subject),
    version: requireString(value, 'version', subject),
    source: requireString(value, 'source', subject),
    digest: requireString(value, 'digest', subject),
    purpose: requireString(value, 'purpose', subject),
    included,
  }
}

const KIND_TITLES: Readonly<Record<DependencyRecord['kind'], string>> = {
  apt: 'System packages (apt)',
  npm: 'Node.js packages (npm)',
  pypi: 'Python distributions (PyPI)',
  archive: 'Locked archives',
  image: 'Container images',
  local: 'Locally built artifacts',
}

/**
 * Render the human-readable dependency report shipped beside the package.
 * @param manifest - Validated build manifest.
 * @returns Markdown report naming every dependency and why the build needs it.
 */
export function renderDependenciesMarkdown(manifest: DebBuildManifest): string {
  const lines = [
    `# ${manifest.package.name} ${manifest.package.version} dependencies`,
    '',
    `- Package: \`${manifest.package.name}\` (${manifest.package.architecture}), maintained by ${manifest.package.maintains}`,
    `- Source revision: \`${manifest.repository.revision}\`${manifest.repository.dirty ? ' with uncommitted changes' : ''}`,
    `- Artifact: \`${manifest.artifact.file}\` (${manifest.artifact.sizeBytes} bytes, sha256 \`${manifest.artifact.sha256}\`)`,
    `- glibc: payload requires ${manifest.maxGlibc}, declared target floor ${manifest.glibcFloor}`,
    `- Node.js CLI payload: ${manifest.includesNodeCli ? 'included' : 'omitted'}`,
    `- Images: ${manifest.images.map(image => `\`${image}\``).join(', ')}`,
    '',
    'Everything listed as included ships inside the package; the remaining rows were consumed while building it.',
  ]
  for (const kind of DEPENDENCY_KINDS) {
    const records = manifest.dependencies.filter(record => record.kind === kind)
    if (records.length === 0) continue
    lines.push('', `## ${KIND_TITLES[kind]}`, '', '| Name | Version | Source | Digest | Purpose | In package |', '| --- | --- | --- | --- | --- | --- |')
    for (const record of [...records].sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(`| \`${record.name}\` | ${record.version} | ${record.source} | ${record.digest} | ${record.purpose} | ${record.included ? 'yes' : 'no'} |`)
    }
  }
  lines.push('')
  return lines.join('\n')
}
