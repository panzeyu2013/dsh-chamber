/**
 * Plugin-inventory display helpers (design 05 §5 / gateway 插件视图): the
 * pure, UI-free projections for the read-only inventory view, mirroring the
 * SSH plugin dialog's row semantics (plugin-diff.ts / PluginSyncModal.tsx
 * split). Split from plugin-inventory-view.tsx so the plain-node test suite
 * (which cannot execute .tsx or CSS modules) covers the projections.
 */

import type { SettingsConnectionsKey } from '../locales.ts'
import type { PluginFiberPhase, PluginInventorySnapshot } from './plugin-inventory-api.ts'

/** The chamber-injected host package names (design 09 module A + design 08):
 *  the same fixed rows the SSH plugin dialog surfaces; the single source of
 *  truth for the names is plugin-sync.ts CLIENT_GRAPH_PACKAGE_NAME. */
export const HOST_GRAPH_PACKAGE = '@dsh-chamber/dsh-host-client-graph'
export const GIT_WORKTREE_PACKAGE = '@dsh-chamber/dsh-host-git-worktree'

/** Official (built-in) package scope: never a third-party row. */
const OFFICIAL_SCOPE = '@deepseek-ai/'

/**
 * Third-party projection: the instance's loaded entries that are neither
 * official (`@deepseek-ai/*`) nor the two chamber host packages — the
 * gateway view's analogue of the SSH dialog's "third-party plugins" diff.
 */
export function thirdPartyEntries(snapshot: Pick<PluginInventorySnapshot, 'entries'>): PluginInventorySnapshot['entries'] {
  return snapshot.entries.filter(entry =>
    !entry.moduleName.startsWith(OFFICIAL_SCOPE)
    && entry.moduleName !== HOST_GRAPH_PACKAGE
    && entry.moduleName !== GIT_WORKTREE_PACKAGE)
}

/**
 * Remote-side label key for one chamber host package, derived from the
 * managed instance's LIVE Loader state (the inventory is more precise than
 * the SSH dialog's file probe: presence + enablement + root-fiber phase are
 * the actual load outcome, never a constant claim). A present-but-DISABLED
 * entry (the host's list() reports disabled Loader entries too) is never
 * claimed live.
 */
export function chamberRemoteKey(
  entries: readonly { moduleName: string; enabled: boolean; fiberPhase: PluginFiberPhase }[],
  packageName: string,
): SettingsConnectionsKey {
  const entry = entries.find(candidate => candidate.moduleName === packageName)
  if (entry === undefined) return 'chamberRemoteNotInjected'
  if (!entry.enabled) return 'chamberRemoteInjectedUnknown'
  if (entry.fiberPhase === 'active') return 'chamberRemoteLive'
  if (entry.fiberPhase === 'failed') return 'chamberRemoteFailed'
  return 'chamberRemoteInjectedUnknown'
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
