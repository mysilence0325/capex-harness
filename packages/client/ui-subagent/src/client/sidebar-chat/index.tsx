/** Right-Sidebar presentation of an existing subagent Conversation. */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ISessions, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {
  PropsRenderFactories, PropsRenderSlots, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { NS } from '../locales.ts'
import css from './SidebarChat.module.css'

/** Stable implementation identity for the Sidebar tab body. */
export const SUBAGENT_CHAT_ID = '@deepseek-ai/dsh-client-ui-subagent'

/** Protocol host of a chat resource address: the key inside `dsh-resource://`. */
const SUBAGENT_CHAT_HOST = 'subagentchat'

/** Path scope of a chat resource address. */
const SUBAGENT_CHAT_SCOPE = 'session'

/** Resource-address prefix for an embedded Session chat. */
export const SUBAGENT_CHAT_ADDRESS = `dsh-resource://${SUBAGENT_CHAT_HOST}/${SUBAGENT_CHAT_SCOPE}/`

/** Value retained by one live chat resource occurrence. */
export interface SubagentChatResource {
  readonly address: SubagentAddress
  readonly reference: SessionReference
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    sidebarChat: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    subagentchat: SubagentChatResource
  }

  interface SlotMap {
    /** Session-scoped Conversation occurrence hosted by one Sidebar chat tab. */
    'sidebar.chat.conversation': { kind: 'single'; scope: 'session' }
  }
}

/**
 * Address one subagent Session together with the routing facts needed to restore it.
 * @param address - durable direct-parent subagent address.
 * @returns canonical Sidebar resource address.
 */
export function subagentChatAddress(address: SubagentAddress): string {
  const query = new URLSearchParams({
    parent: address.parentSessionId,
    mode: address.mode,
  })
  return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(address.childSessionId)}?${query}`
}

/**
 * Parse one canonical Sidebar chat resource address.
 *
 * The address is read out of the string rather than through `new URL`, because a
 * non-special scheme's host parsing is engine-dependent: Chromium 90 reports an
 * empty `hostname` for `dsh-resource://subagentchat/…` and leaves the whole
 * remainder in the opaque path, so a URL-based read calls every chat address
 * malformed on that engine. `protocolOf` reads the host out of the string for
 * that reason, and `parseFileAddress` splits the `file` protocol's address the
 * same way.
 * @param value - possible chat resource address.
 * @returns the encoded direct-parent address, or undefined for another or malformed resource.
 */
export function parseSubagentChatAddress(value: string): SubagentAddress | undefined {
  const prefix = `dsh-resource://${SUBAGENT_CHAT_HOST}`
  // The URL parser lower-cases both the scheme and the host, so the canonical
  // address is matched against that spelling.
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) return undefined
  const boundary = value.search(/[?#]/)
  const path = value.slice(prefix.length, boundary === -1 ? undefined : boundary)
  const [scope, child, ...extra] = path.split('/').filter(segment => segment !== '')
  if (!path.startsWith('/') || scope !== SUBAGENT_CHAT_SCOPE || child === undefined || extra.length > 0) return undefined
  const queryStart = value.indexOf('?')
  const hash = value.indexOf('#')
  const query = queryStart === -1 || (hash !== -1 && hash < queryStart)
    ? ''
    : value.slice(queryStart + 1, hash === -1 ? undefined : hash)
  const parameters = new URLSearchParams(query)
  const parentSessionId = parameters.get('parent')
  const mode = parameters.get('mode')
  if (parentSessionId === null || parentSessionId === '' || (mode !== 'one-shot' && mode !== 'continuable' && mode !== 'unknown')) {
    return undefined
  }
  try {
    const childSessionId = decodeURIComponent(child)
    return {
      parentSessionId: parentSessionId as SessionId,
      childSessionId: childSessionId as SessionId,
      mode,
    }
  } catch (_invalidEncoding) {
    return undefined
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

function isAbortRequested(signal: AbortSignal): boolean {
  return signal.aborted
}

function subagentChatResourceProvider(sessions: ISessions): ResourceProvider<'subagentchat'> {
  return {
    protocol: 'subagentchat',
    async *open(resourceAddress, { signal }) {
      const address = parseSubagentChatAddress(resourceAddress)
      if (address === undefined) throw new Error(`ui-subagent: invalid chat resource address "${resourceAddress}"`)
      if (isAbortRequested(signal)) return
      const reference = sessions.retain(address, { source: 'sidebarChat', signal })
      try {
        yield { ok: true, value: { address, reference } }
        await waitForAbort(signal)
      } finally {
        reference.release()
      }
    },
  }
}

/** Fixed Chat selection used by an embedded Conversation occurrence. */
export function FixedChatConversationView(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Props supplied to the child-Session Conversation host. */
export type ConversationSlotPanelProps = PropsRuntime<'sidebar.chat.conversation'> & PropsRenderFactories

/** Render the shared Conversation content for one explicitly provided child Session. */
export function ConversationSlotPanel({
  sessionId, useSession, useConversation, useSessions, renderFactorySlot,
}: ConversationSlotPanelProps) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const parentAvailabilityPending = session.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settling = (shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true)
    || parentAvailabilityPending
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
    slots: { views: FixedChatConversationView },
  })
}

/** Props supplied to the parent-Session Sidebar tab body. */
export type SidebarChatTabProps =
  PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'sidebar.chat.conversation'>

/** Bind a chat resource's child reference around its Conversation slot. */
export function SidebarChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }: SidebarChatTabProps) {
  const { tab } = useTabInfo()
  const resource = useResource<'subagentchat'>(tab.contentId)
  return (
    <div className={css.root} data-sidebar-chat="">
      {resource.value === undefined
        ? null
        : (
          <SessionProvider session={resource.value.reference}>
            {renderSlot('sidebar.chat.conversation', {})}
          </SessionProvider>
        )}
    </div>
  )
}

/**
 * Register the chat resource owner and its right-Sidebar presentation.
 * @param ctx - Client root carrying Sessions, resources, Slots, and Sidebar registries.
 * @param t - Chat namespace translator used for fallback tab titles.
 */
export function registerSidebarChat(ctx: Context, t: TranslateNS<typeof NS>): void {
  ctx.effect(
    () => ctx.resources.register(subagentChatResourceProvider(ctx.sessions)),
    'ui-subagent: Sidebar chat resources',
  )
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SUBAGENT_CHAT_ID,
    kind: 'subagentchat',
    patterns: [`${SUBAGENT_CHAT_ADDRESS}**`],
    priority: 'builtin',
    canOpen: address => parseSubagentChatAddress(address) !== undefined,
    title: (address) => {
      const child = parseSubagentChatAddress(address)?.childSessionId
      return child === undefined
        ? t('sidebar.chat')
        : ctx.sessions.list.getSnapshot().byId[child]?.projectionValues?.subagent?.label ?? child
    },
  } satisfies SidebarRightTabDefinition), 'ui-subagent: Sidebar chat type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: SUBAGENT_CHAT_ID,
    children: { 'sidebar.chat.conversation': { kind: 'single', scope: 'session' } },
  }, SidebarChatTab)), 'ui-subagent: Sidebar chat body')
  ctx.effect(() => ctx.slots.inject('sidebar.chat.conversation', () => ctx.slots.register({
    name: 'sidebar.chat.conversation',
  }, ConversationSlotPanel)), 'ui-subagent: Sidebar Conversation')
}
