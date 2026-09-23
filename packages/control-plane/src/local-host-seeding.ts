/**
 * Local host seeding: the first-run managed-dsh-home defaults and the
 * per-spawn local `--patch` overlay resolution (design 02 §3.1, design 09
 * module B).
 *
 * Extracted from index.ts so the package entry stays a wiring surface: neither
 * function has a production importer outside the entry, while their suites
 * (and any future owner) import THIS module directly.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPatchOverlay,
  ensureSeedPackage,
  HOST_GRAPH_PATCH_FILENAME,
  HOST_OPEN_IN_INSERT_ID,
  missingHostPackageInserts,
  OFFICIAL_OPEN_IN_DISABLE,
  type SeedEntry,
} from './host-graph-seed.ts'
import { planHostLogBridge } from './host-log-bridge.ts'
import {
  createPrivateFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
} from './private-file.ts'

/**
 * Seed first-run defaults into the managed dsh home ($DSH_HOME of the
 * spawned local host, design 02 §3.1). The dsh web UI derives its locale
 * from the settings document (`locale.preference`, dsh-settings-file) and
 * otherwise falls back to the browser/OS language — seed `zh` so the local
 * instance defaults to Chinese regardless of the system language. Absent
 * file only: an existing document (the user's own edit or an explicit
 * choice) is never touched.
 */
export function seedDshHomeDefaults(dshHome: string): boolean {
  const documentPath = join(dshHome, 'settings.yaml')
  ensurePrivateDirectoryNoFollow(dshHome, 0o700)
  try {
    createPrivateFileExclusiveNoFollow(documentPath, 'locale:\n  preference: zh\n', { mode: 0o600 })
    return true
  } catch (error) {
    // O_EXCL refuses every existing leaf, including a symlink, without
    // opening or modifying it. The dsh settings service owns existing
    // documents, so seeding must not impose a new content/size/type policy.
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') return false
    throw error
  }
}

/**
 * Drop the local `--patch` overlay file. Called by every resolution that passes
 * NO overlay, so the file's presence keeps meaning exactly "the last spawn
 * passed it": the desktop's chamber probe reads that file as a mount fact
 * (`packages/desktop/plugin-sync.ts` localOverlayCarriesInsert), and a leftover
 * from an earlier spawn would report a row the current tree does not carry.
 * An undeletable file is a broken state root (this plane's own layout) — fail
 * loud, never a silent skip that leaves the false fact in place.
 * @param stateDir - the control-plane state root.
 */
function clearHostGraphPatchOverlay(stateDir: string): void {
  rmSync(join(stateDir, HOST_GRAPH_PATCH_FILENAME), { force: true })
}

/** Inputs of one local host-graph overlay resolution (see {@link resolveLocalHostGraphOverlay}). */
export interface LocalHostGraphOverlayInput {
  /** The control-plane state root (the overlay lives directly under it). */
  readonly stateDir: string
  /** The managed dsh home (the profile's own patch layer is read from under it). */
  readonly dshHome: string
  /** The resolved seed registry entries (the four base host packages + extras). */
  readonly entries: readonly SeedEntry[]
  /** Informational sink (the plane's logger in production; tests pass no-ops). */
  readonly log?: (message: string) => void
  /** Warning sink (absent/stub seed sources). */
  readonly warn?: (message: string) => void
  /** Error sink for a packaged host entry whose sourceDir exists but lacks its
   *  built artifact (a packaging defect, not a stub). Defaults to `warn` so a
   *  caller that wires only the warn sink still sees the message. */
  readonly error?: (message: string) => void
  /**
   * Environment that decides the opt-in host-log bridge
   * (DSH_CHAMBER_HOST_LOG_LEVEL — host-log-bridge.ts). Defaults to an EMPTY
   * environment (bridge off), so a synthetic/test caller can never pick up the
   * ambient shell by accident; the production spawn-thunk wiring passes
   * `process.env` explicitly.
   */
  readonly env?: NodeJS.ProcessEnv
  /**
   * Receives the probe domains backed by the host packages this resolution
   * actually seeds: the plane's spawn thunk records
   * them on `PlaneHandle.seededProbeDomains`, so the desktop's activation
   * expectation set follows the real seed set. Optional — direct test callers
   * omit it and keep the resolver a pure overlay producer.
   */
  readonly onSeededProbeDomains?: (domains: readonly string[]) => void
}

/**
 * Resolve one local spawn's `--patch` overlay (design 09 module B), or null
 * when that spawn passes none.
 *
 * Returned path = the overlay this spawn hands the launcher, carrying ONLY the
 * rows the profile's own `cordis.patch.yml` does not already own (loader
 * identities are global across both layers: a duplicated id/name pair is a
 * boot failure, so an already user-owned row is reused, never repeated), PLUS
 * the id-targeted non-insert rows this spawn must apply above every layer —
 * currently the official open-in HOST half's disable when chamber's own
 * open-in host package is seeded (audit arch-03 P2-3: the renderer
 * page-own-skips the official CLIENT row, so the official open-in webServer
 * routes would be a second live wire face with no caller). That disable is
 * NOT an insert identity, so it is emitted even when the profile patch already
 * owns every chamber row.
 *
 * The no-overlay paths (no built `dist/index.js` artifact; nothing to insert
 * and no disable to apply) REMOVE a leftover overlay file. That keeps one
 * invariant the desktop probe relies on: the file exists exactly when the
 * spawn about to run passes it, so reading it is reading this spawn's mount
 * set — never a previous spawn's.
 *
 * @param input - state root, managed dsh home, resolved seed entries, sinks.
 * @returns the `--patch` overlay path, or null (no overlay passed).
 */
export function resolveLocalHostGraphOverlay(input: LocalHostGraphOverlayInput): string | null {
  const { stateDir, dshHome, entries: baseEntries } = input
  const log = input.log ?? (() => {})
  const warn = input.warn ?? (() => {})
  const error = input.error ?? warn
  // Opt-in managed-dsh application-log bridge (host-log-bridge.ts): ONE extra
  // seed entry while DSH_CHAMBER_HOST_LOG_LEVEL is set for this spawn, carrying
  // the generated logger-exporter plugin. With the switch absent the entry list
  // (and therefore every write, row and overlay byte below) carries no bridge
  // entry.
  const bridgeEntry = planHostLogBridge({ stateDir, env: input.env ?? {}, warn })
  const entries = bridgeEntry === null ? baseEntries : [...baseEntries, bridgeEntry]
  // An extra entry with no packaged source is warned, never fatal — but the
  // wording distinguishes a true stub (packaged entry whose package has not
  // shipped yet, e.g. the gateway mobile slot) from a desktop-synced entry
  // merely awaiting its first sync (an expected pre-sync state, logged once
  // per spawn as informational). The base packaged dirs keep their documented
  // silent-skip behavior (absent source or dist = no row, no overlay).
  for (const entry of entries) {
    if (entry.sourceDir === null || !existsSync(entry.sourceDir)) {
      const message = `seed entry '${entry.insert.id}' (${entry.insert.name}): source absent; skipped`
      if (entry.source === 'desktop-synced') log(`${message} (awaiting the first desktop sync)`)
      else warn(`${message} (stub: package not shipped in this runtime)`)
      continue
    }
    // A sourceDir that EXISTS without <sourceDir>/dist/index.js is filtered out
    // of `available` below (no seed, no --patch row). A packaged host package
    // missing its artifact is a real packaging defect and must not disappear
    // silently.
    const artifact = join(entry.sourceDir, 'dist', 'index.js')
    if (!existsSync(artifact)) {
      const message = `seed entry '${entry.insert.id}' (${entry.insert.name}): built artifact missing at ${artifact}; skipped — this spawn has no --patch row for it`
      if (entry.kind === 'host' && entry.source === 'packaged') error(message)
      else warn(message)
    }
  }
  // 影子条目（extraSeedEntries 覆盖同 id）若缺 probeDomains，会让该宿主域在
  // 激活期望集中静默消失——必须 loud。桥接条目由
  // resolver 自己追加（无宿主域），不在用户声明的 seed 集合里，故排除在外。
  for (const entry of baseEntries) {
    if (entry.kind === 'host' && (entry.probeDomains ?? []).length === 0) {
      warn(`seed entry '${entry.insert.id}' (${entry.insert.name}): host entry without probeDomains; its chamber domain will not be probed`)
    }
  }
  const available = entries
    .filter(entry => entry.sourceDir !== null && existsSync(join(entry.sourceDir, 'dist', 'index.js')))
    .map(entry => ({
      label: entry.insert.id,
      sourceDir: entry.sourceDir as string,
      seedFiles: entry.seedFiles,
      insert: entry.insert,
      packageName: entry.insert.name,
      probeDomains: entry.probeDomains ?? [],
    }))
  // The activation expectation set follows exactly what this resolution seeds
  // (the callback fires on the empty set too, so a previously seeded plane
  // resets instead of keeping a stale domain list).
  input.onSeededProbeDomains?.(available.flatMap(entry => entry.probeDomains))

  if (available.length === 0) {
    clearHostGraphPatchOverlay(stateDir)
    return null
  }
  // Preflight every declared package before writing any of them. A damaged
  // second artifact must not leave the first package partially refreshed.
  for (const entry of available) {
    const manifest = join(entry.sourceDir, 'package.json')
    if (!existsSync(manifest)) {
      throw new Error(`${entry.label}: built seed package is missing ${manifest}`)
    }
  }
  // Loader identities are global across the profile patch and this external
  // overlay. Reuse an exact user-owned row, but fail before any package write
  // when an id/name is duplicated or bound differently.
  const profilePatchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  const overlayInserts = missingHostPackageInserts(
    existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : null,
    available.map(entry => entry.insert),
  )
  for (const entry of available) {
    if (ensureSeedPackage(dshHome, entry.packageName, entry.sourceDir, entry.seedFiles)) {
      log(`${entry.label}: seeded ${entry.packageName} into the local web profile`)
    }
  }
  // The official web bundle's open-in HOST row is superseded exactly when
  // chamber's own open-in host package is actually seeded into this profile
  // (audit arch-03 P2-3): the renderer page-own-skips the official CLIENT row,
  // so the official open-in webServer routes would be a second live wire face
  // with no caller. The disable rides the SAME `--patch` overlay, which
  // composes after every bundle layer and both user layers (profile-boot
  // allPatches), so a user layer that re-enabled or re-configured the row is
  // superseded too. The condition is the SEEDED set, not the registry: a
  // runtime that does not ship the chamber open-in package keeps the official
  // row it may still serve (e.g. the gateway's local instance, where a
  // localOnly row is never synced).
  const disables = available.some(entry => entry.insert.id === HOST_OPEN_IN_INSERT_ID)
    ? [OFFICIAL_OPEN_IN_DISABLE]
    : []
  if (overlayInserts.length === 0 && disables.length === 0) {
    clearHostGraphPatchOverlay(stateDir)
    return null
  }
  return buildPatchOverlay(stateDir, overlayInserts, disables)
}
