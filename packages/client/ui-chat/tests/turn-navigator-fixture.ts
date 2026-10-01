import { vi } from 'vitest'
import { act } from '@testing-library/react'

/**
 * Supply rail viewport sizes, band widths, and element-local scrolling absent
 * from jsdom.
 * @param initialHeight - first delivered height, or null to delay initial layout.
 * @returns size controls for the mounted rails and bands.
 */
export function installTurnNavigatorObserver(initialHeight: number | null = 300) {
  const rails = new Map<Element, Observer>()
  const bands = new Map<Element, Observer>()
  let height = initialHeight

  class Observer implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(element: Element): void {
      // The rail's own scroller sits inside the navigation landmark; anything
      // else observed is a rail band, whose width its marker reads.
      if (!(element instanceof HTMLElement) || element.parentElement?.tagName !== 'NAV') {
        bands.set(element, this)
        return
      }
      rails.set(element, this)
      element.scrollTo = (options: ScrollToOptions | number = {}, y?: number) => {
        const next = typeof options === 'number' ? y ?? 0 : options.top ?? element.scrollTop
        if (next === element.scrollTop) return
        element.scrollTop = next
        queueMicrotask(() => {
          if (element.isConnected) act(() => { element.dispatchEvent(new Event('scroll')) })
        })
      }
      queueMicrotask(() => {
        const currentHeight = height
        if (currentHeight !== null && rails.get(element) === this) act(() => { this.deliver(element, 36, currentHeight) })
      })
    }

    unobserve(element: Element): void {
      rails.delete(element)
      bands.delete(element)
    }

    disconnect(): void {
      for (const [element, observer] of rails) {
        if (observer === this) rails.delete(element)
      }
      for (const [element, observer] of bands) {
        if (observer === this) bands.delete(element)
      }
    }

    deliver(target: Element, inlineSize: number, blockSize: number): void {
      const size = [{ inlineSize, blockSize }]
      this.callback([{
        target,
        borderBoxSize: size,
        contentBoxSize: size,
        devicePixelContentBoxSize: size,
        contentRect: new DOMRectReadOnly(0, 0, inlineSize, blockSize),
      }], this)
    }
  }

  vi.stubGlobal('ResizeObserver', Observer)
  return {
    /** @param nextHeight - rail height every mounted rail observer delivers. */
    resize(nextHeight: number): void {
      height = nextHeight
      for (const [element, observer] of rails) observer.deliver(element, 36, height)
    },
    /** @param width - content-box width every mounted band observer delivers. */
    resizeBand(width: number): void {
      for (const [element, observer] of bands) observer.deliver(element, width, 0)
    },
  }
}
