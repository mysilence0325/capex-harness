// @vitest-environment jsdom
/** Menu backing cover placement and lifetime. */
import { createRef } from 'react'
import { createPortal } from 'react-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MenuSurface } from '../src/MenuSurface.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('copies the menu rectangle onto its backing and removes it when unmounted', () => {
  const ref = createRef<HTMLDivElement>()
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(12, 34, 200, 48))
  const view = render(createPortal(<MenuSurface ref={ref} role="menu" compact><button>Action</button></MenuSurface>, document.body))
  const menu = screen.getByRole('menu')
  const backing = document.querySelector<HTMLElement>('[data-menu-backing]')!
  expect(ref.current).toBe(menu)
  // The opaque backing has to sit in the isolated body, outside the menu's own
  // stacking context, and land on the menu's rectangle.
  expect(backing.parentElement).toBe(document.body)
  expect(backing.getAttribute('aria-hidden')).toBe('true')
  expect(backing.style.left).toBe('12px')
  expect(backing.style.top).toBe('34px')
  expect(backing.style.width).toBe('200px')
  expect(backing.style.height).toBe('48px')
  view.unmount()
  expect(document.querySelector('[data-menu-backing]')).toBeNull()
})

it('hands the menu element to a callback ref and clears it on unmount', () => {
  const seen: (HTMLDivElement | null)[] = []
  const view = render(<MenuSurface role="menu" ref={(node) => { seen.push(node) }} />)
  const menu = screen.getByRole('menu')
  expect(seen).toEqual([menu])
  view.unmount()
  expect(seen).toEqual([menu, null])
})

it('gives simultaneously open menus independent backings and follows visibility changes', () => {
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLDivElement) {
    return new DOMRect(Number(this.dataset.anchorX ?? 0), 0, 100, 20)
  })
  const view = render(<><MenuSurface role="menu" data-anchor-x="10" /><MenuSurface role="menu" data-anchor-x="60" /></>)
  const backings = [...document.querySelectorAll<HTMLElement>('[data-menu-backing]')]
  expect(backings).toHaveLength(2)
  expect(backings.map(backing => backing.style.left)).toEqual(['10px', '60px'])
  view.rerender(<MenuSurface role="menu" style={{ visibility: 'hidden' }} />)
  expect(document.querySelector<HTMLElement>('[data-menu-backing]')!.style.visibility).toBe('hidden')
})
