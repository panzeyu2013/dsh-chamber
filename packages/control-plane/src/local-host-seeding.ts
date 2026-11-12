/**
 * Local host seeding: the first-run managed-dsh-home defaults and the per-spawn local
 * `--patch` overlay resolution. Neither function has a production importer outside the
 * package entry, and keeping them here keeps the entry a wiring surface.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parsePluginManifest } from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
import {
  buildPatchOverlay,
  ensureSeedPackage,
  HOST_GRAPH_PATCH_FILENAME,
  HOST_OPEN_IN_INSERT_ID,
  missingHostPackageInserts,
  OFFICIAL_OPEN_IN_DISABLE,
  type SeedEntry,
} from './host-graph-seed.ts'
import {
  bundleRowDisableTargetsForSpawn,
  profileBundlePatchReader,
  resolveBundleRowDisables,
  type BundleRowDisableTarget,
} from './bundle-row-disables.ts'
import { planHostLogBridge } from './host-log-bridge.ts'
import { isSafeModeEnabled } from './safe-mode.ts'
import {
  STARTUP_PLUGIN_ROWS,
  planStartupPluginRows,
  profileOwnsStartupRow,
  renderStartupPluginInserts,
  type StartupPluginCapabilities,
  type StartupPluginRow,
} from './startup-plugin-rows.ts'
import {
  createPrivateFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
} from './private-file.ts'

/**
 * Seed first-run defaults into the managed dsh home. The dsh web UI derives its locale from
 * the settings document and otherwise falls back to the browser/OS language — seed `zh` so
 * the local instance defaults to Chinese. Only an uninitialized home is seeded: dsh 0.1.7
 * renames the legacy file to `.imported` after moving its value into the active profile.
 */
export function seedDshHomeDefaults(dshHome: string): boolean {
  const documentPath = join(dshHome, 'settings.yaml')
  ensurePrivateDirectoryNoFollow(dshHome, 0o700)
  // dsh >= 0.1.7 imports this legacy document into the profile and renames it.
  // Recreating it on every spawn would reapply the default over a user's choice.
  if (existsSync(join(dshHome, 'settings.yaml.imported'))) return false
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
  /**
   * The dsh workspace/install root: the installation anchor an enabled profile BUNDLE is
   * resolved from (the profile anchor is always probed too). Optional so a synthetic caller
   * without a runtime tree can still resolve the profile-only anchors.
   */
  readonly dshWorkspacePath?: string | null
  /**
   * Id-targeted disables for rows a profile BUNDLE mounts (P5b-0); defaults to the canonical
   * registry in bundle-row-disables.ts. Tests pass their own list to pin the semantics.
   */
  readonly bundleRowDisables?: readonly BundleRowDisableTarget[]
  /** The resolved seed registry entries (the four base host packages + extras). */
  readonly entries: readonly SeedEntry[]
  /**
   * Local startup upstream plugin rows (Swift only): the resource roots the sidecar
   * entry resolves (payload + office-skills). Each capability is gated independently
   * and appended to the same `--patch` overlay as a second top-level `- insert:`
   * object with absolute-path config — a missing payload/assets tree emits NO row for
   * that capability (diagnosed, never fatal), and a row the user profile patch already
   * owns is skipped. Absent = this deployment mounts no upstream startup row.
   */
  readonly startupPluginCapabilities?: StartupPluginCapabilities
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
 * The managed web profile's `dsh.profile.bundles` layer — the enabled bundle list the local
 * overlay resolves bundle-mounted rows against ([] when no manifest exists yet).
 *
 * A present-but-unreadable or unparseable manifest is fail-closed: treating it as "no
 * bundles known" would silently leave a forge-enabled row (notably the GitHub provider)
 * enabled. An absent manifest means no profile yet and is legitimately empty.
 */
function profileBundleLayer(dshHome: string): string[] {
  const manifestPath = join(dshHome, 'profiles', 'web', 'package.json')
  if (!existsSync(manifestPath)) return []
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    throw new Error(`bundle enablement: cannot read ${manifestPath} (${error instanceof Error ? error.message : String(error)}); refusing to start with an unknown bundle layer`)
  }
  const parsed = parsePluginManifest(text)
  if (!parsed.ok) {
    throw new Error(`bundle enablement: the local web profile manifest is unusable (${parsed.fault}); refusing to start with an unknown bundle layer`)
  }
  return parsed.bundles
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
 * caller) and a P5b-0 id-targeted disable for a row an enabled profile BUNDLE mounts (see
 * bundle-row-disables.ts: an unenabled bundle is an idempotent skip, an enabled one whose row
 * cannot be proven is fail-closed). Those disables are NOT insert identities and are emitted
 * even when the profile patch owns every chamber row.
 *
 * Local startup upstream rows (Swift) ride the same overlay as a SECOND top-level
 * `- insert:` object (startup-plugin-rows.ts): the primary-runtime/workspace-dependencies
 * row and the office-skills row, each carrying absolute-path config. The capability roots
 * come from the sidecar entry; each row is gated independently on its resources and skipped
 * (with a diagnostic) when absent, and a row the profile patch already owns is skipped.
 * A startup-only overlay is a valid `--patch` too.
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

  // The user profile patch is read ONCE here: the startup rows' reuse decision and the
  // chamber rows' identity reconciliation below must see the same layer.
  const profilePatchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  const profilePatch = existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : null
  // Startup upstream rows (Swift local-only): pure planning (no writes), gated per
  // capability root and appended to this same overlay. Planner failures are limited to
  // relative capability roots (programming errors); a missing payload/assets tree or a
  // user-owned row is a diagnosed skip.
  let startupRows: StartupPluginRow[] = []
  if (input.startupPluginCapabilities !== undefined) {
    if (input.dshWorkspacePath === undefined || input.dshWorkspacePath === null) {
      log('startup plugin rows: workspace path is unresolved; skipped')
    } else {
      startupRows = planStartupPluginRows({
        capabilities: input.startupPluginCapabilities,
        workspacePath: input.dshWorkspacePath,
        dshHome,
        profilePatch,
        log,
        warn,
      })
    }
  }
  // Does THIS spawn actually mount a local skill-office row? Only then may the bundle's
  // own row be force-disabled: capability presence alone is not a mount (the planner
  // skips on an absent/incomplete assets tree or an uninstalled workspace package), and
  // disabling there would remove the only office mount. A user-profile row with the same
  // identity is a live local mount too (the planner's own row is reused, not repeated).
  const mountsLocalOfficeSkills = input.startupPluginCapabilities !== undefined
    && (startupRows.some(row => row.id === STARTUP_PLUGIN_ROWS.officeSkills.id)
      || profileOwnsStartupRow(profilePatch, STARTUP_PLUGIN_ROWS.officeSkills))
  // P5b-0: resolve the bundle-row disables BEFORE any profile write and BEFORE the
  // no-seed-entries early return. A disable-only overlay is valid; skipping the
  // resolution when every chamber seed row is absent would leave a forge-enabled
  // GitHub provider enabled. An enabled bundle whose row identity cannot be proven
  // is fail-closed here, so a misspelled id never leaves a half-refreshed profile.
  const bundleDisables = resolveBundleRowDisables({
    enabledBundles: profileBundleLayer(dshHome),
    readBundlePatches: profileBundlePatchReader({ dshHome, dshWorkspacePath: input.dshWorkspacePath }),
    // Tests pin their own list; the production default adds the web-app office-row
    // disable exactly when this spawn mounts a local office row (rc.2 double mount would
    // throw in the skill registry — see bundle-row-disables.ts).
    targets: input.bundleRowDisables ?? bundleRowDisableTargetsForSpawn({ mountsLocalOfficeSkills }),
    log,
  })
  if (available.length === 0 && bundleDisables.length === 0 && startupRows.length === 0) {
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
  // The canonical renderer rejects an empty row list, so a startup/disable-only overlay skips
  // the chamber reconciliation entirely (there is no chamber insert to place).
  const overlayInserts = available.length === 0
    ? []
    : missingHostPackageInserts(profilePatch, available.map(entry => entry.insert))
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
  const disables = [
    ...(available.some(entry => entry.insert.id === HOST_OPEN_IN_INSERT_ID) ? [OFFICIAL_OPEN_IN_DISABLE] : []),
    ...bundleDisables,
  ]
  if (overlayInserts.length === 0 && disables.length === 0 && startupRows.length === 0) {
    clearHostGraphPatchOverlay(stateDir)
    return null
  }
  // The startup block is the overlay's second top-level `- insert:` object, appended after
  // the chamber rows and their id-targeted disables; zero rows render as '' (legacy bytes).
  return buildPatchOverlay(stateDir, overlayInserts, disables, renderStartupPluginInserts(startupRows))
}
