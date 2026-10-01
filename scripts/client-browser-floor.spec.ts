/**
 * The client browser floor's stylesheet rewrites: which color-mix() forms
 * become static colors, what the appended definitions must resolve to, and the
 * static fallback every dynamic viewport unit gets. The corpus case pins the
 * property that matters in review — a client stylesheet's mixes must all be
 * resolvable, because the browser floor cannot compute one at runtime.
 */
import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_FLOOR_APIS, CLIENT_FLOOR_WORKER_APIS, CLIENT_FLOOR_WORKER_PREAMBLE, CLIENT_SCRIPT_TARGET,
  CLIENT_STYLE_TARGETS,
  downlevelClientCss, loadClientThemeTokens,
} from './client-browser-floor.ts'

const tokens = loadClientThemeTokens(process.cwd())

/** The appended definition block of a rewritten stylesheet. */
function definitions(css: string): string {
  const start = css.indexOf('\nbody { --dsh-mix-')
  return start === -1 ? '' : css.slice(start + 1)
}

describe('client stylesheet downleveling', () => {
  it('targets one Chromium release for scripts and styles', () => {
    expect(CLIENT_SCRIPT_TARGET).toBe('chrome90')
    expect(CLIENT_STYLE_TARGETS).toEqual({ chrome: 90 << 16 })
  })

  it('leaves a stylesheet without floor-only features untouched', () => {
    const css = '.a { color: red; }\n@media (min-width: 10px) { .b { color: blue } }\n'
    expect(downlevelClientCss(css, tokens)).toBe(css)
  })

  it('resolves a mix of a theme token and transparent into that token at the alpha', () => {
    const css = '.a { background: color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent); }'
    const lowered = downlevelClientCss(css, tokens)
    expect(lowered.startsWith('.a { background: var(--dsh-mix-')).toBe(true)
    expect(definitions(lowered)).toContain('--dsh-mix-')
    expect(definitions(lowered)).toContain('rgba(59, 130, 246, 0.4)')
    // One literal serves both themes when the token does not vary.
    expect(definitions(lowered)).not.toContain('body[data-ds-dark-theme]')
    expect(definitions(lowered)).toContain('@supports (color: color-mix(in srgb, red, blue))')
    expect(definitions(lowered)).toContain('color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent)')
  })

  it('gives each theme its own literal for a themed token', () => {
    const css = '.a { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }'
    const block = definitions(downlevelClientCss(css, tokens))
    const light = block.slice(0, block.indexOf('body[data-ds-dark-theme]'))
    const dark = block.slice(block.indexOf('body[data-ds-dark-theme]'))
    expect(light).toContain('rgba(236, 19, 19, 0.12)')
    expect(dark).toContain('rgba(242, 90, 90, 0.12)')
  })

  it('mixes two resolved colors in sRGB', () => {
    const css = '.a { color: color-mix(in srgb, #ff0000 30%, #0000ff); }'
    expect(definitions(downlevelClientCss(css, tokens))).toContain('rgb(77, 0, 179)')
    const even = '.a { color: color-mix(in srgb, #ff0000 80%, #0000ff 80%); }'
    expect(definitions(downlevelClientCss(even, tokens))).toContain('rgb(128, 0, 128)')
    const weighted = '.a { color: color-mix(in srgb, rgba(255, 0, 0, 0.5) 50%, transparent); }'
    expect(definitions(downlevelClientCss(weighted, tokens))).toContain('rgba(255, 0, 0, 0.25)')
    const percent = '.a { color: color-mix(in srgb, rgb(100% 0% 0%) 50%, rgb(0, 0, 255)); }'
    expect(definitions(downlevelClientCss(percent, tokens))).toContain('rgb(128, 0, 128)')
    const named = '.a { color: color-mix(in srgb, #000000, white 18%); }'
    expect(definitions(downlevelClientCss(named, tokens))).toContain('rgb(46, 46, 46)')
    const alpha = '.a { color: color-mix(in srgb, #00000080 50%, #ffffff80); }'
    expect(definitions(downlevelClientCss(alpha, tokens))).toContain('rgba(128, 128, 128, 0.502)')
  })

  it('resolves a nested mix and one naming the stylesheet own property', () => {
    const nested = '.a { color: color-mix(in srgb, color-mix(in srgb, #ff0000 50%, transparent) 50%, #0000ff); }'
    expect(definitions(downlevelClientCss(nested, tokens))).toContain('rgba(85, 0, 170, 0.75)')
    const local = [
      '.a { --own-color: color-mix(in srgb, #ff0000 60%, #0000ff); }',
      '.b { color: color-mix(in srgb, var(--own-color) 50%, transparent); }',
    ].join('\n')
    expect(downlevelClientCss(local, tokens)).toContain('rgba(153, 0, 102, 0.5)')
  })

  it('leaves mixes it cannot resolve as written', () => {
    const unknown = '.a { color: color-mix(in srgb, var(--not-a-token) 10%, transparent); }'
    expect(downlevelClientCss(unknown, tokens)).toBe(unknown)
    const otherSpace = '.a { color: color-mix(in oklab, #ff0000 10%, transparent); }'
    expect(downlevelClientCss(otherSpace, tokens)).toBe(otherSpace)
    const currentColor = '.a { color: color-mix(in srgb, currentColor 10%, transparent); }'
    expect(downlevelClientCss(currentColor, tokens)).toBe(currentColor)
    const cyclic = [
      '.a { --x: var(--y); --y: var(--x); }',
      '.b { color: color-mix(in srgb, var(--x) 10%, transparent); }',
    ].join('\n')
    expect(downlevelClientCss(cyclic, tokens)).toBe(cyclic)
    const ambiguous = [
      '.a { --own: #ff0000; }',
      '.b { --own: #0000ff; }',
      '.c { color: color-mix(in srgb, var(--own) 50%, transparent); }',
    ].join('\n')
    expect(downlevelClientCss(ambiguous, tokens)).toBe(ambiguous)
  })

  it('never rewrites prose', () => {
    const css = '/* color-mix(in srgb, var(--not-a-token) 10%, transparent) */\n.a { color: red; }'
    expect(downlevelClientCss(css, tokens)).toBe(css)
  })

  it('gives each dynamic viewport unit a static fallback', () => {
    const css = '.a { height: 100dvh; width: 40svw; max-height: 10lvh; color: red }\n.b { min-height: calc(100dvh - 8px); }'
    const lowered = downlevelClientCss(css, tokens)
    expect(lowered).toContain('height: 100vh; height: 100dvh;')
    expect(lowered).toContain('width: 40vw; width: 40svw;')
    expect(lowered).toContain('max-height: 10vh; max-height: 10lvh;')
    // A declaration closing its block keeps that shape.
    expect(lowered).toContain('color: red }')
    expect(lowered).toContain('min-height: calc(100vh - 8px); min-height: calc(100dvh - 8px);')
  })

  it('resolves every color-mix in the client corpus', () => {
    const unresolved = new Set<string>()
    for (const file of globSync('packages/client/**/*.css', { cwd: process.cwd() })) {
      const source = readFileSync(file, 'utf8')
      const lowered = downlevelClientCss(source, tokens)
      const start = lowered.indexOf('\nbody { --dsh-mix-')
      const rendered = start === -1 ? lowered : lowered.slice(0, start)
      for (const match of rendered.matchAll(/color-mix\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g)) {
        unresolved.add(match[0].replace(/\s+/g, ' '))
      }
    }
    expect([...unresolved]).toEqual([])
  })
})

describe('shell install contract', () => {
  it('installs exactly the APIs the floor declares', () => {
    // The shell's installer owns the implementations and this module owns the
    // contract; a name added on one side alone is a silent gap in the other.
    const source = readFileSync('packages/client/web/src/compat.ts', 'utf8')
    const installed = [...source.matchAll(/installedApis\.push\('([^']+)'\)/gu)].map(match => match[1])
    expect([...installed].sort()).toEqual([...CLIENT_FLOOR_APIS].sort())
  })
})

describe('worker realm install', () => {
  it('promises only APIs the shell contract lists', () => {
    expect([...CLIENT_FLOOR_WORKER_APIS].filter(api => !CLIENT_FLOOR_APIS.includes(api))).toEqual([])
    // structuredClone is the one entry no shipped payload calls, and its copy
    // semantics do not belong in an injected preamble.
    expect([...CLIENT_FLOOR_APIS].filter(api => !CLIENT_FLOOR_WORKER_APIS.includes(api))).toEqual(['structuredClone'])
  })

  it('installs every declared worker API by name', () => {
    const installed = CLIENT_FLOOR_WORKER_PREAMBLE
    for (const api of CLIENT_FLOOR_WORKER_APIS) {
      const member = api.split('.').at(-1)
      expect(member).toBeDefined()
      // A global is installed through defineProperty, a static through define().
      expect(api.includes('.') ? installed : installed).toContain(api.includes('.') ? `'${String(member)}'` : String(member))
    }
  })

  it('stays feature-detected so a modern realm keeps its native members', () => {
    expect(CLIENT_FLOOR_WORKER_PREAMBLE).toContain('if (target[name] === undefined)')
    for (const api of CLIENT_FLOOR_WORKER_APIS) {
      expect(CLIENT_FLOOR_WORKER_PREAMBLE).not.toContain(`${api} = `)
    }
  })
})
