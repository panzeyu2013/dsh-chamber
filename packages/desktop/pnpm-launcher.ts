/**
 * pnpm launcher resolution for the desktop main process.
 *
 * The candidate sets never name a `.cmd`: Node refuses to spawn `.cmd`/`.bat`
 * without a `shell` option (CVE-2024-27980 hardening, EINVAL); only the bundled
 * `pnpm.cjs` entry is offered, and the caller probes existence before launching.
 *
 * Pure module (no fs/electron): existence probes stay the caller's, and path joins
 * follow the TARGET platform, not the host.
 */
import { posix, win32 } from 'node:path'

function pathFor(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return pathFor(platform).join(...parts)
}


/**
 * Absolute `pnpm.cjs` entries for the desktop's OWN bundled/dev launcher, in preference
 * order — the ONE candidate set every desktop consumer reads (runtime installer pnpmEntry,
 * Swift sidecar assembly, `pnpm pack`, PATH bin-dir scan):
 *   1. `<resourcesPath>/pnpm/bin/pnpm.cjs`             packaged Electron extraResources
 *   2. `assemblyEntry`                                 Swift sidecar assembly entry
 *   3. `legacyAssemblyEntry`                           legacy sidecar assembly dir
 *   4. `<moduleDir>/node_modules/pnpm/bin/pnpm.cjs`    dev workspace tree
 * Sidecar layout spellings are passed in by sidecar-ctx (their Swift layout-lockstep
 * anchors); pure, the caller probes existence (firstExistingPnpmEntry).
 */
export function bundledPnpmEntryCandidates(input: {
  platform: NodeJS.Platform
  /** dirname(fileURLToPath(import.meta.url)) — the desktop package dir / sidecar dir. */
  moduleDir: string
  /** Electron `process.resourcesPath` (packaged app), or null/undefined in dev. */
  resourcesPath?: string | null
  /** Sidecar assembly entry (`<sidecarDir>/pnpm/bin/pnpm.cjs`), or null. */
  assemblyEntry?: string | null
  /** Legacy sidecar assembly entry (`<sidecarDir>/../pnpm/bin/pnpm.cjs`), or null. */
  legacyAssemblyEntry?: string | null
}): string[] {
  const entries: string[] = []
  if (typeof input.resourcesPath === 'string' && input.resourcesPath !== '') {
    entries.push(joinFor(input.platform, input.resourcesPath, 'pnpm', 'bin', 'pnpm.cjs'))
  }
  if (typeof input.assemblyEntry === 'string' && input.assemblyEntry !== '') {
    entries.push(input.assemblyEntry)
  }
  if (typeof input.legacyAssemblyEntry === 'string' && input.legacyAssemblyEntry !== '') {
    entries.push(input.legacyAssemblyEntry)
  }
  entries.push(joinFor(input.platform, input.moduleDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  return entries
}

/** First candidate that exists (the probe is the caller's), or null when none exists. */
export function firstExistingPnpmEntry(
  candidates: readonly string[],
  exists: (entry: string) => boolean,
): string | null {
  for (const entry of candidates) {
    if (exists(entry)) return entry
  }
  return null
}


