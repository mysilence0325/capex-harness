import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyMaintenancePlan, createMaintenancePlan, maintenanceUsage, purgeMaintenanceTrash, restoreMaintenanceBatch,
} from '../src/index.ts'

describe('maintenanceUsage', () => {
  it('groups known local data and ignores symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-maintenance-usage-'))
    try {
      await mkdir(join(home, 'sessions'), { recursive: true })
      await mkdir(join(home, 'attachments'), { recursive: true })
      await writeFile(join(home, 'sessions', 'a'), '1234')
      await writeFile(join(home, 'attachments', 'b'), '12')
      const usage = await maintenanceUsage(home)
      expect(usage.categories.find(item => item.id === 'sessions')?.bytes).toBe(4)
      expect(usage.categories.find(item => item.id === 'attachments')?.bytes).toBe(2)
      expect(usage.totalBytes).toBe(6)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('recoverable Session maintenance', () => {
  it('moves an old archived Session, restores it, and purges only an explicitly old batch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-maintenance-batch-'))
    const ctx = new Context()
    const fiber = await ctx.plugin(JsonlSessionPersistence, {
      root: join(home, 'sessions'),
      compression: 'none',
    })
    try {
      const archivedId = SessionId('archived-session')
      const liveId = SessionId('live-session')
      for (const id of [archivedId, liveId]) {
        const handle = await ctx.sessionPersistence.create({
          version: SESSION_FORMAT_VERSION,
          id,
          createdAt: 1,
          isSeeded: false,
          cwd: '/work',
        })
        await handle.flush()
        await handle.close()
      }
      await mkdir(join(home, 'storages'), { recursive: true })
      await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
        global: { archivedSessionIds: [archivedId] },
      }))

      const now = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000)
      const plan = await createMaintenancePlan({
        home,
        persistence: ctx.sessionPersistence,
        olderThanMs: 24 * 60 * 60 * 1_000,
        now,
      })
      expect(plan.items.map(item => item.sessionId)).toEqual([archivedId])

      const applied = await applyMaintenancePlan(plan, ctx.sessionPersistence)
      expect(applied).toMatchObject({ batch: plan.batch, failed: [] })
      expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).not.toContain(archivedId)
      const batchRoot = join(home, 'trash', 'maintenance', plan.batch)
      expect(JSON.parse(await readFile(join(batchRoot, 'manifest.json'), 'utf8'))).toMatchObject({ batch: plan.batch })

      const restored = await restoreMaintenanceBatch(home, plan.batch)
      expect(restored).toMatchObject({ batch: plan.batch, failed: [] })
      expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toContain(archivedId)

      await applyMaintenancePlan(plan, ctx.sessionPersistence)
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000)
      await utimes(batchRoot, old, old)
      const purged = await purgeMaintenanceTrash(home, 30 * 24 * 60 * 60 * 1_000)
      expect(purged.completed).toEqual([plan.batch])
      await expect(stat(batchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fiber.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})
