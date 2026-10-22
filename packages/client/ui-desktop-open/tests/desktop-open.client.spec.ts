// @vitest-environment jsdom
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('desktop open launch request', () => {
  it('opens the document in an empty Session and clears only launch parameters', async () => {
    const runtime = await SlotTestRuntime.create()
    const sessionId = 'session-1' as SessionId
    const workspaceId = 'workspace-1' as WorkspaceId
    try {
      runtime.ctx.provide('uiWorkspace', {
        openWorkspace: vi.fn(async (id: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
          expect(id).toBe(workspaceId)
          beforeOpen(sessionId)
        }),
        openSession: vi.fn(),
      } as never)
      const openResource = vi.fn()
      runtime.ctx.provide('sidebarRight', { openResource } as never)
      runtime.workspaces.stub('create', async input => ({
        workspaceId,
        title: 'tmp',
        path: input.path,
        sessionIds: [],
      }) as never)
      const locale = new LocaleRuntime(runtime.ctx)
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      await runtime.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } })
      window.history.replaceState(null, '', '/?token=one&open=%2Ftmp%2Fdemo.docx&workspace=%2Ftmp')

      await runtime.mount({ inject: [...inject], apply })
      await vi.waitFor(() => {
        expect(runtime.workspaces.calls).toContainEqual({ method: 'create', args: [{ path: '/tmp' }] })
        expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/session-1/demo.docx')
      })
      expect(runtime.sessions.calls).toEqual([])
      expect(window.location.pathname).toBe('/')
      expect(window.location.search).toBe('?token=one')
    } finally {
      await runtime.dispose()
    }
  })

  it('leaves an incomplete launch request untouched', async () => {
    const runtime = await SlotTestRuntime.create()
    try {
      const locale = new LocaleRuntime(runtime.ctx)
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      window.history.replaceState(null, '', '/?token=one&open=%2Ftmp%2Fdemo.docx')
      await runtime.mount({ inject: [...inject], apply })
      expect(runtime.workspaces.calls).toEqual([])
      expect(window.location.search).toBe('?token=one&open=%2Ftmp%2Fdemo.docx')
    } finally {
      await runtime.dispose()
    }
  })
})
