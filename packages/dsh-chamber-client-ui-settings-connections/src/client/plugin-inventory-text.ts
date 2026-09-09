/**
 * Plugin-inventory display helpers (design 05 §5 / gateway 插件视图): the
 * pure, UI-free projections for the PluginDialog's inventory-backed zones
 * (plan 24 D5-A merged the former PluginSyncModal/PluginInventoryView split),
 * mirroring the SSH plugin row semantics (plugin-diff.ts split). Kept free of
 * .tsx so the plain-node test suite covers the projections.
 */

import type { SettingsConnectionsKey } from '../locales.ts'
import type { PluginFiberPhase, PluginInventorySnapshot } from './plugin-inventory-api.ts'

/** The chamber-injected host package names (design 09 module A + design 08 +
 *  design 24): the registry-derived expected rows the plugin view surfaces.
 *  These three constants are the CLIENT-side mirror of the control-plane
 *  registry (host-graph-seed.ts CHAMBER_HOST_PACKAGES) — a client package
 *  cannot import the Node-side module, so the drift test in
 *  test/chamber-seed-drift.test.ts pins the NAME SET against the registry
 *  source text (a new registry row must fail there, never be silently
 *  ignored). */
export const HOST_GRAPH_PACKAGE = '@dsh-chamber/dsh-host-client-graph'
export const GIT_WORKTREE_PACKAGE = '@dsh-chamber/dsh-host-git-worktree'
/** Archived-session cleanup host domain (design 24, 2026-12). */
export const ARCHIVE_CLEANUP_PACKAGE = '@dsh-chamber/dsh-host-archive-cleanup'

/** The gateway-packaged mobile client entry (design 21 §6.2: the single
 *  packaged exception — mobile access is bound to the gateway and has no
 *  desktop in the chain). A chamber row, never a third-party row. */
export const MOBILE_PACKAGE = '@dsh-chamber/dsh-client-ui-mobile'

/** Official (built-in) package scope: never a third-party row. */
const OFFICIAL_SCOPE = '@deepseek-ai/'

/** Raw cordis patch-insert syntax prefix: the gateway's cordis.patch.yml
 *  insert rows (gateway index.ts hostPackages) are reported by the host
 *  plugin inventory under this prefix (the root include entry itself is
 *  named 'cordis:include'). Stripped before classification. */
const CORDIS_INCLUDE_PREFIX = 'cordis:include '

/** One inventory entry's package class (design 05 §5 chamber rows + the
 *  design 21 §6.2 mobile packaged exception + design 24 archive-cleanup).
 *  `chamber-client` = a chamber CLIENT plugin that is not the packaged mobile
 *  entry: still a chamber row (never third-party), with no dedicated copy. */
export type InventoryEntryKind =
  | 'chamber-host-graph'
  | 'chamber-git-worktree'
  | 'chamber-archive-cleanup'
  | 'chamber-mobile'
  | 'chamber-client'
  | 'official'
  | 'third-party'

/** Strip the raw patch-insert syntax the gateway's cordis.patch.yml rows are
 *  reported under ('cordis:include <name>'). */
function stripCordisInclude(moduleName: string): string {
  return moduleName.startsWith(CORDIS_INCLUDE_PREFIX)
    ? moduleName.slice(CORDIS_INCLUDE_PREFIX.length)
    : moduleName
}

/** Chamber CLIENT plugin scope. The packaged mobile entry is the single
 *  exception today, but the classification is scope-based — never a literal
 *  list — so a future chamber client plugin is a chamber row automatically. */
const CHAMBER_CLIENT_PREFIX = '@dsh-chamber/dsh-client-ui-'

/** Classification of a chamber CLIENT plugin: 'chamber-mobile' is the
 *  packaged gateway exception (dedicated localized copy), 'chamber-client' is
 *  any other chamber client plugin; null = not a chamber client plugin. */
export type ChamberClientKind = 'chamber-mobile' | 'chamber-client'

/** Classify a module specifier as a chamber CLIENT plugin (patch-insert prefix
 *  stripped first). The single source of truth for "is this a chamber client
 *  row" — the gateway table derives its client rows from it instead of naming
 *  a package (2026-09 P1 round). */
export function classifyChamberClientPlugin(moduleName: string): ChamberClientKind | null {
  const name = stripCordisInclude(moduleName)
  if (!name.startsWith(CHAMBER_CLIENT_PREFIX)) return null
  return name === MOBILE_PACKAGE ? 'chamber-mobile' : 'chamber-client'
}

/**
 * Classify one inventory entry's module specifier. The raw patch-insert
 * prefix ('cordis:include <name>') is stripped first, then the plain name
 * decides: the three chamber host packages, the chamber client plugins
 * (packaged mobile entry + any other), the official `@deepseek-ai/*` scope,
 * and everything else as third-party.
 */
export function classifyInventoryEntry(moduleName: string): InventoryEntryKind {
  const name = stripCordisInclude(moduleName)
  const clientKind = classifyChamberClientPlugin(name)
  if (clientKind !== null) return clientKind
  if (name === HOST_GRAPH_PACKAGE) return 'chamber-host-graph'
  if (name === GIT_WORKTREE_PACKAGE) return 'chamber-git-worktree'
  if (name === ARCHIVE_CLEANUP_PACKAGE) return 'chamber-archive-cleanup'
  if (name.startsWith(OFFICIAL_SCOPE)) return 'official'
  return 'third-party'
}

/**
 * Third-party projection: the instance's loaded entries that classify as
 * neither official (`@deepseek-ai/*`) nor any chamber row — the registry host
 * packages, the chamber client plugins (design 21 §6.2; the mobile row used
 * to leak in via its raw patch-syntax report) and every package name in
 * `expectedChamberNames` — the gateway view's analogue of the SSH dialog's
 * "third-party plugins" diff.
 *
 * `expectedChamberNames` is the REGISTRY-DERIVED expected list of the current
 * view (deriveChamberRows' rows, i.e. the desktop manifest projection). The
 * literal constants below only classify the three names this module knows by
 * name; a future registry `@dsh-chamber/dsh-host-*` package is unknown to
 * them and would otherwise leak into this zone's third-party list — the
 * caller's expected list is what keeps the zone honest (review G2-5). It
 * defaults to [] so the pure tests can exercise the literal classification
 * alone.
 */
export function thirdPartyEntries(
  snapshot: Pick<PluginInventorySnapshot, 'entries'>,
  expectedChamberNames: readonly string[] = [],
): PluginInventorySnapshot['entries'] {
  const chamberNames = new Set(expectedChamberNames)
  return snapshot.entries.filter(entry => {
    const name = stripCordisInclude(entry.moduleName)
    if (chamberNames.has(name)) return false
    return classifyInventoryEntry(entry.moduleName) === 'third-party'
  })
}

/**
 * Remote-side label key for one chamber host package, derived from the
 * managed instance's LIVE Loader state (the inventory is more precise than
 * the SSH dialog's file probe: presence + enablement + root-fiber phase are
 * the actual load outcome, never a constant claim). A present-but-DISABLED
 * entry (the host's list() reports disabled Loader entries too) is never
 * claimed live.
 */
/** Map a chamber package name to its inventory-entry kind (the reverse of
 *  classifyInventoryEntry for the fixed chamber rows). */
function chamberKindOf(packageName: string): InventoryEntryKind {
  const clientKind = classifyChamberClientPlugin(packageName)
  if (clientKind !== null) return clientKind
  if (packageName === HOST_GRAPH_PACKAGE) return 'chamber-host-graph'
  if (packageName === GIT_WORKTREE_PACKAGE) return 'chamber-git-worktree'
  if (packageName === ARCHIVE_CLEANUP_PACKAGE) return 'chamber-archive-cleanup'
  return 'third-party'
}

export function chamberRemoteKey(
  entries: readonly { moduleName: string; enabled: boolean; fiberPhase: PluginFiberPhase }[],
  packageName: string,
): SettingsConnectionsKey {
  // Classification-aware match: the gateway's patch-insert rows (the mobile
  // entry) are reported under the raw 'cordis:include <name>' prefix, so a
  // plain moduleName equality would never find them (plan 24 D7-A fix).
  // Non-chamber names keep the historical exact-name contract.
  const kind = chamberKindOf(packageName)
  const entry = kind === 'third-party'
    ? entries.find(candidate => candidate.moduleName === packageName)
    : entries.find(candidate => classifyInventoryEntry(candidate.moduleName) === kind)
  if (entry === undefined) return 'chamberRemoteNotInjected'
  if (!entry.enabled) return 'chamberRemoteInjectedUnknown'
  if (entry.fiberPhase === 'active') return 'chamberRemoteLive'
  if (entry.fiberPhase === 'failed') return 'chamberRemoteFailed'
  return 'chamberRemoteInjectedUnknown'
}

/* ---- Third-party row live state (Loader-derived, per-row 生效状态) ----
 * The installed-row lists (local / gateway / http zones) render each
 * third-party row's live state from the managed instance's Loader plugin
 * snapshot — the profile manifest alone can never claim liveness. Chamber
 * rows never reach this projection (the callers filter them out; their own
 * badges are remoteChamberBadge). */

/** One third-party row's live-state chip: a localized label plus the same
 *  badge tone vocabulary as the chamber rows. */
export interface ThirdPartyLiveState {
  labelKey: SettingsConnectionsKey
  tone: ChamberBadgeTone
}

/**
 * Live state of one installed third-party package, derived from the managed
 * instance's Loader snapshot. Exact-name match (`moduleName === packageName`
 * — the historical exact-name contract for non-chamber names, mirroring
 * chamberRemoteKey): a profile dependency whose package mounts as a Loader
 * entry keeps the package name as its module name. Each state stays under
 * its honesty ceiling — a live claim only from an enabled + active fiber:
 *  - no matching entry AND the package is a profile LAYER (in
 *    `dsh.profile.bundles` / `localList.bundles` — `expectsLoaderEntry`) →
 *    the RUNNING instance has not mounted it yet; it activates on the
 *    instance's next restart (never a live claim);
 *  - no matching entry and NOT a profile layer (plain / client-only
 *    dependency — nothing mounts it on restart: `dsh plugin add` only adds
 *    dsh.bundle-declaring packages to the bundle layers) → null: the state
 *    cell stays neutral; "重启后生效" would be a false promise;
 *  - matched but disabled → installed, explicitly disabled (已停用);
 *  - matched + enabled + active → mounted and live (生效中);
 *  - matched + enabled + failed → the load failed (加载失败);
 *  - matched + enabled in any other phase (pending / loading / unloading /
 *    null fiber) → still loading or between lifecycles (加载中).
 * @param snapshot - the Loader inventory snapshot; null (the read failed or
 *   the instance is not reachable, e.g. a stopped local instance) → null:
 *   the caller keeps the state cell neutral — an unreadable snapshot is
 *   never a state claim.
 * @param expectsLoaderEntry - whether the installed row names a profile
 *   bundle layer (local: `localList.bundles.includes(name)`; gateway:
 *   `installed.bundles.includes(name)`). Only such rows can ever mount via
 *   the Loader, so only they may render the "activates on restart" state
 *   when the snapshot has no entry yet.
 * @returns The chip {labelKey, tone}, or null when no snapshot is available
 *   or the row cannot mount (no entry + not a bundle layer).
 */
export function thirdPartyLiveState(
  snapshot: Pick<PluginInventorySnapshot, 'entries'> | null,
  packageName: string,
  expectsLoaderEntry: boolean,
): ThirdPartyLiveState | null {
  if (snapshot === null) return null
  const entry = snapshot.entries.find(candidate => candidate.moduleName === packageName)
  if (entry === undefined) {
    return expectsLoaderEntry ? { labelKey: 'thirdPartyLiveRestart', tone: 'warn' } : null
  }
  if (!entry.enabled) return { labelKey: 'pluginDisabled', tone: 'muted' }
  if (entry.fiberPhase === 'active') return { labelKey: 'thirdPartyLiveActive', tone: 'ok' }
  // The failed-load label is the shared badge copy (chamberBadgeFailed:
  // 加载失败 / Failed to load) — the tone is what carries the danger color.
  if (entry.fiberPhase === 'failed') return { labelKey: 'chamberBadgeFailed', tone: 'danger' }
  return { labelKey: 'thirdPartyLiveStarting', tone: 'muted' }
}

/* ---- Chamber row badges (plan 24 B1.5: the three-row chamber table is
 * badge-ized — a short label plus a tone the renderer colors) ---- */

/** Tone of one chamber row badge: 'ok' = injected and effective,
 *  'muted' = absent / not yet proven live / unknown, 'warn' = degraded
 *  (unreadable local side or version drift), 'danger' = load failure. */
export type ChamberBadgeTone = 'ok' | 'muted' | 'warn' | 'danger'

/** One chamber row badge: a localized label plus its tone. */
export interface ChamberBadge {
  labelKey: SettingsConnectionsKey
  tone: ChamberBadgeTone
}

/**
 * Local-side badge for one chamber package: the desktop's own profile
 * manifest truth. `injected` = the boot row is installed and patched —
 * the strongest claim available locally, no separate live probe exists.
 * null = unknown: still loading (muted), or the local manifest was
 * unreadable (`failed` — a degradation, hence 'warn'; never a silent
 * "not injected").
 */
export function localChamberBadge(injected: boolean | null, failed: boolean): ChamberBadge {
  if (injected === true) return { labelKey: 'chamberBadgeInjected', tone: 'ok' }
  if (injected === false) return { labelKey: 'chamberBadgeNotInjected', tone: 'muted' }
  return failed
    ? { labelKey: 'chamberBadgeUnknown', tone: 'warn' }
    : { labelKey: 'chamberBadgeUnknown', tone: 'muted' }
}

/**
 * Remote-side badge for one chamber package, reusing the exact
 * chamberRemoteKey live-Loader semantics: present + enabled + active =
 * live (ok); failed = danger; absent = not injected; anything else
 * (present but not proven live, or present-but-disabled) claims presence
 * only — muted, never a live claim.
 */
export function remoteChamberBadge(
  entries: readonly { moduleName: string; enabled: boolean; fiberPhase: PluginFiberPhase }[],
  packageName: string,
): ChamberBadge {
  switch (chamberRemoteKey(entries, packageName)) {
    case 'chamberRemoteLive':
      return { labelKey: 'chamberBadgeLive', tone: 'ok' }
    case 'chamberRemoteFailed':
      return { labelKey: 'chamberBadgeFailed', tone: 'danger' }
    case 'chamberRemoteNotInjected':
      return { labelKey: 'chamberBadgeNotInjected', tone: 'muted' }
    default:
      // chamberRemoteInjectedUnknown: presence is a fact, effectiveness is not.
      return { labelKey: 'chamberBadgeInjected', tone: 'muted' }
  }
}

/* ---- Gateway chamber seed-cache drift (design 21 §6.2/§6.5, plan Phase 3:
 * A0 read side) ----
 * The gateway plugin view's manual chamber sync reads the desktop's own
 * local chamber versions (localPluginList chamber projection — the versions
 * the sync would upload) against the gateway's seed cache (GET
 * /chamber/plugins items). The comparison below is the pure drift the view
 * renders and the「立即同步」action resolves. */

/** Per-package local ↔ gateway-cache comparison state. */
export type ChamberSeedDriftState = 'drift' | 'match' | 'absent-cache' | 'absent-local'

/** One package's state: a cache missing the package/version is the dominant
 *  fact ('absent-cache' — the gateway is fresh or the sync never landed);
 *  an unknown LOCAL version next to a cached package ('absent-local' — the
 *  local manifest was unreadable) can never claim a version mismatch; only
 *  both-known inequality is a real drift. */
function chamberSeedState(localVersion: string | null, cachedVersion: string | null): ChamberSeedDriftState {
  if (cachedVersion === null) return 'absent-cache'
  if (localVersion === null) return 'absent-local'
  return localVersion === cachedVersion ? 'match' : 'drift'
}

/** Compare the local chamber versions against the gateway seed cache (the
 *  GET /chamber/plugins items keyed by package name). Cache entries the map
 *  does not name count as absent-cache; unknown (non-chamber) names in the
 *  map are ignored. */
export function chamberSeedDrift(
  local: readonly { readonly name: string; readonly version: string | null }[],
  cached: Record<string, string | null>,
): Record<string, ChamberSeedDriftState> {
  return Object.fromEntries(
    local.map(pkg => [pkg.name, chamberSeedState(pkg.version, cached[pkg.name] ?? null)]),
  )
}

/* ---- Chamber table row derivation (plan 24 B1.5; extracted + tested 2026-09
 * P1 round) ----
 * The「chamber 内置（注入）」table's rows are DERIVED here, never assembled
 * inline in the component: the derivation encodes the per-target data-source
 * matrix (which read feeds the expected list, the local column and the version
 * column), and an untested inline branch once read the wrong manifest source
 * for the LOCAL target. This module stays locale-free: rows carry label KEYS
 * and version STRINGS, never JSX and never localized text — PluginDialog.tsx
 * maps descriptors to elements with the badge classes. */

/** The plugin dialog's four backends (plan 24 B1.1). */
export type ChamberTarget = 'local' | 'ssh' | 'gateway' | 'http'

/** One derived chamber table row. */
export interface ChamberRowDescriptor {
  /** Stable React key: the registry insert id, or the derived client row's
   *  package name (`chamber-client-unknown` when the inventory is missing). */
  readonly key: string
  /** Package name; null ONLY for the inventory-unavailable client row — an
   *  unknown state never renders a hardcoded package name. */
  readonly name: string | null
  /** Name-cell label key rendered in front of the package name (derived
   *  client rows only; registry rows show the bare package name). */
  readonly nameLabelKey: SettingsConnectionsKey | null
  readonly localBadge: ChamberBadge | null
  readonly remoteBadge: ChamberBadge | null
  /** Local-side version text (`v1.2.3`); null = unknown (the view renders —). */
  readonly versionText: string | null
  /** Version-cell hint key for a derived client row (no version applies). */
  readonly versionHintKey: SettingsConnectionsKey | null
  /** Gateway arm: the seed-cache version text (`v1.2.3`), null = the package
   *  is not cached, or the cache was never read. */
  readonly cacheVersionText: string | null
  /** Gateway arm: the cache was read AND lacks this package (render 未同步) —
   *  false while the whole cache is absent (the zone line speaks instead). */
  readonly cacheNotSynced: boolean
  /** Gateway arm: the cache was read and holds NONE of the expected packages;
   *  suppresses every per-row 未同步 marker and drives the zone status line.
   *  Never true for an EMPTY expected list (an unreadable manifest must not
   *  claim "nothing synced"). */
  readonly cacheAbsent: boolean
  /** Gateway arm: this package's local ↔ cache comparison (null = not read). */
  readonly driftState: ChamberSeedDriftState | null
}

/** One chamber host package's state as the desktop projects it (design 13
 *  §6; structural SUBSET of global.d.ts ChamberHostPackageState — `probe` is
 *  unused by this projection, and the omission keeps this module importable by
 *  the plain-node suite). */
export interface ChamberPackageState {
  readonly insertId: string
  readonly name: string
  readonly installed: boolean
  readonly patched: boolean
  readonly version: string | null
  readonly live: boolean | null
}

/** The ssh remote probe result (design 13 §6), structurally. */
export type ChamberProbeState =
  | { readonly ok: true; readonly packages: readonly ChamberPackageState[] }
  | { readonly ok: false; readonly error: string }

/** One Loader inventory entry (the subset the derivation reads). */
export interface ChamberInventoryEntry {
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/**
 * The ssh remote-side chamber badge: the probed ChamberPackageState tri-state
 * mapped onto the shared badge vocabulary — present + enabled + live = 已生效
 * (ok); present but not proven live = 已注入 (muted); present without the boot
 * layer = 已注入 (warn, the half-injected state); absent = 未注入; probe
 * failure/absent state = 未知 (warn/muted). Never a live claim from a file
 * probe (the same live-Loader semantics the gateway badge uses).
 */
export function sshChamberBadge(state: ChamberPackageState | null | undefined): ChamberBadge {
  if (state === undefined) return { labelKey: 'chamberBadgeUnknown', tone: 'muted' }
  if (state === null) return { labelKey: 'chamberBadgeUnknown', tone: 'warn' }
  if (state.installed && state.patched) {
    if (state.live === true) return { labelKey: 'chamberBadgeLive', tone: 'ok' }
    return { labelKey: 'chamberBadgeInjected', tone: 'muted' }
  }
  if (state.installed) return { labelKey: 'chamberBadgeInjected', tone: 'warn' }
  return { labelKey: 'chamberBadgeNotInjected', tone: 'muted' }
}

/** A Loader entry's own badge: present + enabled + active = live; failed =
 *  danger; anything else claims presence only (remoteChamberBadge parity). */
function chamberEntryBadge(entry: ChamberInventoryEntry): ChamberBadge {
  if (!entry.enabled) return { labelKey: 'chamberBadgeInjected', tone: 'muted' }
  if (entry.fiberPhase === 'active') return { labelKey: 'chamberBadgeLive', tone: 'ok' }
  if (entry.fiberPhase === 'failed') return { labelKey: 'chamberBadgeFailed', tone: 'danger' }
  return { labelKey: 'chamberBadgeInjected', tone: 'muted' }
}

/** The localized copy of a derived client row, keyed by its classification:
 *  only the packaged mobile entry has dedicated keys; any other chamber client
 *  plugin renders its package name with no invented label. */
function chamberClientCopy(kind: ChamberClientKind): {
  labelKey: SettingsConnectionsKey | null
  hintKey: SettingsConnectionsKey | null
} {
  return kind === 'chamber-mobile'
    ? { labelKey: 'chamberMobileRow', hintKey: 'chamberMobileHint' }
    : { labelKey: null, hintKey: null }
}

/**
 * Gateway client-plugin rows, derived from the Loader inventory: every entry
 * whose moduleName classifies as a chamber CLIENT plugin
 * (classifyChamberClientPlugin), deduplicated by package name. Never a
 * hardcoded package name.
 *
 * Two fallbacks keep the row present and honest:
 *  - the inventory is UNAVAILABLE (null) → ONE unknown-state row (the gateway
 *    does package a chamber client plugin, but which one and whether it is
 *    live is unknown right now);
 *  - the inventory IS readable but carries no chamber-client entry → ONE
 *    muted 未注入 row (review G2-6): the old hardcoded row showed exactly
 *    that, and rendering NOTHING at all would let a dropped/disabled client
 *    package look like "no such row exists". Still no hardcoded name.
 */
function chamberClientRows(entries: readonly ChamberInventoryEntry[] | null): ChamberRowDescriptor[] {
  if (entries === null) {
    return [{
      key: 'chamber-client-unknown',
      name: null,
      nameLabelKey: 'chamberMobileRow',
      localBadge: null,
      remoteBadge: { labelKey: 'chamberBadgeUnknown', tone: 'muted' },
      versionText: null,
      versionHintKey: 'chamberMobileHint',
      cacheVersionText: null,
      cacheNotSynced: false,
      cacheAbsent: false,
      driftState: null,
    }]
  }
  const seen = new Set<string>()
  const rows: ChamberRowDescriptor[] = []
  for (const entry of entries) {
    const kind = classifyChamberClientPlugin(entry.moduleName)
    if (kind === null) continue
    const name = stripCordisInclude(entry.moduleName)
    if (seen.has(name)) continue
    seen.add(name)
    const copy = chamberClientCopy(kind)
    rows.push({
      key: `chamber-client:${name}`,
      name,
      nameLabelKey: copy.labelKey,
      localBadge: null,
      remoteBadge: chamberEntryBadge(entry),
      versionText: null,
      versionHintKey: copy.hintKey,
      cacheVersionText: null,
      cacheNotSynced: false,
      cacheAbsent: false,
      driftState: null,
    })
  }
  if (rows.length === 0) {
    return [{
      key: 'chamber-client-absent',
      name: null,
      nameLabelKey: 'chamberMobileRow',
      localBadge: null,
      remoteBadge: { labelKey: 'chamberBadgeNotInjected', tone: 'muted' },
      versionText: null,
      versionHintKey: 'chamberMobileHint',
      cacheVersionText: null,
      cacheNotSynced: false,
      cacheAbsent: false,
      driftState: null,
    }]
  }
  return rows
}

/** The full input matrix of the chamber table (see deriveChamberRows). */
export interface ChamberRowsInput {
  readonly target: ChamberTarget
  /** The TARGET's own expected registry list. LOCAL: its own profile manifest
   *  (`localList.chamber.packages`). ssh/gateway/http: the desktop's local
   *  manifest projection. null = unreadable / not loaded yet. */
  readonly expected: readonly ChamberPackageState[] | null
  /** The DESKTOP's local manifest projection — the LOCAL side column of a
   *  remote target. null = unreadable / not loaded yet. */
  readonly localManifestChamber: readonly ChamberPackageState[] | null
  /** The ssh remote probe (design 13 §6); null for other targets. */
  readonly remoteChamber: ChamberProbeState | null
  /** The managed instance's Loader inventory (gateway/http remote badge and
   *  the gateway's derived client rows). null = not read yet / read failed. */
  readonly inventory: { readonly entries: readonly ChamberInventoryEntry[] } | null
  /** The gateway seed cache: package name → version | null. null = never read. */
  readonly seedCache: Record<string, string | null> | null
  /** The LOCAL manifest read failed (a degradation → warn, never a silent
   *  "not injected"). */
  readonly localSideFailed: boolean
}

/**
 * Derive the chamber table's rows for one target. Data sources (the matrix
 * this function exists to pin — an untested inline copy once read the wrong
 * manifest for the LOCAL target):
 *  - expected list: ssh prefers the remote probe's own list when it succeeded,
 *    otherwise the caller's list (the desktop projection — a remote-only read
 *    failure must stay visible); local/gateway/http use the caller's list.
 *  - LOCAL column: the local target reads ITS OWN profile manifest (its
 *    expected rows); remote targets read the desktop's projection.
 *  - version: ssh reads the remote probe's version, everything else the local
 *    list's version (gateway additionally renders the seed-cache comparison).
 *  - an EMPTY expected list yields no rows and can never claim a seed-cache
 *    state.
 * @returns the registry rows (one per expected package) plus, for the gateway,
 *   the inventory-derived chamber client rows.
 */
export function deriveChamberRows(input: ChamberRowsInput): ChamberRowDescriptor[] {
  const { target, expected, localManifestChamber, remoteChamber, inventory, seedCache, localSideFailed } = input
  const isLocal = target === 'local'
  const isSsh = target === 'ssh'
  const isGateway = target === 'gateway'
  const remoteExpected = isSsh && remoteChamber?.ok === true ? remoteChamber.packages : null
  const expectedList = remoteExpected ?? expected ?? []
  const localList = isLocal ? expected : localManifestChamber
  const localByName = new Map((localList ?? []).map(pkg => [pkg.name, pkg]))
  const remoteByName = new Map((remoteExpected ?? []).map(pkg => [pkg.name, pkg]))
  const entries = inventory === null ? null : inventory.entries
  // A KNOWN, non-empty expected set is a precondition: an unreadable manifest
  // (empty list) must never claim "the gateway has nothing synced".
  const cacheAbsent = isGateway && seedCache !== null && expectedList.length > 0
    && expectedList.every(pkg => (seedCache[pkg.name] ?? null) === null)
  const driftStates = isGateway && seedCache !== null && localList !== null
    ? chamberSeedDrift(localList, seedCache)
    : null
  const unknownBadge: ChamberBadge = { labelKey: 'chamberBadgeUnknown', tone: 'muted' }
  const versionTextOf = (version: string | null): string | null => version === null ? null : `v${version}`

  const rows = expectedList.map((pkg): ChamberRowDescriptor => {
    const local = localByName.get(pkg.name)
    const remote = remoteByName.get(pkg.name)
    const cached = seedCache === null ? null : (seedCache[pkg.name] ?? null)
    return {
      key: pkg.insertId,
      name: pkg.name,
      nameLabelKey: null,
      localBadge: isLocal
        ? localChamberBadge(pkg.installed && pkg.patched, false)
        : localChamberBadge(local === undefined ? null : local.installed && local.patched, localSideFailed),
      remoteBadge: isSsh
        ? sshChamberBadge(remote ?? null)
        : isGateway || target === 'http'
          ? (entries === null ? unknownBadge : remoteChamberBadge(entries, pkg.name))
          : null,
      versionText: versionTextOf(isSsh ? (remote?.version ?? null) : (local?.version ?? null)),
      versionHintKey: null,
      cacheVersionText: isGateway ? versionTextOf(cached) : null,
      cacheNotSynced: isGateway && seedCache !== null && cached === null && !cacheAbsent,
      cacheAbsent,
      driftState: isGateway ? (driftStates?.[pkg.name] ?? null) : null,
    }
  })
  if (isGateway) rows.push(...chamberClientRows(entries))
  return rows
}
