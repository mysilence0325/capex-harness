/** `dsh clean`: inspect and recoverably maintain local Harness data. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  applyMaintenancePlan,
  createMaintenancePlan,
  purgeMaintenanceTrash,
  restoreMaintenanceBatch,
} from '@deepseek-ai/dsh-storage-maintenance'

/** Parsed maintenance command. */
export interface CleanOptions {
  readonly olderThanMs: number
  readonly apply: boolean
  readonly json: boolean
  readonly restore?: string
  readonly purgeTrash: boolean
}

function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/u.exec(value)
  if (match === null) throw new Error(`clean: invalid duration ${JSON.stringify(value)}; use 90d, 12h, 30m, 10s, or 500ms`)
  const amount = Number(match[1])
  const unit = match[2]
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  const result = amount * multiplier
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`clean: duration is out of range: ${value}`)
  return result
}

/** Parse the command's small stable option surface. */
export function parseCleanArgs(args: readonly string[]): CleanOptions {
  let olderThanMs = 90 * 24 * 60 * 60 * 1_000
  let apply = false
  let json = false
  let restore: string | undefined
  let purgeTrash = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === '--apply') apply = true
    else if (arg === '--dry-run') apply = false
    else if (arg === '--json') json = true
    else if (arg === '--purge-trash') purgeTrash = true
    else if (arg === '--older-than') {
      const value = args[++index]
      if (value === undefined) throw new Error('clean: --older-than needs a duration')
      olderThanMs = durationMs(value)
    } else if (arg.startsWith('--older-than=')) {
      olderThanMs = durationMs(arg.slice('--older-than='.length))
    } else if (arg === '--restore') {
      const value = args[++index]
      if (value === undefined || value === '') throw new Error('clean: --restore needs a batch name')
      restore = value
    } else if (arg.startsWith('--restore=')) {
      restore = arg.slice('--restore='.length)
      if (restore === '') throw new Error('clean: --restore needs a batch name')
    } else if (arg === '--help' || arg === '-h') {
      printCleanHelp()
      process.exit(0)
    } else {
      throw new Error(`clean: unknown argument ${JSON.stringify(arg)}`)
    }
  }
  if (restore !== undefined && (apply || purgeTrash)) {
    throw new Error('clean: --restore cannot be combined with --apply or --purge-trash')
  }
  if (purgeTrash && apply) throw new Error('clean: --purge-trash cannot be combined with --apply')
  return { olderThanMs, apply, json, ...(restore === undefined ? {} : { restore }), purgeTrash }
}

function printCleanHelp(): void {
  process.stdout.write([
    'Usage: dsh clean [options]',
    '',
    'Inspect local Session, attachment, cache, and trash usage.',
    '',
    'Options:',
    '  --older-than <duration>  Select data older than 90d by default',
    '  --dry-run               Print the selection without moving data (default)',
    '  --apply                 Move selected data into a recoverable trash batch',
    '  --restore <batch>       Restore a maintenance batch',
    '  --purge-trash           Permanently remove trash batches older than --older-than',
    '  --json                  Print machine-readable JSON',
    '  -h, --help              Show this help',
    '',
  ].join('\n'))
}

function stateUrl(): string | undefined {
  const stateHome = process.env.XDG_STATE_HOME ?? (process.env.HOME === undefined ? undefined : join(process.env.HOME, '.local', 'state'))
  return stateHome === undefined ? undefined : join(stateHome, 'capex-harness', 'web-url')
}

async function serverRunning(): Promise<boolean> {
  const file = stateUrl()
  if (file === undefined) return false
  let url: string
  try { url = (await readFile(file, 'utf8')).trim() } catch { return false }
  if (url === '') return false
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1_000) })
    return true
  } catch {
    return false
  }
}

function renderBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

/**
 * Run one maintenance command and return its process exit code.
 * @param args - clean arguments after the command name.
 * @returns 0 on success, 1 when any item failed or maintenance was refused.
 */
export async function runClean(args: readonly string[]): Promise<number> {
  let options: CleanOptions
  try { options = parseCleanArgs(args) } catch (error) {
    process.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  const home = resolveDshHome()
  if (options.restore !== undefined) {
    const result = await restoreMaintenanceBatch(home, options.restore)
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `restored ${String(result.completed.length)} item(s)\n`)
    if (result.failed.length > 0) process.stderr.write(`${JSON.stringify(result.failed, undefined, 2)}\n`)
    return result.failed.length === 0 ? 0 : 1
  }
  if (options.purgeTrash) {
    const result = await purgeMaintenanceTrash(home, options.olderThanMs)
    process.stdout.write(options.json
      ? `${JSON.stringify(result)}\n`
      : `purged ${String(result.completed.length)} batch(es), reclaimed ${renderBytes(result.reclaimedBytes ?? 0)}\n`)
    if (result.failed.length > 0) process.stderr.write(`${JSON.stringify(result.failed, undefined, 2)}\n`)
    return result.failed.length === 0 ? 0 : 1
  }
  if (options.apply && await serverRunning()) {
    process.stderr.write('dsh: clean --apply requires the Capex Harness Web Host to be stopped\n')
    return 1
  }
  const ctx = new Context()
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
  try {
    const plan = await createMaintenancePlan({
      home,
      persistence: ctx.sessionPersistence,
      olderThanMs: options.olderThanMs,
    })
    if (!options.apply) {
      process.stdout.write(options.json
        ? `${JSON.stringify(plan, undefined, 2)}\n`
        : plan.items.map(item => `${item.kind}\t${renderBytes(item.bytes)}\t${item.source}\n`).join(''))
      if (plan.items.length === 0 && !options.json) process.stdout.write('nothing selected\n')
      return 0
    }
    const result = await applyMaintenancePlan(plan, ctx.sessionPersistence)
    process.stdout.write(options.json
      ? `${JSON.stringify(result, undefined, 2)}\n`
      : `moved ${String(result.completed.length)} item(s) to ${plan.batch}\n`)
    if (result.failed.length > 0) process.stderr.write(`${JSON.stringify(result.failed, undefined, 2)}\n`)
    return result.failed.length === 0 ? 0 : 1
  } finally {
    await fiber.dispose()
  }
}
