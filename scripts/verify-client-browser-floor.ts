/**
 * Client browser-floor artifact gate: nothing the browser loads may carry a
 * construct the floor cannot parse.
 *
 * The two build paths lower their own input, so this gate exists for what they
 * do not compile: third-party scripts embedded as text (the PDF.js Worker, for
 * example) and artifacts a nested build produced. A payload is invisible to a
 * scan of the outer file, because it is a string literal there.
 *
 * [client-browser-floor.spec.ts](./client-browser-floor.spec.ts) asserts the
 * build inputs and their rewrites; this gate asserts the shipped bytes.
 * @module scripts/verify-client-browser-floor
 */
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

/** Name this gate reports under. */
export const GATE = 'verify-client-browser-floor'

/** Every artifact the shell, the module loader, or a Worker constructor fetches. */
export const BROWSER_ARTIFACT_GLOBS: readonly string[] = [
  // Dynamic plugin bundles and their package-local chunks.
  'packages/client/*/lib/client*.js',
  // Statically linked browser libraries the shell bundles.
  'packages/client/web/lib/**/*.js',
  // The assembled Web shell and everything Vite emitted beside it.
  'apps/web/dist/**/*.js',
  // Browser Worker served as its own module, and the page half that boots it.
  'packages/experimental/webworker-runtime/lib/worker.js',
  'packages/experimental/webworker-runtime/lib/client.js',
]

/** Shortest embedded string literal treated as a raw JavaScript payload. */
export const PAYLOAD_MIN_CHARACTERS = 8192

/** One construct the floor cannot parse, located where it ships. */
export interface FloorViolation {
  /** Repository-relative artifact path. */
  readonly file: string
  /** One-based line inside that artifact. */
  readonly line: number
  /** One-based column inside that artifact. */
  readonly column: number
  /** Grammar the floor rejects. */
  readonly construct: string
  /** Whether the construct sits in an embedded payload rather than in the artifact itself. */
  readonly inPayload: boolean
}

/** Violation shape before its artifact position is attached. */
interface LocatedViolation {
  /** Grammar the floor rejects. */
  readonly construct: string
  /** Offset of the offending node. */
  readonly position: number
}

/**
 * Walk every node of one parsed source without recursing: minified artifacts
 * nest expressions far past the JavaScript stack.
 * @param source - Parsed JavaScript.
 * @returns Every node, parents before children.
 */
function* walk(source: ts.SourceFile): Generator<ts.Node> {
  const pending: ts.Node[] = [source]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === undefined) continue
    yield node
    const children: ts.Node[] = []
    ts.forEachChild(node, (child) => { children.push(child) })
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) pending.push(child)
    }
  }
}

function locate(source: ts.SourceFile, node: ts.Node): LocatedViolation['position'] {
  return node.getStart(source)
}

/**
 * Collect the floor's grammar violations in one parsed source.
 * @param source - Parsed JavaScript.
 * @returns Violations with their offsets.
 */
export function collectGrammarViolations(source: ts.SourceFile): LocatedViolation[] {
  const violations: LocatedViolation[] = []
  for (const node of walk(source)) {
    if (ts.isClassStaticBlockDeclaration(node)) {
      violations.push({ construct: 'class static block', position: locate(source, node) })
    } else if (ts.isPrivateIdentifier(node)
      && ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      violations.push({ construct: 'private brand check', position: locate(source, node) })
    } else if (ts.isVariableDeclarationList(node)
      // Bit test only: the combined Using|AwaitUsing mask also matches Const.
      && (node.flags & ts.NodeFlags.Using) !== 0) {
      violations.push({ construct: 'using declaration', position: locate(source, node) })
    } else if (ts.isImportDeclaration(node) && node.attributes !== undefined) {
      violations.push({ construct: 'import attributes', position: locate(source, node) })
    }
  }
  return violations
}

/**
 * Read the raw JavaScript payloads one artifact embeds as text.
 * @param source - Parsed JavaScript.
 * @returns Every long string literal's decoded value.
 */
export function collectPayloads(source: ts.SourceFile): string[] {
  const payloads: string[] = []
  for (const node of walk(source)) {
    if (ts.isStringLiteralLike(node) && node.text.length >= PAYLOAD_MIN_CHARACTERS) payloads.push(node.text)
  }
  return payloads
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
}

/**
 * Collect every floor violation one artifact ships.
 * @param file - Repository-relative artifact path.
 * @param text - Artifact contents.
 * @returns Violations with artifact positions.
 */
export function collectArtifactViolations(file: string, text: string): FloorViolation[] {
  const violations: FloorViolation[] = []
  const record = (source: ts.SourceFile, located: LocatedViolation, inPayload: boolean): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(located.position)
    violations.push({
      file, line: line + 1, column: character + 1, construct: located.construct, inPayload,
    })
  }
  const source = parse(file, text)
  for (const located of collectGrammarViolations(source)) record(source, located, false)
  for (const [index, payload] of collectPayloads(source).entries()) {
    // Payload text has no file of its own: report it against the embedding artifact.
    const payloadSource = parse(file + '#payload' + String(index + 1), payload)
    for (const located of collectGrammarViolations(payloadSource)) record(payloadSource, located, true)
  }
  return violations
}

/**
 * List every browser artifact in the repository.
 * @param root - Absolute repository root.
 * @returns Repository-relative paths, sorted.
 */
export function collectBrowserArtifacts(root: string): string[] {
  return BROWSER_ARTIFACT_GLOBS
    .flatMap(pattern => globSync(pattern, { cwd: root }))
    .map(path => path.split('\\').join('/'))
    .sort()
}

function describe(violation: FloorViolation): string {
  const where = violation.inPayload ? ' (embedded payload)' : ''
  return violation.file + ':' + String(violation.line) + ':' + String(violation.column)
    + ': ' + violation.construct + where
}

function main(): void {
  const root = process.cwd()
  const files = collectBrowserArtifacts(root)
  if (files.length === 0) {
    console.error(GATE + ': no browser artifacts found; build the client face before running this gate.')
    process.exit(1)
  }
  const violations: FloorViolation[] = []
  let payloads = 0
  for (const file of files) {
    const text = readFileSync(resolve(root, file), 'utf8')
    violations.push(...collectArtifactViolations(file, text))
    payloads += collectPayloads(parse(file, text)).length
  }
  if (violations.length > 0) {
    console.error(GATE + ': ' + String(violations.length) + ' construct(s) the Chromium 90 floor cannot parse:')
    for (const violation of violations) console.error('  ' + describe(violation))
    process.exit(1)
  }
  console.log(
    GATE + ': ' + String(files.length) + ' browser artifact(s) and ' + String(payloads)
    + ' embedded payload(s) parse at the client browser floor.',
  )
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main()
}
