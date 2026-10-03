// @vitest-environment jsdom

import { useRef, type ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useStatusTail } from '../src/client/chat/use-status-tail.ts'

/** The transcript column. Rows are mutated through the DOM, as the seats do. */
function Column({ running, children }: { readonly running: boolean; readonly children?: ReactNode }) {
  const columnRef = useRef<HTMLDivElement>(null)
  useStatusTail(columnRef, running)
  return <div ref={columnRef} data-chat-flow="">{children}</div>
}

/** A component whose ref never reaches an element. */
function DetachedColumn() {
  useStatusTail(useRef<HTMLDivElement>(null), true)
  return null
}

const TAIL_ATTRIBUTE = 'data-chat-status-tail'

function element(attributes: Record<string, string>): HTMLDivElement {
  const created = document.createElement('div')
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, value)
  return created
}

/** One visible flow row of the given kind. */
function flowRow(kind: string): HTMLDivElement {
  const created = element({ 'data-chat-flow-kind': kind })
  created.append(document.createTextNode('row'))
  return created
}

function statusRow(): HTMLDivElement {
  return element({ 'data-chat-running': '' })
}

/** Let the column's MutationObserver deliver its queued records. */
async function settled(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function columnOf(view: ReturnType<typeof render>): HTMLElement {
  return view.container.querySelector<HTMLElement>('[data-chat-flow]')!
}

afterEach(() => { cleanup() })

describe('useStatusTail', () => {
  it('marks the column the running status follows output in', () => {
    const view = render(
      <Column running>
        <div data-chat-flow-kind="user">sent</div>
        <div data-chat-flow-kind="assistant-step">answer</div>
        <div data-chat-running="" />
      </Column>,
    )
    expect(columnOf(view).getAttribute(TAIL_ATTRIBUTE)).toBe('output')
  })

  it('leaves the mark off while an input ends the flow and follows later rows', async () => {
    const view = render(<Column running />)
    const column = columnOf(view)
    const answer = flowRow('assistant-step')
    column.append(answer, flowRow('user'), statusRow())
    await settled()
    expect(column.hasAttribute(TAIL_ATTRIBUTE)).toBe(false)
    const later = flowRow('assistant-step')
    column.insertBefore(later, column.lastElementChild)
    await settled()
    expect(column.getAttribute(TAIL_ATTRIBUTE)).toBe('output')
    later.setAttribute('hidden', 'until-found')
    await settled()
    expect(column.hasAttribute(TAIL_ATTRIBUTE)).toBe(false)
  })

  it('reads every input kind and a row without one as no output', async () => {
    const unkinded = element({})
    unkinded.append(document.createTextNode('queued'))
    for (const row of [flowRow('user'), flowRow('steering'), flowRow('turn-trigger'), unkinded]) {
      const view = render(<Column running />)
      const column = columnOf(view)
      column.append(row, statusRow())
      await settled()
      expect(column.hasAttribute(TAIL_ATTRIBUTE)).toBe(false)
      cleanup()
    }
  })

  it('skips hidden and empty seats to reach the row that ends the flow', async () => {
    const view = render(<Column running />)
    const column = columnOf(view)
    const answer = flowRow('assistant-step')
    const emptySeat = element({})
    const emptySlot = flowRow('assistant-step')
    emptySlot.replaceChildren(element({ 'data-slot': 'conversation.chat.node' }))
    column.append(answer, emptySeat, emptySlot, statusRow())
    await settled()
    expect(column.getAttribute(TAIL_ATTRIBUTE)).toBe('output')
    emptySlot.firstElementChild?.append(document.createTextNode('filled'))
    answer.setAttribute('hidden', 'until-found')
    await settled()
    expect(column.getAttribute(TAIL_ATTRIBUTE)).toBe('output')
    emptySlot.setAttribute('hidden', 'until-found')
    await settled()
    expect(column.hasAttribute(TAIL_ATTRIBUTE)).toBe(false)
  })

  it('marks a process group row that ends the flow', async () => {
    const view = render(<Column running />)
    const column = columnOf(view)
    const group = element({ 'data-chat-group-key': 'group:1' })
    group.append(document.createTextNode('process'))
    column.append(group, statusRow())
    await settled()
    expect(column.getAttribute(TAIL_ATTRIBUTE)).toBe('output')
  })

  it('clears the mark when the running window closes', async () => {
    const view = render(
      <Column running>
        <div data-chat-flow-kind="assistant-step">answer</div>
        <div data-chat-running="" />
      </Column>,
    )
    const column = columnOf(view)
    expect(column.getAttribute(TAIL_ATTRIBUTE)).toBe('output')
    view.rerender(
      <Column running={false}>
        <div data-chat-flow-kind="assistant-step">answer</div>
        <div data-chat-running="" />
      </Column>,
    )
    expect(column.hasAttribute(TAIL_ATTRIBUTE)).toBe(false)
    column.append(flowRow('assistant-step'))
    await settled()
    expect(column.hasAttribute(TAIL_ATTRIBUTE)).toBe(false)
  })

  it('clears the mark on unmount and stops following the column', async () => {
    const view = render(
      <Column running>
        <div data-chat-flow-kind="assistant-step">answer</div>
        <div data-chat-running="" />
      </Column>,
    )
    const column = columnOf(view)
    view.unmount()
    expect(column.hasAttribute(TAIL_ATTRIBUTE)).toBe(false)
    column.append(flowRow('assistant-step'))
    await settled()
    expect(column.hasAttribute(TAIL_ATTRIBUTE)).toBe(false)
  })

  it('tolerates a column ref that never reaches an element', () => {
    expect(() => render(<DetachedColumn />)).not.toThrow()
  })
})
