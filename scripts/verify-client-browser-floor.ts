/**
 * Client browser-floor artifact gate: nothing the browser loads may carry a
 * construct the floor cannot parse or call an API the floor lacks.
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
import { CLIENT_FLOOR_APIS } from './client-browser-floor.ts'

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

/**
 * Post-floor API names this gate rejects at a call site, in
 * {@link CLIENT_FLOOR_APIS}'s dotted notation: `Owner.member` names a static or
 * global call, `Owner.prototype.member` an instance call.
 *
 * Curated by two rules, because the gate reads built JavaScript. An entry must
 * name a member the artifact still attributes to the platform, so a name
 * libraries also define for their own objects (`map`, `filter`, `union`,
 * `bytes`, `randomUUID`) stays out. And no shipped artifact may already call the
 * API: a call behind a feature check is reported like any other, so such an
 * entry would fail this gate on third-party code rather than on a regression.
 */
export const FLOOR_DENIED_APIS: readonly string[] = [
  // ECMAScript members Chromium 90 lacks.
  'Object.groupBy',
  'Map.groupBy',
  'Array.fromAsync',
  'Array.prototype.toSpliced',
  'String.prototype.isWellFormed',
  'String.prototype.toWellFormed',
  'Set.prototype.symmetricDifference',
  'Set.prototype.isSubsetOf',
  'Set.prototype.isSupersetOf',
  'Set.prototype.isDisjointFrom',
  'URL.canParse',
  'Uint8Array.fromHex',
  'Uint8Array.prototype.setFromBase64',
  'Uint8Array.prototype.setFromHex',
  // Platform members the same engine lacks.
  'HTMLInputElement.prototype.showPicker',
  'Element.prototype.checkVisibility',
  'Element.prototype.showPopover',
  'Element.prototype.hidePopover',
  'Element.prototype.togglePopover',
  'Document.prototype.startViewTransition',
]

/** One thing the floor cannot run, located where it ships. */
export interface FloorViolation {
  /** Repository-relative artifact path. */
  readonly file: string
  /** One-based line inside that artifact. */
  readonly line: number
  /** One-based column inside that artifact. */
  readonly column: number
  /** Grammar the floor rejects, or `call to <API>` for an API the floor lacks. */
  readonly construct: string
  /** Whether the construct sits in an embedded payload rather than in the artifact itself. */
  readonly inPayload: boolean
}

/** Violation shape before its artifact position is attached. */
interface LocatedViolation {
  /** Grammar the floor rejects, or the API call it cannot serve. */
  readonly construct: string
  /** Offset of the offending node. */
  readonly position: number
}

/** What one call target resolves to. */
interface CallTarget {
  /** Dotted names the target carries, receiver first. */
  readonly names: readonly string[]
  /** Whether the target is a member access rather than a plain identifier. */
  readonly member: boolean
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
 * Resolve a call target to the names a call site reaches.
 * @param callee - Expression a call site invokes.
 * @returns The target's names, or undefined when the target carries none.
 */
function resolveCallTarget(callee: ts.Expression): CallTarget | undefined {
  const names: string[] = []
  let node: ts.Expression = callee
  while (ts.isPropertyAccessExpression(node)) {
    names.unshift(node.name.text)
    node = node.expression
  }
  if (ts.isIdentifier(node)) names.unshift(node.text)
  return names.length === 0 ? undefined : { names, member: ts.isPropertyAccessExpression(callee) }
}

/**
 * Whether one resolved call target reaches the API a deny entry names.
 * @param api - Dotted API name.
 * @param target - Resolved call target.
 * @returns True when the call site reaches that API.
 */
function matchesDeniedApi(api: string, target: CallTarget): boolean {
  const segments = api.split('.')
  const member = segments[segments.length - 1]
  if (member === undefined) return false
  if (segments.length === 1) return !target.member && target.names.length === 1 && target.names[0] === api
  // An instance entry names one member of every receiver: the receiver's type
  // is not in the artifact, so only the member name survives to compare with.
  if (segments.length >= 3 && segments[1] === 'prototype') {
    return target.member && target.names[target.names.length - 1] === member
  }
  if (target.names.length < segments.length) return false
  const offset = target.names.length - segments.length
  return segments.every((segment, index) => target.names[offset + index] === segment)
}

/**
 * What one deny entry claims about the floor, for comparison with the install
 * contract.
 * @param api - Dotted API name.
 * @returns The member name an instance entry claims, otherwise the whole dotted name.
 */
function denyClaim(api: string): string {
  const segments = api.split('.')
  const member = segments[segments.length - 1] ?? ''
  return segments.length >= 3 && segments[1] === 'prototype' ? 'member ' + member : 'name ' + api
}

/**
 * Deny-list entries this gate reports, with the installer's coverage skipped.
 *
 * A name {@link CLIENT_FLOOR_APIS} installs is never a violation: the shell
 * installs it in every realm a client bundle loads, so a call site there —
 * including inside the installer's own artifact — is legal. Skipping is
 * asserted, not assumed: an entry whose call site the installer covers can
 * never be reported, so the gate refuses to run with one rather than look as
 * though it checks an API it cannot flag.
 * @param candidates - Curated API names; defaults to {@link FLOOR_DENIED_APIS}.
 * @param installed - Names the shell installs; defaults to {@link CLIENT_FLOOR_APIS}.
 * @returns Reportable entries, in candidate order.
 * @throws {Error} when a candidate's call site is one the installer covers, or
 * when no candidate remains to report.
 */
export function collectDeniedApis(
  candidates: readonly string[] = FLOOR_DENIED_APIS,
  installed: readonly string[] = CLIENT_FLOOR_APIS,
): readonly string[] {
  const covered = new Map(installed.map(api => [denyClaim(api), api]))
  const denied: string[] = []
  const skipped: string[] = []
  for (const api of candidates) {
    const installer = covered.get(denyClaim(api))
    if (installer === undefined) denied.push(api)
    else skipped.push(api + ' (installed as ' + installer + ')')
  }
  if (skipped.length > 0) {
    throw new Error(GATE + ': FLOOR_DENIED_APIS names APIs CLIENT_FLOOR_APIS installs: ' + skipped.join(', ')
      + '; the floor provides them, so this gate can never report them.')
  }
  if (denied.length === 0) {
    throw new Error(GATE + ': FLOOR_DENIED_APIS leaves nothing to report; the gate would check no API call site.')
  }
  return denied
}

/**
 * Collect the calls to floor-missing APIs in one parsed source.
 *
 * Only a call site counts, and only one whose target resolves to the entry: a
 * name in a comment or a string, or a member read without a call, is accepted.
 * `Owner.member` needs the whole dotted name on the target; an
 * `Owner.prototype.member` entry matches the member name of any receiver,
 * because built JavaScript carries no receiver type, so it is listed only for a
 * member no other owner defines. An alias of the owner or the member, and a
 * computed member (`target['groupBy']()`), are invisible to both forms.
 * @param source - Parsed JavaScript.
 * @param denied - API names to report; defaults to {@link collectDeniedApis}.
 * @returns Violations with their offsets.
 */
export function collectApiViolations(
  source: ts.SourceFile,
  denied: readonly string[] = collectDeniedApis(),
): LocatedViolation[] {
  const violations: LocatedViolation[] = []
  for (const node of walk(source)) {
    if (!ts.isCallExpression(node)) continue
    const target = resolveCallTarget(node.expression)
    if (target === undefined) continue
    for (const api of denied) {
      if (matchesDeniedApi(api, target)) {
        violations.push({ construct: 'call to ' + api, position: locate(source, node) })
      }
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
 * @param denied - API names to report; defaults to {@link collectDeniedApis}.
 * @returns Violations with artifact positions.
 */
export function collectArtifactViolations(
  file: string,
  text: string,
  denied: readonly string[] = collectDeniedApis(),
): FloorViolation[] {
  const violations: FloorViolation[] = []
  const record = (source: ts.SourceFile, located: LocatedViolation, inPayload: boolean): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(located.position)
    violations.push({
      file, line: line + 1, column: character + 1, construct: located.construct, inPayload,
    })
  }
  const collect = (source: ts.SourceFile, inPayload: boolean): void => {
    for (const located of collectGrammarViolations(source)) record(source, located, inPayload)
    for (const located of collectApiViolations(source, denied)) record(source, located, inPayload)
  }
  const source = parse(file, text)
  collect(source, false)
  for (const [index, payload] of collectPayloads(source).entries()) {
    // Payload text has no file of its own: report it against the embedding artifact.
    collect(parse(file + '#payload' + String(index + 1), payload), true)
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
  const denied = collectDeniedApis()
  const violations: FloorViolation[] = []
  let payloads = 0
  for (const file of files) {
    const text = readFileSync(resolve(root, file), 'utf8')
    violations.push(...collectArtifactViolations(file, text, denied))
    payloads += collectPayloads(parse(file, text)).length
  }
  if (violations.length > 0) {
    console.error(GATE + ': ' + String(violations.length) + ' violation(s) at the Chromium 90 floor:')
    for (const violation of violations) console.error('  ' + describe(violation))
    process.exit(1)
  }
  console.log(
    GATE + ': ' + String(files.length) + ' browser artifact(s) and ' + String(payloads)
    + ' embedded payload(s) meet the client browser floor.',
  )
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main()
}
