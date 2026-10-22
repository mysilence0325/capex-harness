/** Vendor stylesheets are scoped with explicit selectors, not a scoped at-rule. */
import { describe, expect, it } from 'vitest'
import { scopeStyles } from '../src/client/excel/scope-styles.ts'

describe('vendored stylesheet scoping', () => {
  it('prefixes every selector with the preview root', () => {
    expect(scopeStyles('[data-excel-preview]', '.a,.b{x:1}'))
      .toBe('[data-excel-preview] .a, [data-excel-preview].a, [data-excel-preview] .b, [data-excel-preview].b {x:1}')
  })

  it('recurses into block at-rules and keeps named at-rules whole', () => {
    expect(scopeStyles('[data-x]', '@media (max-width:600px){.a{x:1}}'))
      .toBe('@media (max-width:600px) {[data-x] .a, [data-x].a {x:1}}')
    expect(scopeStyles('[data-x]', '@keyframes k{from{a:1}to{a:2}}'))
      .toBe('@keyframes k {from{a:1}to{a:2}}')
  })

  it('strips comments before scoping', () => {
    expect(scopeStyles('[data-x]', '/* note */ .a{x:1}')).toBe('[data-x] .a, [data-x].a {x:1}')
  })
})
