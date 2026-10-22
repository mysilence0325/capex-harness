/** Read the Host-published local user identity used by the settings fallback. */
import type { LocalUserIdentity } from '@deepseek-ai/dsh-local-user/types'

/** Runtime global name shared with the local-user Host plugin. */
const IDENTITY_GLOBAL = '__DSH_IDENTITY__'

/**
 * Validate the browser-visible identity payload at the Host-injection boundary.
 * @param value - global value read from the rendered index.
 * @returns the display facts, or undefined when the composition has no identity.
 */
export function parseLocalIdentity(value: unknown): Pick<LocalUserIdentity, 'displayName' | 'login'> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.displayName !== 'string' || typeof record.login !== 'string') return undefined
  const displayName = record.displayName.trim()
  const login = record.login.trim()
  if (displayName === '' && login === '') return undefined
  return { displayName: displayName === '' ? login : displayName, login }
}

/**
 * Read the current local identity from the Host-injected global.
 * @returns display facts for the Host process user, or undefined when the page carries no identity.
 */
export function readLocalIdentity(): Pick<LocalUserIdentity, 'displayName' | 'login'> | undefined {
  return parseLocalIdentity(Reflect.get(globalThis, IDENTITY_GLOBAL))
}
