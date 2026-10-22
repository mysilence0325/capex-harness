/** Consume a desktop-launched file and open it in a new Session document preview. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { en, zh, type DesktopOpenKey } from './locales.ts'
import { DesktopOpenToast } from './Toast.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    desktopOpen: DesktopOpenKey
  }
}

const NS = 'desktopOpen'
const FILE_PARAM = 'open'
const WORKSPACE_PARAM = 'workspace'

/** Services required before a launch request can be adopted. */
export const inject = ['slots', 'locale']

interface LaunchRequest {
  readonly file: string
  readonly workspace: string
}

function readLaunchRequest(search: string): LaunchRequest | undefined {
  const params = new URLSearchParams(search)
  const file = params.get(FILE_PARAM)?.trim() ?? ''
  const workspace = params.get(WORKSPACE_PARAM)?.trim() ?? ''
  return file === '' || workspace === '' ? undefined : { file, workspace }
}

function clearLaunchRequest(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete(FILE_PARAM)
  url.searchParams.delete(WORKSPACE_PARAM)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || path
}

/**
 * Adopt one desktop launch request after Workspace and Session baselines are ready.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  const request = typeof window === 'undefined' ? undefined : readLaunchRequest(window.location.search)
  if (request === undefined) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-open: dictionaries')
  const t = ctx.locale.bind(NS)
  const notice = createSnapshotStore<string | null>(null)
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'desktop-open-notice',
    locale: NS,
    inject: () => ({ hooks: { message: notice }, dismiss: () => { notice.set(null) } }),
  }, DesktopOpenToast)), 'desktop-open: failure notice')

  ctx.inject(['workspaces', 'sessions', 'uiWorkspace', 'sidebarRight'], (scope) => {
    let started = false
    const start = (): void => {
      if (started) return
      if (scope.workspaces.list.getSnapshot().phase !== 'ready'
        || scope.sessions.list.getSnapshot().phase !== 'ready') return
      started = true
      clearLaunchRequest()
      void (async () => {
        const workspace = await scope.workspaces.create({ path: request.workspace })
        await scope.uiWorkspace.openWorkspace(workspace.workspaceId, (sessionId) => {
          scope.sidebarRight.openResource(fileAddressFor(sessionId, workspace.path, request.file))
        })
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        notice.set(t('openFailed', { name: fileName(request.file), message }))
      })
    }
    const disposeWorkspaces = scope.workspaces.list.subscribe(start)
    const disposeSessions = scope.sessions.list.subscribe(start)
    start()
    return () => { disposeWorkspaces(); disposeSessions() }
  })
}
