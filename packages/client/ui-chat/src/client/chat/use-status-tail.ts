/**
 * Mirror the transcript row that ends the flow onto its column.
 *
 * The running status separates itself from the row above it only while that row
 * holds output rather than the input a reader just sent. Which row that is stays
 * a DOM fact: a folded seat carries \`hidden\`, and a seat whose renderer emits
 * nothing — an open Turn's process control — leaves an empty slot. Chromium 90
 * evaluates neither the selector list that would ask for it nor \`:has()\`, so the
 * column states the fact as an attribute the stylesheet selects on, the way
 * ConversationHeader mirrors its tab strip.
 * @module @deepseek-ai/dsh-client-ui-chat/use-status-tail
 */

import { useLayoutEffect, type RefObject } from 'react'

/** Marker the column carries while the visible row before the running status holds output. */
const STATUS_TAIL_ATTRIBUTE = 'data-chat-status-tail'

/** Row kinds that carry input: the status never draws a rule between itself and a sent message. */
const INPUT_KINDS: ReadonlySet<string> = new Set(['user', 'steering', 'turn-trigger'])

/** Whether one column child contributes no visible row. */
function isBlankRow(row: Element): boolean {
  if (row.hasAttribute('hidden')) return true
  if (row.childNodes.length === 0) return true
  const slot = row.querySelector(':scope > [data-slot="conversation.chat.node"]')
  return slot !== null && slot.childNodes.length === 0
}

/** Whether one visible row holds the output the status is separated from. */
function holdsOutput(row: Element): boolean {
  if (row.hasAttribute('data-chat-group-key')) return true
  const kind = row.getAttribute('data-chat-flow-kind')
  return kind !== null && !INPUT_KINDS.has(kind)
}

/**
 * Mark the column while the visible row before the running status holds output.
 * @param columnRef - the transcript column holding both the flow rows and the status.
 * @param running - whether the running status is mounted.
 */
export function useStatusTail(columnRef: RefObject<HTMLElement | null>, running: boolean): void {
  useLayoutEffect(() => {
    if (!running) return
    const column = columnRef.current
    if (column === null) return
    const sync = (): void => {
      const status = column.querySelector(':scope > [data-chat-running]')
      let row = status === null ? null : status.previousElementSibling
      while (row !== null && isBlankRow(row)) row = row.previousElementSibling
      if (row !== null && holdsOutput(row)) column.setAttribute(STATUS_TAIL_ATTRIBUTE, 'output')
      else column.removeAttribute(STATUS_TAIL_ATTRIBUTE)
    }
    sync()
    // Seat visibility and slot content move without a Chat render, so the marker
    // follows the column's own mutations instead of a props change.
    const observer = new MutationObserver(sync)
    observer.observe(column, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] })
    return () => {
      observer.disconnect()
      column.removeAttribute(STATUS_TAIL_ATTRIBUTE)
    }
  }, [columnRef, running])
}
