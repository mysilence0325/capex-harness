/**
 * Host-architecture inputs for the JavaScript build phase.
 *
 * Bundlers link native bindings that emulation cannot load, so the JavaScript
 * phase runs in a container for the daemon's own architecture. That container
 * needs its own Node.js, which the primary-runtime lock pins for both Linux
 * architectures the build supports.
 */

import primaryRuntimeLock from '../primary-runtime/lock.json' with { type: 'json' }

const LOCK = primaryRuntimeLock

/**
 * Locked Node.js archive for the architecture a build container runs on.
 * @param platform - Docker platform reported by the daemon, e.g. `linux/amd64`.
 * @returns The locked archive URL and its SHA-256.
 */
export function hostNodeArchive(platform: string): { readonly url: string; readonly sha256: string } {
  const target = platform.endsWith('/arm64') ? 'linux-arm64' : 'linux-x64'
  const entry = LOCK.targets[target]
  return {
    url: `https://nodejs.org/dist/v${LOCK.nodeVersion}/node-v${LOCK.nodeVersion}-${entry.nodeArchive}`,
    sha256: entry.nodeSha256,
  }
}
