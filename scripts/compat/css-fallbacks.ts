/**
 * Downgrade the two stylesheet features Chromium 102 cannot express, at the
 * point where each plugin's CSS is compiled.
 *
 * Container queries are rewritten to the equivalent viewport media query: every
 * affected surface is a pane whose width tracks the window, so the breakpoint
 * still lands, and the rule stops being discarded wholesale.
 *
 * `scrollbar-width: none` hides a scrollbar that the shell would otherwise
 * paint; each rule that declares it gains the `::-webkit-scrollbar` sibling
 * that Chromium 102 does honour.
 * @module scripts/compat/css-fallbacks
 */

/** At-rules whose body holds ordinary rules. */
const NESTED_AT_RULES = /^@(media|supports|layer)\b/

/** Rewrite `@container (max-width: N)` and its named form to a media query. */
export function rewriteContainerQueries(css: string): string {
  return css.replaceAll(
    /@container\s+(?:[\w-]+\s+)?\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g,
    '@media (max-width: $1px)',
  )
}

/** Whether one declaration block hides the scrollbar through the new property. */
function hidesScrollbar(body: string): boolean {
  return /scrollbar-width\s*:\s*none/.test(body)
}

/**
 * Append the prefixed scrollbar rules that Chromium 102 understands.
 * @param css - stylesheet text.
 * @returns the stylesheet with one `::-webkit-scrollbar` sibling per hidden bar.
 */
export function addScrollbarFallbacks(css: string): string {
  return walkRules(css)
}

function walkRules(source: string): string {
  const parts: string[] = []
  let depth = 0
  let headerStart = 0
  let bodyStart = 0
  let header = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') {
      if (depth === 0) {
        header = source.slice(headerStart, index).trim()
        bodyStart = index
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const body = source.slice(bodyStart, index + 1)
        if (header.length === 0) {
          parts.push(body)
        } else if (NESTED_AT_RULES.test(header)) {
          const open = body.indexOf('{')
          parts.push(`${header} {${walkRules(body.slice(open + 1, -1))}}`)
        } else {
          parts.push(`${header} ${body}`)
          if (!header.startsWith('@') && hidesScrollbar(body)) {
            const selectors = header.split(',').map(selector => selector.trim()).filter(selector => selector.length > 0)
            parts.push(selectors.map(selector => `${selector}::-webkit-scrollbar{display:none}`).join(''))
          }
        }
        headerStart = index + 1
        header = ''
      }
    }
  }
  parts.push(source.slice(headerStart))
  return parts.join('')
}
