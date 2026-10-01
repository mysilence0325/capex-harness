import { createHash } from 'node:crypto'
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Targets } from 'lightningcss'

/**
 * The client's browser floor: the Chromium release every client artifact must
 * run on, and the stylesheet rewrites that floor needs and no compiler
 * performs.
 *
 * Script syntax and vendor prefixes come from the compilers — esbuild and oxc
 * for JavaScript, Lightning CSS for stylesheets — both driven by the constants
 * here. Two stylesheet features have no compiler lowering and are rewritten by
 * {@link downlevelClientCss} instead: color-mix() with custom-property
 * operands, resolved against the theme's own token sheets, and the dynamic
 * viewport units (dvh and its siblings), which get a static fallback
 * declaration ahead of the original.
 * @module scripts/client-browser-floor
 */

/** Chromium release the client builds target: the oldest engine the product supports. */
export const CLIENT_SCRIPT_TARGET = 'chrome90'

/**
 * Lightning CSS targets for every client stylesheet, in browserslist's
 * encoding (major version shifted into the high bits).
 */
export const CLIENT_STYLE_TARGETS: Targets = { chrome: 90 << 16 }

/** Repository-relative directory holding the design-token stylesheets both client build paths consume. */
const THEME_STYLE_DIRECTORY = 'packages/client/ui-theme/src/styles'

/** Selector whose custom properties are the light theme's values. */
const LIGHT_THEME_SELECTOR = 'body'

/** Selector whose custom properties are the dark theme's values. */
const DARK_THEME_SELECTOR = 'body[data-ds-dark-theme]'

/** One custom property's text value, keyed by property name. */
export type ThemeTokenTable = ReadonlyMap<string, string>

/** Static custom-property values of both themes, as the token sheets declare them. */
export interface ClientThemeTokens {
  /** Values declared for the light theme. */
  readonly light: ThemeTokenTable
  /** Values declared for the dark theme. */
  readonly dark: ThemeTokenTable
  /** Token sheets those values were read from, for watchers. */
  readonly files: readonly string[]
}

/** A color in sRGB with straight (non-premultiplied) alpha. */
interface RgbaColor {
  /** Red channel, 0-1. */
  readonly red: number
  /** Green channel, 0-1. */
  readonly green: number
  /** Blue channel, 0-1. */
  readonly blue: number
  /** Alpha channel, 0-1. */
  readonly alpha: number
}

/** The literal each engine should paint, per theme, for one resolved mix. */
interface MixDefinition {
  /** Value the light theme resolves to. */
  readonly light: string
  /** Value the dark theme resolves to. */
  readonly dark: string
  /** Original color-mix() text, kept for engines that implement it. */
  readonly expression: string
}

/** Custom properties one stylesheet declares, for mixes that reference them. */
type LocalCustomProperties = ReadonlyMap<string, string | undefined>

/**
 * Reference-chain length past which a custom property counts as unset, so a
 * cyclic declaration cannot recurse without end.
 */
const MAX_REFERENCE_DEPTH = 8

/** Named colors the token sheets and component styles mix with. */
const NAMED_COLORS: ReadonlyMap<string, RgbaColor> = new Map([
  ['transparent', { red: 0, green: 0, blue: 0, alpha: 0 }],
  ['black', { red: 0, green: 0, blue: 0, alpha: 1 }],
  ['white', { red: 1, green: 1, blue: 1, alpha: 1 }],
])

/** Resolve one custom property name to its declared value. */
type CustomPropertyLookup = (name: string) => string | undefined

/**
 * Read the design-token stylesheets and split their custom properties by theme.
 * @param root - repository root the token sheets are read from.
 * @returns the light and dark token tables.
 */
export function loadClientThemeTokens(root: string = process.cwd()): ClientThemeTokens {
  const directory = resolve(root, THEME_STYLE_DIRECTORY)
  const light = new Map<string, string>()
  const dark = new Map<string, string>()
  const files: string[] = []
  for (const file of globSync('*.css', { cwd: directory }).sort()) {
    const path = resolve(directory, file)
    files.push(path)
    collectThemeDeclarations(readFileSync(path, 'utf8'), light, dark)
  }
  return { light, dark, files }
}

/**
 * Collect the custom properties one stylesheet declares, by theme selector.
 * @param css - stylesheet source.
 * @param light - table receiving light-theme declarations.
 * @param dark - table receiving dark-theme declarations.
 */
function collectThemeDeclarations(
  css: string,
  light: Map<string, string>,
  dark: Map<string, string>,
): void {
  const source = stripComments(css)
  let index = 0
  while (index < source.length) {
    const open = source.indexOf('{', index)
    if (open === -1) return
    const close = matchingBrace(source, open)
    if (close === -1) return
    const prelude = source.slice(index, open).trim()
    const body = source.slice(open + 1, close)
    if (prelude.startsWith('@')) {
      // Grouping rules (@media, @supports, @layer) hold nested style rules.
      if (!/@(?:keyframes|-webkit-keyframes|font-face|property|page)/u.test(prelude)) {
        collectThemeDeclarations(body, light, dark)
      }
    } else {
      const selector = prelude.replace(/\s+/gu, ' ').trim()
      // Only the theme roots declare tokens every element inherits; a scoped
      // selector declares values for one subtree, not for the theme.
      const table = selector === LIGHT_THEME_SELECTOR
        ? light
        : selector === DARK_THEME_SELECTOR ? dark : undefined
      if (table !== undefined) {
        for (const [name, value] of parseDeclarations(body)) table.set(name, value)
      }
    }
    index = close + 1
  }
}

/**
 * Split custom-property declarations out of a declaration block.
 * @param body - text between a rule's braces.
 * @returns the name and value pairs, in source order.
 */
function parseDeclarations(body: string): [string, string][] {
  const declarations: [string, string][] = []
  for (const statement of splitTopLevel(body, ';')) {
    const separator = statement.indexOf(':')
    if (separator === -1) continue
    const name = statement.slice(0, separator).trim()
    const value = statement.slice(separator + 1).trim()
    if (name.startsWith('--') && value.length > 0) declarations.push([name, value])
  }
  return declarations
}

/**
 * Read the custom properties one stylesheet declares anywhere in its rules, so
 * a mix can reference a value the same file sets — the usual way a component
 * names a color it builds from theme tokens.
 * @param css - stylesheet source.
 * @returns property name to declared value; a name declared twice with
 * different values maps to undefined, because no single value can stand in.
 */
function localCustomProperties(css: string): LocalCustomProperties {
  const declared = new Map<string, string | undefined>()
  for (const match of stripComments(css).matchAll(/--[a-zA-Z0-9-]+\s*:\s*[^;{}]+/gu)) {
    const text = match[0]
    const separator = text.indexOf(':')
    const name = text.slice(0, separator).trim()
    const value = text.slice(separator + 1).trim()
    const existing = declared.get(name)
    if (existing === undefined && !declared.has(name)) declared.set(name, value)
    else if (existing !== value) declared.set(name, undefined)
  }
  return declared
}

/**
 * Split text on a separator that is neither quoted nor nested in parentheses.
 * @param text - text to split.
 * @param separator - single-character separator.
 * @returns the parts, trimmed.
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const character of text) {
    if (quote !== '') {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth -= 1
    } else if (character === separator && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  parts.push(current.trim())
  return parts
}

/**
 * Find the brace closing the block opened at an index.
 * @param text - stylesheet source.
 * @param open - index of the opening brace.
 * @returns the matching brace's index, or -1 when the block is unclosed.
 */
function matchingBrace(text: string, open: number): number {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Find the parenthesis closing the call opened at an index.
 * @param text - stylesheet source.
 * @param open - index of the opening parenthesis.
 * @returns the matching parenthesis's index, or -1 when it is unclosed.
 */
function matchingParenthesis(text: string, open: number): number {
  let depth = 0
  let quote = ''
  for (let index = open; index < text.length; index += 1) {
    const character = text[index]
    if (quote !== '') {
      if (character === quote && text[index - 1] !== '\\') quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Strip CSS comments from a stylesheet.
 * @param css - stylesheet source.
 * @returns the source without comment text.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '')
}

/**
 * Rewrite the stylesheet features the browser floor cannot interpret.
 *
 * color-mix() becomes a custom property whose value is the computed color per
 * theme, with the original expression behind @supports for engines that
 * implement it; every replacement's definition is appended to the returned
 * stylesheet, so one stylesheet stays self-contained. Unresolvable mixes — a
 * color neither the token sheets nor an engine-supported function expresses —
 * are left as written.
 * @param css - stylesheet source, comments included.
 * @param tokens - theme token tables the mixes are resolved against.
 * @returns the rewritten stylesheet, with definitions appended.
 */
export function downlevelClientCss(css: string, tokens: ClientThemeTokens): string {
  const definitions = new Map<string, MixDefinition>()
  const local = localCustomProperties(css)
  const rewritten = transformOutsideComments(css, (segment) => {
    const withMixes = rewriteColorMix(segment, tokens, local, definitions)
    return addViewportUnitFallbacks(withMixes)
  })
  if (definitions.size === 0) return rewritten
  return rewritten + '\n' + renderMixDefinitions(definitions) + '\n'
}

/**
 * Split a stylesheet into comment and non-comment runs, transforming only the
 * latter, so a rewrite can never reach into prose.
 * @param css - stylesheet source.
 * @param transform - rewrite applied to each non-comment run.
 * @returns the stylesheet with its non-comment runs transformed.
 */
function transformOutsideComments(css: string, transform: (segment: string) => string): string {
  return css.split(/(\/\*[\s\S]*?\*\/)/u).map((part, index) => index % 2 === 0 ? transform(part) : part).join('')
}

/**
 * Replace every resolvable color-mix() with a custom property carrying the
 * computed color, recording the definition to append.
 * @param segment - comment-free stylesheet text.
 * @param tokens - theme token tables.
 * @param definitions - collector for the definitions to append.
 * @returns the text with resolvable mixes replaced.
 */
function rewriteColorMix(
  segment: string,
  tokens: ClientThemeTokens,
  local: LocalCustomProperties,
  definitions: Map<string, MixDefinition>,
): string {
  let result = ''
  let index = 0
  while (index < segment.length) {
    const start = segment.indexOf('color-mix(', index)
    if (start === -1) return result + segment.slice(index)
    const close = matchingParenthesis(segment, start + 'color-mix'.length)
    if (close === -1) return result + segment.slice(index)
    const arguments_ = segment.slice(start + 'color-mix('.length, close)
    // A resolvable mix covers whatever mixes it nests; only an unresolvable
    // one descends, so its nested mixes still get their own definitions.
    const resolved = resolveMix(arguments_, tokens, local)
    const inner = resolved === undefined
      ? rewriteColorMix(arguments_, tokens, local, definitions)
      : arguments_
    result += segment.slice(index, start)
    const expression = 'color-mix(' + inner + ')'
    if (resolved === undefined) {
      result += expression
    } else {
      const name = mixPropertyName(expression, resolved)
      // Stylesheets may repeat one expression; identical definitions make the
      // repeat harmless, and differing ones would not be.
      definitions.set(name, {
        light: resolved.light,
        dark: resolved.dark,
        expression,
      })
      result += 'var(' + name + ')'
    }
    index = close + 1
  }
  return result
}

/**
 * Compute both themes' literal for one color-mix() argument list.
 * @param args - arguments between the mix's parentheses.
 * @param tokens - theme token tables.
 * @returns the light and dark literals, or undefined when an operand is not
 * resolvable from the token sheets.
 */
function resolveMix(
  args: string,
  tokens: ClientThemeTokens,
  local: LocalCustomProperties,
): { readonly light: string; readonly dark: string } | undefined {
  const light = evaluateColorMix(args, name => tokens.light.get(name) ?? local.get(name), 0)
  const dark = evaluateColorMix(args, name => tokens.dark.get(name) ?? local.get(name), 0) ?? light
  const resolvedLight = light ?? dark
  return resolvedLight === undefined
    ? undefined
    : { light: formatColor(resolvedLight), dark: formatColor(dark ?? resolvedLight) }
}

/**
 * Evaluate one color-mix() argument list in sRGB.
 * @param args - arguments between the mix's parentheses.
 * @param lookup - custom property resolver for the theme being computed.
 * @returns the mixed color, or undefined for a form outside this floor.
 */
function evaluateColorMix(args: string, lookup: CustomPropertyLookup, depth: number): RgbaColor | undefined {
  if (depth > MAX_REFERENCE_DEPTH) return undefined
  const parts = splitTopLevel(args, ',')
  const space = parts[0]
  const first = parts[1]
  const second = parts[2]
  // An omitted color space means oklab, not sRGB; only explicit sRGB mixes
  // are computed here.
  if (parts.length !== 3 || space === undefined || first === undefined || second === undefined) return undefined
  if (space.trim().toLowerCase() !== 'in srgb') return undefined
  const left = parseColorOperand(first, lookup, depth)
  const right = parseColorOperand(second, lookup, depth)
  if (left === undefined || right === undefined) return undefined
  return mixColors(left, right)
}

/**
 * Split one color operand, with its optional weight, out of a mix's arguments.
 * @param operand - operand text.
 * @param lookup - custom property resolver.
 * @returns the color and its weight, or undefined when the color is outside
 * this floor.
 */
function parseColorOperand(
  operand: string,
  lookup: CustomPropertyLookup,
  depth: number,
): { readonly color: RgbaColor; readonly weight: number | undefined } | undefined {
  const weighted = /^(.*?)\s+([0-9]*\.?[0-9]+)%$/su.exec(operand.trim())
  const text = (weighted === null ? operand : weighted[1] ?? '').trim()
  const color = parseColor(text, lookup, depth + 1)
  if (color === undefined) return undefined
  const percentage = weighted === null ? undefined : weighted[2]
  return { color, weight: percentage === undefined ? undefined : Number(percentage) / 100 }
}

/**
 * Mix two weighted colors the way color-mix(in srgb, ...) does: premultiplied
 * sRGB, the omitted weight taking the remainder, and weights summing past
 * 100% scaled back to 100%.
 * @param first - first operand and its weight.
 * @param second - second operand and its weight.
 * @returns the mixed color.
 */
function mixColors(
  first: { readonly color: RgbaColor; readonly weight: number | undefined },
  second: { readonly color: RgbaColor; readonly weight: number | undefined },
): RgbaColor {
  let firstWeight = first.weight ?? (second.weight === undefined ? 0.5 : 1 - second.weight)
  let secondWeight = second.weight ?? (first.weight === undefined ? 0.5 : 1 - first.weight)
  const total = firstWeight + secondWeight
  if (total > 1) {
    firstWeight /= total
    secondWeight /= total
  }
  const alpha = firstWeight * first.color.alpha + secondWeight * second.color.alpha
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 }
  const channel = (left: number, right: number): number =>
    (firstWeight * left * first.color.alpha + secondWeight * right * second.color.alpha) / alpha
  return {
    red: channel(first.color.red, second.color.red),
    green: channel(first.color.green, second.color.green),
    blue: channel(first.color.blue, second.color.blue),
    alpha,
  }
}

/**
 * Parse one CSS color the token sheets or component styles can express.
 * @param text - color text, possibly a var() reference or a nested mix.
 * @param lookup - custom property resolver.
 * @returns the color, or undefined when the form is outside this floor.
 */
function parseColor(text: string, lookup: CustomPropertyLookup, depth: number): RgbaColor | undefined {
  if (depth > MAX_REFERENCE_DEPTH) return undefined
  const value = text.trim()
  const named = NAMED_COLORS.get(value.toLowerCase())
  if (named !== undefined) return named
  if (value.startsWith('#')) return parseHexColor(value)
  const functional = /^(rgba?|color-mix)\((.*)\)$/su.exec(value)
  if (functional !== null) {
    const body = (functional[2] ?? '').trim()
    if (functional[1] === 'color-mix') return evaluateColorMix(body, lookup, depth + 1)
    return parseRgbFunction(body)
  }
  if (value.startsWith('var(')) {
    const resolved = resolveVariable(value, lookup, depth)
    return resolved === undefined ? undefined : parseColor(resolved, lookup, depth + 1)
  }
  return undefined
}

/**
 * Resolve one var(--name[, fallback]) reference.
 * @param text - the reference, parentheses included.
 * @param lookup - custom property resolver.
 * @returns the referenced value or its fallback, or undefined when neither is
 * available.
 */
function resolveVariable(text: string, lookup: CustomPropertyLookup, depth: number): string | undefined {
  if (depth > MAX_REFERENCE_DEPTH) return undefined
  const open = text.indexOf('(')
  const close = matchingParenthesis(text, open)
  if (close === -1) return undefined
  const parts = splitTopLevel(text.slice(open + 1, close), ',')
  const name = parts[0]
  const resolved = name === undefined ? undefined : lookup(name.trim())
  if (resolved !== undefined) return resolved
  return parts.length < 2 ? undefined : parts.slice(1).join(',').trim()
}

/**
 * Parse a #rgb, #rgba, #rrggbb, or #rrggbbaa color.
 * @param text - hex color text.
 * @returns the color, or undefined for another length or character set.
 */
function parseHexColor(text: string): RgbaColor | undefined {
  const digits = text.slice(1)
  const expanded = digits.length <= 4
    ? digits.split('').map(digit => digit + digit).join('')
    : digits
  if (!/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(expanded)) return undefined
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16) / 255,
    green: Number.parseInt(expanded.slice(2, 4), 16) / 255,
    blue: Number.parseInt(expanded.slice(4, 6), 16) / 255,
    alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  }
}

/**
 * Parse the arguments of rgb() or rgba(), in the comma or the space-and-slash
 * form.
 * @param body - arguments between the parentheses.
 * @returns the color, or undefined for a form outside this floor.
 */
function parseRgbFunction(body: string): RgbaColor | undefined {
  const parts = body.includes(',')
    ? splitTopLevel(body, ',')
    : splitTopLevel(body.replace('/', ' / '), ' ')
  const channels = [parts[0], parts[1], parts[2]].map(parseChannel)
  if (channels.some(channel => channel === undefined)) return undefined
  const alphaText = parts[3]
  const alpha = alphaText === undefined || alphaText === '' ? 1 : parseAlpha(alphaText)
  if (alpha === undefined) return undefined
  return {
    red: channels[0] as number,
    green: channels[1] as number,
    blue: channels[2] as number,
    alpha,
  }
}

/**
 * Parse one rgb() channel, a number or a percentage.
 * @param text - channel text.
 * @returns the channel as 0-1, or undefined.
 */
function parseChannel(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const value = text.trim()
  if (value.endsWith('%')) {
    const percentage = Number(value.slice(0, -1))
    return Number.isFinite(percentage) ? percentage / 100 : undefined
  }
  const number = Number(value)
  return Number.isFinite(number) ? number / 255 : undefined
}

/**
 * Parse the alpha argument of rgb() or rgba().
 * @param text - alpha text, a number or a percentage.
 * @returns alpha as 0-1, or undefined.
 */
function parseAlpha(text: string): number | undefined {
  const value = text.trim()
  const percentage = value.endsWith('%')
  const number = Number(percentage ? value.slice(0, -1) : value)
  if (!Number.isFinite(number)) return undefined
  return percentage ? number / 100 : number
}

/**
 * Render a color in the comma-separated form every engine of the floor parses.
 * @param color - color to render.
 * @returns the rgb() or rgba() text.
 */
function formatColor(color: RgbaColor): string {
  const channels = [color.red, color.green, color.blue].map(value => Math.round(value * 255))
  const alpha = Math.round(color.alpha * 1000) / 1000
  const prefix = alpha >= 1 ? 'rgb(' : 'rgba('
  const suffix = alpha >= 1 ? ')' : ', ' + String(alpha) + ')'
  return prefix + channels.join(', ') + suffix
}

/**
 * Name the custom property holding one mix, keyed by what it must resolve to,
 * so two stylesheets only share a name when they share a value.
 * @param expression - original color-mix() text.
 * @param resolved - the theme literals.
 * @returns the custom property name.
 */
function mixPropertyName(
  expression: string,
  resolved: { readonly light: string; readonly dark: string },
): string {
  const digest = createHash('sha1')
    .update(expression + '|' + resolved.light + '|' + resolved.dark)
    .digest('hex')
    .slice(0, 8)
  return '--dsh-mix-' + digest
}

/**
 * Render the definitions one stylesheet's mixes need.
 * @param definitions - definitions collected while rewriting.
 * @returns the definition rules: each theme's literal, plus the @supports
 * block that reinstates the original expression where engines implement it.
 */
function renderMixDefinitions(definitions: ReadonlyMap<string, MixDefinition>): string {
  const light: string[] = []
  const dark: string[] = []
  const source: string[] = []
  const darkSource: string[] = []
  for (const [name, definition] of definitions) {
    light.push(name + ': ' + definition.light)
    source.push(name + ': ' + definition.expression)
    if (definition.dark !== definition.light) {
      dark.push(name + ': ' + definition.dark)
      darkSource.push(name + ': ' + definition.expression)
    }
  }
  const rules = ['body { ' + light.join('; ') + '; }']
  if (dark.length > 0) rules.push('body[data-ds-dark-theme] { ' + dark.join('; ') + '; }')
  const supported = ['body { ' + source.join('; ') + '; }']
  if (darkSource.length > 0) {
    supported.push('body[data-ds-dark-theme] { ' + darkSource.join('; ') + '; }')
  }
  rules.push('@supports (color: color-mix(in srgb, red, blue)) { ' + supported.join(' ') + ' }')
  return rules.join('\n')
}

/**
 * Give every dynamic-viewport-unit declaration a static fallback ahead of it,
 * so an engine without those units still lays the box out.
 * @param segment - comment-free stylesheet text.
 * @returns the text with fallback declarations inserted.
 */
function addViewportUnitFallbacks(segment: string): string {
  return segment.replace(
    /([a-zA-Z-]+)(\s*:\s*)([^;{}]*?[0-9.](?:dvh|dvw|svh|svw|lvh|lvw)\b[^;{}]*?)(;|(?=\s*\}))/gu,
    (_match, property: string, separator: string, value: string, terminator: string) => {
      const fallback = value
        .replace(/(?<=[0-9.])(?:dvh|svh|lvh)\b/gu, 'vh')
        .replace(/(?<=[0-9.])(?:dvw|svw|lvw)\b/gu, 'vw')
      return property + separator + fallback.trim() + '; ' + property + separator + value.trim() + terminator
    },
  )
}
