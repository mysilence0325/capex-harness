/**
 * Audit the built client artifacts against the Chromium 102 baseline.
 *
 * The point of scanning artifacts rather than sources is that the deployed
 * shell evaluates the bundles: a stylesheet is inlined into a plugin's
 * `client.js` string and a third-party chunk can carry a call the workspace
 * never wrote. Every hit names the artifact, the feature, and the first
 * location inside it.
 *
 * Usage: `pnpm run compat:audit [--fail-on=hard] [--json]`
 * @module scripts/compat/audit-chromium
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCEPTED, ACCEPTED_FILE_HITS, BASELINE_CHROME, RULES, SHIMMED, rulesNewerThanBaseline, type FeatureRule, type Severity,
} from './features.ts'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** One artifact plus the feature hits found inside it. */
export interface ArtifactHits {
  readonly file: string
  readonly hits: readonly FeatureHit[]
}

/** A single feature use inside one artifact. */
export interface FeatureHit {
  readonly id: string
  readonly kind: FeatureRule['kind']
  readonly minChrome: number
  readonly severity: Severity
  readonly count: number
  readonly line: number
  readonly column: number
  readonly excerpt: string
  readonly status: 'shimmed' | 'accepted' | 'mitigated' | 'unhandled'
}

/** Whole-run result, also the JSON report payload. */
export interface AuditReport {
  readonly baseline: number
  readonly artifacts: number
  readonly files: readonly ArtifactHits[]
  readonly totals: Readonly<Record<Severity, number>> & {
    readonly unhandled: number
    readonly shimmed: number
    readonly accepted: number
    readonly mitigated: number
  }
}

/** Collect built JavaScript artifacts that the web shell serves. */
export function artifactFiles(root = REPOSITORY_ROOT): string[] {
  const files: string[] = []
  const collect = (directory: string, accept: (name: string) => boolean): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) collect(path, accept)
      else if (entry.isFile() && accept(entry.name)) files.push(path)
    }
  }
  for (const group of ['client', 'experimental']) {
    const base = join(root, 'packages', group)
    if (!existsSync(base)) continue
    for (const pkg of readdirSync(base, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      collect(join(base, pkg.name, 'lib'), name => name === 'client.js' || (name.startsWith('client.') && name.endsWith('.js')))
    }
  }
  // `assets/langs` holds syntax-highlight grammars: their text contains CSS
  // tokens as pattern data, never as styles the shell applies.
  collect(join(root, 'apps', 'web', 'dist', 'assets'),
    name => name.endsWith('.js') && !name.endsWith('.map'))
  return files.filter(file => !file.includes(`${sep}assets${sep}langs${sep}`)).sort()
}

/** Line and column of one index inside a text buffer. */
function positionOf(text: string, index: number): { line: number; column: number } {
  let line = 1
  let lastBreak = -1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1
      lastBreak = cursor
    }
  }
  return { line, column: index - lastBreak }
}

/** Status of one feature id given the shim and acceptance tables. */
function statusOf(rule: FeatureRule, file: string): FeatureHit['status'] {
  if (SHIMMED.has(rule.id)) return 'shimmed'
  if (ACCEPTED.has(rule.id)) return 'accepted'
  if (ACCEPTED_FILE_HITS.some(entry => entry.id === rule.id && file.endsWith(entry.file))) return 'accepted'
  return 'unhandled'
}

/**
 * Find every rule hit in one artifact's text.
 * @param text - artifact contents.
 * @param rules - feature table to apply.
 * @returns one entry per feature present in the artifact.
 */
export function auditText(text: string, rules: readonly FeatureRule[] = RULES, file = ''): FeatureHit[] {
  const hits: FeatureHit[] = []
  for (const rule of rules) {
    if (rule.without !== undefined && text.includes(rule.without)) continue
    const mitigated = rule.mitigation !== undefined && text.includes(rule.mitigation)
    const expression = new RegExp(rule.pattern, 'g')
    let match: RegExpExecArray | null
    let count = 0
    let first = -1
    while ((match = expression.exec(text)) !== null) {
      if (first < 0) first = match.index
      count += 1
      if (match[0].length === 0) expression.lastIndex += 1
    }
    if (count === 0) continue
    const { line, column } = positionOf(text, first)
    hits.push({
      id: rule.id,
      kind: rule.kind,
      minChrome: rule.minChrome,
      severity: rule.severity,
      count,
      line,
      column,
      excerpt: text.slice(Math.max(0, first - 40), Math.min(text.length, first + 80)).replaceAll('\n', ' '),
      status: mitigated ? 'mitigated' : statusOf(rule, file),
    })
  }
  return hits.sort((left, right) => right.minChrome - left.minChrome)
}

/**
 * Audit every built artifact.
 * @param root - repository root.
 * @param baseline - shell version the report is written against.
 * @returns per-file hits plus totals.
 */
export function auditArtifacts(root = REPOSITORY_ROOT, baseline = BASELINE_CHROME): AuditReport {
  const rules = rulesNewerThanBaseline(baseline)
  const files: ArtifactHits[] = []
  for (const file of artifactFiles(root)) {
    const hits = auditText(readFileSync(file, 'utf8'), rules, file.split(sep).join('/'))
    if (hits.length > 0) files.push({ file: relative(root, file).split(sep).join('/'), hits })
  }
  const totals = { hard: 0, visual: 0, cosmetic: 0, unhandled: 0, shimmed: 0, accepted: 0, mitigated: 0 }
  for (const entry of files) {
    for (const hit of entry.hits) {
      totals[hit.severity] += 1
      totals[hit.status] += 1
    }
  }
  return { baseline, artifacts: artifactFiles(root).length, files, totals }
}

const SEVERITY_ORDER: readonly Severity[] = ['hard', 'visual', 'cosmetic']

/** Render the Markdown report. */
export function renderReport(report: AuditReport): string {
  const lines = [
    `# Chromium ${String(report.baseline)} compatibility audit`,
    '',
    `Artifacts scanned: ${String(report.artifacts)}`,
    '',
    '| Severity | Hits | Unhandled |',
    '| --- | --- | --- |',
  ]
  for (const severity of SEVERITY_ORDER) {
    const unhandled = report.files.flatMap(entry => entry.hits).filter(hit => hit.severity === severity && hit.status === 'unhandled').length
    lines.push(`| ${severity} | ${String(report.totals[severity])} | ${String(unhandled)} |`)
  }
  lines.push('', `Shimmed: ${String(report.totals.shimmed)} · Mitigated: ${String(report.totals.mitigated)}`
    + ` · Accepted: ${String(report.totals.accepted)}`, '')
  for (const severity of SEVERITY_ORDER) {
    const entries = report.files
      .map(entry => ({ file: entry.file, hits: entry.hits.filter(hit => hit.severity === severity) }))
      .filter(entry => entry.hits.length > 0)
    if (entries.length === 0) continue
    lines.push(`## ${severity}`, '')
    for (const entry of entries) {
      lines.push(`### ${entry.file}`, '')
      lines.push('| Feature | Min Chrome | Count | Status | First hit |', '| --- | --- | --- | --- | --- |')
      for (const hit of entry.hits) {
        const excerpt = hit.excerpt.replaceAll('|', '\\|').slice(0, 90)
        lines.push(`| ${hit.id} | ${String(hit.minChrome)} | ${String(hit.count)} | ${hit.status} | \`${excerpt}\` (${String(hit.line)}:${String(hit.column)}) |`)
      }
      lines.push('')
    }
  }
  const accepted = [...ACCEPTED.entries()]
  if (accepted.length > 0) {
    lines.push('## Accepted differences', '')
    for (const [id, reason] of accepted) lines.push(`- \`${id}\`: ${reason}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** Identifier of the first unhandled hard hit, if any. */
export function firstUnhandledHard(report: AuditReport): FeatureHit | undefined {
  for (const entry of report.files) {
    const hit = entry.hits.find(candidate => candidate.severity === 'hard' && candidate.status === 'unhandled')
    if (hit !== undefined) return hit
  }
  return undefined
}

function main(): void {
  const args = process.argv.slice(2)
  const failOn = args.find(argument => argument.startsWith('--fail-on='))?.slice('--fail-on='.length)
  if (failOn !== undefined && failOn !== 'hard' && failOn !== 'none') {
    throw new Error(`compat:audit: --fail-on must be "hard" or "none", received ${failOn}`)
  }
  const report = auditArtifacts()
  const outputDirectory = join(REPOSITORY_ROOT, 'dist', 'compat')
  mkdirSync(outputDirectory, { recursive: true })
  writeFileSync(join(outputDirectory, 'chromium102.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(outputDirectory, 'chromium102.md'), `${renderReport(report)}\n`)
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`compat:audit — ${String(report.artifacts)} artifacts, `
      + `hard ${String(report.totals.hard)}, visual ${String(report.totals.visual)}, cosmetic ${String(report.totals.cosmetic)}; `
      + `unhandled ${String(report.totals.unhandled)}\n`)
    process.stdout.write('report: dist/compat/chromium102.md\n')
  }
  if (failOn === 'hard') {
    const hit = firstUnhandledHard(report)
    if (hit !== undefined) {
      process.stderr.write(`compat:audit: unhandled hard feature ${hit.id} (min Chrome ${String(hit.minChrome)})\n`)
      process.exitCode = 1
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
