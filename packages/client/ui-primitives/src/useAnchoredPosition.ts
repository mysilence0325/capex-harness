/**
 * Keep a fixed-position floating element anchored to a trigger.
 *
 * A portaled panel is positioned from its anchor's viewport rect, which stops
 * being true the moment anything scrolls or the window resizes. This owns that
 * one concern: measure the anchor, then either offset the panel below or above
 * it and clamp the result inside the viewport, or copy the anchor's own
 * rectangle onto the panel, and re-run on scroll (capture phase, so scrollers
 * nested inside the page are caught too), on resize, and on the observed
 * element's own size changes while the element is open.
 * @module @deepseek-ai/dsh-client-ui-primitives/useAnchoredPosition
 */

import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { overlayTopMargin } from './overlay-top-margin.ts'

/** Placement inputs both placements share. */
interface AnchoredPositionTarget {
  /** Whether the floating element is mounted and should track its anchor. */
  open: boolean
  /** The element the panel is placed from. */
  anchorRef: RefObject<HTMLElement | null>
  /** The floating element the returned geometry is applied to; the side placement also measures it, so its clamp uses real dimensions. */
  panelRef: RefObject<HTMLElement | null>
}

/** Offset the panel from one anchor edge, clamped inside the viewport. */
interface AnchoredSidePlacement extends AnchoredPositionTarget {
  /** Placement to use; omit for the offset placement. */
  placement?: 'side'
  /** Which anchor edge the panel hangs from: below it (`bottom`, the default) or above it (`top`). */
  side?: 'top' | 'bottom'
  /** Which anchor edge the panel lines up with: its left edge (`start`, the default) or its right edge (`end`). */
  align?: 'start' | 'end'
  /** Distance kept between the anchor edge named by `side` and the panel. */
  gap: number
  /** Distance kept between the panel and each viewport edge; the frame's overlay inset widens the top margin. */
  margin: number
}

/** Overlay the panel on the anchor: the anchor's own rectangle becomes the panel's, with no offset and no clamp. */
interface AnchoredCoverPlacement extends AnchoredPositionTarget {
  /** Copy the anchor's rectangle — position and size — onto the panel, whatever the viewport shows. */
  placement: 'cover'
}

/** Inputs for {@link useAnchoredPosition}. */
export type AnchoredPositionOptions = AnchoredSidePlacement | AnchoredCoverPlacement

/**
 * Whether a measured panel geometry is the one already recorded, so a repeated
 * measurement renders nothing.
 * @param current - the recorded geometry, or null before the first measurement.
 * @param next - the geometry just measured.
 * @returns whether every recorded field already holds the measured value.
 */
function sameCoverGeometry(current: CSSProperties | null, next: CSSProperties): boolean {
  return current !== null && current.left === next.left && current.top === next.top
    && current.width === next.width && current.height === next.height
}

/**
 * Track an anchor and return the panel's fixed geometry.
 * @param options - the open state, the two refs, and the placement: either the
 *   offset placement's side, alignment, and gap/margin distances, or the cover
 *   placement that copies the anchor's rectangle.
 * @returns the panel's fixed geometry — `left`/`top` for the offset placement,
 *   `left`/`top`/`width`/`height` for the cover placement — or `null` before the
 *   first measurement.
 */
export function useAnchoredPosition(options: AnchoredPositionOptions): CSSProperties | null {
  const { open, anchorRef, panelRef } = options
  const cover = options.placement === 'cover'
  /** The offset placement's own inputs; the cover placement declares none of them. */
  const sidePlacement = cover ? null : options
  const side = sidePlacement?.side ?? 'bottom'
  const align = sidePlacement?.align ?? 'start'
  const gap = sidePlacement?.gap ?? 0
  const margin = sidePlacement?.margin ?? 0
  const [position, setPosition] = useState<CSSProperties | null>(null)

  /** Measure the anchor and record the geometry the active placement asks for. */
  const measure = useCallback((): void => {
    /* v8 ignore start -- geometry read from real layout: jsdom has no anchor
       rect, so the unmeasured-anchor arm runs in browser scenarios instead. */
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    /* v8 ignore stop */
    if (cover) {
      const next: CSSProperties = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      setPosition(current => sameCoverGeometry(current, next) ? current : next)
      return
    }
    /* v8 ignore start -- the clamp arms read real layout: jsdom reports zero
       offset sizes, so the positive-size arms are exercised by browser scenarios
       rather than unit tests. */
    const panel = panelRef.current
    const width = panel?.offsetWidth ?? 0
    const height = panel?.offsetHeight ?? 0
    let left = align === 'end' ? rect.right - width : rect.left
    let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap
    if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
    if (height > 0) top = Math.min(Math.max(top, overlayTopMargin(margin)), window.innerHeight - height - margin)
    /* v8 ignore stop */
    setPosition({ left, top })
  }, [anchorRef, panelRef, cover, side, align, gap, margin])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    // The side placement measures once per open, in the same commit that opened
    // it, so its clamp uses real dimensions before anything paints. The cover
    // placement measures after every commit instead (the effect below).
    if (!cover) measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    // The side placement's panel changes height without either event — a status
    // line appearing inside it, or a `resize: vertical` textarea dragged taller
    // — and a stale clamp would let a panel near the bottom edge cross the
    // margin it is supposed to respect. The cover placement instead follows the
    // anchor's own size, which the copy is made of. The guard keeps the hook
    // usable where `ResizeObserver` is absent, which is how jsdom runs.
    const observed = cover ? anchorRef.current : panelRef.current
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && observed !== null) {
      observer = new ResizeObserver(measure)
      observer.observe(observed)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, anchorRef, panelRef, cover, measure])

  // A caller can move the anchor without a scroll, a resize, or a size change:
  // Menu positions a portalled list in its own layout effect, which runs after
  // this child's, and tracks a dragged anchor every frame. Copying the anchor
  // after every commit keeps the panel over it in those cases; a measurement
  // that changed nothing renders nothing.
  useLayoutEffect(() => {
    if (open && cover) measure()
  })

  return position
}
