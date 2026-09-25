/**
 * The control-plane seed for the chamber host package that exposes the host boot
 * graph. To read that graph the local host needs a chamber-owned package exposing
 * it over a Remote (`clientModules.graph()`). This module distributes it into the
 * managed local profile and materializes the `--patch` overlay that mounts it:
 * ensureSeedPackage copies package.json + dist/index.js into
 * <dshHome>/profiles/web/node_modules/@dsh-chamber/<pkg>/ (the anchor user plugins
 * resolve from; in-sync copies are skipped, drifted ones overwritten), and
 * buildPatchOverlay writes <stateDir>/dsh-chamber-graph.patch.yml in the shared
 * loader-patch format. Both are idempotent; the overlay rides every spawn and
 * applies at host boot. All paths derive from stateDir/dshHome; target parents are
 * real directory components and writes use the shared no-follow + fsync primitive.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// The loader `insert` row render/parse/conflict logic is single-sourced in
// cordis-inserts.ts; only the fail-loud message wording stays here.
import {
  hasExactInsert,
  insertConflict,
  renderCordisInserts,
  renderCordisOverlay,
  type CordisDisablePatch,
} from './cordis-inserts.ts'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
} from './private-file.ts'

/** The patch overlay file under <stateDir> (design 09 §3.1 方案 A). */
export const HOST_GRAPH_PATCH_FILENAME = 'dsh-chamber-graph.patch.yml'

/** The chamber host package the overlay mounts (design 09 方案 A, module A). */
export const HOST_GRAPH_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-client-graph'

/** Chamber-owned host package that executes Git worktree operations in-host. */
export const HOST_GIT_WORKTREE_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-git-worktree'

/** Chamber-owned host package that purges archived session content in-host. */
export const HOST_ARCHIVE_CLEANUP_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-archive-cleanup'

/** Chamber-owned host package that serves the local open-in domain in-host
 *  (the fork of upstream's open-in host half). LOCAL shape only — see `localOnly`. */
export const HOST_OPEN_IN_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-open-in'

/** Loader ids for the chamber-owned host packages. */
export const HOST_GRAPH_INSERT_ID = 'client-graph'
export const HOST_GIT_WORKTREE_INSERT_ID = 'git-worktree'
export const HOST_ARCHIVE_CLEANUP_INSERT_ID = 'archive-cleanup'
export const HOST_OPEN_IN_INSERT_ID = 'open-in'

/** A host package row that can be rendered into the shared loader overlay. */
export interface HostPackageInsert {
  id: string
  name: string
}

export const HOST_GRAPH_INSERT: HostPackageInsert = {
  id: HOST_GRAPH_INSERT_ID,
  name: HOST_GRAPH_PACKAGE_NAME,
}

export const HOST_GIT_WORKTREE_INSERT: HostPackageInsert = {
  id: HOST_GIT_WORKTREE_INSERT_ID,
  name: HOST_GIT_WORKTREE_PACKAGE_NAME,
}

export const HOST_ARCHIVE_CLEANUP_INSERT: HostPackageInsert = {
  id: HOST_ARCHIVE_CLEANUP_INSERT_ID,
  name: HOST_ARCHIVE_CLEANUP_PACKAGE_NAME,
}

export const HOST_OPEN_IN_INSERT: HostPackageInsert = {
  id: HOST_OPEN_IN_INSERT_ID,
  name: HOST_OPEN_IN_PACKAGE_NAME,
}

/**
 * The official web bundle's open-in HOST row and the id-targeted disable patch that
 * supersedes it whenever chamber's own open-in host package is seeded.
 *
 * The official CLIENT row now loads from the host graph (D2): its file-level
 * surfaces register, while its HEADER entry renders null here (the document-relative
 * open-in-app/* routes resolve to the control-plane origin, not the instance) and
 * chamber's seed-open-in registers the host Remote that owns the effective header
 * seat. The official HOST half would still mount its open-in webServer routes with
 * no caller, leaving a second live wire authority. The disable row rides the same
 * `--patch` overlay, which composes AFTER every bundle layer and both user layers,
 * so a user layer that
 * re-enables the row is superseded too. `disabled: true` means "never init"; an
 * unmatched row warns and skips.
 */
export const OFFICIAL_OPEN_IN_INSERT_ID = 'open-in-app'
export const OFFICIAL_OPEN_IN_PACKAGE_NAME = '@deepseek-ai/dsh-host-open-in-app'
export const OFFICIAL_OPEN_IN_DISABLE: CordisDisablePatch = {
  id: OFFICIAL_OPEN_IN_INSERT_ID,
  name: OFFICIAL_OPEN_IN_PACKAGE_NAME,
}

/**
 * One chamber host package: its loader overlay row plus the Typert Remote that
 * proves it live inside a RUNNING instance.
 *
 * THIS list is the single source for every chamber host domain's IDENTITY — the
 * loader insert id/name plus the liveness probe method/args — and consumers DERIVE
 * from it: the control-plane seed registry, the gateway's syncable/probe maps, the
 * desktop's local+remote injection probes and the plugin-management page.
 *
 * A new row still needs hand-registered wire-ups, each fail-loud when the domain is
 * absent: the control-plane local profile seed, the desktop remote/gateway source
 * dirs (plugin-sync.ts THROWS for a non-localOnly row with no sourceDir key) and
 * dsh-runtime's activation-probe registry + per-domain probe branch.
 */
export interface ChamberHostPackageDescriptor {
  /** The loader overlay row (id/name — see cordis-inserts.ts). */
  readonly insert: HostPackageInsert
  /** Liveness probe: the Remote method (`namespace/method`) and its args. The method
   *  MUST be one of dsh-runtime's `HOST_DOMAIN_PROBE_NAMES`; every probe must be cheap:
   *  a 404 from the dsh gateway means "boot row not loaded yet". */
  readonly probe: { readonly method: string; readonly args: unknown }
  /**
   * The domain is meaningful for the LOCAL instance shape only: a host domain that
   * acts on the machine the user sits at has nothing to serve on a remote server.
   * Honoured at the sync points (desktop remote upload/probe, every gateway's synced
   * cache) and by the plugin-management page, which lists such a row for the LOCAL
   * target only; the derived probe maps and HOST_DOMAIN_PROBE_NAMES stay COMPLETE
   * because the gateway's load-time set-equality pin compares them wholesale.
   */
  readonly localOnly?: true
}

/** The chamber host packages in seed order (the authoritative registry). */
export const CHAMBER_HOST_PACKAGES: readonly ChamberHostPackageDescriptor[] = [
  { insert: HOST_GRAPH_INSERT, probe: { method: 'clientGraph/graph', args: {} } },
  { insert: HOST_GIT_WORKTREE_INSERT, probe: { method: 'gitWorktree/previewCreate', args: { input: {} } } },
  { insert: HOST_ARCHIVE_CLEANUP_INSERT, probe: { method: 'archiveCleanup/probe', args: {} } },
  { insert: HOST_OPEN_IN_INSERT, probe: { method: 'openInApp/probe', args: {} }, localOnly: true },
]

/**
 * Fail-fast registry pin: every registry row must own a DISTINCT probe method, insert
 * id and package name (the gateway's set-equality pin compares only the SET of domain
 * values, so a reused domain would pass while the per-package activation-probe map
 * became ambiguous), and duplicate loader identities are unrepresentable in the
 * overlay. Throws, never warns; lives with the registry's owner and runs at load, so
 * every consumer is covered by construction.
 */
export function assertChamberHostRegistry(
  registry: readonly ChamberHostPackageDescriptor[] = CHAMBER_HOST_PACKAGES,
): void {
  const methods = new Set<string>()
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const descriptor of registry) {
    const { id, name } = descriptor.insert
    const method = descriptor.probe.method
    if (methods.has(method)) {
      throw new Error(
        `CHAMBER_HOST_PACKAGES: probe method '${method}' is claimed by more than one host package `
          + '(the per-package activation-probe map would be ambiguous)',
      )
    }
    if (ids.has(id)) throw new Error(`CHAMBER_HOST_PACKAGES: duplicate loader insert id '${id}'`)
    if (names.has(name)) throw new Error(`CHAMBER_HOST_PACKAGES: duplicate host package name '${name}'`)
    methods.add(method)
    ids.add(id)
    names.add(name)
  }
}

assertChamberHostRegistry()

/**
 * Seed registry: one seedable chamber package/plugin entry. The loader overlay row is
 * identical for every entry; `kind`/`source` drive the seed file set and source
 * resolution only.
 *
 * Consumers: the desktop control plane uses the host packages as base entries
 * (hostGraphPackageSourceDir / hostGitWorktreePackageSourceDir /
 * hostArchiveCleanupPackageSourceDir / hostOpenInPackageSourceDir); the gateway adds
 * extraSeedEntries — a client kind entry is a stub whose absent sourceDir is a warned
 * skip, never an error, and `localOnly` rows are never synced (the same skip applies).
 */
export type SeedEntryKind = 'host' | 'client'

/** Where a seed entry's bytes come from. 'packaged' = the owner's own dist;
 *  'desktop-synced' = a cache directory under the state root populated by a connecting desktop. */
export type SeedSource = 'packaged' | 'desktop-synced'

export interface SeedEntry {
  /** The loader overlay row (the only wire-relevant part). */
  insert: HostPackageInsert
  /** Loader target nature: 'host' packages resolve inside the dsh process and may back
   *  activation-probe domains; 'client' plugins load in the web frontend. */
  kind: SeedEntryKind
  source: SeedSource
  /** Packaged source directory (package.json + seedFiles). null/absent → skipped with
   *  the caller's warn (a stub whose package is not yet shipped). */
  sourceDir: string | null
  /** Seed file set; defaults to the host base (package.json + dist/index.js). */
  seedFiles?: readonly string[]
  /** Activation-probe domains this entry backs (kind 'host' only). Both seed-registry
   *  call sites derive it from the row (probeDomains: [descriptor.probe.method]); the
   *  remaining hand-registered consumer is dsh-runtime's HOST_DOMAIN_PROBE_NAMES, which
   *  stays complete even for `localOnly` rows. */
  probeDomains?: readonly string[]
}

/**
 * The canonical chamber host-seed package namespace: every kind 'host' entry is named
 * `@dsh-chamber/dsh-chamber-seed-<loader-id>`, matching its directory and loader id —
 * otherwise the profile directory, the overlay row and the probe domain disagree.
 */
export const HOST_SEED_PACKAGE_PREFIX = '@dsh-chamber/dsh-chamber-seed-'

/**
 * Fail loud when a host seed insert escapes the canonical namespace. Called by both
 * seed registries so a non-conforming host package can never be seeded, synced or
 * probed. Client kind entries are exempt — they are client plugins, not host seeds.
 */
export function assertHostSeedInsertNaming(inserts: readonly HostPackageInsert[]): void {
  for (const insert of inserts) {
    if (insert.name !== `${HOST_SEED_PACKAGE_PREFIX}${insert.id}`) {
      throw new Error(
        `chamber host seed: insert ${JSON.stringify(insert)} must be named `
          + `${HOST_SEED_PACKAGE_PREFIX}<loader-id> (kind 'host' ⇒ dsh-chamber-seed-<loader-id>)`,
      )
    }
  }
}

/** SeedEntry-level form of {@link assertHostSeedInsertNaming}. */
export function assertHostSeedEntryNaming(entries: readonly SeedEntry[]): void {
  assertHostSeedInsertNaming(entries.filter(entry => entry.kind === 'host').map(entry => entry.insert))
}

/**
 * The canonical overlay content: a top-level YAML array of loader patch entries —
 * `[{ insert: [{ id, name }] }]` possibly followed by id-targeted disable rows —
 * matching the shared loadOverlayPatches format (rendered by renderCordisOverlay in
 * cordis-inserts.ts). Insert names resolve through the profile node_modules anchor; a
 * disable row's name is the upstream bundle's own package specifier.
 */

/**
 * Reconcile chamber loader rows with the user's profile patch before writing packages
 * or an overlay: an exact single row is reused and omitted, and any id/name collision
 * or duplicate is rejected loudly so the next dsh boot cannot fail from a duplicate
 * loader id or a Remote mounted under two ids.
 */
export function missingHostPackageInserts(
  profilePatch: string | null,
  inserts: readonly HostPackageInsert[],
): HostPackageInsert[] {
  // Reuse the canonical renderer as the single validation point for desired
  // rows (valid syntax plus unique ids/names).
  renderCordisInserts(inserts)
  if (profilePatch === null) return inserts.map(entry => ({ ...entry }))

  const missing: HostPackageInsert[] = []
  for (const insert of inserts) {
    const conflict = insertConflict(profilePatch, insert)
    if (conflict !== null) {
      if (conflict === 'duplicate-identity') {
        throw new Error(
          `host package seed: profile patch contains duplicate loader identity for id '${insert.id}' or package '${insert.name}'`,
        )
      }
      if (conflict === 'id-bound') {
        throw new Error(`host package seed: loader id '${insert.id}' is already bound to a different package`)
      }
      throw new Error(`host package seed: package '${insert.name}' is already mounted under a different loader id`)
    }
    // No conflict: the row is exactly present (reused) or has no trace at all (still missing).
    if (!hasExactInsert(profilePatch, insert)) missing.push({ ...insert })
  }
  return missing
}

/**
 * Files seeded from each chamber host package (its complete runtime surface) — the
 * SINGLE SOURCE for every side that names that file set (local profile seed, desktop
 * remote seed writer + install probes, gateway upload payload, gateway sync cache +
 * packaged mobile seed). Hand-copying the pair would let a third seed file be written
 * locally while the desktop→gateway PUT carries two keys and the gateway still answers
 * 200/changed:true. ORDER IS PART OF THE CONTRACT: manifest first, built entry second.
 */
export const HOST_PACKAGE_SEED_FILES = ['package.json', 'dist/index.js'] as const

/** One package-relative seed file path. Every consumer keys its per-file table by this
 *  union, so an added member is a compile error on each side that cannot serve it. */
export type HostPackageSeedFile = (typeof HOST_PACKAGE_SEED_FILES)[number]

const MAX_SEED_TARGET_BYTES = 64 * 1024 * 1024

/** Stable target read. Only true absence is a cache miss; unsafe, oversized,
 * or concurrently replaced evidence fails loudly instead of being followed. */
function readSeedTarget(path: string, maxBytes = MAX_SEED_TARGET_BYTES): string | null {
  try {
    return readPrivateFileNoFollow(path, { tightenMode: 0o600, maxBytes }).value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Materialize the profile-owned resolution anchors one final component at a time: the
 *  official hoisted profile contract makes `web/node_modules` and its scope real
 *  directories (package entries beneath them may be pnpm links), while `profiles/web`
 *  remains an ordinary ancestor so established layouts can place it through a symlink. */
function ensureSeedTargetParent(dshHome: string, packageName: string, relative: string): string {
  const modulesDir = join(dshHome, 'profiles', 'web', 'node_modules')
  const scopeDir = join(modulesDir, '@dsh-chamber')
  const packageDir = join(scopeDir, packageName.slice('@dsh-chamber/'.length))
  const directoryOptions = { existingMode: 'preserve' as const }
  ensurePrivateDirectoryNoFollow(modulesDir, 0o700, directoryOptions)
  ensurePrivateDirectoryNoFollow(scopeDir, 0o700, directoryOptions)
  ensurePrivateDirectoryNoFollow(packageDir, 0o700, directoryOptions)
  // Any declared seed file beyond the package root (dist/, css/, …) gets its
  // own final-component parent — a real directory, never a symlink.
  const targetDir = dirname(join(packageDir, relative))
  if (targetDir !== packageDir) {
    ensurePrivateDirectoryNoFollow(targetDir, 0o700, directoryOptions)
  }
  return join(packageDir, relative)
}

/**
 * Ensure the host-graph patch overlay exists under <stateDir> and return its absolute
 * path. Idempotent: a content-matching file is left untouched; a drifted/absent file is
 * rewritten atomically with 0600 perms. Throws on write failure — the state root is the
 * plane's own layout, never a silent skip. `inserts` defaults to the client-graph row;
 * production passes OFFICIAL_OPEN_IN_DISABLE as `disables` exactly when the chamber
 * open-in host package is seeded, so the superseded official host half is never mounted.
 */
export function buildPatchOverlay(
  stateDir: string,
  inserts: readonly HostPackageInsert[] = [HOST_GRAPH_INSERT],
  disables: readonly CordisDisablePatch[] = [],
): string {
  const path = join(stateDir, HOST_GRAPH_PATCH_FILENAME)
  const content = renderCordisOverlay(inserts, disables)
  ensurePrivateDirectoryNoFollow(stateDir, 0o700, { existingMode: 'preserve' })
  if (readSeedTarget(path) === content) return path
  atomicWritePrivateFileNoFollow(path, content, { mode: 0o600 })
  return path
}

/**
 * Distribute one seed entry into the managed local profile so the spawned host can
 * resolve the overlay row: copy each declared seed file to
 * <dshHome>/profiles/web/node_modules/@dsh-chamber/<name>/. Idempotent per file
 * (identical bytes skipped, missing/drifted rewritten atomically with 0600).
 *
 * An absent sourceDir is NOT an error (the entry may not be built in this runtime), so
 * the caller decides how to surface the skip. A source that exists but is missing a
 * declared file, or a failed copy, throws: a shipped-but-broken entry is a packaging bug
 * and the plane surfaces it as a start error instead of booting a host whose --patch row
 * cannot resolve.
 */
export function ensureSeedPackage(
  dshHome: string,
  packageName: string,
  sourceDir: string | null,
  seedFiles?: readonly string[],
): boolean {
  if (sourceDir === null || !existsSync(sourceDir)) return false
  if (!/^@dsh-chamber\/[a-zA-Z0-9._-]+$/.test(packageName)) {
    throw new Error(`chamber seed: invalid chamber package name ${JSON.stringify(packageName)}`)
  }
  const files = seedFiles ?? HOST_PACKAGE_SEED_FILES
  if (files.length === 0) {
    throw new Error('chamber seed: seedFiles must not be empty (an empty set would seed nothing yet emit an overlay row)')
  }
  let wrote = false
  for (const relative of files) {
    // Seed file paths are caller-trusted, but a malformed entry must fail loud instead of
    // escaping the package dir or silently seeding nothing.
    if (typeof relative !== 'string' || relative === '' || relative.startsWith('/') || relative.includes('\\')
      || relative.split('/').includes('..') || relative.split('/').includes('.')) {
      throw new Error(`chamber seed: invalid seed file path ${JSON.stringify(relative)}`)
    }
    const source = join(sourceDir, relative)
    if (!existsSync(source)) {
      throw new Error(`chamber seed: ${source} missing in package ${sourceDir}`)
    }
    // Source packages may live in the development tree or a packaged resource VFS, so their
    // read boundary stays unchanged. The chamber-owned target parent must be a real final
    // component: a pnpm operation may prune it, but may not redirect it.
    const sourceBytes = readFileSync(source)
    const target = ensureSeedTargetParent(dshHome, packageName, relative)
    const current = readSeedTarget(target, Math.max(MAX_SEED_TARGET_BYTES, sourceBytes.length))
    if (current !== null && sourceBytes.equals(Buffer.from(current))) continue
    atomicWritePrivateFileNoFollow(target, sourceBytes, { mode: 0o600 })
    wrote = true
  }
  return wrote
}
