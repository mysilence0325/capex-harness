/** Source check for the header label's collapse rule, owned by the title row's marker. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const labelCss = readFileSync(fileURLToPath(new URL(
  '../src/client/AgentPresetLabel.module.css',
  import.meta.url,
)), 'utf8')

describe('agent-preset header label styles', () => {
  it('collapses on the title row\'s narrow marker instead of a container query', () => {
    // Chromium 90 has no container queries (chrome 105), so the rule selects the
    // attribute the conversation title row publishes at 540px.
    expect(labelCss).toMatch(/\[data-narrow\]\s*\.label\s*\{\s*display:\s*none;\s*\}/)
    expect(labelCss).not.toContain('@container')
  })
})
