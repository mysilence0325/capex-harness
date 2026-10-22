/**
 * Runtime shims for the browser baseline the offline deployment targets.
 *
 * The shipped shells are Chromium 102, and the client artifacts are built with
 * `chrome102` as their target, so syntax is already safe. These are the
 * standard-library members the bundles call that Chromium 102 does not have:
 * `Promise.withResolvers` (Chrome 119), `AbortSignal.any`/`timeout` (116/103),
 * the Array copy methods (110–121), and the Set composition methods (122).
 * Each shim installs only when the runtime lacks the member, so a newer shell
 * keeps its native implementation.
 * @module @deepseek-ai/dsh-client-web/src/compat
 */

type Resolvers<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
}

/** Install one non-enumerable data property, matching built-in method descriptors. */
function defineMethod(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { configurable: true, writable: true, value })
}

/** Whether the runtime already provides a built-in member. */
function has(target: object, name: string): boolean {
  return typeof (target as Record<string, unknown>)[name] === 'function'
}

function withResolvers<T>(): Resolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function anySignal(signals: Iterable<AbortSignal>): AbortSignal {
  const controller = new AbortController()
  const list = [...signals]
  const abort = (event: Event): void => {
    controller.abort((event.currentTarget as AbortSignal).reason)
  }
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
  }
  for (const signal of list) signal.addEventListener('abort', abort, { once: true })
  controller.signal.addEventListener('abort', () => {
    for (const signal of list) signal.removeEventListener('abort', abort)
  }, { once: true })
  return controller.signal
}

function timeoutSignal(milliseconds: number): AbortSignal {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError('AbortSignal.timeout: milliseconds must be a finite non-negative number')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new DOMException('signal timed out', 'TimeoutError')) }, milliseconds)
  controller.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
  return controller.signal
}

function copySort<T>(this: readonly T[], compare?: (left: T, right: T) => number): T[] {
  return [...this].sort(compare)
}

function copyReverse<T>(this: readonly T[]): T[] {
  return [...this].reverse()
}

function copySplice<T>(this: readonly T[], start: number, deleteCount?: number, ...items: T[]): T[] {
  const copy = [...this]
  if (deleteCount === undefined) copy.splice(start)
  else copy.splice(start, deleteCount, ...items)
  return copy
}

function copyWith<T>(this: readonly T[], index: number, value: T): T[] {
  const copy = [...this]
  const at = index < 0 ? copy.length + index : index
  if (!Number.isInteger(at) || at < 0 || at >= copy.length) throw new RangeError('Array.prototype.with: index out of range')
  copy[at] = value
  return copy
}

function setUnion<T>(this: ReadonlySet<T>, other: ReadonlySet<T>): Set<T> {
  const result = new Set(this)
  for (const value of other) result.add(value)
  return result
}

function setIntersection<T>(this: ReadonlySet<T>, other: ReadonlySet<T>): Set<T> {
  const result = new Set<T>()
  for (const value of this) if (other.has(value)) result.add(value)
  return result
}

function setDifference<T>(this: ReadonlySet<T>, other: ReadonlySet<T>): Set<T> {
  const result = new Set<T>()
  for (const value of this) if (!other.has(value)) result.add(value)
  return result
}

function setSymmetricDifference<T>(this: ReadonlySet<T>, other: ReadonlySet<T>): Set<T> {
  const result = new Set<T>()
  for (const value of this) if (!other.has(value)) result.add(value)
  for (const value of other) if (!this.has(value)) result.add(value)
  return result
}

function setIsSubsetOf<T>(this: ReadonlySet<T>, other: ReadonlySet<T>): boolean {
  for (const value of this) if (!other.has(value)) return false
  return true
}

function setIsSupersetOf<T>(this: ReadonlySet<T>, other: ReadonlySet<T>): boolean {
  for (const value of other) if (!this.has(value)) return false
  return true
}

function setIsDisjointFrom<T>(this: ReadonlySet<T>, other: ReadonlySet<T>): boolean {
  for (const value of this) if (other.has(value)) return false
  return true
}

function hasOwn(target: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

function arrayAt<T>(this: readonly T[], index: number): T | undefined {
  const length = this.length
  const at = Math.trunc(index) || 0
  return this[at < 0 ? length + at : at]
}

function stringAt(this: string, index: number): string | undefined {
  const at = Math.trunc(index) || 0
  const resolved = at < 0 ? this.length + at : at
  return resolved < 0 || resolved >= this.length ? undefined : this[resolved]
}

function throwIfAborted(this: AbortSignal): void {
  if (this.aborted) throw this.reason
}

function urlParse(input: string, base?: string): URL | null {
  try {
    return base === undefined ? new URL(input) : new URL(input, base)
  } catch {
    return null
  }
}

/** Characters that carry regex meaning outside a character class. */
const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/g

function regexpEscape(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  const escaped = text.replace(REGEXP_SYNTAX, String.raw`\$&`)
  // A leading digit would read as a backreference in the produced pattern.
  return /^[0-9]/.test(escaped)
    ? `\\x${text.charCodeAt(0).toString(16).padStart(2, '0')}${escaped.slice(1)}`
    : escaped
}

/**
 * Install the missing standard-library members once. Call it before the boot
 * kernel touches any injected state; repeated calls are no-ops.
 */
export function installBrowserCompat(): void {
  if (!has(Promise, 'withResolvers')) defineMethod(Promise, 'withResolvers', withResolvers)
  if (!has(AbortSignal, 'any')) defineMethod(AbortSignal, 'any', anySignal)
  if (!has(AbortSignal, 'timeout')) defineMethod(AbortSignal, 'timeout', timeoutSignal)
  if (!has(AbortSignal.prototype, 'throwIfAborted')) defineMethod(AbortSignal.prototype, 'throwIfAborted', throwIfAborted)
  if (!has(URL, 'canParse')) defineMethod(URL, 'canParse', (input: string, base?: string) => urlParse(input, base) !== null)
  if (!has(URL, 'parse')) defineMethod(URL, 'parse', urlParse)
  if (!has(RegExp, 'escape')) defineMethod(RegExp, 'escape', regexpEscape)
  if (!has(Object, 'hasOwn')) defineMethod(Object, 'hasOwn', hasOwn)
  if (!has(Array.prototype, 'at')) defineMethod(Array.prototype, 'at', arrayAt)
  if (!has(String.prototype, 'at')) defineMethod(String.prototype, 'at', stringAt)
  if (!has(Array.prototype, 'toSorted')) defineMethod(Array.prototype, 'toSorted', copySort)
  if (!has(Array.prototype, 'toReversed')) defineMethod(Array.prototype, 'toReversed', copyReverse)
  if (!has(Array.prototype, 'toSpliced')) defineMethod(Array.prototype, 'toSpliced', copySplice)
  if (!has(Array.prototype, 'with')) defineMethod(Array.prototype, 'with', copyWith)
  if (!has(Set.prototype, 'union')) defineMethod(Set.prototype, 'union', setUnion)
  if (!has(Set.prototype, 'intersection')) defineMethod(Set.prototype, 'intersection', setIntersection)
  if (!has(Set.prototype, 'difference')) defineMethod(Set.prototype, 'difference', setDifference)
  if (!has(Set.prototype, 'symmetricDifference')) defineMethod(Set.prototype, 'symmetricDifference', setSymmetricDifference)
  if (!has(Set.prototype, 'isSubsetOf')) defineMethod(Set.prototype, 'isSubsetOf', setIsSubsetOf)
  if (!has(Set.prototype, 'isSupersetOf')) defineMethod(Set.prototype, 'isSupersetOf', setIsSupersetOf)
  if (!has(Set.prototype, 'isDisjointFrom')) defineMethod(Set.prototype, 'isDisjointFrom', setIsDisjointFrom)
}
