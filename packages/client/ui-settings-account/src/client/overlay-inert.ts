/** Shared inert ownership for overlapping account overlays. */

/** Focusable descendants the fallback takes out of the tab order. */
const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, iframe, [tabindex]'

/** One element's inert ownership, shared by every overlay covering it. */
interface InertOwnership {
  /** Overlays currently covering the element. */
  count: number
  /** Inert value the element carried before the first overlay. */
  previous: boolean
  /** Whether the engine implements inert natively. */
  readonly native: boolean
  /** Tab order entries the fallback cleared, with the attribute to restore. */
  readonly tabIndexes: Map<HTMLElement, string | null>
}

const owners = new WeakMap<HTMLElement, InertOwnership>()

/**
 * Whether this realm implements the `inert` attribute.
 * @param element - element about to be made inert.
 * @returns true when the engine owns the behavior.
 */
function hasNativeInert(element: HTMLElement): boolean {
  return 'inert' in element
}

/**
 * Apply the fallback an engine without `inert` needs: out of the tab order,
 * hidden from assistive technology, and deaf to pointer input.
 * @param element - background element covered by an overlay.
 * @param state - ownership record collecting what to restore.
 */
function applyFallback(element: HTMLElement, state: InertOwnership): void {
  element.setAttribute('aria-hidden', 'true')
  element.style.pointerEvents = 'none'
  for (const focusable of element.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    state.tabIndexes.set(focusable, focusable.getAttribute('tabindex'))
    focusable.setAttribute('tabindex', '-1')
  }
}

/**
 * Undo {@link applyFallback}.
 * @param element - background element covered by an overlay.
 * @param state - ownership record holding the original values.
 */
function releaseFallback(element: HTMLElement, state: InertOwnership): void {
  element.removeAttribute('aria-hidden')
  element.style.pointerEvents = ''
  for (const [focusable, tabIndex] of state.tabIndexes) {
    if (tabIndex === null) focusable.removeAttribute('tabindex')
    else focusable.setAttribute('tabindex', tabIndex)
  }
  state.tabIndexes.clear()
}

/**
 * Disable background interaction until every account overlay releases the element.
 *
 * Chromium 90 has no `inert`, so the covered element also leaves the tab order,
 * hides from assistive technology, and ignores pointer input; engines that
 * implement the attribute keep their native behavior.
 * @param element - background element covered by an overlay.
 * @returns an idempotent release restoring the original state after the last owner.
 */
export function acquireOverlayInert(element: HTMLElement): () => void {
  const native = hasNativeInert(element)
  const state = owners.get(element) ?? { count: 0, previous: element.inert, native, tabIndexes: new Map() }
  state.count++
  owners.set(element, state)
  element.inert = true
  if (!native) applyFallback(element, state)
  let released = false
  return () => {
    if (released) return
    released = true
    if (--state.count === 0) {
      element.inert = state.previous
      if (!native) releaseFallback(element, state)
      owners.delete(element)
    }
  }
}
