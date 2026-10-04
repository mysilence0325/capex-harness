/**
 * The browser floor installs exactly the APIs Chromium 90 lacks, and only
 * those: every engine that already has an API keeps its own, and a second
 * install pass is a no-op. The spec removes the APIs from the realm to run the
 * install branch, then drives the installed implementations through the
 * behavior the client relies on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as Compat from '../src/compat.ts'

/** API names the floor installs when the engine lacks them, in install order. */
const FLOOR = [
  'Object.hasOwn',
  'Array.prototype.at',
  'Array.prototype.findLast',
  'Array.prototype.findLastIndex',
  'Array.prototype.toSorted',
  'Array.prototype.toReversed',
  'Promise.withResolvers',
  'structuredClone',
  'AbortSignal.any',
  'AbortSignal.timeout',
  'AbortSignal.prototype.throwIfAborted',
  'Iterator',
  'Promise.try',
  'URL.parse',
  'Uint8Array.fromBase64',
  'Uint8Array.prototype.toHex',
  'Uint8Array.prototype.toBase64',
  'Map.prototype.getOrInsert',
  'Map.prototype.getOrInsertComputed',
  'WeakMap.prototype.getOrInsert',
  'WeakMap.prototype.getOrInsertComputed',
  'Math.sumPrecise',
  'Set.prototype.intersection',
  'Blob.prototype.bytes',
  'ArrayBuffer.prototype.transferToFixedLength',
  'RegExp.escape',
  'Response.prototype.bytes',
]

/** `RegExp.escape` as the floor installs it, read at call time. */
const regexp = RegExp as { escape?: (value: string) => string }

/** `AbortSignal.prototype.throwIfAborted` as the floor installs it, read at call time. */
const abortCheck = AbortSignal.prototype as { throwIfAborted?: () => void }

/** `Response.prototype.bytes` as the floor installs it, read at call time. */
const responseBytes = Response.prototype as { bytes?: () => Promise<Uint8Array> }

/** `Uint8Array.prototype.toHex` as the floor installs it, read at call time. */
const uint8ArrayHex = Uint8Array.prototype as { toHex?: (this: Uint8Array) => string }

/** `Uint8Array.prototype.toBase64` as the floor installs it, read at call time. */
const uint8ArrayBase64 = Uint8Array.prototype as { toBase64?: (this: Uint8Array, options?: unknown) => string }

/** The Map upserts as the floor installs them, read at call time. */
const mapUpserts = Map.prototype as {
  getOrInsert?: <K, V>(this: Map<K, V>, key: K, value: V) => V
  getOrInsertComputed?: <K, V>(this: Map<K, V>, key: K, callback: (key: K) => V) => V
}

/** The WeakMap upserts as the floor installs them, read at call time. */
const weakMapUpserts = WeakMap.prototype as {
  getOrInsert?: <K extends WeakKey, V>(this: WeakMap<K, V>, key: K, value: V) => V
  getOrInsertComputed?: <K extends WeakKey, V>(this: WeakMap<K, V>, key: K, callback: (key: K) => V) => V
}

/** `Math.sumPrecise` as the floor installs it, read at call time. */
const mathSumPrecise = Math as { sumPrecise?: (values: Iterable<unknown>) => number }

/** `Set.prototype.intersection` as the floor installs it, read at call time. */
const setIntersection = Set.prototype as { intersection?: <T>(this: Set<T>, other: ReadonlySet<T>) => Set<T> }

/** `Blob.prototype.bytes` as the floor installs it, read at call time. */
const blobBytes = Blob.prototype as { bytes?: () => Promise<Uint8Array> }

/** `ArrayBuffer.prototype.transferToFixedLength` as the floor installs it, read at call time. */
const transferToFixedLength = ArrayBuffer.prototype as { transferToFixedLength?: (newLength?: number) => ArrayBuffer }

/** Undo one removal of a realm API. */
type Restoration = () => void

/**
 * Delete an own property and return its restoration.
 * @param owner - object carrying the property.
 * @param key - property name.
 * @returns the restore callback, a no-op when the property was absent.
 */
function without(owner: object, key: string): Restoration {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  Reflect.deleteProperty(owner, key)
  return () => {
    if (descriptor !== undefined) Object.defineProperty(owner, key, descriptor)
  }
}

/**
 * Define a stand-in for a floor API the test realm itself lacks.
 * @param owner - object carrying the property.
 * @param key - property name.
 * @param value - stand-in value.
 * @returns the removal of that stand-in.
 */
function withNative(owner: object, key: string, value: unknown): Restoration {
  Object.defineProperty(owner, key, { value, writable: true, configurable: true })
  return () => { Reflect.deleteProperty(owner, key) }
}

/**
 * Load a module instance whose install flag is unset, as a fresh page load has.
 * @returns the module under test.
 */
async function freshCompat(): Promise<typeof Compat> {
  vi.resetModules()
  return await import('../src/compat.ts')
}

describe('browser compatibility floor', () => {
  const restorations: Restoration[] = []

  beforeAll(async () => {
    // The test realm can trail the engines the client ships to: stand in for
    // every floor API this Node release lacks, so a complete engine still
    // installs nothing.
    restorations.push(
      withNative(Promise, 'try', (callback: () => unknown) => Promise.resolve(callback())),
      withNative(Uint8Array, 'fromBase64', () => new Uint8Array()),
      withNative(Uint8Array.prototype, 'toHex', () => ''),
      withNative(Uint8Array.prototype, 'toBase64', () => ''),
      withNative(Map.prototype, 'getOrInsert', () => undefined),
      withNative(Map.prototype, 'getOrInsertComputed', () => undefined),
      withNative(WeakMap.prototype, 'getOrInsert', () => undefined),
      withNative(WeakMap.prototype, 'getOrInsertComputed', () => undefined),
      withNative(Math, 'sumPrecise', () => 0),
      withNative(RegExp, 'escape', (value: string) => value),
    )
    // An engine that ships every API: the floor installs nothing.
    const complete = await freshCompat()
    expect(complete.installBrowserCompat()).toEqual([])
    expect(complete.installBrowserCompat()).toEqual([])

    restorations.push(
      without(Object, 'hasOwn'),
      without(Array.prototype, 'at'),
      without(Array.prototype, 'findLast'),
      without(Array.prototype, 'findLastIndex'),
      without(Array.prototype, 'toSorted'),
      without(Array.prototype, 'toReversed'),
      without(Promise, 'withResolvers'),
      without(globalThis, 'structuredClone'),
      without(AbortSignal, 'any'),
      without(AbortSignal, 'timeout'),
      without(AbortSignal.prototype, 'throwIfAborted'),
      without(globalThis, 'Iterator'),
      without(Promise, 'try'),
      without(URL, 'parse'),
      without(Uint8Array, 'fromBase64'),
      without(Uint8Array.prototype, 'toHex'),
      without(Uint8Array.prototype, 'toBase64'),
      without(Map.prototype, 'getOrInsert'),
      without(Map.prototype, 'getOrInsertComputed'),
      without(WeakMap.prototype, 'getOrInsert'),
      without(WeakMap.prototype, 'getOrInsertComputed'),
      without(Math, 'sumPrecise'),
      without(Set.prototype, 'intersection'),
      without(Blob.prototype, 'bytes'),
      without(ArrayBuffer.prototype, 'transferToFixedLength'),
      without(RegExp, 'escape'),
      without(Response.prototype, 'bytes'),
    )
    // An engine that lacks them: the floor installs each one once. Loading the
    // side-effect entry afterwards covers the shell's own import path.
    const missing = await freshCompat()
    expect(missing.installBrowserCompat()).toEqual(FLOOR)
    expect(missing.installBrowserCompat()).toEqual([])
    await import('../src/compat-install.ts')
  })

  afterAll(() => {
    for (const restore of restorations.reverse()) restore()
  })

  it('answers own-property questions without Object.prototype', () => {
    class Holder { inherited = 1 }
    expect(Object.hasOwn({ present: 1 }, 'present')).toBe(true)
    expect(Object.hasOwn(new Holder(), 'inherited')).toBe(true)
    expect(Object.hasOwn({}, 'toString')).toBe(false)
  })

  it('reads array members from either end', () => {
    expect([1, 2, 3].at(0)).toBe(1)
    expect([1, 2, 3].at(-1)).toBe(3)
    expect([1, 2, 3].at(3)).toBeUndefined()
    expect([1, 2, 3].at(-4)).toBeUndefined()
    expect([1, 2, 3].at(1.7)).toBe(2)
    const empty: number[] = []
    expect(empty.at(0)).toBeUndefined()
  })

  it('searches from the end', () => {
    const values = [1, 2, 3, 2]
    expect(values.findLast(value => value === 2)).toBe(2)
    expect(values.findLast(value => value === 9)).toBeUndefined()
    expect(values.findLastIndex(value => value === 2)).toBe(3)
    expect(values.findLastIndex(value => value === 9)).toBe(-1)
    const owner = { floor: 2 }
    expect(values.findLast(function (this: { floor: number }, value) {
      return value === this.floor
    }, owner)).toBe(2)
    expect(values.findLastIndex(function (this: { floor: number }, value) {
      return value === this.floor
    }, owner)).toBe(3)
    const nothing: number[] = []
    expect(nothing.findLast(value => value === 42)).toBeUndefined()
  })

  it('sorts and reverses into a copy', () => {
    const values = [3, 1, 2]
    expect(values.toSorted()).toEqual([1, 2, 3])
    expect(values.toSorted((left, right) => right - left)).toEqual([3, 2, 1])
    expect(values.toReversed()).toEqual([2, 1, 3])
    expect(values).toEqual([3, 1, 2])
  })

  it('exposes a promise with its settlement functions', async () => {
    const settled = Promise.withResolvers<string>()
    expect(settled.promise).toBeInstanceOf(Promise)
    settled.resolve('done')
    await expect(settled.promise).resolves.toBe('done')
    const failed = Promise.withResolvers<string>()
    failed.reject(new Error('refused'))
    await expect(failed.promise).rejects.toThrow('refused')
  })

  it('clones the values the client passes through structuredClone', () => {
    expect(structuredClone(7)).toBe(7)
    expect(structuredClone(null)).toBeNull()
    const source = { text: 'a', nested: { list: [1, 2] }, when: new Date(0), pattern: /a/giu }
    const copy = structuredClone(source)
    expect(copy).toEqual(source)
    expect(copy).not.toBe(source)
    expect(copy.nested).not.toBe(source.nested)
    expect(copy.when).not.toBe(source.when)
    expect(copy.pattern.source).toBe(source.pattern.source)

    const map = structuredClone(new Map([['key', { deep: true }]]))
    expect(map.get('key')).toEqual({ deep: true })
    const set = structuredClone(new Set([1, 2]))
    expect([...set]).toEqual([1, 2])
    const bytes = structuredClone(new Uint8Array([1, 2, 3]).buffer)
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3])
    expect([...structuredClone(new Uint8Array([4, 5]))]).toEqual([4, 5])
    const view = structuredClone(new DataView(new Uint8Array([6, 7]).buffer))
    expect(view.byteLength).toBe(2)
    const blob = structuredClone(new Blob(['body'], { type: 'text/plain' }))
    expect(blob.type).toBe('text/plain')
    expect(blob.size).toBe(4)

    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const clonedCycle = structuredClone(cyclic)
    expect(clonedCycle.self).toBe(clonedCycle)
  })

  it('refuses the values structuredClone cannot carry', () => {
    expect(() => structuredClone(() => undefined)).toThrow(expect.objectContaining({ name: 'DataCloneError' }))
    expect(() => structuredClone(Symbol('x'))).toThrow(expect.objectContaining({ name: 'DataCloneError' }))
  })

  it('combines abort signals', async () => {
    const first = new AbortController()
    const second = new AbortController()
    const combined = AbortSignal.any([first.signal, second.signal])
    expect(combined.aborted).toBe(false)
    expect(AbortSignal.any([]).aborted).toBe(false)
    first.abort(new Error('stop'))
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toEqual(new Error('stop'))
    second.abort()
    expect(second.signal.aborted).toBe(true)

    const already = new AbortController()
    already.abort()
    const immediate = AbortSignal.any([already.signal, new AbortController().signal])
    expect(immediate.aborted).toBe(true)
  })

  it('reports an abort at the point a cancellation is checked', () => {
    const pending = new AbortController()
    expect(() => { pending.signal.throwIfAborted() }).not.toThrow()
    pending.abort(new Error('cancelled'))
    expect(() => { pending.signal.throwIfAborted() }).toThrow('cancelled')
    const bare = new AbortController()
    bare.abort()
    expect(() => { bare.signal.throwIfAborted() }).toThrow(expect.objectContaining({ name: 'AbortError' }))
    // Chromium 90 aborts carry no reason, and that arm answers with the
    // specification AbortError too.
    expect(() => abortCheck.throwIfAborted?.call({ aborted: true }))
      .toThrow(expect.objectContaining({ name: 'AbortError' }))
  })

  it('times out on its own deadline', async () => {
    const signal = AbortSignal.timeout(1)
    expect(signal.aborted).toBe(false)
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() })
    })
    expect(signal.aborted).toBe(true)
    expect((signal.reason as DOMException).name).toBe('TimeoutError')
  })
  it('names the shared iterator prototype third-party code patches', () => {
    // pdf.js writes Iterator.prototype.join before it checks anything else.
    const iteratorGlobal = (globalThis as { Iterator?: { prototype: object } }).Iterator
    expect(iteratorGlobal).toBeDefined()
    const inner = Reflect.getPrototypeOf([][Symbol.iterator]())
    const shared = inner === null ? null : Reflect.getPrototypeOf(inner)
    expect(iteratorGlobal?.prototype).toBe(shared)
    interface Patched { describe?: () => string }
    const patched = shared as Patched
    patched.describe = () => 'ok'
    expect((Reflect.getPrototypeOf([1, 2][Symbol.iterator]()) as Patched).describe?.()).toBe('ok')
  })

  it('runs a callback through Promise.try', async () => {
    const promiseTry = Promise as { try?: <T>(callback: () => T) => Promise<T> }
    await expect(promiseTry.try?.(() => 2)).resolves.toBe(2)
    await expect(promiseTry.try?.(() => { throw new Error('boom') })).rejects.toThrow('boom')
  })

  it('parses a URL without throwing on invalid input', () => {
    const urlParse = URL as { parse?: (value: string, base?: string) => URL | null }
    expect(urlParse.parse?.('https://example.com/a')?.pathname).toBe('/a')
    expect(urlParse.parse?.('/a', 'https://example.com')?.href).toBe('https://example.com/a')
    expect(urlParse.parse?.('http://')).toBeNull()
  })

  it('rethrows the error a URL parse cannot read as a rejected address', () => {
    const urlParse = URL as { parse?: (value: unknown, base?: unknown) => URL | null }
    const unreadable = { toString: () => { throw new Error('unreadable address') } }
    expect(() => urlParse.parse?.(unreadable)).toThrow('unreadable address')
  })

  it('decodes base64 bytes', () => {
    const fromBase64 = Uint8Array as { fromBase64?: (value: string) => Uint8Array }
    expect([...(fromBase64.fromBase64?.('AQID') ?? new Uint8Array())]).toEqual([1, 2, 3])
    expect(fromBase64.fromBase64?.('')?.length).toBe(0)
  })

  it('encodes the receiver bytes as lower-case hex', () => {
    expect(uint8ArrayHex.toHex?.call(new Uint8Array([0, 15, 255]))).toBe('000fff')
    expect(uint8ArrayHex.toHex?.call(new Uint8Array([222, 173, 190, 239]))).toBe('deadbeef')
    expect(uint8ArrayHex.toHex?.call(new Uint8Array([171]))).toBe('ab')
    expect(uint8ArrayHex.toHex?.call(new Uint8Array())).toBe('')
  })

  it('encodes the receiver bytes as base64', () => {
    const encode = (bytes: readonly number[], options?: unknown): string | undefined => {
      const toBase64 = uint8ArrayBase64.toBase64
      return toBase64 === undefined ? undefined : toBase64.call(new Uint8Array(bytes), options)
    }
    expect(encode([77, 97, 110])).toBe('TWFu')
    expect(encode([77, 97])).toBe('TWE=')
    expect(encode([77])).toBe('TQ==')
    expect(encode([])).toBe('')
    // The two alphabets' last characters are what separate them: 62 and 63 are
    // +/ in base64 and -_ in base64url.
    expect(encode([251, 255, 191])).toBe('+/+/')
    expect(encode([251, 255, 191, 77, 97])).toBe('+/+/TWE=')
    expect(encode([77], {})).toBe('TQ==')
    expect(encode([77, 97], { omitPadding: true })).toBe('TWE')
    expect(encode([251, 255, 191], { alphabet: 'base64url' })).toBe('-_-_')
    expect(encode([251, 255, 191], { alphabet: 'base64', omitPadding: true })).toBe('+/+/')
  })

  it('reads the options the proposal defines and refuses the rest', () => {
    const call = uint8ArrayBase64.toBase64 as (this: Uint8Array, options?: unknown) => string
    const encode = (options: unknown): string => call.call(new Uint8Array([77]), options)
    expect(encode({ omitPadding: 1 })).toBe('TQ')
    expect(() => encode(null)).toThrow(TypeError)
    expect(() => encode(7)).toThrow(TypeError)
    expect(() => encode({ alphabet: 'latin1' })).toThrow(TypeError)
  })

  it('inserts a map entry once and returns the value already there', () => {
    const getOrInsert = mapUpserts.getOrInsert as (key: string, value: number) => number
    const map = new Map<string, number>()
    expect(getOrInsert.call(map, 'a', 1)).toBe(1)
    expect(getOrInsert.call(map, 'a', 2)).toBe(1)
    expect(map.get('a')).toBe(1)
    // A key that holds undefined is present, not missing: the entry stays.
    const insertText = mapUpserts.getOrInsert as (key: string, value: string | undefined) => string | undefined
    const explicit = new Map<string, string | undefined>([['present', undefined]])
    expect(insertText.call(explicit, 'present', 'replacement')).toBeUndefined()
    expect(explicit.get('present')).toBeUndefined()
    expect(explicit.size).toBe(1)
  })

  it('computes a map entry once, keyed by the entry it missed on', () => {
    const getOrInsertComputed = mapUpserts.getOrInsertComputed as (key: string, callback: (key: string) => string) => string
    const computed = new Map<string, string>()
    const seen: string[] = []
    expect(getOrInsertComputed.call(computed, 'x', (key) => {
      seen.push(key)
      return 'first'
    })).toBe('first')
    expect(getOrInsertComputed.call(computed, 'x', () => 'second')).toBe('first')
    expect(seen).toEqual(['x'])
    expect(computed.size).toBe(1)
  })

  it('upserts a WeakMap entry', () => {
    const getOrInsert = weakMapUpserts.getOrInsert as (key: object, value: number) => number
    const getOrInsertComputed = weakMapUpserts.getOrInsertComputed as (key: object, callback: (key: object) => number) => number
    const key = {}
    const weak = new WeakMap<object, number>()
    expect(getOrInsert.call(weak, key, 1)).toBe(1)
    expect(getOrInsertComputed.call(weak, key, () => 2)).toBe(1)
    const fresh = {}
    expect(getOrInsertComputed.call(weak, fresh, missed => missed === fresh ? 3 : 0)).toBe(3)
    expect(weak.get(key)).toBe(1)
  })

  it('sums the values pdf.js measures with', () => {
    expect(mathSumPrecise.sumPrecise?.([1, 2, 3])).toBe(6)
    expect(mathSumPrecise.sumPrecise?.([])).toBe(0)
    expect(mathSumPrecise.sumPrecise?.(new Set([2, 4]))).toBe(6)
    expect(mathSumPrecise.sumPrecise?.([0.1, 0.2])).toBeCloseTo(0.3, 12)
    // Neumaier compensation keeps a sum a plain accumulation loses.
    expect(mathSumPrecise.sumPrecise?.([1e100, 1, -1e100])).toBe(1)
    expect(() => mathSumPrecise.sumPrecise?.([1, 'x'])).toThrow(TypeError)
  })

  it('intersects two sets without changing either', () => {
    const first = new Set([1, 2, 3])
    const shared = setIntersection.intersection?.call(first, new Set([2, 3, 4]))
    expect([...(shared ?? [])]).toEqual([2, 3])
    expect([...first]).toEqual([1, 2, 3])
    expect([...(setIntersection.intersection?.call(new Set([1]), new Set()) ?? [])]).toEqual([])
  })

  it('reads a blob body as bytes', async () => {
    const bytes = await blobBytes.bytes?.call(new Blob([new Uint8Array([1, 2, 3])]))
    expect([...(bytes ?? [])]).toEqual([1, 2, 3])
  })

  it('moves buffer bytes into a fixed-length buffer and detaches the source', () => {
    const source = new Uint8Array([1, 2, 3, 4]).buffer
    const trimmed = transferToFixedLength.transferToFixedLength?.call(source, 2)
    expect([...new Uint8Array(trimmed ?? new ArrayBuffer(0))]).toEqual([1, 2])
    // The proposal leaves the source detached, so its byteLength reads zero.
    expect(source.byteLength).toBe(0)
    const grown = transferToFixedLength.transferToFixedLength?.call(new Uint8Array([9]).buffer, 3)
    expect([...new Uint8Array(grown ?? new ArrayBuffer(0))]).toEqual([9, 0, 0])
    const same = new Uint8Array([5, 6]).buffer
    expect([...new Uint8Array(transferToFixedLength.transferToFixedLength?.call(same) ?? new ArrayBuffer(0))]).toEqual([5, 6])
    expect(() => transferToFixedLength.transferToFixedLength?.call(new ArrayBuffer(1), -1)).toThrow(RangeError)
  })

  it('escapes a string for literal use in a pattern', () => {
    expect(regexp.escape?.('')).toBe('')
    // The specification's tables: syntax characters and the solidus take a
    // reverse solidus, the other punctuators and the whitespace take hex forms.
    expect(regexp.escape?.('^$\\.*+?()[]{}|/')).toBe('\\^\\$\\\\\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\/')
    expect(regexp.escape?.(',-=<>#&!%:;@~' + "'`" + '"')).toBe('\\x2c\\x2d\\x3d\\x3c\\x3e\\x23\\x26\\x21\\x25\\x3a\\x3b\\x40\\x7e\\x27\\x60\\x22')
    expect(regexp.escape?.('\t\n\u000b\f\r')).toBe('\\t\\n\\v\\f\\r')
    expect(regexp.escape?.(' \u00a0\u202f\ufeff')).toBe('\\x20\\xa0\\u202f\\ufeff')
    // Only an ASCII letter or digit in first position is encoded.
    expect(regexp.escape?.('The Quick Brown Fox')).toBe('\\x54he\\x20Quick\\x20Brown\\x20Fox')
    expect(regexp.escape?.('1+1')).toBe('\\x31\\+1')
    expect(regexp.escape?.('abc')).toBe('\\x61bc')
    expect(regexp.escape?.('.a1b2c3')).toBe('\\.a1b2c3')
    // A well-formed surrogate pair survives; either half on its own is encoded.
    expect(regexp.escape?.('😊')).toBe('😊')
    expect(regexp.escape?.('\ud800')).toBe('\\ud800')
    expect(regexp.escape?.('\udc00')).toBe('\\udc00')
    expect(regexp.escape?.('a\ud800b')).toBe('\\x61\\ud800b')
    expect(() => (regexp.escape as (value: unknown) => string)(7)).toThrow(TypeError)
  })

  it('produces a pattern matching the text it escaped', () => {
    const text = 'C++ (2.0) [beta] {a|b} \\ ^$ * ? + / 😊'
    const pattern = '^' + (regexp.escape?.(text) ?? '') + '$'
    expect(new RegExp(pattern).test(text)).toBe(true)
    // Every syntax character is literal: one changed or added character no
    // longer matches the anchored pattern.
    expect(new RegExp(pattern).test(text.replace('2.0', '2x0'))).toBe(false)
    expect(new RegExp(pattern).test(text + 'x')).toBe(false)
    expect(new RegExp(pattern).test(text.slice(1))).toBe(false)
  })

  it('reads a response body as bytes', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]))
    const bytes = await responseBytes.bytes?.call(response)
    expect([...(bytes ?? [])]).toEqual([1, 2, 3])
  })

  it('resolves the bytes an array buffer would', async () => {
    const body = new Uint8Array([4, 5, 6])
    const bytes = await responseBytes.bytes?.call(new Response(body))
    expect([...(bytes ?? [])]).toEqual([...new Uint8Array(await new Response(body).arrayBuffer())])
  })
})
