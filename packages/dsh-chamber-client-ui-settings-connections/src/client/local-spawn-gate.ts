/**
 * Local-card runtime spawn gate (design 18 §3.6 「applying 相位门控」, 2026-12
 * audit P0-4). Pure, node-testable.
 *
 * WHY this module exists: the local connection card has TWO entries that spawn
 * the local instance —
 *
 * - 「启动」 (`startLocal`: POST /api/connections), and
 * - 「清理并接管」 (`reclaimLocal`: POST /api/connections/local/reclaim, which
 *   clears this state directory's own stale/orphaned writer records and then
 *   STARTS the local instance — control-plane/src/api.ts:26-28 answers
 *   `{reclaimed, connection, spawned}`).
 *
 * design 18:245-247 requires the gate to cover «「启动」按钮与任何实例 spawn
 * 入口» — EVERY spawn entry — because an instance spawned inside the
 * snapshot→switch→probe window races the 「未决切换前绝不 spawn」 rule. Before
 * this module only the start button carried the verdict, so 「清理并接管」
 * could still spawn during the applying window.
 *
 * The AUTHORITATIVE gate itself stays where it is
 * (`renderer/src/runtime-management.ts` `runtimeBlocksLocalStart`: fail closed
 * while the bridge hydrates and for every phase with an unsafe DSH_HOME). This
 * module reads that verdict as an INPUT and owns only the projection the card
 * renders — one verdict for both entries plus the one visible reason row — so
 * the two entries cannot drift apart again.
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
 * One verdict for every local-card spawn entry: whether the entries are gated,
 * and the reason row the card renders while they are.
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
 * Copy precedence (the pre-2026-12 inline ladder, now total): hydration →
 * applying → every remaining gate reason. The last branch is the point of this
 * projection: `runtimeBlocksLocalStart` also blocks on `canRetryRestore` and
 * a half/incomplete restore, and those states previously disabled the start
 * button WITHOUT rendering any reason row — a gated entry with no visible
 * cause. Every blocked verdict therefore names itself.
 *
 * @param facts - the card's runtime facts.
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
