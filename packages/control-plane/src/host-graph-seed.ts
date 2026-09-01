/**
 * Todo 09 (方案 A) module B — the control-plane seed for the chamber host
 * package that exposes the host boot graph.
 *
 * Background (docs/design/09-client-plugin-runtime-loading.md §3.1 方案 A):
 * the chamber frontend loads dsh client plugins (`dsh.client` rows) at runtime
 * by merging the host's own boot graph (composed by the host's
 * `dsh-client-modules` service) with the chamber composite bundle. To read
 * that graph the local host needs a chamber-owned host package exposing it
 * over a Remote (`clientModules.graph()`). This module distributes that
 * package (module A, `packages/dsh-host-client-graph`) into the managed local
 * profile and materializes the `--patch` overlay that mounts it:
 *
 *   - ensureHostGraphPackage copies module A's package (package.json +
 *     dist/index.js) into <dshHome>/profiles/web/node_modules/@dsh-chamber/
 *     dsh-host-client-graph/ — the profile node_modules anchor user plugins
 *     resolve from (profile layout: $DSH_HOME/profiles/web/package.json +
 *     cordis.patch.yml, see @deepseek-ai/dsh-app-boot profile.ts). Idempotent:
 *     an in-sync copy is skipped, a drifted one is overwritten.
 *   - buildPatchOverlay materializes <stateDir>/dsh-chamber-graph.patch.yml —
 *     a top-level YAML array of loader patch entries (the exact format the
 *     dsh CLI's `--patch <path>` overlay and a bundle's cordis.patch.yml
 *     share, @deepseek-ai/dsh-app-boot loadOverlayPatches) inserting the
 *     client-graph row. Idempotent: content-identical files are left alone.
 *
 * The overlay is appended to every spawn command line (webProfileArgs in
 * spawn-dsh.ts) and applies at host boot — a pre-existing running local
 * instance picks it up on its next restart (the official plugin-set-change
 * cadence, design 09 §3.2).
 *
 * Security: every path is derived from stateDir/dshHome (internal path
 * concatenation — no user input injection surface); controlled target parents
 * are real final directory components, target reads are stable/no-follow and
 * bounded, and writes use the shared random-O_EXCL/no-follow + file/parent
 * fsync publication primitive with 0600 perms. Source package reads retain
 * their ordinary filesystem/packaged-resource boundary.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// The loader `insert` row render/parse/conflict logic is single-sourced in
// cordis-inserts.ts (A2 cross-package protocol single-sourcing) — shared with
// the desktop remote seed (plugin-sync.ts); only the fail-loud message
// wording stays here.
import { hasExactInsert, insertConflict, renderCordisInserts } from './cordis-inserts.ts'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
} from './private-file.ts'

/** The patch overlay file under <stateDir> (design 09 §3.1 方案 A). */
export const HOST_GRAPH_PATCH_FILENAME = 'dsh-chamber-graph.patch.yml'

/** The chamber host package the overlay mounts (design 09 方案 A, module A). */
export const HOST_GRAPH_PACKAGE_NAME = '@dsh-chamber/dsh-host-client-graph'

/** Chamber-owned host package that executes Git worktree operations in-host. */
export const HOST_GIT_WORKTREE_PACKAGE_NAME = '@dsh-chamber/dsh-host-git-worktree'

/** Loader ids for the two chamber-owned host packages. */
export const HOST_GRAPH_INSERT_ID = 'client-graph'
export const HOST_GIT_WORKTREE_INSERT_ID = 'git-worktree'

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

/**
 * Seed registry (2026-12 interface): one seedable chamber package/plugin
 * entry. The loader overlay row itself is identical for every entry (cordis
 * `insert` id/name — see cordis-inserts.ts); `kind`/`source` are metadata
 * that drive the seed file set and the future source resolution only.
 *
 * Consumers:
 * - desktop control plane: the two host packages (base entries, legacy
 *   `hostGraphPackageSourceDir` / `hostGitWorktreePackageSourceDir` options);
 * - gateway: the same two host packages plus `extraSeedEntries` — the mobile
 *   slot (`@dsh-chamber/dsh-client-ui-mobile`, kind 'client') is a stub whose
 *   packaged source dir ships on the mobile branch; until then an absent
 *   sourceDir is a warned skip, never an error.
 */
export type SeedEntryKind = 'host' | 'client'

/** Where a seed entry's bytes come from. 'packaged' = the owner's own dist
 *  (desktop app resources / gateway host-packages). 'desktop-synced' = a
 *  cache directory under the state root populated by a connecting desktop
 *  (the gateway pass-through seam; no owner resolves it yet — Phase 3). */
export type SeedSource = 'packaged' | 'desktop-synced'

export interface SeedEntry {
  /** The loader overlay row (the only wire-relevant part). */
  insert: HostPackageInsert
  /** Loader target nature: 'host' packages resolve inside the dsh process
   *  and may back activation-probe domains; 'client' plugins load in the web
   *  frontend (e.g. the gateway-hosted browser UI). */
  kind: SeedEntryKind
  source: SeedSource
  /** Packaged source directory (package.json + seedFiles). null or absent →
   *  skipped with the caller's warn (a stub entry whose package is not yet
   *  shipped — e.g. the gateway mobile slot). */
  sourceDir: string | null
  /** Seed file set; defaults to the host base (package.json + dist/index.js).
   *  Client plugins may extend (css/assets) when their package lands. */
  seedFiles?: readonly string[]
  /** Activation-probe domains this entry backs (kind 'host' only). Documented
   *  metadata: the dsh-runtime probe seam does NOT consume this registry —
   *  it re-derives presence from the seed cache filesystem
   *  (`hasSyncedHostSeed` in packages/gateway/src/plugins.ts, hardcoding the
   *  same two syncable packages), so this list must stay in sync with the
   *  probe set (`HOST_DOMAIN_PROBE_NAMES` in packages/dsh-runtime). */
  probeDomains?: readonly string[]
}

/**
 * The canonical overlay content: a top-level YAML array of loader patch
 * entries — `[{ insert: [{ id: 'client-graph', name: '@dsh-chamber/…' }] }]`
 * — matching @deepseek-ai/dsh-app-boot's loadOverlayPatches format exactly
 * (a `--patch` overlay and a bundle's cordis.patch.yml share the format;
 * rendered by the shared renderCordisInserts, single-sourced in
 * cordis-inserts.ts). `name` resolves through the profile's node_modules
 * anchor, which ensureHostGraphPackage fills.
 */

/**
 * Reconcile chamber loader rows with the user's profile patch before writing
 * packages or an external overlay. An exact single row is reused and omitted
 * from the overlay; any id/name collision or duplicate is rejected loudly so
 * the next dsh boot cannot fail from a duplicate loader id or double-mount a
 * Remote under two ids.
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
    // No conflict: the row is either exactly present (reused, omitted from
    // the overlay) or has no trace at all (still missing).
    if (!hasExactInsert(profilePatch, insert)) missing.push({ ...insert })
  }
  return missing
}

/** Files seeded from each chamber host package (its complete runtime surface). */
const HOST_PACKAGE_SEED_FILES = ['package.json', 'dist/index.js'] as const
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

/** Materialize the profile-owned resolution anchors one final component at a
 * time. The official hoisted profile contract makes `web/node_modules` and
 * its scope real directories (package entries beneath them may be pnpm
 * links); this chamber package is a bare seed and owns its package/dist dirs.
 * `profiles/web` remains an ordinary ancestor so established home/profile
 * layouts can still place it through a symlink. */
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
 * Ensure the host-graph patch overlay exists under <stateDir> and return its
 * absolute path. Idempotent: an existing file whose content matches the
 * canonical overlay is left untouched; a drifted/absent file is (re)written
 * atomically with 0600 perms. Throws on write failure — the state root is the
 * plane's own layout, so an unwritable overlay is a plane problem, never a
 * silent skip.
 * @param stateDir - the control-plane state root.
 * @returns the overlay path to pass to spawns as `--patch`.
 */
export function buildPatchOverlay(
  stateDir: string,
  inserts: readonly HostPackageInsert[] = [HOST_GRAPH_INSERT],
): string {
  const path = join(stateDir, HOST_GRAPH_PATCH_FILENAME)
  const content = renderCordisInserts(inserts)
  ensurePrivateDirectoryNoFollow(stateDir, 0o700, { existingMode: 'preserve' })
  if (readSeedTarget(path) === content) return path
  atomicWritePrivateFileNoFollow(path, content, { mode: 0o600 })
  return path
}

/**
 * Distribute one seed entry into the managed local profile so the spawned
 * host can resolve the overlay row. Copies each declared seed file
 * (package.json + dist/index.js by default) to
 * <dshHome>/profiles/web/node_modules/@dsh-chamber/<name>/.
 *
 * Idempotent per file: an existing target whose bytes hash identically to the
 * source is skipped; a missing or drifted target is rewritten atomically with
 * 0600 perms. Returns whether any file was written.
 *
 * Failure semantics: an absent sourceDir is NOT an error — the entry may not
 * be built or bundled in this runtime (e.g. the packaged desktop, or the
 * gateway mobile stub whose package ships on the mobile branch), so the
 * caller decides how to surface the skip. A source that exists but is missing
 * a declared file, or a copy that fails, throws (fail-loud: a shipped-but-
 * broken entry is a packaging bug, never a silent skip). Note the caller's
 * gate is the BUILT artifact dist/index.js only: a source that passes that
 * gate but is missing another declared file — e.g. package.json
 * present-dist-but-no-manifest — is exactly the shipped-but-broken case and
 * the throw is intentional: the plane surfaces it as a start/spawn error
 * (fail-loud) instead of booting a host whose --patch row cannot resolve.
 * @param dshHome - the managed dsh home (the spawned host's $DSH_HOME).
 * @param packageName - the chamber package name (`@dsh-chamber/…`).
 * @param sourceDir - the entry's packaged source directory.
 * @param seedFiles - per-entry seed file set (defaults to the host base).
 * @returns true when at least one file was written, false when already in
 *   sync or the source package is absent.
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
    // Seed file paths are caller-trusted (the control plane / gateway are the
    // only producers), but a malformed entry must fail loud instead of
    // escaping the package dir or silently seeding nothing.
    if (typeof relative !== 'string' || relative === '' || relative.startsWith('/') || relative.includes('\\')
      || relative.split('/').includes('..') || relative.split('/').includes('.')) {
      throw new Error(`chamber seed: invalid seed file path ${JSON.stringify(relative)}`)
    }
    const source = join(sourceDir, relative)
    if (!existsSync(source)) {
      throw new Error(`chamber seed: ${source} missing in package ${sourceDir}`)
    }
    // Source packages can live in the development tree or a packaged resource
    // virtual filesystem, so their established ordinary read boundary stays
    // unchanged. The chamber-owned target parent, by contrast, must be a real
    // final component; a pnpm operation may prune it, but may not redirect it.
    const sourceBytes = readFileSync(source)
    const target = ensureSeedTargetParent(dshHome, packageName, relative)
    const current = readSeedTarget(target, Math.max(MAX_SEED_TARGET_BYTES, sourceBytes.length))
    if (current !== null && sourceBytes.equals(Buffer.from(current))) continue
    atomicWritePrivateFileNoFollow(target, sourceBytes, { mode: 0o600 })
    wrote = true
  }
  return wrote
}

/** Backwards-compatible host-package wrapper (legacy callers/tests). */
export function ensureHostPackage(
  dshHome: string,
  packageName: string,
  sourceDir: string,
): boolean {
  return ensureSeedPackage(dshHome, packageName, sourceDir)
}

/** Backwards-compatible module-A wrapper retained for existing callers/tests. */
export function ensureHostGraphPackage(dshHome: string, sourceDir: string): boolean {
  return ensureHostPackage(dshHome, HOST_GRAPH_PACKAGE_NAME, sourceDir)
}
