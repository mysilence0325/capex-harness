/**
 * Width markers for the conversation header's title row.
 *
 * The row was the container query's container for the header occupants that
 * shed their text, so it states the widths itself and every engine reads them;
 * Chromium 90 has no container queries (chrome 105).
 */
import type { RefObject } from 'react'
import { useNarrowAttribute } from '@deepseek-ai/dsh-client-ui-primitives'

/** Content width (CSS pixels) at or below which the preset label yields. */
const NARROW_TITLE_ROW_WIDTH = 540
/** Content width (CSS pixels) at or below which header actions keep only their icons. */
const TIGHT_TITLE_ROW_WIDTH = 480

/**
 * Mark the title row at both header-occupant widths.
 * @param ref - The row that carries `container-type: inline-size`.
 */
export function useTitleRowMarkers(ref: RefObject<HTMLElement | null>): void {
  useNarrowAttribute(ref, NARROW_TITLE_ROW_WIDTH, 'data-narrow')
  useNarrowAttribute(ref, TIGHT_TITLE_ROW_WIDTH, 'data-tight')
}
