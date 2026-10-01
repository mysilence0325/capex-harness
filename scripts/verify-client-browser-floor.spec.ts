import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  collectArtifactViolations,
  collectBrowserArtifacts,
  collectGrammarViolations,
  collectPayloads,
  PAYLOAD_MIN_CHARACTERS,
} from './verify-client-browser-floor.ts'

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('fixture.js', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
}

function constructs(text: string): string[] {
  return collectGrammarViolations(parse(text)).map(violation => violation.construct)
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
