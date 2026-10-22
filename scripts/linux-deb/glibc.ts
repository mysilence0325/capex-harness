/**
 * Enforce the glibc symbol ceiling of an assembled payload.
 *
 * The container build runs `readelf --version-info` over every ELF file it
 * ships and captures the output with markers; this module parses that capture
 * and decides whether the payload can load on a target with the declared glibc.
 */

/** Marker that separates payload files inside one captured dump. */
export const VERSION_INFO_MARKER = '@@FILE '

/** One payload file and the version-info output read from it. */
export interface VersionInfoDump {
  /** Payload-relative path, using forward slashes. */
  readonly path: string
  /** `readelf --version-info` output for that file, without the newline that separated it from the next header. */
  readonly output: string
}

/** One payload file whose required symbol version exceeds the declared floor. */
export interface GlibcViolation {
  /** Payload-relative path. */
  readonly path: string
  /** Highest glibc symbol version the file requires. */
  readonly required: string
}

const SYMBOL_PATTERN = /Name:\s+GLIBC_(\d+(?:\.\d+)*)/gu

/**
 * Split a captured dump into per-file entries.
 * @param dump - Captured text whose file headers use {@link VERSION_INFO_MARKER}.
 * @returns Entries in capture order; text before the first header is ignored.
 */
export function parseVersionInfoDump(dump: string): readonly VersionInfoDump[] {
  const entries: VersionInfoDump[] = []
  let path: string | undefined
  let body: string[] = []
  const flush = (): void => {
    if (path !== undefined) entries.push({ path, output: body.join('\n') })
  }
  // The capture ends each file with the newline that terminated its last output
  // line, which the split would otherwise keep as an extra body line. Blank
  // lines a file really printed stay, because the capture ends only the dump.
  const lines = (dump.endsWith('\n') ? dump.slice(0, -1) : dump).split('\n')
  for (const line of lines) {
    if (line.startsWith(VERSION_INFO_MARKER)) {
      flush()
      path = line.slice(VERSION_INFO_MARKER.length).trim()
      body = []
      continue
    }
    if (path !== undefined) body.push(line)
  }
  flush()
  return entries
}

/**
 * Highest glibc symbol version a version-info capture requires.
 * @param output - Verbatim `readelf --version-info` output.
 * @returns The version as `major.minor...`, or undefined when no glibc symbol is referenced.
 */
export function maxGlibcVersion(output: string): string | undefined {
  let highest: string | undefined
  for (const match of output.matchAll(SYMBOL_PATTERN)) {
    const version = match[1]
    if (version === undefined) continue
    if (highest === undefined || compareGlibcVersions(version, highest) > 0) highest = version
  }
  return highest
}

/**
 * Order two dotted glibc version strings numerically.
 * @param left - First version, for example `2.31`.
 * @param right - Second version.
 * @returns A negative number when left precedes right, zero when equal, and a positive number otherwise.
 */
export function compareGlibcVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(part => Number(part))
  const rightParts = right.split('.').map(part => Number(part))
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Collect the payload files that a target with the declared glibc cannot load.
 * @param entries - Parsed version-info capture.
 * @param floor - Highest glibc symbol version the target provides.
 * @returns Violations in capture order, each naming the file and its requirement.
 */
export function glibcViolations(
  entries: readonly VersionInfoDump[],
  floor: string,
): readonly GlibcViolation[] {
  const violations: GlibcViolation[] = []
  for (const entry of entries) {
    const required = maxGlibcVersion(entry.output)
    if (required === undefined) continue
    if (compareGlibcVersions(required, floor) > 0) violations.push({ path: entry.path, required })
  }
  return violations
}

/**
 * Fail when the payload needs glibc symbols the target does not provide.
 * @param entries - Parsed version-info capture.
 * @param floor - Highest glibc symbol version the target provides.
 * @throws Listing the offending files, capped so the message stays readable.
 */
export function assertGlibcFloor(entries: readonly VersionInfoDump[], floor: string): void {
  const violations = glibcViolations(entries, floor)
  if (violations.length === 0) return
  const listed = violations.slice(0, 20).map(item => `${item.path} needs GLIBC_${item.required}`)
  const remaining = violations.length - listed.length
  throw new Error([
    `${violations.length} payload file(s) require glibc above the declared floor ${floor}:`,
    ...listed,
    ...(remaining > 0 ? [`... and ${remaining} more`] : []),
    'Rebuild with a lower --glibc-floor, which rebuilds the glibc-linked addons on an older base image.',
  ].join('\n'))
}
