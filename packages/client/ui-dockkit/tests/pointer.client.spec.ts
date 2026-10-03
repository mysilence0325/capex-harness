// @vitest-environment jsdom
/**
 * The document-level pointer mark: a gesture's own `data-dockkit-pointer`
 * marker is reachable only through :has(), which Chromium 90 drops whole, so
 * followPointer publishes the document attribute the sidebar browser's webview
 * selects on instead.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { followPointer } from '../src/components/pointer.ts'

const MARK = 'data-dockkit-pointer-active'

const followers = { move: vi.fn(), up: vi.fn(), cancel: vi.fn() }

function element(): HTMLElement {
  const created = document.createElement('div')
  document.body.append(created)
  return created
}

afterEach(() => {
  document.body.replaceChildren()
  document.documentElement.removeAttribute(MARK)
  vi.clearAllMocks()
})

it('marks the document for as long as the gesture holds the pointer', () => {
  const card = element()
  expect(document.documentElement.hasAttribute(MARK)).toBe(false)
  const release = followPointer(card, 1, followers)
  expect(document.documentElement.hasAttribute(MARK)).toBe(true)
  expect(card.dataset.dockkitPointer).toBe('1')
  release()
  expect(document.documentElement.hasAttribute(MARK)).toBe(false)
  expect(card.dataset.dockkitPointer).toBeUndefined()
})

it('keeps the mark until the last concurrent gesture releases the pointer', () => {
  const first = element()
  const second = element()
  const releaseFirst = followPointer(first, 1, followers)
  const releaseSecond = followPointer(second, 2, followers)
  releaseFirst()
  expect(document.documentElement.hasAttribute(MARK)).toBe(true)
  releaseSecond()
  expect(document.documentElement.hasAttribute(MARK)).toBe(false)
})

it('clears the mark when the engine cancels the pointer', () => {
  const card = element()
  followPointer(card, 7, followers)
  window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 7 }))
  expect(document.documentElement.hasAttribute(MARK)).toBe(false)
  expect(followers.cancel).toHaveBeenCalledOnce()
})
