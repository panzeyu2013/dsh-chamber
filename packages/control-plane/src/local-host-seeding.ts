/**
 * Local host seeding: the first-run managed-dsh-home defaults and the per-spawn local
 * `--patch` overlay resolution. Neither function has a production importer outside the
 * package entry, and keeping them here keeps the entry a wiring surface.
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
import { isSafeModeEnabled } from './safe-mode.ts'
import {
  createPrivateFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
} from './private-file.ts'

/**
 * Seed first-run defaults into the managed dsh home. The dsh web UI derives its locale from
 * the settings document and otherwise falls back to the browser/OS language — seed `zh` so
 * the local instance defaults to Chinese. Absent file only: an existing document is never
 * touched.
 */
export function seedDshHomeDefaults(dshHome: string): boolean {
  const documentPath = join(dshHome, 'settings.yaml')
  ensurePrivateDirectoryNoFollow(dshHome, 0o700)
  try {
    createPrivateFileExclusiveNoFollow(documentPath, 'locale:\n  preference: zh\n', { mode: 0o600 })
    return true
  } catch (error) {
    // O_EXCL refuses every existing leaf, including a symlink, without opening or modifying
    // it; the dsh settings service owns existing documents.
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') return false
    throw error
  }
}

/**
 * Drop the local `--patch` overlay file. Called by every resolution that passes NO overlay,
 * so the file's presence keeps meaning exactly "the last spawn passed it" — the desktop probe
 * reads it as a mount fact, and a leftover would report a row the current tree does not carry.
 * An undeletable file is a broken state root: fail loud, never a silent skip.
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
  /** Informational sink (the plane's logger in production). */
  readonly log?: (message: string) => void
  /** Warning sink (absent/stub seed sources). */
  readonly warn?: (message: string) => void
  /** Error sink for a packaged host entry whose sourceDir exists but lacks its built artifact;
   *  defaults to `warn` so a caller wiring only the warn sink still sees it. */
  readonly error?: (message: string) => void
  /**
   * Environment deciding the opt-in host-log bridge. Defaults to EMPTY (bridge off) so a
   * synthetic caller never picks up the ambient shell by accident; production passes
   * `process.env` explicitly.
   */
  readonly env?: NodeJS.ProcessEnv
  /**
   * 安全模式（C4）：true = 本次解析不 seed 任何条目不传 --patch。缺省按 `env` 里的
   * DSH_CHAMBER_SAFE_MODE=1 判定；装配侧（createControlPlane）把自己解析出的
   * safeMode 显式传进来，避免「选项 true 而 env 未设」时两处读点分叉。
   */
  readonly safeMode?: boolean
  /**
   * Receives the probe domains backed by the host packages this resolution actually seeds,
   * so the desktop's activation expectation set follows the real seed set. Optional.
   */
  readonly onSeededProbeDomains?: (domains: readonly string[]) => void
}

/**
 * Resolve one local spawn's `--patch` overlay, or null when that spawn passes none.
 *
 * The overlay carries ONLY the rows the profile's own `cordis.patch.yml` does not already
 * own (loader identities are global: a duplicated id/name pair is a boot failure, so an
 * already user-owned row is reused, never repeated), PLUS the id-targeted non-insert rows
 * this spawn must apply above every layer — currently the official open-in HOST half's
 * disable when chamber's own open-in host package is seeded (the renderer page-own-skips the
 * official CLIENT row, so its webServer routes would be a second live wire face with no
 * caller). That disable is NOT an insert identity and is emitted even when the profile patch
 * owns every chamber row.
 *
 * The no-overlay paths REMOVE a leftover overlay file, keeping the desktop probe's invariant:
 * the file exists exactly when the spawn about to run passes it.
 */
export function resolveLocalHostGraphOverlay(input: LocalHostGraphOverlayInput): string | null {
  const { stateDir, dshHome, entries: baseEntries } = input
  const log = input.log ?? (() => {})
  const warn = input.warn ?? (() => {})
  const error = input.error ?? warn
  // 安全模式（C4）：本次启动一条 seed 都不写——不刷新 profile 包、不生成/传
  // --patch overlay、期望集发空集（激活探针不得按上次的域做 exact-set 裁决）。
  // 遗留 overlay 必须清掉：「文件存在 ⟺ 本次 spawn 会传它」是 desktop 探针读的
  // 不变式，陈旧文件会把「没 seed」误读成「seed 了」。
  if (input.safeMode ?? isSafeModeEnabled(input.env ?? {})) {
    clearHostGraphPatchOverlay(stateDir)
    input.onSeededProbeDomains?.([])
    log(`安全模式：跳过 chamber 宿主包 seeding（${baseEntries.length} 条 seed 条目）；下次普通启动自动恢复`)
    return null
  }
  // Opt-in host-log bridge: ONE extra seed entry while DSH_CHAMBER_HOST_LOG_LEVEL is set for
  // this spawn. With the switch absent the entry list (and every overlay byte below) carries none.
  const bridgeEntry = planHostLogBridge({ stateDir, env: input.env ?? {}, warn })
  const entries = bridgeEntry === null ? baseEntries : [...baseEntries, bridgeEntry]
  // An extra entry with no packaged source is warned, never fatal — but the wording
  // distinguishes a true stub from a desktop-synced entry awaiting its first sync. The base
  // packaged dirs keep their silent-skip behavior (absent source or dist = no row).
  for (const entry of entries) {
    if (entry.sourceDir === null || !existsSync(entry.sourceDir)) {
      const message = `seed entry '${entry.insert.id}' (${entry.insert.name}): source absent; skipped`
      if (entry.source === 'desktop-synced') log(`${message} (awaiting the first desktop sync)`)
      else warn(`${message} (stub: package not shipped in this runtime)`)
      continue
    }
    // A sourceDir that EXISTS without dist/index.js is filtered out below: a packaged host
    // package missing its artifact is a real defect and must not disappear silently.
    const artifact = join(entry.sourceDir, 'dist', 'index.js')
    if (!existsSync(artifact)) {
      const message = `seed entry '${entry.insert.id}' (${entry.insert.name}): built artifact missing at ${artifact}; skipped — this spawn has no --patch row for it`
      if (entry.kind === 'host' && entry.source === 'packaged') error(message)
      else warn(message)
    }
  }
  // 影子条目若缺 probeDomains，会让该宿主域在激活期望集中静默消失——必须 loud。桥接条目无宿主域，排除在外。
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
  // The callback fires on the empty set too, so a previously seeded plane resets instead of keeping a stale domain list.
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
  // Loader identities are global across the profile patch and this overlay: reuse an exact
  // user-owned row, but fail before any write when an id/name is duplicated or bound differently.
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
  // The official web bundle's open-in HOST row is superseded exactly when chamber's own
  // open-in host package is actually seeded (the renderer page-own-skips the official CLIENT
  // row, so its webServer routes would be a second live wire face). The disable rides the SAME
  // overlay, which composes after every bundle and user layer, so a user layer that re-enabled
  // the row is superseded too. The condition is the SEEDED set, not the registry.
  const disables = available.some(entry => entry.insert.id === HOST_OPEN_IN_INSERT_ID)
    ? [OFFICIAL_OPEN_IN_DISABLE]
    : []
  if (overlayInserts.length === 0 && disables.length === 0) {
    clearHostGraphPatchOverlay(stateDir)
    return null
  }
  return buildPatchOverlay(stateDir, overlayInserts, disables)
}
