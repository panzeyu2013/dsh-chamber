/**
 * Gateway seed-cache for desktop-synced chamber host packages (design 17
 * §9.3, 2026-12 Phase 3): the three chamber host packages
 * (dsh-host-client-graph, dsh-host-git-worktree, dsh-host-archive-cleanup —
 * the last added 2026-12, design 24) are no longer shipped inside
 * the gateway package — a connecting desktop uploads its own copies through
 * the authenticated `PUT /chamber/plugins` surface, and the gateway caches
 * them under `<stateDir>/chamber-plugins/<name>/` for the control-plane seed
 * registry (every spawn re-seeds from this cache, so runtime version switches
 * follow automatically).
 *
 * Version semantics: the cache holds the LAST-SYNCED desktop's copies. A
 * fresh gateway (no cache) hosts a plain dsh whose activation probe skips the
 * chamber host domains until the first desktop sync — the expected probe set
 * is derived from the ACTUAL cache contents (syncedHostDomainProbeNames →
 * activationProbeNamesForDomains; an empty cache yields the reduced base
 * set, not the binary hostDomains flag of the older runtime seam); the
 * syncing desktop then restarts dsh so the seeded profile picks the
 * packages up.
 *
 * Security: package names are whitelisted (the three host packages only); every
 * cache write is an atomic 0600 no-follow write under the 0700 stateDir
 * discipline; file sizes are bounded; package.json must parse and its `name`
 * must match the requested entry. The mobile client-plugin slot is NOT
 * syncable — it is packaged in the gateway distribution (mobile access is
 * bound to the gateway and has no desktop in the chain).
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOST_ARCHIVE_CLEANUP_INSERT,
  HOST_GIT_WORKTREE_INSERT,
  HOST_GRAPH_INSERT,
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
} from '@dsh-chamber/control-plane'
import type { Logger } from '@dsh-chamber/control-plane'
import { HOST_DOMAIN_PROBE_NAMES } from '@dsh-chamber/dsh-runtime'

/** Cache root under the gateway stateDir. */
export const SYNCED_PLUGIN_DIR = 'chamber-plugins'

/** The syncable chamber host packages (desktop-provided since 2026-12;
 *  insert id/name single-sourced from the control-plane seed registry
 *  (dedupe audit N3); dsh-host-archive-cleanup added 2026-12, design 24). */
export const SYNCABLE_HOST_PACKAGES = [
  HOST_GRAPH_INSERT,
  HOST_GIT_WORKTREE_INSERT,
  HOST_ARCHIVE_CLEANUP_INSERT,
] as const

/** The activation-probe domain each syncable host package backs (design 24
 *  §7 C: the probe expectation derives from the actually seeded packages —
 *  this map is the sync-cache side of HOST_DOMAIN_PROBE_NAMES). */
const HOST_PACKAGE_PROBE_DOMAINS: Readonly<Record<string, string>> = {
  '@dsh-chamber/dsh-host-client-graph': 'clientGraph/graph',
  '@dsh-chamber/dsh-host-git-worktree': 'gitWorktree/previewCreate',
  '@dsh-chamber/dsh-host-archive-cleanup': 'archiveCleanup/probe',
}

// Fail-fast drift pin (design 24 §7 C): the map's domain VALUES must equal
// the dsh-runtime authoritative set (HOST_DOMAIN_PROBE_NAMES) — a typo'd or
// one-sided domain aborts the gateway at load instead of passing a mounted
// chamber domain unprobed (same drift class as the map-miss throw below and
// dsh-runtime's activationProbeNamesForDomains unknown-name throw).
const mappedProbeDomains = new Set<string>(Object.values(HOST_PACKAGE_PROBE_DOMAINS))
if (mappedProbeDomains.size !== HOST_DOMAIN_PROBE_NAMES.length
  || HOST_DOMAIN_PROBE_NAMES.some(domain => !mappedProbeDomains.has(domain))) {
  throw new Error(
    'HOST_PACKAGE_PROBE_DOMAINS drifted from dsh-runtime HOST_DOMAIN_PROBE_NAMES '
      + '(add/remove the domain on BOTH sides: the gateway seed map and the shared activation-probe set)',
  )
}

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

/** One shared unsyncable-package refusal message (the route echoes it back
 * sanitized — a syncing desktop meeting an OLDER gateway release must see
 * why its package was refused instead of a bare 400). */
function unsyncableMessage(name: string): string {
  return `unsyncable package ${JSON.stringify(name)} (this gateway release cannot cache it — it may predate the package; update the gateway to match the connecting desktop)`
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
      if (slug === null) throw invalidInput(unsyncableMessage(name))
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
      if (dir === null) throw invalidInput(unsyncableMessage(name))
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

/** Chamber host domains whose synced package is actually present in the seed
 *  cache (design 24 §7 C, M2 derivation): replaces the binary all-or-none
 *  gate for partial syncs (old desktop ↔ new gateway, interrupted syncs).
 *  An empty list = a plain dsh (reduced probe set); the full list = all
 *  chamber domains. Fail-loud drift check: a syncable host package with no
 *  domain in HOST_PACKAGE_PROBE_DOMAINS throws instead of being silently
 *  skipped — dropping its probe row would let a mounted chamber domain pass
 *  activation unprobed (the same drift class the dsh-runtime
 *  activationProbeNamesForDomains unknown-name throw guards; the map miss is
 *  source-level metadata drift). Must stay in sync with
 *  HOST_DOMAIN_PROBE_NAMES in packages/dsh-runtime (same three domains).
 *  @param stateDir - gateway state root; presence is checked per package at
 *    <stateDir>/chamber-plugins/<scope-stripped name>/dist/index.js.
 *  @param packages - the syncable host package list to derive over (the
 *    module SYNCABLE_HOST_PACKAGES constant by default; injectable so tests
 *    can drive the fail-loud drift path — production callers never pass it). */
export function syncedHostDomainProbeNames(
  stateDir: string,
  packages: readonly { id: string; name: string }[] = SYNCABLE_HOST_PACKAGES,
): readonly string[] {
  const cacheRoot = join(stateDir, SYNCED_PLUGIN_DIR)
  const names: string[] = []
  for (const entry of packages) {
    const domain = HOST_PACKAGE_PROBE_DOMAINS[entry.name]
    if (domain === undefined) {
      throw new Error(
        `syncable host package ${JSON.stringify(entry.name)} has no activation probe domain (HOST_PACKAGE_PROBE_DOMAINS drift — add its domain or remove the package)`,
      )
    }
    const dir = join(cacheRoot, entry.name.slice('@dsh-chamber/'.length))
    if (existsSync(join(dir, 'dist', 'index.js'))) names.push(domain)
  }
  return names
}

/** Source dir for a synced host package (may not exist yet). */
export function syncedSourceDir(stateDir: string, name: string): string {
  const slug = slugFor(name) ?? 'unknown'
  return join(stateDir, SYNCED_PLUGIN_DIR, slug)
}
