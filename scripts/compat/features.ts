/**
 * Chromium version gates for the browser features this product actually calls
 * or declares. `minChrome` is the first stable Chrome release that ships the
 * feature; the audit flags every built artifact that uses a feature newer than
 * the deployment baseline.
 *
 * Severity describes what the shell does when the feature is missing:
 * - `hard`: the call throws, or the whole stylesheet region is discarded.
 * - `visual`: one declaration is dropped and the surface keeps working.
 * - `cosmetic`: only a shape or motion refinement is lost.
 * @module scripts/compat/features
 */

/** Baseline shell the packaged UI must run on. */
export const BASELINE_CHROME = 102

export type Severity = 'hard' | 'visual' | 'cosmetic'

export type FeatureKind = 'js' | 'css-property' | 'css-function' | 'css-selector' | 'css-at-rule'

export interface FeatureRule {
  /** Stable identifier used in the report and in the shim inventory. */
  readonly id: string
  readonly kind: FeatureKind
  readonly minChrome: number
  readonly severity: Severity
  /** Regular expression source applied to built artifact text. */
  readonly pattern: string
  /** Optional marker that must be absent for the hit to count. */
  readonly without?: string
  /** Marker proving the artifact ships its own fallback for the feature. */
  readonly mitigation?: string
  /** Optional explanation shown in the report. */
  readonly note?: string
}

/**
 * Features this build either shims at runtime or deliberately keeps.
 * A `shim` entry is still reported, but the report marks it covered, so the
 * gate distinguishes "known and handled" from "unhandled".
 */
export const SHIMMED = new Set([
  'promise-with-resolvers',
  'abort-signal-any',
  'abort-signal-timeout',
  'array-copy-methods',
  'set-composition-methods',
  'url-can-parse',
  'url-parse',
  'regexp-escape',
])

/** Features accepted as-is, with the reason recorded in the report. */
export const ACCEPTED = new Map<string, string>([
  ['corner-shape', 'Squircle corners fall back to border-radius; no layout or legibility impact.'],
  ['text-wrap-balance', 'Headings wrap across their full width instead of balancing the last line.'],
  [
    'field-sizing',
    'Content-sized textareas keep their declared min-height and scroll once the text outgrows it.',
  ],
  [
    'has-selector',
    'Relational selectors tune hover affordances and overlay padding. Chromium 102 keeps the base rule;'
      + ' the surfaces stay usable with slightly wider padding and hover-only hints that require a pointer.',
  ],
  [
    'secure-context-api',
    'Reachable only from a secure context; the shipped launcher opens http://127.0.0.1, which qualifies.',
  ],
])

/**
 * Hits this build accepts inside one artifact, where the code belongs to a
 * vendor bundle that this fork does not patch.
 */
export const ACCEPTED_FILE_HITS: ReadonlyArray<{ id: string; file: string; reason: string }> = [
  {
    id: 'color-mix',
    file: 'ui-sidebar-documentpreview/lib/client.pdf.js',
    reason: 'pdfjs-dist sets a find-bar popup background from a runtime template string; it keeps its default color on 102.',
  },
]

export const RULES: readonly FeatureRule[] = [
  {
    id: 'promise-with-resolvers',
    kind: 'js',
    minChrome: 119,
    severity: 'hard',
    pattern: String.raw`Promise\s*\.\s*withResolvers\s*\(`,
    note: 'installBrowserCompat() installs the shim before the shell boots.',
  },
  {
    id: 'abort-signal-any',
    kind: 'js',
    minChrome: 116,
    severity: 'hard',
    pattern: String.raw`AbortSignal\s*\.\s*any\s*\(`,
  },
  {
    id: 'abort-signal-timeout',
    kind: 'js',
    minChrome: 103,
    severity: 'hard',
    pattern: String.raw`AbortSignal\s*\.\s*timeout\s*\(`,
  },
  {
    id: 'array-copy-methods',
    kind: 'js',
    minChrome: 110,
    severity: 'hard',
    pattern: String.raw`\.\s*(?:toSorted|toReversed|toSpliced|with)\s*\(`,
  },
  {
    id: 'url-can-parse',
    kind: 'js',
    minChrome: 120,
    severity: 'hard',
    pattern: String.raw`URL\s*\.\s*canParse\s*\(`,
  },
  {
    id: 'url-parse',
    kind: 'js',
    minChrome: 126,
    severity: 'hard',
    pattern: String.raw`URL\s*\.\s*parse\s*\(`,
  },
  {
    id: 'regexp-escape',
    kind: 'js',
    minChrome: 136,
    severity: 'hard',
    pattern: String.raw`RegExp\s*\.\s*escape\s*\(`,
  },
  {
    id: 'object-group-by',
    kind: 'js',
    minChrome: 117,
    severity: 'hard',
    pattern: String.raw`(?:Object|Map)\s*\.\s*groupBy\s*\(`,
  },
  {
    id: 'array-from-async',
    kind: 'js',
    minChrome: 121,
    severity: 'hard',
    pattern: String.raw`Array\s*\.\s*fromAsync\s*\(`,
  },
  {
    id: 'check-visibility',
    kind: 'js',
    minChrome: 105,
    severity: 'hard',
    pattern: String.raw`\.\s*checkVisibility\s*\(`,
  },
  {
    id: 'dialog-request-close',
    kind: 'js',
    minChrome: 134,
    severity: 'hard',
    pattern: String.raw`\.\s*requestClose\s*\(`,
  },
  {
    id: 'start-view-transition',
    kind: 'js',
    minChrome: 111,
    severity: 'hard',
    pattern: String.raw`startViewTransition\s*\(`,
  },
  {
    id: 'secure-context-api',
    kind: 'js',
    minChrome: 0,
    severity: 'visual',
    pattern: String.raw`(?:crypto\s*\.\s*randomUUID|navigator\s*\.\s*clipboard|crypto\s*\.\s*subtle)`,
  },
  {
    id: 'color-mix',
    kind: 'css-function',
    minChrome: 111,
    severity: 'visual',
    pattern: String.raw`color-mix\s*\(`,
    mitigation: String.raw`--dsw-mix-`,
  },
  {
    id: 'has-selector',
    kind: 'css-selector',
    minChrome: 105,
    severity: 'visual',
    pattern: String.raw`:has\s*\(`,
  },
  {
    id: 'container-query',
    kind: 'css-at-rule',
    minChrome: 105,
    severity: 'visual',
    pattern: String.raw`@container\b`,
  },
  {
    id: 'scope-at-rule',
    kind: 'css-at-rule',
    minChrome: 118,
    severity: 'hard',
    pattern: String.raw`@scope\b`,
    note: 'The whole scoped block is discarded, so the surface loses every rule inside it.',
  },
  {
    id: 'dynamic-viewport-units',
    kind: 'css-property',
    minChrome: 108,
    severity: 'visual',
    // Declaration context only: base64 payloads contain the same three letters.
    pattern: String.raw`(?:height|width)\s*:[^;}]{0,80}\d(?:dvh|svh|lvh)\b`,
    mitigation: String.raw`100vh`,
  },
  {
    id: 'light-dark',
    kind: 'css-function',
    minChrome: 123,
    severity: 'visual',
    // Declaration context only: vendor parsers mention the name as a string.
    pattern: String.raw`:\s*[^;{}]*light-dark\(\s*(?:#|rgb|hsl|white|black)`,
  },
  {
    id: 'scrollbar-color-width',
    kind: 'css-property',
    minChrome: 121,
    severity: 'visual',
    // Skip custom properties such as `--dsh-scrollbar-width`.
    pattern: String.raw`(?<![-\w])scrollbar-(?:width|color)\s*:`,
    mitigation: String.raw`::-webkit-scrollbar`,
  },
  {
    id: 'field-sizing',
    kind: 'css-property',
    minChrome: 123,
    severity: 'visual',
    pattern: String.raw`field-sizing\s*:`,
  },
  {
    id: 'text-wrap-balance',
    kind: 'css-property',
    minChrome: 114,
    severity: 'cosmetic',
    pattern: String.raw`text-wrap\s*:\s*(?:balance|pretty)`,
  },
  {
    id: 'corner-shape',
    kind: 'css-property',
    minChrome: 139,
    severity: 'cosmetic',
    pattern: String.raw`corner-shape\s*:`,
  },
  {
    id: 'anchor-positioning',
    kind: 'css-property',
    minChrome: 125,
    severity: 'visual',
    pattern: String.raw`(?:anchor-name|position-anchor)\s*:`,
  },
  {
    id: 'subgrid',
    kind: 'css-property',
    minChrome: 117,
    severity: 'visual',
    pattern: String.raw`grid-template-(?:columns|rows)\s*:\s*subgrid`,
  },
  {
    id: 'starting-style',
    kind: 'css-at-rule',
    minChrome: 117,
    severity: 'cosmetic',
    pattern: String.raw`@starting-style\b`,
  },
]

/** Rules whose minimum version is newer than the baseline, newest first. */
export function rulesNewerThanBaseline(baseline = BASELINE_CHROME): readonly FeatureRule[] {
  return RULES.filter(rule => rule.minChrome > baseline).sort((left, right) => right.minChrome - left.minChrome)
}
