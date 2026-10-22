/**
 * Standard-library shims prepended to the vendored document workers.
 *
 * The PDF and spreadsheet engines run in their own realms, created from blob
 * sources, so the shell's `installBrowserCompat()` never reaches them. Both
 * engines call members the Chromium 102 shell lacks — `pdf.worker` alone calls
 * `Promise.withResolvers` and `URL.parse` — and a missing member there fails
 * the whole preview. The prelude is plain JavaScript because it executes
 * before any module of the vendor bundle.
 * @module @deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/worker-compat
 */

export const WORKER_COMPAT_SOURCE = String.raw`
(function () {
  if (typeof Promise === 'function' && typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function () {
      var resolve, reject
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej })
      return { promise: promise, resolve: resolve, reject: reject }
    }
  }
  if (typeof URL === 'function' && typeof URL.parse !== 'function') {
    URL.parse = function (input, base) {
      try { return base === undefined ? new URL(input) : new URL(input, base) } catch (error) { return null }
    }
  }
  if (typeof URL === 'function' && typeof URL.canParse !== 'function') {
    URL.canParse = function (input, base) { return URL.parse(input, base) !== null }
  }
  if (typeof RegExp === 'function' && typeof RegExp.escape !== 'function') {
    RegExp.escape = function (value) {
      var text = String(value)
      var escaped = text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
      return /^[0-9]/.test(escaped)
        ? '\\x' + text.charCodeAt(0).toString(16).padStart(2, '0') + escaped.slice(1)
        : escaped
    }
  }
})();
`
