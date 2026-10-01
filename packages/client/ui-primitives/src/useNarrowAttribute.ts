/**
 * Narrow-width markers for the selectors a container query used to own: the
 * element that was the container states the fact instead, so every engine
 * reads it. Chromium 90 has no container queries (chrome 105).
 */
import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Keep `attribute` on the referenced element while its content box is at or
 * below `breakpoint` CSS pixels, re-measuring on every size change.
 * @param ref - The element that was the query's container.
 * @param breakpoint - Content width at or below which the marker is present.
 * @param attribute - Attribute to toggle. Two widths on one element need two
 * names; the default is `data-narrow`.
 */
export function useNarrowAttribute(
  ref: RefObject<HTMLElement | null>,
  breakpoint: number,
  attribute = 'data-narrow',
): void {
  useLayoutEffect(() => {
    const element = ref.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (element === null) return
    const mark = (width: number): void => { element.toggleAttribute(attribute, width <= breakpoint) }
    const style = getComputedStyle(element)
    // The marked width is the content box, which is what a container query
    // measures; an unset padding reads as no padding rather than as NaN.
    mark(element.clientWidth
      - (parseFloat(style.paddingLeft) || 0)
      - (parseFloat(style.paddingRight) || 0))
    // jsdom and the unit lane have no ResizeObserver: the measurement above is
    // then the only one, and the element keeps its first answer.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      /* v8 ignore next -- a resize delivery always carries its own box. */
      if (entry === undefined) return
      mark(entry.contentRect.width)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ref, breakpoint, attribute])
}
