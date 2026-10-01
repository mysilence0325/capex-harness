import { useCallback, useEffect, useRef } from 'react'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function DefaultConversationViews({
  view, useSession, useConversation, useConversationViews, useInput, inputActions, useStore, actions,
  renderSlot, bindDraftMirror, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  const viewRequest = useStore(s => s.viewRequest ?? null)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  // A view that elects the full-bleed composer overlay marks its own root, and
  // the shell's layout keys on that mark. Watching this area's direct children
  // is what carries the mark up: a view mounts, unmounts, or switches there,
  // and a producer that set the mark after mounting would need an attribute
  // observer on the whole subtree, which the conversation's own inserts would
  // then flood.
  const overlayObserver = useRef<MutationObserver | null>(null)
  const overlayShell = useRef<Element | null>(null)
  const bindViewArea = useCallback((area: HTMLDivElement | null) => {
    overlayObserver.current?.disconnect()
    overlayObserver.current = null
    if (area === null) {
      overlayShell.current?.removeAttribute('data-composer-overlay')
      overlayShell.current = null
      return
    }
    const shell = area.closest('[data-conversation-shell]')
    overlayShell.current = shell
    if (shell === null) return
    const sync = (): void => {
      if (area.querySelector(':scope > [data-conversation-composer-overlay]') === null) shell.removeAttribute('data-composer-overlay')
      else shell.setAttribute('data-composer-overlay', '')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(area, { childList: true })
    overlayObserver.current = observer
  }, [])

  if (session.blank && conversationPhase(session, conversation) === 'blank') return null
  const viewId = view ?? active?.id
  return (
    <div className={css.viewArea} ref={bindViewArea}>
      {viewId !== undefined && renderSlot('conversation.view', {
        inspectCall,
        viewRequest,
        openView,
        completeViewRequest: actions.completeViewRequest,
      }, { only: viewId })}
    </div>
  )
}
