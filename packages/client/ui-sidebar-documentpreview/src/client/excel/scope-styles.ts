/**
 * Confine a vendor stylesheet to one preview root with explicit selectors.
 *
 * A scoped at-rule would express this directly, but Chromium 102 discards a
 * scoped block wholesale, leaving the workbook unstyled. The vendor sheet is
 * class rules only, so every selector list is rewritten to match the root or a
 * descendant; block at-rules recurse, and named at-rules stay whole.
 * @module @deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/excel/scope-styles
 */

/** At-rules whose body holds ordinary rules and may be scoped recursively. */
const NESTED_AT_RULES = /^@(media|supports|layer|container)\b/

/**
 * Prefix every rule of a stylesheet with one root selector.
 * @param root - selector of the element that owns the preview.
 * @param css - vendor stylesheet text.
 * @returns stylesheet whose rules only match inside `root`.
 */
export function scopeStyles(root: string, css: string): string {
  return scopeBlock(root, css.replaceAll(/\/\*[\s\S]*?\*\//g, ''))
}

function scopeBlock(root: string, source: string): string {
  const parts: string[] = []
  let depth = 0
  let headerStart = 0
  let bodyStart = 0
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') {
      if (depth === 0) {
        const header = source.slice(headerStart, index).trim()
        bodyStart = index
        if (header.length > 0 && !header.startsWith('@')) {
          const scoped = header.split(',').map((selector) => {
            const trimmed = selector.trim()
            return `${root} ${trimmed}, ${root}${trimmed}`
          })
          parts.push(`${scoped.join(', ')} `)
        } else if (header.length > 0 && !NESTED_AT_RULES.test(header)) {
          // Keyframes and font faces define names, not matches: keep them whole.
          parts.push(`${header} `)
        }
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const body = source.slice(bodyStart, index + 1)
        const header = source.slice(headerStart, bodyStart).trim()
        if (header.length > 0 && NESTED_AT_RULES.test(header)) {
          const open = body.indexOf('{')
          parts.push(`${header} {${scopeBlock(root, body.slice(open + 1, -1))}}`)
        } else {
          parts.push(body)
        }
        headerStart = index + 1
      }
    }
  }
  parts.push(source.slice(headerStart))
  return parts.join('')
}
