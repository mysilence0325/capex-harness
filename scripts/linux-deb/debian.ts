/**
 * Debian packaging metadata for the source-built dsh payload.
 *
 * The container build consumes the rendered control file, so every field a
 * `dpkg -I` reader sees is decided here and covered by unit tests.
 */

/**
 * Installed package name. The binary is `dsh`; the package name avoids the
 * unrelated Debian `dsh` package.
 */
export const DEB_PACKAGE_NAME = 'capex-harness'

/** Architecture of every artifact this builder produces. */
export const DEB_ARCHITECTURE = 'arm64'

/** Absolute payload root on the installed system. */
export const DEB_INSTALL_ROOT = '/usr/lib/capex-harness'

/** Debian revision appended after the upstream version. */
export const DEB_REVISION = ''

/** Debian section and priority reported by package tooling. */
export const DEB_SECTION = 'devel'

/** Debian priority reported by package tooling. */
export const DEB_PRIORITY = 'optional'

/**
 * Runtime dependencies. The payload carries its own Node.js and CPython, so
 * only the C library and a CA bundle are required; `libc6 (>= 2.28)` is the
 * floor of the official Node.js 24 arm64 build and of the locked CPython.
 */
export const DEB_DEPENDS = ['libc6 (>= 2.28)', 'ca-certificates'] as const

/** Optional integrations the payload probes at runtime. */
export const DEB_RECOMMENDS = ['bubblewrap', 'git', 'wmctrl'] as const

/** Fields of the generated `DEBIAN/control` file. */
export interface DebianPackageMetadata {
  /** Installed package name. */
  readonly name: string
  /** Debian version, including the revision. */
  readonly version: string
  /** Debian architecture. */
  readonly architecture: string
  /** Debian `Maintainer` field; the builder passes the operator's identity. */
  readonly maintainer: string
  /** Required packages, in `dpkg` syntax. */
  readonly depends: readonly string[]
  /** Recommended packages, in `dpkg` syntax. */
  readonly recommends: readonly string[]
  /** Single-line `Description` synopsis. */
  readonly shortDescription: string
  /** Long description paragraphs; each entry becomes one indented line. */
  readonly longDescription: readonly string[]
}

const UPSTREAM_PATTERN = /^[0-9][0-9A-Za-z.+~]*$/u
const PRERELEASE_PATTERN = /^[0-9A-Za-z.+~]+$/u
const REVISION_PATTERN = /^[0-9A-Za-z.+~]+$/u

/**
 * Convert a repository version into a Debian version.
 *
 * A prerelease separator becomes `~` so the prerelease sorts before its
 * release, which is what `dpkg --compare-versions` expects for `0.2.1-alpha.4`.
 * @param productVersion - Version read from the repository manifest, optionally prefixed with `v`.
 * @param revision - Debian revision appended after the converted upstream version.
 * @returns The Debian version string, with no revision suffix when `revision` is empty.
 * @throws When the version cannot be represented as a Debian version.
 */
export function debianVersion(productVersion: string, revision: string = DEB_REVISION): string {
  const trimmed = productVersion.trim().replace(/^v/u, '')
  if (trimmed === '') throw new Error('debian package: the product version is empty')
  const separator = trimmed.indexOf('-')
  const upstream = separator === -1 ? trimmed : trimmed.slice(0, separator)
  const prerelease = separator === -1 ? '' : trimmed.slice(separator + 1)
  if (!UPSTREAM_PATTERN.test(upstream) || (prerelease !== '' && !PRERELEASE_PATTERN.test(prerelease))) {
    throw new Error(`debian package: ${JSON.stringify(productVersion)} is not a Debian upstream version`)
  }
  if (revision !== '' && !REVISION_PATTERN.test(revision)) {
    throw new Error(`debian package: ${JSON.stringify(revision)} is not a Debian revision`)
  }
  const base = `${upstream}${prerelease === '' ? '' : `~${prerelease}`}`
  return revision === '' ? base : `${base}-${revision}`
}

/**
 * Name of the built artifact, following Debian's file-name convention.
 * @param metadata - Package metadata whose name, version, and architecture name the file.
 * @returns The `.deb` file name.
 */
export function debianArtifactName(metadata: DebianPackageMetadata): string {
  return `${metadata.name}_${metadata.version}_${metadata.architecture}.deb`
}

/**
 * Render `DEBIAN/control`.
 *
 * `Installed-Size` is deliberately absent: the container build measures the
 * assembled tree and appends the field before `dpkg-deb` runs.
 * @param metadata - Package metadata to render.
 * @returns Control file text ending with one newline.
 * @throws When the synopsis contains a line break, which Debian cannot represent.
 */
export function renderControlFile(metadata: DebianPackageMetadata): string {
  if (/[\n\r]/u.test(metadata.shortDescription)) {
    throw new Error('debian package: the description synopsis must be a single line')
  }
  const lines = [
    `Package: ${metadata.name}`,
    `Version: ${metadata.version}`,
    `Architecture: ${metadata.architecture}`,
    `Maintainer: ${metadata.maintainer}`,
    `Section: ${DEB_SECTION}`,
    `Priority: ${DEB_PRIORITY}`,
    ...(metadata.depends.length === 0 ? [] : [`Depends: ${metadata.depends.join(', ')}`]),
    ...(metadata.recommends.length === 0 ? [] : [`Recommends: ${metadata.recommends.join(', ')}`]),
    `Description: ${metadata.shortDescription}`,
    ...metadata.longDescription.map(line => (line === '' ? ' .' : ` ${line}`)),
    '',
  ]
  return lines.join('\n')
}

/**
 * Build the package metadata for one product version.
 * @param productVersion - Version read from the repository manifest.
 * @param options - Debian version revision and `Maintainer` field.
 * @returns Package metadata for the arm64 CLI payload.
 */
export function deepseekHarnessPackage(
  productVersion: string,
  options: { readonly maintainer: string; readonly revision?: string },
): DebianPackageMetadata {
  return {
    name: DEB_PACKAGE_NAME,
    version: debianVersion(productVersion, options.revision),
    architecture: DEB_ARCHITECTURE,
    maintainer: options.maintainer,
    depends: DEB_DEPENDS,
    recommends: DEB_RECOMMENDS,
    shortDescription: 'Capex Harness agent CLI with a bundled runtime',
    longDescription: [
      'Capex Harness runs a plugin-composed agent loop from a configuration',
      'file. This package installs the dsh command line with the Node.js runtime',
      'and dependency closure built from the matching source revision, so no',
      'system Node.js is needed.',
      '',
      'It also installs the Python SDK runtime: a bundled CPython interpreter with',
      'deepseek-harness-sdk and its matching runtime wheel, a pre-seeded resource',
      'cache for the Office skills, and the dsh-sdk, dsh-python, dsh-pip, and',
      'dsh-office-convert commands. An offline wheelhouse covers the pinned authoring,',
      'PDF, Markdown, data-analysis, and common development packages.',
    ],
  }
}
