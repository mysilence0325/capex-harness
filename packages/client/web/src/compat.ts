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
  return installedApis
}
