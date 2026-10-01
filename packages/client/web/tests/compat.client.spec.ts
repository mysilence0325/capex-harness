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
]

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
})
