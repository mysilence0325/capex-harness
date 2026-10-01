/** Source check for the trigger's collapse rule, owned by the title row's marker. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const actionCss = readFileSync(fileURLToPath(new URL(
  '../src/client/TeamAction.module.css',
  import.meta.url,
)), 'utf8')

describe('TeamAction trigger styles', () => {
  it('collapses the trigger label on the title row\'s tight marker instead of a container query', () => {
    // Chromium 90 has no container queries (chrome 105). TeamAction still reads
    // the collapsed state off the computed display this rule produces.
    expect(actionCss).toMatch(/\[data-tight\]\s*\.triggerLabel\s*\{\s*display:\s*none;\s*\}/)
    expect(actionCss).not.toContain('@container')
  })
})
