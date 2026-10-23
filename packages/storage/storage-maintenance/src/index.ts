/** Local data accounting and recoverable maintenance for one Harness home. */
import { readdir, readFile, rename, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { MaintenanceItem, MaintenanceManifest, MaintenanceResult, StorageUsage, StorageUsageCategory } from './types.ts'

export type * from './types.ts'

function inside(root: string, path: string): boolean {
  const base = resolve(root)
  const target = resolve(path)
  return target === base || target.startsWith(`${base}${sep}`)
}

async function directoryBytes(path: string): Promise<number> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let total = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await directoryBytes(child)
    else if (entry.isFile()) total += (await stat(child)).size
  }
  return total
}

async function newestMtime(path: string): Promise<number> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let newest = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(child))
    else if (entry.isFile()) newest = Math.max(newest, (await stat(child)).mtimeMs)
  }
  return newest
}

/**
 * Measure bounded local data categories without following symlinks.
 * @param home - Harness home.
 * @returns current usage and stable category totals.
 */
export async function maintenanceUsage(home: string): Promise<StorageUsage> {
  const categories: readonly StorageUsageCategory[] = await Promise.all([
    { id: 'sessions' as const, path: 'sessions' },
    { id: 'attachments' as const, path: 'attachments' },
    { id: 'cache' as const, path: 'cache' },
    { id: 'trash' as const, path: 'trash' },
    { id: 'storages' as const, path: 'storages' },
    { id: 'profiles' as const, path: 'profiles' },
    { id: 'logs' as const, path: 'logs' },
  ].map(async category => ({ id: category.id, bytes: await directoryBytes(join(home, category.path)) })))
  const known = categories.reduce((sum, category) => sum + category.bytes, 0)
  const totalBytes = await directoryBytes(home)
  return {
    version: 1,
    home,
    totalBytes,
    categories: [...categories, { id: 'other', bytes: Math.max(0, totalBytes - known) }],
    measuredAt: new Date().toISOString(),
  }
}

async function archivedIds(home: string): Promise<ReadonlySet<string>> {
  const value: unknown = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}'
    throw error
  }))
  if (typeof value !== 'object' || value === null || !('global' in value)) return new Set()
  const global = (value as { global?: unknown }).global
  if (typeof global !== 'object' || global === null || !('archivedSessionIds' in global)) return new Set()
  const ids = (global as { archivedSessionIds?: unknown }).archivedSessionIds
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
}

function attachmentIds(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/sha256:[a-f0-9]{64}/gu)) output.add(match[0])
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) attachmentIds(item, output)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) attachmentIds(item, output)
  }
}

async function localAttachmentItems(
  home: string, referenced: ReadonlySet<string>, cutoffMs: number,
): Promise<MaintenanceItem[]> {
  const root = join(home, 'attachments', 'v1')
  const items: MaintenanceItem[] = []
  const addTree = async (path: string): Promise<void> => {
    let info
    try { info = await stat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink()) return
    const bytes = info.isDirectory() ? await directoryBytes(path) : info.size
    if (info.isDirectory() && bytes === 0) return
    const newest = info.isDirectory() ? await newestMtime(path) : info.mtimeMs
    if (newest > cutoffMs) return
    const rel = relative(home, path)
    items.push({ kind: 'attachment', source: path, target: join(home, 'trash', 'maintenance', '__BATCH__', rel),
      bytes, reason: 'unreferenced attachment older than cutoff' })
  }
  for (const bucket of ['objects', 'file-objects']) {
    const bucketRoot = join(root, bucket)
    let prefixes
    try { prefixes = await readdir(bucketRoot, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue
      const entries = await readdir(join(bucketRoot, prefix.name), { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const id = `sha256:${entry.name}`
        if (!referenced.has(id)) await addTree(join(bucketRoot, prefix.name, entry.name))
      }
    }
  }
  const filesRoot = join(root, 'files')
  let refs: Dirent[] = []
  try { refs = await readdir(filesRoot, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    refs = []
  }
  for (const prefix of refs) {
    if (!prefix.isDirectory()) continue
    const entries = await readdir(join(filesRoot, prefix.name), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && !referenced.has(`sha256:${entry.name}`)) {
        await addTree(join(filesRoot, prefix.name, entry.name))
      }
    }
  }
  return items
}

/**
 * Build a recoverable dry-run plan for archived Sessions and unreferenced data.
 * @param options - home, persistence reader, cutoff, and plan clock.
 * @returns plan with stable trash targets and no filesystem mutation.
 */
export async function createMaintenancePlan(options: {
  readonly home: string
  readonly persistence: SessionPersistence
  readonly olderThanMs?: number
  readonly now?: Date
}): Promise<MaintenanceManifest> {
  const home = resolve(options.home)
  const now = options.now ?? new Date()
  const cutoffTime = now.getTime() - (options.olderThanMs ?? 90 * 24 * 60 * 60 * 1_000)
  const archived = await archivedIds(home)
  const snapshots = await options.persistence.list()
  const selected = new Set<string>()
  const items: MaintenanceItem[] = []
  for (const snapshot of snapshots) {
    if (!archived.has(snapshot.header.id)) continue
    if ((snapshot.modifiedAt ?? snapshot.header.createdAt) > cutoffTime) continue
    selected.add(snapshot.header.id)
    items.push({
      kind: 'session',
      source: `session:${snapshot.header.id}`,
      target: join(home, 'trash', 'maintenance', '__BATCH__', 'sessions', snapshot.header.id),
      bytes: snapshot.sizeBytes ?? 0,
      reason: `archived Session inactive before ${new Date(cutoffTime).toISOString()}`,
      sessionId: snapshot.header.id,
    })
  }
  const referenced = new Set<string>()
  for (const snapshot of snapshots) {
    if (selected.has(snapshot.header.id)) continue
    const handle = await options.persistence.open(snapshot.header.id, 'read')
    try {
      const stored = await handle.read()
      attachmentIds(stored.events, referenced)
    } finally {
      await handle.close()
    }
  }
  items.push(...await localAttachmentItems(home, referenced, cutoffTime))
  const cache = join(home, 'cache', 'attachments', 'request-images')
  const cacheBytes = await directoryBytes(cache)
  if (cacheBytes > 0 && await newestMtime(cache) <= cutoffTime) {
    items.push({
      kind: 'cache',
      source: cache,
      target: join(home, 'trash', 'maintenance', '__BATCH__', relative(home, cache)),
      bytes: cacheBytes,
      reason: 'regenerable request-image cache older than cutoff',
    })
  }
  const batch = `${now.toISOString().replaceAll(':', '-')}-${randomUUID()}`
  return {
    version: 1,
    batch,
    createdAt: now.toISOString(),
    cutoff: new Date(cutoffTime).toISOString(),
    home,
    items: items.map(item => ({ ...item, target: item.target.replace('__BATCH__', batch) })),
  }
}

function assertInsideHome(home: string, path: string): void {
  if (!inside(home, path)) throw new Error(`maintenance path escapes Harness home: ${path}`)
}

/**
 * Apply a dry-run plan by moving complete items into its recoverable batch.
 * @param plan - immutable plan returned by {@link createMaintenancePlan}.
 * @param persistence - persistence used for Session directory moves.
 * @returns per-item outcomes after every independent move settles.
 */
export async function applyMaintenancePlan(
  plan: MaintenanceManifest,
  persistence: SessionPersistence,
): Promise<MaintenanceResult> {
  const batchRoot = join(plan.home, 'trash', 'maintenance', plan.batch)
  await mkdir(batchRoot, { recursive: true, mode: 0o700 })
  const completed: string[] = []
  const failed: { source: string; message: string }[] = []
  const persistedItems: MaintenanceItem[] = []
  for (const item of plan.items) {
    try {
      assertInsideHome(plan.home, item.target)
      if (item.kind === 'session') {
        if (item.sessionId === undefined) throw new Error('Session maintenance item has no Session id')
        const moved = await persistence.relocate(item.sessionId as SessionId, item.target)
        persistedItems.push({ ...item, source: moved.source })
        completed.push(moved.source)
      } else {
        assertInsideHome(plan.home, item.source)
        await mkdir(dirname(item.target), { recursive: true, mode: 0o700 })
        await rename(item.source, item.target)
        persistedItems.push(item)
        completed.push(item.source)
      }
    } catch (error) {
      persistedItems.push(item)
      failed.push({ source: item.source, message: error instanceof Error ? error.message : String(error) })
    }
  }
  await writeFile(join(batchRoot, 'manifest.json'), `${JSON.stringify({ ...plan, items: persistedItems }, undefined, 2)}\n`, { mode: 0o600 })
  return { batch: plan.batch, completed, failed }
}

/**
 * Restore every item in one maintenance batch.
 * @param home - Harness home.
 * @param batch - batch directory name from `dsh clean --apply`.
 * @returns per-item restore outcomes.
 */
export async function restoreMaintenanceBatch(home: string, batch: string): Promise<MaintenanceResult> {
  assertInsideHome(home, join(home, 'trash', 'maintenance', batch))
  const root = join(home, 'trash', 'maintenance', batch)
  const parsed: unknown = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  if (!isMaintenanceManifest(parsed)) throw new Error(`maintenance batch "${batch}" has an invalid manifest`)
  const plan = parsed
  const completed: string[] = []
  const failed: { source: string; message: string }[] = []
  for (const item of [...plan.items].reverse()) {
    try {
      assertInsideHome(home, item.source)
      assertInsideHome(home, item.target)
      await stat(item.source).then(() => { throw new Error(`restore target already exists: ${item.source}`) }, (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      await mkdir(dirname(item.source), { recursive: true, mode: 0o700 })
      await rename(item.target, item.source)
      completed.push(item.target)
    } catch (error) {
      failed.push({ source: item.target, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { batch, completed, failed }
}

function isMaintenanceManifest(value: unknown): value is MaintenanceManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.batch !== 'string' || typeof record.createdAt !== 'string'
    || typeof record.cutoff !== 'string' || typeof record.home !== 'string' || !Array.isArray(record.items)) return false
  return record.items.every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
    const row = item as Record<string, unknown>
    return (row.kind === 'session' || row.kind === 'attachment' || row.kind === 'cache')
      && typeof row.source === 'string' && typeof row.target === 'string'
      && typeof row.bytes === 'number' && typeof row.reason === 'string'
      && (row.sessionId === undefined || typeof row.sessionId === 'string')
  })
}

/**
 * Permanently remove batches older than a cutoff. This is the only permanent
 * maintenance operation and requires its own explicit command.
 * @param home - Harness home.
 * @param olderThanMs - minimum batch age.
 * @param now - comparison clock.
 * @returns removed batches and reclaimed bytes.
 */
export async function purgeMaintenanceTrash(
  home: string,
  olderThanMs = 30 * 24 * 60 * 60 * 1_000,
  now = new Date(),
): Promise<MaintenanceResult> {
  const root = join(home, 'trash', 'maintenance')
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { batch: '', completed: [], failed: [], reclaimedBytes: 0 }
    throw error
  }
  const completed: string[] = []
  const failed: { source: string; message: string }[] = []
  let reclaimedBytes = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    try {
      const info = await stat(path)
      if (now.getTime() - info.mtimeMs < olderThanMs) continue
      reclaimedBytes += await directoryBytes(path)
      await rm(path, { recursive: true, force: true })
      completed.push(entry.name)
    } catch (error) {
      failed.push({ source: path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { batch: '', completed, failed, reclaimedBytes }
}

/** Remote-only usage projection consumed by the Settings shell. */
export class StorageMaintenance extends TypertRemoteService {
  static inject = ['profileContext']

  constructor(ctx: Context) {
    super(ctx, 'storageMaintenance')
  }

  /**
   * Measure the active Harness home.
   * @returns current local-data usage.
   */
  @Remote('usage')
  async usage(): Promise<StorageUsage> {
    return maintenanceUsage(this.ctx.profileContext.home)
  }
}

export default StorageMaintenance
