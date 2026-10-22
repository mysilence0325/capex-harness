/** Resolve the operating-system identity that owns the running Harness process. */
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

/** Browser global carrying the process owner's local account identity. */
export const LOCAL_USER_IDENTITY_GLOBAL = '__DSH_IDENTITY__'

/** Stable identity payload version accepted by the settings shell. */
export const LOCAL_USER_IDENTITY_VERSION = 1

/** Where a display name was resolved from. */
export type LocalUserNameSource = 'gecos' | 'env' | 'login'

/** Local account identity exposed to the browser. */
export interface LocalUserIdentity {
  readonly version: typeof LOCAL_USER_IDENTITY_VERSION
  readonly login: string
  readonly displayName: string
  readonly source: LocalUserNameSource
  readonly resolvedAt: string
}

/** Deployment controls for the bounded NSS account lookup. */
export interface Config {
  /** Maximum time spent asking NSS for the account entry. */
  readonly lookupTimeoutMs: number
}

/** Validated local identity configuration. */
export const Config: z<Config> = z.object({
  lookupTimeoutMs: z.natural().min(1).max(2_147_483_647).default(2_000),
})

/** Ambient process facts used by {@link resolveLocalUserIdentity}. */
export interface LocalUserIdentityOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => Date
  readonly timeoutMs?: number
  readonly readUserInfo?: () => { readonly username: string }
  readonly queryPasswd?: (login: string, timeoutMs: number) => string
}

function defaultLogin(options: LocalUserIdentityOptions): string {
  try {
    const login = (options.readUserInfo ?? userInfo)().username.trim()
    if (login !== '') return login
  } catch {
    // A minimal container may expose no passwd identity; environment login names remain usable.
  }
  const env = options.env ?? process.env
  return (env.USER ?? env.LOGNAME ?? '').trim()
}

function defaultPasswd(login: string, timeoutMs: number): string {
  return execFileSync('getent', ['passwd', login], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * Resolve the process owner's display name from GECOS, then an explicit
 * environment override, then the login name.
 * @param options - process and lookup seams; all have production defaults.
 * @returns a JSON-safe, versioned local identity payload.
 */
export function resolveLocalUserIdentity(options: LocalUserIdentityOptions = {}): LocalUserIdentity {
  const env = options.env ?? process.env
  const login = defaultLogin(options)
  const timeoutMs = options.timeoutMs ?? 2_000
  let displayName = ''
  let source: LocalUserNameSource = 'login'
  try {
    const entry = (options.queryPasswd ?? defaultPasswd)(login, timeoutMs)
    displayName = (entry.split(':')[4] ?? '').split(',')[0]?.trim() ?? ''
    if (displayName !== '') source = 'gecos'
  } catch {
    // getent may be absent, time out, or reject an NSS-only account; the explicit and login fallbacks cover it.
  }
  if (displayName === '') {
    displayName = (env.USER_FULLNAME ?? '').trim()
    if (displayName !== '') source = 'env'
  }
  if (displayName === '') {
    displayName = login
    source = 'login'
  }
  return {
    version: LOCAL_USER_IDENTITY_VERSION,
    login,
    displayName,
    source,
    resolvedAt: (options.now ?? (() => new Date()))().toISOString(),
  }
}

/**
 * Publish the process owner identity in every rendered Web index.
 * @param ctx - Host context collecting initialization rows.
 * @param config - bounded identity lookup controls.
 */
export function apply(ctx: Context, config: Config = { lookupTimeoutMs: 2_000 }): void {
  const identity = resolveLocalUserIdentity({ timeoutMs: config.lookupTimeoutMs })
  applyIdentity(ctx, identity)
}

/**
 * Publish an already-resolved identity. This keeps the browser injection
 * contract testable without mocking process or NSS lookup.
 * @param ctx - Host context collecting initialization rows.
 * @param identity - validated local identity payload.
 */
export function applyIdentity(ctx: Context, identity: LocalUserIdentity): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: LOCAL_USER_IDENTITY_GLOBAL, value: identity })
  })
}

export default apply
