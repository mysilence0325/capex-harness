/**
 * Web shell library entry. The shell's product is {@link AppWebEntry} —
 * apps/web's Vite entry runs it against #root. The boot page and fiber-state
 * projection remain internal; the static module table and its platform words
 * form the package's build-time contract.
 * @module @deepseek-ai/dsh-client-web
 */

// First: the browser floor every other module of this graph stands on.
import './compat-install.ts'

export { AppWebEntry, type BootSeams } from './boot.ts'
export { getStaticModules } from './seed.ts'
export { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS, type PlatformModule } from './platform.ts'
export { applyIndexInjections } from './apply-injections.ts'
