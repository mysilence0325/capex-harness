// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from '../src/client/locales.ts'
import { StorageUsageRow } from '../src/client/StorageUsageRow.tsx'
import type {} from '../src/client/index.ts'

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const unusedHook = (() => { throw new Error('unused by storage settings row') }) as never
const kit = {
  useSessions: unusedHook,
  useSessionStatus: unusedHook,
  usePanelInfo,
  useSessionRetainInfo: () => undefined,
  useResource,
  useWorkspaces: unusedHook,
  ...allowAllAccess,
}

describe('StorageUsageRow', () => {
  it('shows grouped usage without a destructive action', async () => {
    const readUsage = vi.fn(async () => ({
      version: 1 as const,
      home: '/home/user',
      totalBytes: 3 * 1024 * 1024,
      measuredAt: '2026-10-22T00:00:00.000Z',
      categories: [
        { id: 'sessions' as const, bytes: 1024 * 1024 },
        { id: 'attachments' as const, bytes: 2 * 1024 * 1024 },
      ],
    }))
    render(<StorageUsageRow {...kit} t={makeTranslate(en)} readUsage={readUsage} />)
    await waitFor(() => { expect(screen.getByText('Total 3.0 MiB')).toBeTruthy() })
    expect(screen.getByText('Sessions 1.0 MiB')).toBeTruthy()
    expect(screen.getByText('Attachments 2.0 MiB')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /delete|purge/i })).toBeNull()
  })
})
