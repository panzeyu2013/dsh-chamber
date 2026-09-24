/**
 * Gateway seed-cache for desktop-synced chamber host packages: they are not
 * shipped in the gateway, so a desktop uploads copies through the
 * authenticated `PUT /chamber/plugins`; the gateway caches them under
 * `<stateDir>/chamber-plugins/<name>/`, and every spawn re-seeds from this
 * cache. The cache holds the LAST-SYNCED desktop's copies: a fresh gateway
 * hosts a plain dsh whose activation probe derives from the ACTUAL cache
 * contents (empty cache = reduced base set, not a hostDomains flag).
 * Security: whitelisted registry-derived names only; package.json must parse
 * with a matching `name`; atomic 0600 no-follow writes under 0700 stateDir.
 * The mobile plugin slot ships with the gateway and is never synced.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CHAMBER_HOST_PACKAGES,
  HOST_PACKAGE_SEED_FILES,
  assertHostSeedInsertNaming,
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
} from '@dsh-chamber/control-plane'
import type { HostPackageSeedFile, Logger } from '@dsh-chamber/control-plane'
import { HOST_DOMAIN_PROBE_NAMES } from '@dsh-chamber/dsh-runtime'
import { readPrivateTextOrNull } from './private-read.ts'

/** Cache root under the gateway stateDir. */
export const SYNCED_PLUGIN_DIR = 'chamber-plugins'

/** The syncable chamber host packages — DERIVED from the control-plane's
 *  authoritative registry, never a hand-maintained parallel list. */
export const SYNCABLE_HOST_PACKAGES = CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.insert)

// Fail-fast naming pin: this list gates PUT /chamber/plugins, the cache slug
// and the probe derivation, so a non-canonical name aborts the gateway at load.
assertHostSeedInsertNaming(SYNCABLE_HOST_PACKAGES)

/** The activation-probe domain each syncable host package backs (derived from the seeded set). */
const HOST_PACKAGE_PROBE_DOMAINS: Readonly<Record<string, string>> = Object.fromEntries(
  CHAMBER_HOST_PACKAGES.map(descriptor => [descriptor.insert.name, descriptor.probe.method]),
)

// Fail-fast drift pin: the map's domain VALUES must equal the dsh-runtime
// authoritative set (HOST_DOMAIN_PROBE_NAMES), so a typo'd or one-sided domain
// aborts the gateway at load instead of passing a mounted chamber domain unprobed.
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

/**
 * The upload/cache file set — DERIVED from the control-plane seed tuple
 * (`HOST_PACKAGE_SEED_FILES`), so desktop and cache speak one set.
 */
export const SYNCED_PLUGIN_FILES: readonly HostPackageSeedFile[] = HOST_PACKAGE_SEED_FILES

/** Wire shape of one upload, keyed by package-relative seed path (a new tuple member without a carrier fails to compile). */
export type SyncedPluginFiles = { [K in HostPackageSeedFile]: string }

/** Per-file cache size bound: a new declared file with no bound here is a compile error. */
const SYNCED_FILE_MAX_BYTES: Record<HostPackageSeedFile, number> = {
  'package.json': SYNCED_PACKAGE_MAX_BYTES,
  'dist/index.js': SYNCED_ARTIFACT_MAX_BYTES,
}

/** The declared member carrying the manifest (name/version anchor); dropping package.json is a compile error. */
const MANIFEST_SEED_FILE: HostPackageSeedFile = 'package.json'

export interface ChamberPlugins {
  /** Non-secret cached projection: name + version per synced host package. */
  list(): Array<{ name: string; version: string | null }>
  /** Validate + atomically cache one upload; throws on invalid input (route 400) or persistence failure (500). */
  put(name: string, files: SyncedPluginFiles): Promise<{ changed: boolean }>
}

function slugFor(name: string): string | null {
  const entry = SYNCABLE_HOST_PACKAGES.find(candidate => candidate.name === name)
  return entry === null || entry === undefined ? null : name.slice('@dsh-chamber/'.length)
}

/** Validation failure (route 400); persistence failures map to 500. `keep` hands
 * the route's sanitizer the caller's vocabulary so a scoped name is not redacted. */
function invalidInput(message: string, keep: readonly string[] = []): Error & { code: 'invalid_input'; keep?: readonly string[] } {
  const error = new Error(message) as Error & { code: 'invalid_input'; keep?: readonly string[] }
  error.code = 'invalid_input'
  if (keep.length > 0) error.keep = keep
  return error
}

/** Shared unsyncable-package refusal message (echoed back sanitized, so an older gateway says why). */
function unsyncableMessage(name: string): string {
  return `unsyncable package ${JSON.stringify(name)} (this gateway release cannot cache it — it may predate the package; update the gateway to match the connecting desktop)`
}

/** Read one cache file (0600 no-follow, bounded); null when absent. */
function readCacheFile(path: string, maxBytes: number): string | null {
  return readPrivateTextOrNull(path, { tightenMode: 0o600, requiredMode: 0o600, maxBytes })
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
    const manifest = readCacheFile(join(dir, MANIFEST_SEED_FILE), SYNCED_PACKAGE_MAX_BYTES)
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
      if (slug === null) throw invalidInput(unsyncableMessage(name), [name])
      // Presence + size validation over the SHARED seed file set: a missing member is refused, not dropped.
      const declared: Array<{ relative: HostPackageSeedFile; text: string }> = []
      for (const relative of SYNCED_PLUGIN_FILES) {
        const text = files[relative]
        if (typeof text !== 'string') {
          throw invalidInput(`plugin upload must carry ${SYNCED_PLUGIN_FILES.join(' and ')}`)
        }
        declared.push({ relative, text })
      }
      for (const { relative, text } of declared) {
        if (Buffer.byteLength(text) > SYNCED_FILE_MAX_BYTES[relative]) {
          throw invalidInput(relative === MANIFEST_SEED_FILE
            ? 'plugin package.json exceeds the size bound'
            : `plugin ${relative} exceeds the size bound`)
        }
      }
      const manifestText = files[MANIFEST_SEED_FILE]
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
      if (dir === null) throw invalidInput(unsyncableMessage(name), [name])
      // Atomic 0600 publication under the 0700 cache root (no-follow; pnpm may
      // prune the profile target, never this cache). Parents become real dirs.
      mkdirSync(cacheRoot, { recursive: true, mode: 0o700 })
      ensurePrivateDirectoryNoFollow(cacheRoot, 0o700, { existingMode: 'preserve' })
      ensurePrivateDirectoryNoFollow(dir, 0o700, { existingMode: 'preserve' })
      for (const { relative } of declared) {
        const parent = dirname(join(dir, relative))
        if (parent !== dir) {
          ensurePrivateDirectoryNoFollow(parent, 0o700, { existingMode: 'preserve' })
        }
      }
      const targets = declared.map(entry => ({
        relative: entry.relative,
        text: entry.text,
        target: join(dir, entry.relative),
        current: readCacheFile(join(dir, entry.relative), SYNCED_FILE_MAX_BYTES[entry.relative]),
      }))
      const changed = targets.some(entry => entry.current !== entry.text)
      if (!changed) return { changed }
      for (const entry of targets) {
        atomicWritePrivateFileNoFollow(entry.target, entry.text, { mode: 0o600 })
      }
      logger.log(`chamber-plugins: synced ${name} v${manifest.version}`)
      return { changed }
    },
  }
}

/** Chamber host domains whose synced package is actually present in the seed
 *  cache: per-package presence for partial syncs. Empty list = a plain dsh
 *  (reduced probe set); the full list = all chamber domains. Fail-loud drift
 *  check: a syncable package with no domain in HOST_PACKAGE_PROBE_DOMAINS throws
 *  instead of being silently skipped, which would let a mounted chamber domain
 *  pass activation unprobed. */
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
