/**
 * The gateway's pnpm entry binding.
 *
 * The gateway ships the pinned pnpm as a bare `dist/pnpm/bin/pnpm.cjs`, invisible to
 * a PATH lookup. Making that entry reachable to the managed host (upstream's plugin
 * manager spawns a literal `pnpm` from the host environment) is the control plane's
 * PATH provision (design 02 §3.1): the gateway only resolves WHICH entry it hands to
 * `createControlPlane`.
 */
import { createRequire as nodeCreateRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePnpmEntry as resolveSharedPnpmEntry } from '@dsh-chamber/dsh-runtime'

const gatewayRequire = nodeCreateRequire(import.meta.url)

/**
 * Package-resolution fallback entries for the dev / npm-installed shape: pnpm is
 * a real dependency there and its `exports` hides `./bin/pnpm.cjs`; a resolution
 * failure yields NO entry (never a throw), so the bundled copy can still win.
 */
function packagePnpmEntries(): readonly string[] {
  try {
    return [join(dirname(gatewayRequire.resolve('pnpm')), 'bin', 'pnpm.cjs')]
  } catch {
    return []
  }
}

/**
 * Absolute path of the pnpm entry script the gateway runs: the bundled
 * `dist/pnpm` copy first (`fileURLToPath`, since `path.dirname` would mangle a
 * `file://` URL), then the resolved `pnpm` package bin. When every candidate is
 * absent the shared resolver returns its first, so existence stays the caller's
 * business (loud failure, never a silently different pnpm).
 */
export function resolvePnpmEntry(): string {
  return resolveSharedPnpmEntry({
    platform: process.platform,
    execPath: process.execPath,
    env: process.env,
    bundledDir: dirname(fileURLToPath(import.meta.url)),
    explicitEntries: packagePnpmEntries(),
  })
}
