/**
 * Precompute `color-mix()` for shells that predate it.
 *
 * `color-mix(in srgb, var(--x) 10%, transparent)` resolves at style-computation
 * time, so the palette value is only known once a theme is applied. This module
 * evaluates every mix against both palettes declared in `design-platform.css`
 * and rewrites the expression to a custom property with the light value as its
 * `var()` fallback. The generated `mix-fallbacks.css` then rebinds that property
 * for the dark palette, so each theme keeps its own result.
 * @module scripts/compat/color-mix
 */

/** One color, with alpha in the 0–1 range. */
export interface Rgba {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

/** Palette declarations of one theme, keyed by custom property name. */
export type Variables = ReadonlyMap<string, string>

const HEX = /^#([0-9a-f]{3,8})$/i
const RGB = /^rgba?\(([^)]+)\)$/i

/** Parse one `rgb()`/`rgba()`/hex value; alpha stays 0–1. */
export function parseColor(text: string): Rgba | undefined {
  const value = text.trim().toLowerCase()
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (value === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  if (value === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  const hex = HEX.exec(value)
  if (hex !== null) {
    const digits = hex[1] ?? ''
    const expand = digits.length <= 4 ? digits.split('').map(char => `${char}${char}`).join('') : digits
    const channel = (offset: number): number => Number.parseInt(expand.slice(offset, offset + 2), 16)
    return {
      r: channel(0),
      g: channel(2),
      b: channel(4),
      a: expand.length === 8 ? channel(6) / 255 : 1,
    }
  }
  const rgb = RGB.exec(value)
  if (rgb === null) return undefined
  const parts = (rgb[1] ?? '').split(/[,/]/).map(part => part.trim())
  if (parts.length < 3) return undefined
  const number = (text: string): number => text.endsWith('%')
    ? Number.parseFloat(text) * 2.55
    : Number.parseFloat(text)
  const [red, green, blue, alphaText] = parts
  if (red === undefined || green === undefined || blue === undefined) return undefined
  const alpha = alphaText === undefined ? 1 : Number.parseFloat(alphaText)
  return { r: number(red), g: number(green), b: number(blue), a: alpha }
}

/** Render a color back to CSS, trimming float noise. */
export function formatColor(color: Rgba): string {
  const channel = (value: number): string => String(Math.round(Math.min(255, Math.max(0, value))))
  const alpha = Math.round(Math.min(1, Math.max(0, color.a)) * 1000) / 1000
  return alpha >= 1
    ? `rgb(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)})`
    : `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${String(alpha)})`
}

/** `var(--name)` and `var(--name, fallback)` with one level of nested parens. */
const VAR_REFERENCE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g

/** Substitute `var(--x)` and `var(--x, fallback)` references until none remain. */
export function resolveVariables(text: string, variables: Variables, depth = 0): string {
  if (depth > 8) return text
  const next = text.replaceAll(VAR_REFERENCE, (match, name: string, fallback?: string) => {
    const value = variables.get(name) ?? fallback?.trim()
    if (value === undefined) return match
    return value
  })
  if (next === text) return text
  return resolveVariables(next, variables, depth + 1)
}

/** Split one `color-mix()` argument list into color and percentage parts. */
function parseOperand(operand: string, variables: Variables): { color: Rgba; percentage: number } | undefined {
  const trimmed = operand.trim()
  const percentMatch = /(-?[\d.]+)%\s*$/.exec(trimmed)
  const percentage = percentMatch?.[1] === undefined ? undefined : Number.parseFloat(percentMatch[1])
  const colorText = resolveVariables(percentMatch === null ? trimmed : trimmed.slice(0, percentMatch.index), variables)
  // A nested mix is itself a color operand; evaluate it before parsing.
  const color = colorText.trim().startsWith('color-mix(')
    ? evaluateColorMix(colorText.trim(), variables)
    : parseColor(colorText)
  if (color === undefined) return undefined
  return { color, percentage: percentage ?? Number.NaN }
}

/**
 * Evaluate one `color-mix()` expression against a palette.
 * @param expression - the full `color-mix(...)` text.
 * @param variables - palette declarations of the theme to evaluate.
 * @returns the mixed color, or undefined when an operand is not a known color.
 */
export function evaluateColorMix(expression: string, variables: Variables): Rgba | undefined {
  const inner = expression.slice(expression.indexOf('(') + 1, expression.lastIndexOf(')'))
  const parts = splitArguments(inner)
  if (parts.length < 3) return undefined
  const [spaceText, firstText, secondText] = parts
  if (spaceText === undefined || firstText === undefined || secondText === undefined) return undefined
  const space = spaceText.trim().toLowerCase()
  if (space !== 'in srgb') return undefined
  const first = parseOperand(firstText, variables)
  const second = parseOperand(secondText, variables)
  if (first === undefined || second === undefined) return undefined
  let firstShare = Number.isNaN(first.percentage) ? Number.NaN : first.percentage / 100
  let secondShare = Number.isNaN(second.percentage) ? Number.NaN : second.percentage / 100
  if (Number.isNaN(firstShare) && Number.isNaN(secondShare)) {
    firstShare = 0.5
    secondShare = 0.5
  } else if (Number.isNaN(firstShare)) {
    firstShare = 1 - secondShare
  } else if (Number.isNaN(secondShare)) {
    secondShare = 1 - firstShare
  }
  const total = firstShare + secondShare
  if (total <= 0) return undefined
  firstShare /= total
  secondShare /= total
  const alpha = first.color.a * firstShare + second.color.a * secondShare
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const blend = (left: number, right: number): number =>
    (left * first.color.a * firstShare + right * second.color.a * secondShare) / alpha
  return {
    r: blend(first.color.r, second.color.r),
    g: blend(first.color.g, second.color.g),
    b: blend(first.color.b, second.color.b),
    a: alpha,
  }
}

/** Split a comma-separated argument list, ignoring commas inside parentheses. */
export function splitArguments(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** Canonical form used as the table key, independent of authoring whitespace. */
export function normalizeColorMix(expression: string): string {
  return expression.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
}

/** Every `color-mix(...)` span in a stylesheet, nesting included, in source order. */
export function findColorMixRanges(css: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const marker = 'color-mix('
  let index = css.indexOf(marker)
  while (index >= 0) {
    let depth = 0
    let end = index + marker.length - 1
    for (; end < css.length; end += 1) {
      const char = css[end]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    ranges.push({ start: index, end: end + 1 })
    index = css.indexOf(marker, index + marker.length)
  }
  return ranges
}

/** Every `color-mix(...)` expression in a stylesheet, in source order. */
export function findColorMix(css: string): string[] {
  return findColorMixRanges(css).map(range => css.slice(range.start, range.end))
}

/** Stable custom-property name for one expression. */
export function tokenNameFor(expression: string): string {
  const slug = expression
    .replace(/^color-mix\(/i, '')
    .replace(/\)$/, '')
    .replaceAll(/var\(\s*--dsw-/g, '')
    .replaceAll(/[\s(),%]+/g, '-')
    .replaceAll(/[^\w-]+/g, '')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .toLowerCase()
  return `--dsw-mix-${slug}`
}

/** Rewrite every evaluable `color-mix()` to its precomputed custom property. */
export function rewriteColorMix(css: string, table: ReadonlyMap<string, { token: string; fallback: string }>): string {
  let output = ''
  let cursor = 0
  // Outermost first: a replaced span swallows the nested ranges it contains.
  const ranges = [...findColorMixRanges(css)].sort((left, right) => left.start - right.start)
  for (const range of ranges) {
    if (range.start < cursor) continue
    const entry = table.get(normalizeColorMix(css.slice(range.start, range.end)))
    output += css.slice(cursor, range.start)
    output += entry === undefined ? css.slice(range.start, range.end) : `var(${entry.token}, ${entry.fallback})`
    cursor = range.end
  }
  return output + css.slice(cursor)
}

/** Read `--name: value` declarations from one CSS block body. */
export function readDeclarations(block: string): Map<string, string> {
  const declarations = new Map<string, string>()
  const pattern = /(--[\w-]+)\s*:\s*([^;]+);/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(block)) !== null) {
    const [, name, value] = match
    if (name !== undefined && value !== undefined) declarations.set(name, value.trim())
  }
  return declarations
}

/** Extract the body of the first rule whose selector matches exactly. */
export function readRule(css: string, selector: string): string | undefined {
  const index = css.indexOf(`${selector} {`)
  if (index < 0) return undefined
  const open = css.indexOf('{', index)
  let depth = 0
  for (let cursor = open; cursor < css.length; cursor += 1) {
    if (css[cursor] === '{') depth += 1
    else if (css[cursor] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, cursor)
    }
  }
  return undefined
}

/**
 * Extract every rule body whose selector matches exactly, in document order.
 * A palette splits one selector across blocks (static colors first, aliases
 * later), so callers must merge them with later blocks winning.
 */
export function readRules(css: string, selector: string): string[] {
  const bodies: string[] = []
  let searchFrom = 0
  for (;;) {
    const index = css.indexOf(`${selector} {`, searchFrom)
    if (index < 0) break
    const open = css.indexOf('{', index)
    let depth = 0
    let end = css.length
    for (let cursor = open; cursor < css.length; cursor += 1) {
      if (css[cursor] === '{') depth += 1
      else if (css[cursor] === '}') {
        depth -= 1
        if (depth === 0) {
          end = cursor
          break
        }
      }
    }
    bodies.push(css.slice(open + 1, end))
    searchFrom = end + 1
  }
  return bodies
}
