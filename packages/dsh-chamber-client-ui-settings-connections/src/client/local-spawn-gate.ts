/**
 * Local-card runtime spawn gate. Pure, node-testable.
 *
 * The local card has TWO entries that spawn the local instance: 「启动」 (POST /api/connections)
 * and 「清理并接管」 (POST /api/connections/local/reclaim, which clears this state directory's own
 * stale/orphaned writer records and then STARTS the instance). The gate must cover EVERY spawn
 * entry — an instance spawned inside the snapshot→switch→probe window races the 「未决切换前绝不
 * spawn」 rule — so this module reads the AUTHORITATIVE verdict (`runtimeBlocksLocalStart` in the
 * client-core runtime-management face) as an INPUT and owns only the projection the card renders:
 * one verdict for both entries plus the one visible reason row, so the two cannot drift apart.
 */
import type { SettingsConnectionsKey } from '../locales.ts'

/** Facts the local card already holds; the gate verdict is passed in, never re-derived. */
export interface LocalSpawnGateFacts {
  /** `runtimeBlocksLocalStart(state, surfacePresent)` — the one authoritative verdict. */
  blocked: boolean
  /** The runtime store has not produced a snapshot yet (bridge hydration). */
  hydrating: boolean
  /** Runtime phase projection; only 'applying' carries its own copy. */
  phase: string | null | undefined
  /** Main-process block reason, shown verbatim when it carries one. */
  runtimeBlockedReason?: string | null
}

/**
 * One verdict for every local-card spawn entry: whether the entries are gated, and the reason row
 * the card renders while they are.
 */
export interface LocalSpawnGate {
  /** True while NO spawn entry (start or reclaim) may run. */
  blocked: boolean
  /** The reason row's dictionary key; null while nothing is gated. */
  reasonKey: SettingsConnectionsKey | null
  /** Server-provided detail for the row (verbatim), or null. */
  reasonDetail: string | null
}

/**
 * Project the runtime gate for the local card.
 *
 * Copy precedence: hydration → applying → every remaining gate reason. The last branch is the
 * point of this projection: the authoritative verdict also blocks on `canRetryRestore` and a
 * half/incomplete restore, which would otherwise disable the start button WITHOUT any reason
 * row — every blocked verdict therefore names itself.
 * @returns the verdict: `blocked` plus at most one reason row.
 */
export function localSpawnGate(facts: LocalSpawnGateFacts): LocalSpawnGate {
  if (!facts.blocked) return { blocked: false, reasonKey: null, reasonDetail: null }
  if (facts.hydrating) return { blocked: true, reasonKey: 'localRuntimeHydrating', reasonDetail: null }
  if (facts.phase === 'applying') return { blocked: true, reasonKey: 'localRuntimeApplying', reasonDetail: null }
  const detail = typeof facts.runtimeBlockedReason === 'string' && facts.runtimeBlockedReason.trim() !== ''
    ? facts.runtimeBlockedReason
    : null
  return { blocked: true, reasonKey: 'localRuntimeBlocked', reasonDetail: detail }
}
