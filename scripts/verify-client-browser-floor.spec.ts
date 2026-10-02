import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CLIENT_FLOOR_APIS } from './client-browser-floor.ts'
import {
  collectApiViolations,
  collectArtifactViolations,
  collectBrowserArtifacts,
  collectDeniedApis,
  collectGrammarViolations,
  collectPayloads,
  FLOOR_DENIED_APIS,
  PAYLOAD_MIN_CHARACTERS,
} from './verify-client-browser-floor.ts'

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('fixture.js', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
}

function constructs(text: string): string[] {
  return collectGrammarViolations(parse(text)).map(violation => violation.construct)
}

function apiConstructs(text: string): string[] {
  return collectApiViolations(parse(text)).map(violation => violation.construct)
}

describe('client browser floor grammar', () => {
  it('accepts the syntax the floor parses', () => {
    expect(constructs([
      'class A { x = 1; static y = 2; #p = 3; get p() { return this.#p } }',
      'const a = { ...b }; a?.b ??= 1;',
      'const re = /a/d;',
      'async function f() { for await (const x of []) {} }',
      'const n = 1_000n;',
    ].join('\n'))).toEqual([])
  })

  it('rejects each construct the floor cannot parse', () => {
    expect(constructs('class A { static { this.x = 1 } }')).toEqual(['class static block'])
    expect(constructs('class A { #x = 1; static has(o) { return #x in o } }')).toEqual(['private brand check'])
    expect(constructs('using handle = open()')).toEqual(['using declaration'])
    expect(constructs('async function f() { await using handle = open() }')).toEqual(['using declaration'])
    expect(constructs("import data from './d.json' with { type: 'json' }")).toEqual(['import attributes'])
  })

  it('locates a violation on the line that carries it', () => {
    const [violation] = collectGrammarViolations(parse('const a = 1\nclass B { static {} }\n'))
    expect(violation?.construct).toBe('class static block')
    expect(violation?.position).toBe('const a = 1\nclass B { static {} }\n'.indexOf('static'))
  })
})

describe('client browser floor API calls', () => {
  it('reports a call to an API the floor lacks', () => {
    const violations = collectArtifactViolations('lib/client.js', 'const grouped = Object.groupBy(items, pick)\n')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.construct).toBe('call to Object.groupBy')
    expect(violations[0]?.line).toBe(1)
    expect(violations[0]?.inPayload).toBe(false)
  })

  it('reports an instance call the artifact does not type', () => {
    expect(apiConstructs('input.showPicker()\nview.setFromBase64(encoded)\n')).toEqual([
      'call to HTMLInputElement.prototype.showPicker',
      'call to Uint8Array.prototype.setFromBase64',
    ])
  })

  it('needs a call site, not a name', () => {
    expect(apiConstructs([
      '// Object.groupBy(items, pick)',
      'const named = "Object.groupBy"',
      'const held = Object.groupBy',
      'const picker = input.showPicker',
      'const text = "input.showPicker()"',
      'registry.groupBy(items, pick)',
      'accept(Object.groupBy)',
    ].join('\n'))).toEqual([])
  })

  it('accepts the APIs the shell installs', () => {
    expect(apiConstructs([
      'Object.hasOwn(target, "key")',
      'const copy = structuredClone(value)',
      'const sorted = values.toSorted()',
      'const { promise } = Promise.withResolvers()',
      'signal.throwIfAborted()',
    ].join('\n'))).toEqual([])
  })

  it('reports a payload that calls an API the floor lacks', () => {
    const payload = 'const grouped = Object.groupBy(items, pick)'.padEnd(PAYLOAD_MIN_CHARACTERS, ' ')
    const violations = collectArtifactViolations('lib/client.pdf.js', `const source = ${JSON.stringify(payload)};`)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.construct).toBe('call to Object.groupBy')
    expect(violations[0]?.inPayload).toBe(true)
  })
})

describe('client browser floor deny list', () => {
  it('reports every curated entry the installer leaves open', () => {
    expect(collectDeniedApis()).toEqual([...FLOOR_DENIED_APIS])
    expect(FLOOR_DENIED_APIS.length).toBeGreaterThan(0)
  })

  it('refuses a deny entry the installer covers', () => {
    // An installed name is skipped as a call site, so this entry could never
    // fire; the drift has to fail loudly instead of hiding the API.
    expect(() => collectDeniedApis(['Object.hasOwn'], CLIENT_FLOOR_APIS)).toThrow(/Object\.hasOwn/u)
  })

  it('refuses two entries that resolve to one receiver-agnostic call site', () => {
    // A String call and an Array call are one call site to a rule that cannot
    // see the receiver, so the installed member covers both.
    expect(() => collectDeniedApis(['String.prototype.at'], CLIENT_FLOOR_APIS)).toThrow(/Array\.prototype\.at/u)
  })

  it('refuses a deny list with nothing left to report', () => {
    expect(() => collectDeniedApis([], [])).toThrow(/nothing to report/u)
  })
})

describe('client browser floor payloads', () => {
  it('reads only literals long enough to be a payload', () => {
    const long = 'x'.repeat(PAYLOAD_MIN_CHARACTERS)
    expect(collectPayloads(parse(`const a = "${long}"; const b = "short";`))).toEqual([long])
  })

  it('reports a payload violation against the artifact that embeds it', () => {
    const payload = 'class A { static { this.x = 1 } }'.padEnd(PAYLOAD_MIN_CHARACTERS, ' ')
    const violations = collectArtifactViolations('lib/client.pdf.js', `const source = ${JSON.stringify(payload)};`)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.construct).toBe('class static block')
    expect(violations[0]?.inPayload).toBe(true)
    expect(violations[0]?.file).toBe('lib/client.pdf.js')
  })

  it('reports a violation in the artifact itself', () => {
    const violations = collectArtifactViolations('lib/client.js', 'class A { static {} }')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.inPayload).toBe(false)
    expect(violations[0]?.line).toBe(1)
  })
})

describe('client browser floor corpus', () => {
  it('finds the built browser artifacts the gate must judge', () => {
    const files = collectBrowserArtifacts(process.cwd())
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) expect(file).toMatch(/^[a-z].*\.js$/u)
  })
})
