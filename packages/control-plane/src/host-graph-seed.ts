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
 * package (module A, `packages/dsh-chamber-seed-client-graph`) into the managed local
 * profile and materializes the `--patch` overlay that mounts it:
 *
 *   - ensureSeedPackage copies a chamber host package (package.json +
 *     dist/index.js) into <dshHome>/profiles/web/node_modules/@dsh-chamber/
 *     <package>/ — the profile node_modules anchor user plugins
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
export const HOST_GRAPH_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-client-graph'

/** Chamber-owned host package that executes Git worktree operations in-host. */
export const HOST_GIT_WORKTREE_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-git-worktree'

/** Chamber-owned host package that purges archived session content in-host
 *  (design 24: `archiveCleanup/{preview,purge}`). */
export const HOST_ARCHIVE_CLEANUP_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-archive-cleanup'

/** Loader ids for the three chamber-owned host packages. */
export const HOST_GRAPH_INSERT_ID = 'client-graph'
export const HOST_GIT_WORKTREE_INSERT_ID = 'git-worktree'
export const HOST_ARCHIVE_CLEANUP_INSERT_ID = 'archive-cleanup'

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

/**
 * One chamber host package: its loader overlay row plus the Typert Remote that
 * proves it live inside a RUNNING instance.
 *
 * THE single source for every consumer — the control-plane seed registry, the
 * gateway's syncable/probe map, the desktop's local+remote injection probes
 * and the connections plugin-management page all derive from this list.
 * Adding a chamber host package means adding ONE row here; a hand-maintained
 * parallel row table anywhere else is a defect (2026-09 user decision: a
 * seeded host package MUST show up in the plugin-management page, and the
 * page must not hardcode the package set).
 */
export interface ChamberHostPackageDescriptor {
  /** The loader overlay row (id/name — see cordis-inserts.ts). */
  readonly insert: HostPackageInsert
  /** Liveness probe: the Remote method (`namespace/method`) and the args it
   *  accepts. The method MUST be one of dsh-runtime's
   *  `HOST_DOMAIN_PROBE_NAMES` (pinned by the desktop/gateway drift tests),
   *  and every probe must be cheap: a 404 from the dsh gateway deterministically
   *  means "boot row not loaded yet" (injected, restart pending). */
  readonly probe: { readonly method: string; readonly args: unknown }
}

/** The chamber host packages in seed order (the authoritative registry). */
export const CHAMBER_HOST_PACKAGES: readonly ChamberHostPackageDescriptor[] = [
  { insert: HOST_GRAPH_INSERT, probe: { method: 'clientGraph/graph', args: {} } },
  { insert: HOST_GIT_WORKTREE_INSERT, probe: { method: 'gitWorktree/previewCreate', args: { input: {} } } },
  { insert: HOST_ARCHIVE_CLEANUP_INSERT, probe: { method: 'archiveCleanup/probe', args: {} } },
]

/**
 * Fail-fast registry pin (review G2-2, cohesion E-#2): every registry row must
 * own a DISTINCT probe method, insert id and package name.
 *
 * The gateway's set-equality drift pin against dsh-runtime's
 * `HOST_DOMAIN_PROBE_NAMES` compares only the SET of domain values, so a 4th
 * row reusing an existing domain would pass it while the per-package
 * activation-probe map silently became ambiguous (one domain standing for two
 * rows); duplicate loader identities are equally unrepresentable in the
 * overlay. Throws, never warns.
 *
 * Lives with the registry's OWNER (this module) and runs at load below, so
 * every consumer — control plane, gateway and the desktop facade — is covered
 * by construction rather than by each consumer remembering to call it. The
 * `registry` parameter exists only so the plain-node suites can pin the
 * duplicate cases with a synthetic list (the load-time call can only ever see
 * the real registry).
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
 * Seed registry (2026-12 interface): one seedable chamber package/plugin
 * entry. The loader overlay row itself is identical for every entry (cordis
 * `insert` id/name — see cordis-inserts.ts); `kind`/`source` are metadata
 * that drive the seed file set and the future source resolution only.
 *
 * Consumers:
 * - desktop control plane: the three host packages as base entries
 *   (`hostGraphPackageSourceDir` / `hostGitWorktreePackageSourceDir` /
 *   `hostArchiveCleanupPackageSourceDir` options — design 24);
 * - gateway: the same three host packages as desktop-synced entries plus
 *   `extraSeedEntries` — the mobile slot (`@dsh-chamber/dsh-client-ui-mobile`,
 *   kind 'client') is a stub whose packaged source dir ships on the mobile
 *   branch; until then an absent sourceDir is a warned skip, never an error.
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
  /** Activation-probe domains this entry backs (kind 'host' only). Pure
   *  metadata with NO code consumer today: the activation expected set is
   *  derived per spawn from the ACTUALLY SEEDED host entries instead, never
   *  from this registry — the gateway derives `syncedHostDomainProbeNames`
   *  (packages/gateway/src/plugins.ts) over its per-package domain map
   *  `HOST_PACKAGE_PROBE_DOMAINS` (cache presence per package), and
   *  dsh-runtime folds that derived list into the expected set through
   *  `activationProbeNamesForDomains`. The hand-synced places that must stay
   *  in lockstep — named explicitly: the per-package probeDomains attached
   *  to the HOST_*_INSERT rows at the two seed-registry call sites
   *  (control-plane/src/index.ts and gateway/src/index.ts — the values do
   *  NOT live on the INSERT constants themselves), the gateway's
   *  SYNCABLE_HOST_PACKAGES and HOST_PACKAGE_PROBE_DOMAINS, and
   *  `HOST_DOMAIN_PROBE_NAMES` in
   *  packages/dsh-runtime/src/activation-gate.ts (same three domains). */
  probeDomains?: readonly string[]
}

/**
 * The canonical chamber host-seed package namespace (Batch 1 naming
 * unification, 2026-09): every kind 'host' seed entry is named
 * `@dsh-chamber/dsh-chamber-seed-<loader-id>`, matching its directory and its
 * loader id. The pre-rename names (`@dsh-chamber/dsh-host-*`) are gone — a
 * host entry outside this scheme would re-introduce the naming split the
 * unification retired (and a name whose suffix is not the loader id makes the
 * seeded profile directory, the overlay row and the activation-probe domain
 * disagree).
 */
export const HOST_SEED_PACKAGE_PREFIX = '@dsh-chamber/dsh-chamber-seed-'

/**
 * Fail loud when a host seed insert escapes the canonical namespace. Called by
 * both seed registries (control-plane's base entries plus every
 * `extraSeedEntries` addition, and the gateway's syncable list) so a
 * non-conforming host package can never be seeded, synced or probed. Client
 * kind entries (the gateway mobile slot) are exempt by design: they are client
 * plugins, not host seeds, and keep their own naming.
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

/** SeedEntry-level form of {@link assertHostSeedInsertNaming}: the host-kind
 *  entries are the ones the namespace rule binds. */
export function assertHostSeedEntryNaming(entries: readonly SeedEntry[]): void {
  assertHostSeedInsertNaming(entries.filter(entry => entry.kind === 'host').map(entry => entry.insert))
}

/**
 * The canonical overlay content: a top-level YAML array of loader patch
 * entries — `[{ insert: [{ id: 'client-graph', name: '@dsh-chamber/…' }] }]`
 * — matching @deepseek-ai/dsh-app-boot's loadOverlayPatches format exactly
 * (a `--patch` overlay and a bundle's cordis.patch.yml share the format;
 * rendered by the shared renderCordisInserts, single-sourced in
 * cordis-inserts.ts). `name` resolves through the profile's node_modules
 * anchor, which ensureSeedPackage fills.
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
