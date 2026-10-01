/** Resident conversation navigation and Session-specific header content. */
import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import type { ConversationHeaderProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import css from './ConversationRoot.module.css'

/**
 * Keeps global navigation available before a Session exists.
 * @param props - Optional Session sources and authorized header slots.
 * @returns The persistent header with any selected Session's title and views.
 */
export function ConversationHeader({ sessionId, useSession, useConversation, renderSlot }: ConversationHeaderProps) {
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const headerRef = useRef<HTMLElement>(null)
  // The tab strip arrives through a slot, so the header mirrors its marker onto
  // itself: the padding that depends on tabs then reads a local attribute in
  // every engine, including the ones that cannot evaluate :has().
  useEffect(() => {
    const header = headerRef.current
    /* v8 ignore next -- the ref is attached before effects run. */
    if (header === null) return
    const sync = (): void => {
      if (header.querySelector('[data-conversation-tabs]') === null) header.removeAttribute('data-header-tabs')
      else header.setAttribute('data-header-tabs', '')
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(header, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])
  const blank = session === undefined || conversation === undefined
    || (session.blank && conversationPhase(session, conversation) === 'blank')
  return (
    <header
      ref={headerRef}
      className={clsx(css.header, blank && css.headerBlank, sessionId === undefined && css.headerSessionless)}
      data-window-drag
    >
      <div className={css.headerLeading} data-conversation-header-leading="">
        {renderSlot('conversation.header.leading', {})}
      </div>
      {sessionId === undefined
        ? <div className={css.titleRow} />
        : renderSlot('conversation.session.header', { hideChrome: blank })}
    </header>
  )
}
