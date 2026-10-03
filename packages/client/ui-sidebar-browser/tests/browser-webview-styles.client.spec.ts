/**
 * The webview's gesture rule as stylesheet text. jsdom has no native guest view,
 * so this pins the selector that cancels guest pointer input: it reads the
 * document mark ui-dockkit publishes while a drag holds the pointer, because
 * Chromium 90 drops :has() over the gesture's own element marker.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/view/Browser.module.css', import.meta.url)), 'utf8')

describe('Browser.module.css webview', () => {
  it('cancels guest pointer input for the whole docking gesture', () => {
    const rule = /:global\(html\[data-dockkit-pointer-active\]\)\s*\.webview\s*\{([^}]*)\}/.exec(css)
    expect(rule?.[1]).toContain('pointer-events: none')
  })
})
