/**
 * Gateway seed-cache for desktop-synced chamber host packages (design 17
 * §9.3, 2026-12 Phase 3): the two chamber host packages
 * (dsh-host-client-graph, dsh-host-git-worktree) are no longer shipped inside
 * the gateway package — a connecting desktop uploads its own copies through
 * the authenticated `PUT /chamber/plugins` surface, and the gateway caches
 * them under `<stateDir>/chamber-plugins/<name>/` for the control-plane seed
 * registry (every spawn re-seeds from this cache, so runtime version switches
 * follow automatically).
 *
 * Version semantics: the cache holds the LAST-SYNCED desktop's copies. A
 * fresh gateway (no cache) hosts a plain dsh whose activation probe skips the
 * chamber host domains (runtime-probes hostDomains=false) until the first
 * desktop sync; the syncing desktop then restarts dsh so the seeded profile
 * picks the packages up.
 *
 * Security: package names are whitelisted (the two host packages only); every
 * cache write is an atomic 0600 no-follow write under the 0700 stateDir
 * discipline; file sizes are bounded; package.json must parse and its `name`
 * must match the requested entry. The mobile client-plugin slot is NOT
 * syncable — it is packaged in the gateway distribution (mobile access is
 * bound to the gateway and has no desktop in the chain).
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
} from '@dsh-chamber/control-plane'
import type { Logger } from '@dsh-chamber/control-plane'

/** Cache root under the gateway stateDir. */
export const SYNCED_PLUGIN_DIR = 'chamber-plugins'

/** The syncable chamber host packages (desktop-provided since 2026-12). */
export const SYNCABLE_HOST_PACKAGES = [
  { id: 'client-graph', name: '@dsh-chamber/dsh-host-client-graph' },
  { id: 'git-worktree', name: '@dsh-chamber/dsh-host-git-worktree' },
] as const

export const SYNCED_PACKAGE_MAX_BYTES = 64 * 1024
export const SYNCED_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024
export const SYNCED_VERSION_MAX_CHARS = 128

export interface SyncedPluginFiles {
  'package.json': string
  'dist/index.js': string
}

export interface ChamberPlugins {
  /** Non-secret cached projection: name + version per synced host package. */
  list(): Array<{ name: string; version: string | null }>
  /** Validate + atomically cache one host package upload. Throws on invalid
   * input (the route maps to 400) and on persistence failure (500). */
  put(name: string, files: SyncedPluginFiles): Promise<{ changed: boolean }>
}

function slugFor(name: string): string | null {
  const entry = SYNCABLE_HOST_PACKAGES.find(candidate => candidate.name === name)
  return entry === null || entry === undefined ? null : name.slice('@dsh-chamber/'.length)
}

/** Validation failure (route maps to 400). Persistence failures (fs errors)
 * carry no such code and must map to 500 — see the /chamber/plugins route. */
function invalidInput(message: string): Error & { code: 'invalid_input' } {
  const error = new Error(message) as Error & { code: 'invalid_input' }
  error.code = 'invalid_input'
  return error
}

/** Read one cache file (0600 no-follow, bounded); null when absent. */
function readCacheFile(path: string, maxBytes: number): string | null {
  try {
    return readPrivateFileNoFollow(path, { tightenMode: 0o600, requiredMode: 0o600, maxBytes }).value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function createChamberPlugins(stateDir: string, logger: Logger): ChamberPlugins {
  const cacheRoot = join(stateDir, SYNCED_PLUGIN_DIR)

  function packageDir(name: string): string | null {
    const slug = slugFor(name)
    return slug === null ? null : join(cacheRoot, slug)
  }

  function cachedVersion(name: string): string | null {
    const dir = packageDir(name)
    if (dir === null) return null
    const manifest = readCacheFile(join(dir, 'package.json'), SYNCED_PACKAGE_MAX_BYTES)
    if (manifest === null) return null
    try {
      const parsed = JSON.parse(manifest) as { version?: unknown }
      return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null
    } catch {
      return null
    }
  }

  return {
    list() {
      return SYNCABLE_HOST_PACKAGES.map(entry => ({ name: entry.name, version: cachedVersion(entry.name) }))
    },

    async put(name, files) {
      const slug = slugFor(name)
      if (slug === null) throw invalidInput(`unsyncable package ${JSON.stringify(name)}`)
      const manifestText = files['package.json']
      const artifactText = files['dist/index.js']
      if (typeof manifestText !== 'string' || typeof artifactText !== 'string') {
        throw invalidInput('plugin upload must carry package.json and dist/index.js')
      }
      if (Buffer.byteLength(manifestText) > SYNCED_PACKAGE_MAX_BYTES) {
        throw invalidInput('plugin package.json exceeds the size bound')
      }
      if (Buffer.byteLength(artifactText) > SYNCED_ARTIFACT_MAX_BYTES) {
        throw invalidInput('plugin dist/index.js exceeds the size bound')
      }
      let manifest: { name?: unknown; version?: unknown }
      try {
        manifest = JSON.parse(manifestText) as { name?: unknown; version?: unknown }
      } catch {
        throw invalidInput('plugin package.json is not valid JSON')
      }
      if (manifest.name !== name) {
        throw invalidInput('plugin package.json name does not match the requested package')
      }
      if (typeof manifest.version !== 'string' || manifest.version.length === 0
        || manifest.version.length > SYNCED_VERSION_MAX_CHARS) {
        throw invalidInput('plugin package.json version is missing or oversized')
      }
      const dir = packageDir(name)
      if (dir === null) throw invalidInput(`unsyncable package ${JSON.stringify(name)}`)
      // Atomic 0600 publication under the 0700 cache root (no-follow
      // discipline; a pnpm operation may prune the profile target, but never
      // this gateway-owned cache).
      mkdirSync(cacheRoot, { recursive: true, mode: 0o700 })
      ensurePrivateDirectoryNoFollow(cacheRoot, 0o700, { existingMode: 'preserve' })
      ensurePrivateDirectoryNoFollow(dir, 0o700, { existingMode: 'preserve' })
      const distDir = join(dir, 'dist')
      ensurePrivateDirectoryNoFollow(distDir, 0o700, { existingMode: 'preserve' })
      const targetManifest = join(dir, 'package.json')
      const targetArtifact = join(distDir, 'index.js')
      const currentManifest = readCacheFile(targetManifest, SYNCED_PACKAGE_MAX_BYTES)
      const currentArtifact = readCacheFile(targetArtifact, SYNCED_ARTIFACT_MAX_BYTES)
      const changed = currentManifest !== manifestText || currentArtifact !== artifactText
      if (!changed) return { changed }
      atomicWritePrivateFileNoFollow(targetManifest, manifestText, { mode: 0o600 })
      atomicWritePrivateFileNoFollow(targetArtifact, artifactText, { mode: 0o600 })
      logger.log(`chamber-plugins: synced ${name} v${manifest.version}`)
      return { changed }
    },
  }
}

/** Standalone seed-cache presence check for the runtime probe shape gate. */
export function hasSyncedHostSeed(stateDir: string): boolean {
  const cacheRoot = join(stateDir, SYNCED_PLUGIN_DIR)
  return SYNCABLE_HOST_PACKAGES.every(entry => {
    const dir = join(cacheRoot, entry.name.slice('@dsh-chamber/'.length))
    return existsSync(join(dir, 'dist', 'index.js'))
  })
}

/** Source dir for a synced host package (may not exist yet). */
export function syncedSourceDir(stateDir: string, name: string): string {
  const slug = slugFor(name) ?? 'unknown'
  return join(stateDir, SYNCED_PLUGIN_DIR, slug)
}
