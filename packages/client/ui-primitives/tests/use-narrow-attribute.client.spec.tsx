// @vitest-environment jsdom
/**
 * `useNarrowAttribute` wiring: the element that was a container query's
 * container carries the fact the stylesheet selects on instead.
 *
 * jsdom computes no layout, so the marked widths are stubbed: what is asserted
 * is the measurement the marker comes from (the content box, not the border
 * box), the re-measurement on every delivered size, and the release of the
 * observer on unmount.
 */
import { useRef } from 'react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useNarrowAttribute } from '../src/useNarrowAttribute.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** One recorded `ResizeObserver` instance, so a test can deliver a size. */
interface Recorded {
  deliver: (width: number) => void
  observed: Element[]
  disconnected: boolean
}

/**
 * Install a recording `ResizeObserver` double.
 * @returns the list every constructed observer registers itself in.
 */
function stubResizeObserver(): Recorded[] {
  const made: Recorded[] = []
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: (entries: [{ contentRect: { width: number } }]) => void) {
      const record: Recorded = {
        deliver: (width) => { callback([{ contentRect: { width } }]) },
        observed: [],
        disconnected: false,
      }
      made.push(record)
      this.record = record
    }

    private readonly record: Recorded

    observe(element: Element) { this.record.observed.push(element) }
    disconnect() { this.record.disconnected = true }
  })
  return made
}

/** Host that marks one box. */
function Host({ breakpoint, attribute, padding }: {
  breakpoint: number
  attribute?: string
  padding?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useNarrowAttribute(ref, breakpoint, attribute)
  return <div ref={ref} data-testid="box" style={padding === undefined ? undefined : { padding }} />
}

describe('useNarrowAttribute', () => {
  it('marks the content box from the first measurement where no ResizeObserver exists', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(600)
    onTestFinished(() => { width.mockRestore() })

    render(<Host breakpoint={560} padding="0 24px" />)
    // 600px of padding box minus 24px on each side is inside the cut; the
    // padding box alone would not be.
    expect(screen.getByTestId('box').hasAttribute('data-narrow')).toBe(true)

    width.mockReturnValue(600 + 48)
    cleanup()
    render(<Host breakpoint={560} padding="0 24px" />)
    expect(screen.getByTestId('box').hasAttribute('data-narrow')).toBe(false)
  })

  it('marks an unset padding as no padding and honours another attribute name', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400)
    onTestFinished(() => { width.mockRestore() })

    render(<Host breakpoint={480} attribute="data-tight" />)
    const box = screen.getByTestId('box')
    expect(box.hasAttribute('data-tight')).toBe(true)
    expect(box.hasAttribute('data-narrow')).toBe(false)
  })

  it('follows every delivered size and releases the observer on unmount', () => {
    const made = stubResizeObserver()
    const { unmount } = render(<Host breakpoint={540} />)
    const box = screen.getByTestId('box')
    // jsdom reports a zero-width box, which is inside every cut.
    expect(box.hasAttribute('data-narrow')).toBe(true)
    const [observer] = made
    expect(observer).toBeDefined()

    observer!.deliver(700)
    expect(box.hasAttribute('data-narrow')).toBe(false)
    observer!.deliver(540)
    expect(box.hasAttribute('data-narrow')).toBe(true)
    expect(observer!.observed).toEqual([box])

    unmount()
    expect(observer!.disconnected).toBe(true)
  })
})
