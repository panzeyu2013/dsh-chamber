/**
 * Threshold tables - the SINGLE source of the lifecycle numbers for the TS side.
 *
 * Imports NOTHING (not even `node:` builtins): consumed by browser code, and mirrored
 * read-only by `tables.json` for the Swift side. One source, two consumers; changing a
 * value here is a BEHAVIOR_CHANGES entry, never a free parameter.
 */

/** Rolling window of the physical-carrier rebuild throttle (three call sites share it). */
export const REBUILD_WINDOW_MS = 60_000
export const MAX_REBUILDS_PER_WINDOW = 1
export const MIN_REBUILD_SPACING_MS = 1_000
/** In-flight rebuild grace: without it `replaceSocket` could cancel its own successor's
 * connect attempt. */
export const IN_FLIGHT_GRACE_MS = 1_000

/** Opening-item deadline per logical-stream episode, and its widening ladder. Ladder
 * index = consecutive timeouts for ONE episode; the episode, not an endpoint digest,
 * owns the widening. Sole owner for TS and the fork. */
export const OPENING_TIMEOUT_LADDER_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000, 300_000]

/** A logical stream must have lived at least this long before its teardown may judge
 * the socket silent. */
export const SILENT_TEARDOWN_MIN_MS = 15_000

/** Consecutive unanswered opening deadlines for ONE episode before the carrier is
 * rebuilt while frames ARE arriving. A frame-answering socket is left alone on the
 * first timeout; only a second consecutive miss proves the request is stuck. */
export const OPENING_STALL_STREAK = 2

/** Bound on the reducer's opening-ledger maps: a page that times out on many sessions
 * must not grow the ledger without a limit. Oldest-first eviction only resets a key's
 * widening; it never changes a decision already made. */
const OPENING_EPISODE_KEYS_MAX = 256

/** Deadline for one WebSocket handshake: a socket that never fires open/error/close
 * must fail the attempt, not park every open() until the lane's readiness timeout. */
export const HANDSHAKE_TIMEOUT_MS = 30_000

/** Presentation-arbiter thresholds: absolute release deadlines the frame carries, so
 * the renderer imports ONE table instead of owning module-local copies. */
export const PRESENTATION_THRESHOLDS = {
  veilActionsAfterMs: 10_000,
  surfaceMaxHoldMs: 70_000,
  surfaceAbsentFallbackMs: 2_000,
} as const

/** Environment handed to the carrier reducer - tables, never call-site literals, so the
 * executor cannot drift from the table. */
export const CARRIER_ENV = {
  rebuildWindowMs: REBUILD_WINDOW_MS,
  maxRebuildsPerWindow: MAX_REBUILDS_PER_WINDOW,
  minRebuildSpacingMs: MIN_REBUILD_SPACING_MS,
  inFlightGraceMs: IN_FLIGHT_GRACE_MS,
  openingStallStreak: OPENING_STALL_STREAK,
  openingEpisodeKeysMax: OPENING_EPISODE_KEYS_MAX,
} as const

/** Opening deadline for an episode that has already timed out `streak` times. */
export function openingBudgetMs(streak: number): number {
  const index = Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0
  const capped = Math.min(index, OPENING_TIMEOUT_LADDER_MS.length - 1)
  return OPENING_TIMEOUT_LADDER_MS[capped] as number
}

/**
 * The FOUR recovery ladders' thresholds, as the single table. Every ladder READS this
 * table instead of declaring its own literals: the mobile stall machine, the sidebar's
 * authority probe, the renderer's authority escalation and the open-in stream-health
 * chip. The numbers are measured from each module's own declarations; changing a value
 * is a BEHAVIOR_CHANGES entry, never a free parameter.
 */
export const LADDER_TABLES = {
  /** The phone's stall ladder. */
  mobile: {
    thresholdMs: 45_000,
    pollMs: 3_000,
    resyncCooldownMs: 120_000,
    resyncWindowMs: 600_000,
    resyncMax: 3,
    failedMs: 90_000,
  },
  /** The session-fact authority: ONE set of numbers for two hosts of the same engine -
   * the sidebar executor's probe cadence and the App's reconnect/notice escalation. */
  authority: {
    /** Probes (independent authority reads) per running episode. */
    probeAfterMs: 60_000,
    probeCoalesceMs: 200_000,
    probeWindowMs: 600_000,
    maxProbesPerWindow: 3,
    /** Reconnect only with stuck evidence (a probe that could not conclude). */
    reconnectAfterMs: 190_000,
    reconnectCooldownMs: 300_000,
    maxReconnects: 1,
    /** Notice = reconnectAfterMs + grace, preserving tier order. */
    noticeAfterMs: 310_000,
  },
  /** open-in session-stream-health.ts: the conversation-stream health ladder. */
  streamHealth: {
    errorGraceMs: 8_000,
    loadingStallMs: 20_000,
    loadingFailedMs: 90_000,
    healCooldownMs: 120_000,
    healBudgetWindowMs: 600_000,
    healBudgetMax: 3,
    healSettleMs: 20_000,
    carrierChurnMs: 10_000,
  },
} as const

/** The literal table as a value, for the tables.json lockstep assertion. */
export const TABLE_SNAPSHOT = {
  rebuildWindowMs: REBUILD_WINDOW_MS,
  maxRebuildsPerWindow: MAX_REBUILDS_PER_WINDOW,
  minRebuildSpacingMs: MIN_REBUILD_SPACING_MS,
  inFlightGraceMs: IN_FLIGHT_GRACE_MS,
  openingTimeoutLadderMs: OPENING_TIMEOUT_LADDER_MS,
  silentTeardownMinMs: SILENT_TEARDOWN_MIN_MS,
  openingStallStreak: OPENING_STALL_STREAK,
  openingEpisodeKeysMax: OPENING_EPISODE_KEYS_MAX,
  handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  presentation: PRESENTATION_THRESHOLDS,
  ladders: LADDER_TABLES,
} as const
