/**
 * Plugin-inventory display helpers (design 05 §5 / gateway 插件视图): the
 * pure, UI-free projections for the PluginDialog's inventory-backed zones
 * (plan 24 D5-A merged the former PluginSyncModal/PluginInventoryView split),
 * mirroring the SSH plugin row semantics (plugin-diff.ts split). Kept free of
 * .tsx so the plain-node test suite covers the projections.
 */

import type { SettingsConnectionsKey } from '../locales.ts'
import type { PluginFiberPhase, PluginInventorySnapshot } from './plugin-inventory-api.ts'

/** The chamber-injected host package names (design 09 module A + design 08):
 *  the same fixed rows the SSH plugin dialog surfaces; the single source of
 *  truth for the names is plugin-sync.ts CLIENT_GRAPH_PACKAGE_NAME. */
export const HOST_GRAPH_PACKAGE = '@dsh-chamber/dsh-host-client-graph'
export const GIT_WORKTREE_PACKAGE = '@dsh-chamber/dsh-host-git-worktree'

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
 *  design 21 §6.2 mobile packaged exception). */
export type InventoryEntryKind =
  | 'chamber-host-graph'
  | 'chamber-git-worktree'
  | 'chamber-mobile'
  | 'official'
  | 'third-party'

/**
 * Classify one inventory entry's module specifier. The raw patch-insert
 * prefix ('cordis:include <name>') is stripped first, then the plain name
 * decides: the two chamber host packages, the packaged mobile entry, the
 * official `@deepseek-ai/*` scope, and everything else as third-party.
 */
export function classifyInventoryEntry(moduleName: string): InventoryEntryKind {
  const name = moduleName.startsWith(CORDIS_INCLUDE_PREFIX)
    ? moduleName.slice(CORDIS_INCLUDE_PREFIX.length)
    : moduleName
  if (name === HOST_GRAPH_PACKAGE) return 'chamber-host-graph'
  if (name === GIT_WORKTREE_PACKAGE) return 'chamber-git-worktree'
  if (name === MOBILE_PACKAGE) return 'chamber-mobile'
  if (name.startsWith(OFFICIAL_SCOPE)) return 'official'
  return 'third-party'
}

/**
 * Third-party projection: the instance's loaded entries that classify as
 * neither official (`@deepseek-ai/*`) nor any chamber row — the two host
 * packages AND the packaged mobile entry (design 21 §6.2; the mobile row
 * used to leak in via its raw patch-syntax report) — the gateway view's
 * analogue of the SSH dialog's "third-party plugins" diff.
 */
export function thirdPartyEntries(snapshot: Pick<PluginInventorySnapshot, 'entries'>): PluginInventorySnapshot['entries'] {
  return snapshot.entries.filter(entry => classifyInventoryEntry(entry.moduleName) === 'third-party')
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
  if (packageName === HOST_GRAPH_PACKAGE) return 'chamber-host-graph'
  if (packageName === GIT_WORKTREE_PACKAGE) return 'chamber-git-worktree'
  if (packageName === MOBILE_PACKAGE) return 'chamber-mobile'
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

/** The desktop's local chamber versions (its own profile manifest). */
export interface ChamberLocalVersions {
  hostGraph: string | null
  gitWorktree: string | null
}

/** Per-package local ↔ gateway-cache comparison state. */
export type ChamberSeedDriftState = 'drift' | 'match' | 'absent-cache' | 'absent-local'

/** Both chamber packages' drift states at once (name-keyed cache map). */
export interface ChamberSeedDriftProjection {
  hostGraph: ChamberSeedDriftState
  gitWorktree: ChamberSeedDriftState
}

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
  local: ChamberLocalVersions,
  cached: Record<string, string | null>,
): ChamberSeedDriftProjection {
  return {
    hostGraph: chamberSeedState(local.hostGraph, cached[HOST_GRAPH_PACKAGE] ?? null),
    gitWorktree: chamberSeedState(local.gitWorktree, cached[GIT_WORKTREE_PACKAGE] ?? null),
  }
}
