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
 * concatenation — no user input injection surface); all writes are atomic
 * (tmp + rename) with 0600 perms so no partial/cross-user-readable state can
 * be observed.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The patch overlay file under <stateDir> (design 09 §3.1 方案 A). */
export const HOST_GRAPH_PATCH_FILENAME = 'dsh-chamber-graph.patch.yml'

/** The chamber host package the overlay mounts (design 09 方案 A, module A). */
export const HOST_GRAPH_PACKAGE_NAME = '@dsh-chamber/dsh-host-client-graph'

/**
 * The canonical overlay content: a top-level YAML array of loader patch
 * entries — `[{ insert: [{ id: 'client-graph', name: '@dsh-chamber/…' }] }]`
 * — matching @deepseek-ai/dsh-app-boot's loadOverlayPatches format exactly
 * (a `--patch` overlay and a bundle's cordis.patch.yml share the format).
 * `name` resolves through the profile's node_modules anchor, which
 * ensureHostGraphPackage fills.
 */
export const HOST_GRAPH_PATCH_OVERLAY = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-host-client-graph'
`

/** Files seeded from module A's package (its complete runtime surface). */
const HOST_GRAPH_SEED_FILES = ['package.json', 'dist/index.js'] as const

/** Atomic text write (tmp + rename, 0600): no partial file on crash. */
function atomicWrite(path: string, content: string | Uint8Array): void {
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}

/** sha256 hex of a file's bytes (the seed in-sync comparison). */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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
export function buildPatchOverlay(stateDir: string): string {
  const path = join(stateDir, HOST_GRAPH_PATCH_FILENAME)
  if (existsSync(path) && readFileSync(path, 'utf8') === HOST_GRAPH_PATCH_OVERLAY) {
    return path
  }
  mkdirSync(stateDir, { recursive: true })
  atomicWrite(path, HOST_GRAPH_PATCH_OVERLAY)
  return path
}

/**
 * Distribute module A's host package into the managed local profile so the
 * spawned host can resolve the client-graph row the overlay inserts.
 * Copies package.json + dist/index.js to
 * <dshHome>/profiles/web/node_modules/@dsh-chamber/dsh-host-client-graph/.
 *
 * Idempotent per file: an existing target whose bytes hash identically to the
 * source is skipped; a missing or drifted target is rewritten atomically with
 * 0600 perms. Returns whether any file was written.
 *
 * Failure semantics: an absent sourceDir is NOT an error — module A may not
 * be built or bundled in this runtime (e.g. the packaged desktop), so the
 * caller decides how to surface the skip. A source that exists but is missing
 * a declared file, or a copy that fails, throws (fail-loud: a shipped-but-
 * broken module A is a packaging bug, never a silent skip). Note the caller's
 * gate (index.ts) is the BUILT artifact dist/index.js only: a source that
 * passes that gate but is missing another declared file — e.g. package.json
 * present-dist-but-no-manifest — is exactly the shipped-but-broken case and
 * the throw is intentional: the plane surfaces it as a start/spawn error
 * (fail-loud) instead of booting a host whose --patch row cannot resolve.
 * @param dshHome - the managed dsh home (the spawned host's $DSH_HOME).
 * @param sourceDir - module A's package directory (package.json + dist/index.js).
 * @returns true when at least one file was written, false when already in
 *   sync or the source package is absent.
 */
export function ensureHostGraphPackage(dshHome: string, sourceDir: string): boolean {
  if (!existsSync(sourceDir)) return false
  const targetDir = join(dshHome, 'profiles', 'web', 'node_modules', HOST_GRAPH_PACKAGE_NAME)
  let wrote = false
  for (const relative of HOST_GRAPH_SEED_FILES) {
    const source = join(sourceDir, relative)
    const target = join(targetDir, relative)
    if (!existsSync(source)) {
      throw new Error(`host-graph seed: ${source} missing in module A package ${sourceDir}`)
    }
    // existsSync(target) + sha256(target) is a tiny TOCTOU window: an
    // external deletion between the two reads throws ENOENT from sha256 —
    // fail-loud by design (a seed target vanishing mid-check is a
    // profile-internal pnpm race), the window is sub-millisecond, and the
    // next spawn's re-seed (index.ts resolveHostGraphPatch) self-heals.
    if (existsSync(target) && sha256(source) === sha256(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    atomicWrite(target, readFileSync(source))
    wrote = true
  }
  return wrote
}
