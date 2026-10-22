/** Compatibility tooling: palette evaluation, artifact audit, and vendored CSS scoping. */
import { describe, expect, it } from 'vitest'
import {
  evaluateColorMix, findColorMix, formatColor, readDeclarations, readRules, resolveVariables, rewriteColorMix, tokenNameFor,
} from '../color-mix.ts'
import { auditText, firstUnhandledHard, renderReport } from '../audit-chromium.ts'
import { RULES, rulesNewerThanBaseline } from '../features.ts'

const palette = new Map([
  ['--green', 'rgb(34, 197, 94)'],
  ['--ink', 'rgb(15, 17, 21)'],
  ['--paper', 'var(--ink)'],
])

describe('color-mix evaluation', () => {
  it('mixes a palette color with transparency into an rgba result', () => {
    const color = evaluateColorMix('color-mix(in srgb, var(--green) 10%, transparent)', palette)
    expect(color && formatColor(color)).toBe('rgba(34, 197, 94, 0.1)')
  })

  it('follows a var() chain and a two-color blend', () => {
    expect(resolveVariables('var(--paper)', palette)).toBe('rgb(15, 17, 21)')
    const color = evaluateColorMix('color-mix(in srgb, var(--paper) 50%, white)', palette)
    expect(color && formatColor(color)).toBe('rgb(135, 136, 138)')
  })

  it('evaluates a nested mix against the same palette', () => {
    const color = evaluateColorMix(
      'color-mix(in srgb, color-mix(in srgb, var(--green) 50%, white) 50%, black)',
      palette,
    )
    expect(color && formatColor(color)).toBe('rgb(72, 113, 87)')
  })

  it('returns undefined when an operand is not a known color', () => {
    expect(evaluateColorMix('color-mix(in srgb, var(--missing) 10%, transparent)', palette)).toBeUndefined()
    expect(evaluateColorMix('color-mix(in oklab, var(--green) 10%, transparent)', palette)).toBeUndefined()
  })

  it('rewrites every occurrence, ignoring spacing differences', () => {
    const table = new Map([['color-mix(in srgb, var(--green) 10%, transparent)', { token: '--mix-green-10', fallback: 'rgba(34, 197, 94, 0.1)' }]])
    const css = '.a{background:color-mix(in srgb,var(--green)   10%,transparent)}.b{border-color:color-mix(in srgb, var(--green) 10%, transparent)}'
    expect(rewriteColorMix(css, table)).toBe('.a{background:var(--mix-green-10, rgba(34, 197, 94, 0.1))}.b{border-color:var(--mix-green-10, rgba(34, 197, 94, 0.1))}')
  })

  it('finds nested expressions innermost-last and names them stably', () => {
    const found = findColorMix('color-mix(in srgb, color-mix(in srgb, var(--green) 50%, white) 50%, black)')
    expect(found).toHaveLength(2)
    expect(tokenNameFor('color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)'))
      .toBe('--dsw-mix-in-srgb-alias-state-success-primary-10-transparent')
  })

  it('merges palette rules declared in several blocks, later ones winning', () => {
    const css = 'body { --a: rgb(1, 2, 3); }\nbody[data-ds-dark-theme] { --a: rgb(9, 9, 9); }\nbody { --b: red; }'
    const light = new Map(readRules(css, 'body').flatMap(body => [...readDeclarations(body)]))
    expect(light.get('--a')).toBe('rgb(1, 2, 3)')
    expect(light.get('--b')).toBe('red')
    expect([...readRules(css, 'body[data-ds-dark-theme]')]).toHaveLength(1)
  })
})

describe('artifact audit', () => {
  const baseline = rulesNewerThanBaseline(102)

  it('flags a hard feature and reports its baseline gap', () => {
    const hits = auditText('const ok = URL.canParse(location.href)', baseline)
    const hit = hits.find(entry => entry.id === 'url-can-parse')
    expect(hit?.severity).toBe('hard')
    expect(hit?.minChrome).toBe(120)
    expect(hit?.status).toBe('shimmed')
  })

  it('treats a dvh declaration as mitigated once the vh fallback ships', () => {
    const withFallback = auditText('.a{max-height:calc(100vh - 4px);max-height:calc(100dvh - 4px)}', baseline)
    expect(withFallback.find(entry => entry.id === 'dynamic-viewport-units')?.status).toBe('mitigated')
    const withoutFallback = auditText('.a{max-height:calc(100dvh - 4px)}', baseline)
    expect(withoutFallback.find(entry => entry.id === 'dynamic-viewport-units')?.status).toBe('unhandled')
  })

  it('scopes an accepted vendor hit to its artifact', () => {
    const vendor = auditText('x.style.backgroundColor = "color-mix(in srgb, red 30%, white)"', baseline, 'ui-sidebar-documentpreview/lib/client.pdf.js')
    expect(vendor.find(entry => entry.id === 'color-mix')?.status).toBe('accepted')
  })

  it('reports the first unhandled hard hit and renders it in the summary', () => {
    const rules = RULES.filter(rule => rule.id === 'dialog-request-close')
    const hits = auditText('dialog.requestClose()', rules)
    const report = {
      baseline: 102,
      artifacts: 1,
      files: [{ file: 'x.js', hits }],
      totals: { hard: 1, visual: 0, cosmetic: 0, unhandled: 1, shimmed: 0, accepted: 0, mitigated: 0 },
    }
    expect(firstUnhandledHard(report)?.id).toBe('dialog-request-close')
    expect(renderReport(report)).toContain('| hard | 1 | 1 |')
  })
})

