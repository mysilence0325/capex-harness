/**
 * Shell evaluation order.
 *
 * `@deepseek-ai/dsh-client-web`'s first import installs the browser floor, so
 * it lands before any other client module — including every dynamic plugin
 * bundle, which the loader evaluates after the shell. Keeping the install in
 * its own module is what makes "first" a property of the entry rather than of
 * the imports inside {@link ./compat.ts}.
 * @module @deepseek-ai/dsh-client-web/src/compat-install
 */
import { installBrowserCompat } from './compat.ts'

installBrowserCompat()
