/**
 * Browser-compatibility floor for the Web client.
 *
 * The client builds target Chromium 90, the oldest engine this product
 * supports. That engine parses the syntax those builds emit, but it lacks
 * several standard APIs the client calls directly, and a missing API throws at
 * the call site — most of them sit on the shell's boot path, so one gap is a
 * blank page. This module installs the missing APIs before any other client
 * module evaluates; {@link ./compat-install.ts} is the shell's first import.
 * Every entry is feature-detected, so engines that already ship the API keep
 * their native implementation and pay only the check.
 *
 * The floor is deliberately the APIs this client actually calls: an entry
 * without a call site and a spec makes this module a wish list rather than a
 * compatibility contract.
 * @module @deepseek-ai/dsh-client-web/src/compat
 */

/** Whether a previous {@link installBrowserCompat} call already ran in this realm. */
let floorInstalled = false

/** Array members Chromium 90 lacks, as an optional-property view of the prototype. */
interface ArrayCompat {
  at?: <T>(this: T[], index: number) => T | undefined
  findLast?: <T>(
    this: T[],
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ) => T | undefined
  findLastIndex?: <T>(
    this: T[],
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ) => number
  toSorted?: <T>(this: T[], compareFn?: (left: T, right: T) => number) => T[]
  toReversed?: <T>(this: T[]) => T[]
}

/** Static members Chromium 90 lacks on the constructors this client calls. */
interface ObjectCompat {
  hasOwn?: (target: object, key: PropertyKey) => boolean
}

interface PromiseCompat {
  withResolvers?: <T>() => {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
  }
}

interface AbortSignalCompat {
  any?: (signals: AbortSignal[]) => AbortSignal
  timeout?: (milliseconds: number) => AbortSignal
}

/** Statics Chromium 90 lacks on the constructors pdf.js reaches unguarded. */
interface PromiseTryCompat {
  try?: <T>(callback: () => T | PromiseLike<T>) => Promise<T>
}

interface UrlCompat {
  parse?: (url: string, base?: string) => URL | null
}

interface Uint8ArrayCompat {
  fromBase64?: (value: string) => Uint8Array
}

/** Prototype members of the base64/hex proposal Chromium 90 lacks. */
interface Uint8ArrayEncodersCompat {
  toHex?: (this: Uint8Array) => string
  toBase64?: (this: Uint8Array, options?: unknown) => string
}

/** The options object `Uint8Array.prototype.toBase64` reads, as the proposal specifies it. */
interface Uint8ArrayBase64Options {
  /** Alphabet to encode with, validated against the proposal's two; the default is base64. */
  alphabet?: unknown
  /** Whether to leave the trailing = padding off, read with ToBoolean. */
  omitPadding?: unknown
}

/** The Map and WeakMap upserts Chromium 90 lacks, as a view of either prototype. */
interface CollectionUpsertCompat {
  getOrInsert?: <K, V>(this: Map<K, V>, key: K, value: V) => V
  getOrInsertComputed?: <K, V>(this: Map<K, V>, key: K, callback: (key: K) => V) => V
}

/** The `Math` static Chromium 90 lacks. */
interface MathCompat {
  sumPrecise?: (values: Iterable<number>) => number
}

/** The `Set` member Chromium 90 lacks. */
interface SetCompat {
  intersection?: <T>(this: Set<T>, other: ReadonlySet<T>) => Set<T>
}

/** The `Blob` member Chromium 90 lacks, reached through the canvas image path. */
interface BlobCompat {
  bytes?: () => Promise<Uint8Array>
}

/** The `ArrayBuffer` member Chromium 90 lacks, which the PDF Worker trims font tables with. */
interface ArrayBufferTransferCompat {
  transferToFixedLength?: (newLength?: number) => ArrayBuffer
}

/** The `RegExp` static Chromium 90 lacks. */
interface RegExpCompat {
  escape?: (value: string) => string
}

/** The response member Chromium 90 lacks, reached through the type pdf.js fetches with. */
interface ResponseCompat {
  bytes?: () => Promise<Uint8Array>
}

interface AbortSignalPrototypeCompat {
  throwIfAborted?: () => void
}

/**
 * Resolve an index the way `Array.prototype.at` does.
 * @param length - array length the index is resolved against.
 * @param index - possibly negative index from the call site.
 * @returns the absolute in-range index, or undefined when it falls outside.
 */
function resolveRelativeIndex(length: number, index: number): number | undefined {
  const relative = Math.trunc(index) || 0
  const resolved = relative < 0 ? length + relative : relative
  return resolved < 0 || resolved >= length ? undefined : resolved
}

/**
 * Install `Object.hasOwn`.
 * @param installedApis - collector for the names this pass installs.
 */
function installObjectHasOwn(installedApis: string[]): void {
  const object = Object as ObjectCompat
  if (object.hasOwn !== undefined) return
  object.hasOwn = (target: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(target, key)
  installedApis.push('Object.hasOwn')
}

/**
 * Install the array members the client calls: `at`, `findLast`,
 * `findLastIndex`, `toSorted`, and `toReversed`.
 * @param installedApis - collector for the names this pass installs.
 */
function installArrayMembers(installedApis: string[]): void {
  const prototype = Array.prototype as ArrayCompat
  if (prototype.at === undefined) {
    prototype.at = function at<T>(this: T[], index: number): T | undefined {
      const resolved = resolveRelativeIndex(this.length, index)
      return resolved === undefined ? undefined : this[resolved]
    }
    installedApis.push('Array.prototype.at')
  }
  if (prototype.findLast === undefined) {
    prototype.findLast = function findLast<T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => unknown,
      thisArg?: unknown,
    ): T | undefined {
      for (let index = this.length - 1; index >= 0; index -= 1) {
        const value = this[index] as T
        if (predicate.call(thisArg, value, index, this)) return value
      }
      return undefined
    }
    installedApis.push('Array.prototype.findLast')
  }
  if (prototype.findLastIndex === undefined) {
    prototype.findLastIndex = function findLastIndex<T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => unknown,
      thisArg?: unknown,
    ): number {
      for (let index = this.length - 1; index >= 0; index -= 1) {
        if (predicate.call(thisArg, this[index] as T, index, this)) return index
      }
      return -1
    }
    installedApis.push('Array.prototype.findLastIndex')
  }
  if (prototype.toSorted === undefined) {
    prototype.toSorted = function toSorted<T>(this: T[], compareFn?: (left: T, right: T) => number): T[] {
      return [...this].sort(compareFn)
    }
    installedApis.push('Array.prototype.toSorted')
  }
  if (prototype.toReversed === undefined) {
    prototype.toReversed = function toReversed<T>(this: T[]): T[] {
      return [...this].reverse()
    }
    installedApis.push('Array.prototype.toReversed')
  }
}

/**
 * Install `Promise.withResolvers`.
 * @param installedApis - collector for the names this pass installs.
 */
function installPromiseWithResolvers(installedApis: string[]): void {
  const promise = Promise as PromiseCompat
  if (promise.withResolvers !== undefined) return
  promise.withResolvers = <T>(): {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
  } => {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const pending = new Promise<T>((settle, fail) => {
      resolve = settle
      reject = fail
    })
    return { promise: pending, resolve, reject }
  }
  installedApis.push('Promise.withResolvers')
}

/**
 * Install `AbortSignal.prototype.throwIfAborted`.
 *
 * The client calls it on every cancellable request path. Chromium 90 has no
 * `signal.reason`, so the thrown reason is always the `AbortError`
 * the native member raises for a signal aborted without one.
 * @param installedApis - collector for the names this pass installs.
 */
function installAbortSignalAbortCheck(installedApis: string[]): void {
  const prototype = AbortSignal.prototype as AbortSignalPrototypeCompat
  if (prototype.throwIfAborted !== undefined) return
  prototype.throwIfAborted = function throwIfAborted(this: AbortSignal): void {
    if (!this.aborted) return
    if (this.reason !== undefined) throw this.reason
    throw new DOMException('The operation was aborted.', 'AbortError')
  }
  installedApis.push('AbortSignal.prototype.throwIfAborted')
}

/**
 * Install the `AbortSignal` statics.
 *
 * Chromium 90 drops the reason argument of `AbortController.abort`, so a
 * combined or timed-out signal reports the engine's default abort reason
 * instead of the source signal's. Callers that branch on `signal.reason`
 * must treat an absent reason as an abort.
 * @param installedApis - collector for the names this pass installs.
 */
function installAbortSignalStatics(installedApis: string[]): void {
  const abortSignal = AbortSignal as AbortSignalCompat
  if (abortSignal.any === undefined) {
    abortSignal.any = (signals: AbortSignal[]): AbortSignal => {
      const controller = new AbortController()
      const listeners = new Map<AbortSignal, () => void>()
      const release = (): void => {
        for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
        listeners.clear()
      }
      for (const signal of signals) {
        if (signal.aborted) {
          controller.abort(signal.reason)
          release()
          return controller.signal
        }
        const listener = (): void => {
          controller.abort(signal.reason)
          release()
        }
        listeners.set(signal, listener)
        signal.addEventListener('abort', listener)
      }
      return controller.signal
    }
    installedApis.push('AbortSignal.any')
  }
  if (abortSignal.timeout === undefined) {
    abortSignal.timeout = (milliseconds: number): AbortSignal => {
      const controller = new AbortController()
      setTimeout(() => {
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
      }, milliseconds)
      return controller.signal
    }
    installedApis.push('AbortSignal.timeout')
  }
}

/**
 * Copy one value the way `structuredClone` does, for the data this client
 * passes through it: primitives, plain objects, arrays, `Date`, `RegExp`,
 * `Map`, `Set`, `Blob`, and `ArrayBuffer` with its views. Functions and
 * symbols raise the `DataCloneError` the native implementation raises; other
 * exotic values (DOM nodes, class instances with private state) copy their
 * enumerable own properties like any other object.
 * @param value - value to copy.
 * @param seen - copies already made, keyed by source object, so cycles and
 * repeated references keep their identity.
 * @returns the copy.
 * @throws {DOMException} with name `DataCloneError` for functions and symbols.
 */
function cloneStructured(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new DOMException(`${typeof value} could not be cloned.`, 'DataCloneError')
    }
    return value
  }
  const source = value
  const existing = seen.get(source)
  if (existing !== undefined) return existing
  if (source instanceof Date) return new Date(source.getTime())
  if (source instanceof RegExp) return new RegExp(source.source, source.flags)
  if (source instanceof Blob) return source.slice(0, source.size, source.type)
  if (source instanceof ArrayBuffer) return source.slice(0)
  if (ArrayBuffer.isView(source)) return cloneArrayBufferView(source)
  if (source instanceof Map) {
    const copy = new Map<unknown, unknown>()
    seen.set(source, copy)
    for (const [key, entry] of source) copy.set(cloneStructured(key, seen), cloneStructured(entry, seen))
    return copy
  }
  if (source instanceof Set) {
    const copy = new Set<unknown>()
    seen.set(source, copy)
    for (const entry of source) copy.add(cloneStructured(entry, seen))
    return copy
  }
  if (Array.isArray(source)) {
    const copy: unknown[] = []
    seen.set(source, copy)
    for (const entry of source) copy.push(cloneStructured(entry, seen))
    return copy
  }
  const copy: Record<string, unknown> = {}
  seen.set(source, copy)
  for (const [key, entry] of Object.entries(source)) copy[key] = cloneStructured(entry, seen)
  return copy
}

/**
 * Copy an `ArrayBuffer` view into its own buffer, the way structured
 * serialization does: same bytes, offset zero.
 * @param view - typed array or `DataView` to copy.
 * @returns a view of the same type over the copied bytes.
 */
function cloneArrayBufferView(view: ArrayBufferView): ArrayBufferView {
  const bytes = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
  if (view instanceof DataView) return new DataView(bytes.buffer)
  const Construct = view.constructor as new (buffer: ArrayBufferLike) => ArrayBufferView
  return new Construct(bytes.buffer)
}

/**
 * Install `structuredClone`.
 * @param installedApis - collector for the names this pass installs.
 */
function installStructuredClone(installedApis: string[]): void {
  // The library types declare the API unconditionally; the engine is what may
  // withhold it, so the probe reads the global through its own view.
  const scope = globalThis as { structuredClone?: unknown }
  if (scope.structuredClone !== undefined) return
  globalThis.structuredClone = <T>(value: T): T => cloneStructured(value, new Map()) as T
  installedApis.push('structuredClone')
}

/**
 * Install the `Iterator` global the shared iterator prototype is reachable through.
 *
 * Chromium 90 has the internal prototype every built-in iterator inherits from
 * but no global naming it, and pdf.js reaches it unguarded to add helpers:
 * `Iterator.prototype.join != 'function' && (Iterator.prototype.join = ...)`
 * throws before its own check can run.
 * @param installedApis - collector for the names this pass installs.
 */
function installIteratorGlobal(installedApis: string[]): void {
  const scope = globalThis as { Iterator?: unknown }
  if (scope.Iterator !== undefined) return
  const inner = Reflect.getPrototypeOf([][Symbol.iterator]())
  const shared = inner === null ? null : Reflect.getPrototypeOf(inner)
  if (shared === null) return
  const IteratorGlobal = function Iterator(): void {
    // The global only names the prototype built-in iterators already share.
  }
  Object.defineProperty(IteratorGlobal, 'prototype', { value: shared })
  Object.defineProperty(globalThis, 'Iterator', { value: IteratorGlobal, writable: true, configurable: true })
  installedApis.push('Iterator')
}

/**
 * Install `Promise.try`.
 * @param installedApis - collector for the names this pass installs.
 */
function installPromiseTry(installedApis: string[]): void {
  const promise = Promise as PromiseTryCompat
  if (promise.try !== undefined) return
  promise.try = <T>(callback: () => T | PromiseLike<T>): Promise<T> =>
    new Promise<T>((resolve) => { resolve(callback()) })
  installedApis.push('Promise.try')
}

/**
 * Install `URL.parse`, which reports an unparsable input as null instead of throwing.
 * @param installedApis - collector for the names this pass installs.
 */
function installUrlParse(installedApis: string[]): void {
  const url = URL as UrlCompat
  if (url.parse !== undefined) return
  url.parse = (value: string, base?: string): URL | null => {
    try {
      return base === undefined ? new URL(value) : new URL(value, base)
    } catch (error) {
      if (error instanceof TypeError) return null
      throw error
    }
  }
  installedApis.push('URL.parse')
}

/**
 * Install `Uint8Array.fromBase64`, which pdf.js calls for base64 transfer-encoded bodies.
 * @param installedApis - collector for the names this pass installs.
 */
function installUint8ArrayFromBase64(installedApis: string[]): void {
  const view = Uint8Array as Uint8ArrayCompat
  if (view.fromBase64 !== undefined) return
  view.fromBase64 = (value: string): Uint8Array => {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  installedApis.push('Uint8Array.fromBase64')
}

/** Lower-case hex digits `Uint8Array.prototype.toHex` encodes with. */
const HEX_DIGITS = '0123456789abcdef'

/** Standard base64 alphabet, the proposal's default. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** URL-safe base64 alphabet, the proposal's base64url option. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Install the base64/hex proposal's encoders, which pdf.js calls on its own
 * byte ranges: PDFDocument.fingerprints calls toHex on the two hashed ranges,
 * and the display half calls toBase64 on the font data it hands to FontFace
 * and on the signature it saves.
 *
 * The options object is validated the way the proposal specifies it, because
 * the installed member is a standard API untyped JavaScript calls.
 * @param installedApis - collector for the names this pass installs.
 */
function installUint8ArrayEncoders(installedApis: string[]): void {
  const prototype = Uint8Array.prototype as Uint8ArrayEncodersCompat
  if (prototype.toHex === undefined) {
    prototype.toHex = function toHex(this: Uint8Array): string {
      let text = ''
      for (const byte of this) text += HEX_DIGITS.charAt(byte >> 4) + HEX_DIGITS.charAt(byte & 15)
      return text
    }
    installedApis.push('Uint8Array.prototype.toHex')
  }
  if (prototype.toBase64 === undefined) {
    prototype.toBase64 = function toBase64(this: Uint8Array, options?: unknown): string {
      let encoding: 'base64' | 'base64url' = 'base64'
      let omitPadding = false
      if (options !== undefined) {
        if (options === null || typeof options !== 'object') {
          throw new TypeError('Uint8Array.prototype.toBase64 options must be an object')
        }
        const requested = options as Uint8ArrayBase64Options
        const alphabet = requested.alphabet
        if (alphabet !== undefined) {
          if (alphabet !== 'base64' && alphabet !== 'base64url') {
            throw new TypeError('Uint8Array.prototype.toBase64 alphabet must be one of base64 or base64url')
          }
          encoding = alphabet
        }
        omitPadding = Boolean(requested.omitPadding)
      }
      const table = encoding === 'base64url' ? BASE64URL_ALPHABET : BASE64_ALPHABET
      let text = ''
      let index = 0
      for (; index + 2 < this.length; index += 3) {
        const first = this[index] as number
        const second = this[index + 1] as number
        const third = this[index + 2] as number
        const triple = (first << 16) | (second << 8) | third
        text += table.charAt((triple >> 18) & 63) + table.charAt((triple >> 12) & 63)
          + table.charAt((triple >> 6) & 63) + table.charAt(triple & 63)
      }
      const remaining = this.length - index
      if (remaining === 1) {
        const single = this[index] as number
        text += table.charAt(single >> 2) + table.charAt((single & 3) << 4)
        if (!omitPadding) text += '=='
      } else if (remaining === 2) {
        const pair = ((this[index] as number) << 8) | (this[index + 1] as number)
        text += table.charAt(pair >> 10) + table.charAt((pair >> 4) & 63) + table.charAt((pair & 15) << 2)
        if (!omitPadding) text += '='
      }
      return text
    }
    installedApis.push('Uint8Array.prototype.toBase64')
  }
}

/**
 * Read a map entry, inserting the given value when the key is absent.
 * @param key - key to look up.
 * @param value - value to insert when the key is absent.
 * @returns the existing or newly inserted value.
 */
function getOrInsert<K, V>(this: Map<K, V>, key: K, value: V): V {
  const existing = this.get(key)
  if (existing !== undefined || this.has(key)) return existing as V
  this.set(key, value)
  return value
}

/**
 * Read a map entry, computing and inserting its value when the key is absent.
 * @param key - key to look up, handed to the callback only when it is absent.
 * @param callback - computes the value to insert.
 * @returns the existing or newly inserted value.
 */
function getOrInsertComputed<K, V>(this: Map<K, V>, key: K, callback: (key: K) => V): V {
  const existing = this.get(key)
  if (existing !== undefined || this.has(key)) return existing as V
  const computed = callback(key)
  this.set(key, computed)
  return computed
}

/**
 * Install the Map and WeakMap upserts pdf.js keeps its stream, font, and
 * annotation caches in.
 * @param installedApis - collector for the names this pass installs.
 */
function installCollectionUpserts(installedApis: string[]): void {
  const map = Map.prototype as CollectionUpsertCompat
  if (map.getOrInsert === undefined) {
    map.getOrInsert = getOrInsert
    installedApis.push('Map.prototype.getOrInsert')
  }
  if (map.getOrInsertComputed === undefined) {
    map.getOrInsertComputed = getOrInsertComputed
    installedApis.push('Map.prototype.getOrInsertComputed')
  }
  const weakMap = WeakMap.prototype as CollectionUpsertCompat
  if (weakMap.getOrInsert === undefined) {
    weakMap.getOrInsert = getOrInsert
    installedApis.push('WeakMap.prototype.getOrInsert')
  }
  if (weakMap.getOrInsertComputed === undefined) {
    weakMap.getOrInsertComputed = getOrInsertComputed
    installedApis.push('WeakMap.prototype.getOrInsertComputed')
  }
}

/**
 * Install `Math.sumPrecise`, which pdf.js sums font metrics and table lengths with.
 *
 * The specification requires a correctly rounded sum; Neumaier compensation
 * keeps the running error and adds it back once, which is exact for the
 * metric sums this client computes. The installed member is a standard API, so
 * it keeps the specification TypeError for a value that is not a number.
 * @param installedApis - collector for the names this pass installs.
 */
function installMathSumPrecise(installedApis: string[]): void {
  const math = Math as MathCompat
  if (math.sumPrecise !== undefined) return
  math.sumPrecise = (values: Iterable<number>): number => {
    let sum = 0
    let compensation = 0
    for (const value of values) {
      if (typeof value !== 'number') throw new TypeError('Math.sumPrecise expects an iterable of numbers')
      const next = sum + value
      // Neumaier's term: this addition's rounding error, added back at the end.
      compensation += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum
      sum = next
    }
    return sum + compensation
  }
  installedApis.push('Math.sumPrecise')
}

/**
 * Install `Set.prototype.intersection`, which the PDF Worker calls on the
 * destination sets it linearizes.
 * @param installedApis - collector for the names this pass installs.
 */
function installSetIntersection(installedApis: string[]): void {
  const prototype = Set.prototype as SetCompat
  if (prototype.intersection !== undefined) return
  prototype.intersection = function intersection<T>(this: Set<T>, other: ReadonlySet<T>): Set<T> {
    const result = new Set<T>()
    for (const value of this) if (other.has(value)) result.add(value)
    return result
  }
  installedApis.push('Set.prototype.intersection')
}

/**
 * Install `Blob.prototype.bytes`, which the PDF Worker reads a
 * canvas-rendered image back through.
 * @param installedApis - collector for the names this pass installs.
 */
function installBlobBytes(installedApis: string[]): void {
  const prototype = Blob.prototype as BlobCompat
  if (prototype.bytes !== undefined) return
  prototype.bytes = function bytes(this: Blob): Promise<Uint8Array> {
    return this.arrayBuffer().then(buffer => new Uint8Array(buffer))
  }
  installedApis.push('Blob.prototype.bytes')
}

/**
 * Detach an `ArrayBuffer` the way the transfer proposal does.
 *
 * Chromium 90 has no resizable buffers and no `structuredClone` in a Worker,
 * so a message port is the one way to move the bytes out and leave the source
 * detached.
 * @param buffer - buffer to detach.
 */
function detachArrayBuffer(buffer: ArrayBuffer): void {
  const channel = new MessageChannel()
  channel.port1.postMessage(buffer, [buffer])
  channel.port1.close()
  channel.port2.close()
}

/**
 * Install `ArrayBuffer.prototype.transferToFixedLength`, which the PDF Worker
 * trims the font tables it hands the display with.
 *
 * The installed member is a standard API, so it keeps the specification
 * RangeError for a length the static parameter type cannot exclude.
 * @param installedApis - collector for the names this pass installs.
 */
function installArrayBufferTransfer(installedApis: string[]): void {
  const prototype = ArrayBuffer.prototype as ArrayBufferTransferCompat
  if (prototype.transferToFixedLength !== undefined) return
  prototype.transferToFixedLength = function transferToFixedLength(this: ArrayBuffer, newLength?: number): ArrayBuffer {
    const source = new Uint8Array(this)
    const length = newLength === undefined ? source.length : Math.trunc(newLength)
    if (!Number.isFinite(length) || length < 0) {
      throw new RangeError('ArrayBuffer.prototype.transferToFixedLength length must be a non-negative integer')
    }
    const copy = new Uint8Array(length)
    copy.set(source.subarray(0, Math.min(source.length, length)))
    detachArrayBuffer(this)
    return copy.buffer
  }
  installedApis.push('ArrayBuffer.prototype.transferToFixedLength')
}

/** Characters `RegExp.escape` prefixes with a reverse solidus. */
const REGEXP_ESCAPED_SYNTAX = '^$\\.*+?()[]{}|/'

/** Punctuation `RegExp.escape` encodes as \xNN. */
const REGEXP_OTHER_PUNCTUATORS = ',-=<>#&!%:;@~' + "'`" + '"'

/** Whitespace and line terminators `RegExp.escape` encodes, the control escapes excepted. */
const REGEXP_ESCAPED_WHITESPACE = ' \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

/** `RegExp.escape`'s escape sequences for the code units 9 through 13, in order. */
const REGEXP_CONTROL_ESCAPES = 'tnvfr'

/**
 * Encode one code unit in the escape form the specification requires: \xNN below
 * U+0100, \uNNNN above it, both lowercase.
 * @param unit - code unit to encode.
 * @returns the escape sequence.
 */
function encodeRegExpEscape(unit: number): string {
  const width = unit < 256 ? 2 : 4
  return '\\' + (width === 2 ? 'x' : 'u') + unit.toString(16).padStart(width, '0')
}

/**
 * Whether a code unit is an ASCII letter or decimal digit, the class the escape
 * encodes in first position so the result cannot read as a backreference.
 * @param unit - code unit to test.
 * @returns whether the unit is alphanumeric ASCII.
 */
function isAsciiAlphanumeric(unit: number): boolean {
  return (unit >= 0x30 && unit <= 0x39) || (unit >= 0x41 && unit <= 0x5a) || (unit >= 0x61 && unit <= 0x7a)
}

/**
 * Whether one code unit is a surrogate with no counterpart beside it.
 * @param value - string the unit belongs to.
 * @param index - position of the unit.
 * @param unit - code unit to test.
 * @returns whether the unit is an unpaired surrogate.
 */
function isUnpairedSurrogate(value: string, index: number, unit: number): boolean {
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = value.charCodeAt(index + 1)
    return !(next >= 0xdc00 && next <= 0xdfff)
  }
  if (unit >= 0xdc00 && unit <= 0xdfff) {
    const previous = value.charCodeAt(index - 1)
    return !(previous >= 0xd800 && previous <= 0xdbff)
  }
  return false
}

/**
 * Escape a string for literal use inside a regular expression, as
 * `RegExp.escape` specifies it: syntax characters and the solidus take a
 * reverse solidus, a leading ASCII letter or digit, the control characters, the
 * other punctuators, and the whitespace and line terminators take the
 * specification's `\xNN` or `\uNNNN` form, a well-formed surrogate pair
 * stays as written, and an unpaired surrogate is encoded.
 * @param value - string to escape.
 * @returns the escaped pattern source.
 */
function escapeRegExpPattern(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    const character = value.charAt(index)
    if (index === 0 && isAsciiAlphanumeric(unit)) result += encodeRegExpEscape(unit)
    else if (unit >= 9 && unit <= 13) result += '\\' + REGEXP_CONTROL_ESCAPES.charAt(unit - 9)
    else if (REGEXP_ESCAPED_SYNTAX.includes(character)) result += '\\' + character
    else if (REGEXP_OTHER_PUNCTUATORS.includes(character) || REGEXP_ESCAPED_WHITESPACE.includes(character)) {
      result += encodeRegExpEscape(unit)
    } else if (isUnpairedSurrogate(value, index, unit)) result += encodeRegExpEscape(unit)
    else result += character
  }
  return result
}

/**
 * Install `RegExp.escape`.
 *
 * The installed member is a standard API third-party JavaScript calls, so it
 * keeps the specification's TypeError for an input the static parameter type
 * cannot exclude.
 * @param installedApis - collector for the names this pass installs.
 */
function installRegExpEscape(installedApis: string[]): void {
  const regexp = RegExp as RegExpCompat
  if (regexp.escape !== undefined) return
  regexp.escape = (value: string): string => {
    if (typeof value !== 'string') throw new TypeError('RegExp.escape expects a string')
    return escapeRegExpPattern(value)
  }
  installedApis.push('RegExp.escape')
}

/**
 * Install `Response.prototype.bytes`, which pdf.js calls for the cmap and font
 * bodies it fetches with that response type.
 * @param installedApis - collector for the names this pass installs.
 */
function installResponseBytes(installedApis: string[]): void {
  const prototype = Response.prototype as ResponseCompat
  if (prototype.bytes !== undefined) return
  prototype.bytes = function bytes(this: Response): Promise<Uint8Array> {
    return this.arrayBuffer().then(buffer => new Uint8Array(buffer))
  }
  installedApis.push('Response.prototype.bytes')
}

/**
 * Install every missing API of the client's browser floor.
 *
 * Idempotent per realm: the first call installs what the engine lacks, later
 * calls only re-check. Every client bundle evaluates after the shell, so the
 * shell's one pass covers the whole application.
 * @returns the APIs this call installed, empty when the engine already has
 * them all or the floor is already in place.
 */
export function installBrowserCompat(): string[] {
  const installedApis: string[] = []
  if (floorInstalled) return installedApis
  floorInstalled = true
  installObjectHasOwn(installedApis)
  installArrayMembers(installedApis)
  installPromiseWithResolvers(installedApis)
  installStructuredClone(installedApis)
  installAbortSignalStatics(installedApis)
  installAbortSignalAbortCheck(installedApis)
  installIteratorGlobal(installedApis)
  installPromiseTry(installedApis)
  installUrlParse(installedApis)
  installUint8ArrayFromBase64(installedApis)
  installUint8ArrayEncoders(installedApis)
  installCollectionUpserts(installedApis)
  installMathSumPrecise(installedApis)
  installSetIntersection(installedApis)
  installBlobBytes(installedApis)
  installArrayBufferTransfer(installedApis)
  installRegExpEscape(installedApis)
  installResponseBytes(installedApis)
  return installedApis
}
