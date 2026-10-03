/** Shared menu material and the macOS backing that lets Chromium blur transparent windows. */
import { forwardRef, useCallback, useRef, type ComponentPropsWithoutRef } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useAnchoredPosition } from './useAnchoredPosition.ts'
import css from './MenuSurface.module.css'

/** Menu containers preserve native div props and refs. */
export interface MenuSurfaceProps extends ComponentPropsWithoutRef<'div'> {
  /** Match the shared compact menu's smaller outer radius. */
  compact?: boolean
}

/**
 * Paint a menu and, on macOS, an opaque backing behind the page content within its bounds.
 * The backing copies the menu's own rectangle, so it stays aligned while the menu is
 * placed, resized, or moved by a nested menu.
 * @param props - Div content and placement, and compact geometry.
 * @param ref - The visible menu div, excluding the non-interactive backing.
 * @returns Menu content plus a backing portal removed with the menu.
 */
export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface({
  compact = false, className, style, children, ...props
}, ref) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const backingRef = useRef<HTMLDivElement | null>(null)
  // The caller's ref contract stays on the menu div; the cover placement
  // measures that same element through this second ref.
  const attachSurface = useCallback((node: HTMLDivElement | null) => {
    surfaceRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref !== null) ref.current = node
  }, [ref])
  // The backing is mounted with the surface, so it tracks the menu for its whole life.
  const backingPosition = useAnchoredPosition({
    open: true, placement: 'cover', anchorRef: surfaceRef, panelRef: backingRef,
  })
  return <>
    <div {...props} ref={attachSurface} data-menu-material="translucent"
      className={clsx(css.surface, compact && css.compact, className)} style={style}>
      <div aria-hidden="true" className={css.material} />
      {children}
    </div>
    {createPortal(
      <div ref={backingRef} aria-hidden="true" data-menu-backing="" className={clsx(css.backing, compact && css.compact)}
        style={{ ...backingPosition, visibility: style?.visibility }} />,
      document.body,
    )}
  </>
})
