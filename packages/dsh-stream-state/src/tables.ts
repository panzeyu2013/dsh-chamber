/**
 * Threshold tables - the SINGLE source of the lifecycle numbers for the TS side.
 *
 * PURITY (enforced by scripts/test.mjs): this module imports NOTHING, not even
 * node: builtins. It is consumed by browser code, so a `node:fs` read here would
 * compile but fail at runtime in the page. The cross-language mirror
 * (`tables.json`) is therefore a READ-ONLY projection of these literals:
 * `test/tables/tables-parity.test.ts` fails if the two disagree, and the Swift
 * mirror gate reads the JSON. One source (these literals), two consumers.
 *
 * Discipline: changing a value here is a
 * BEHAVIOR_CHANGES entry (see DIVERGENCE.md), never a free parameter.
 */

/** Rolling window of the physical-carrier rebuild throttle.
 * The three replacement entries share this bound (see the stream-carrier audit). */
export const REBUILD_WINDOW_MS = 60_000
export const MAX_REBUILDS_PER_WINDOW = 1
/** Minimum distance between two allowed rebuilds. */
export const MIN_REBUILD_SPACING_MS = 1_000
/** In-flight rebuild grace: without it `replaceSocket` could cancel its own
 * successor's connect attempt because nothing tracks this. */
export const IN_FLIGHT_GRACE_MS = 1_000

/** Opening-item deadline per logical-stream episode, and its widening ladder.
 * Mirrors REMOTE_STREAM_OPENING_TIMEOUT_MS / `remoteStreamOpeningTimeoutMs`
 * (packages/dsh-api-gateway/src/client/remote-retry-policy.ts). Ladder index =
 * consecutive timeouts for ONE episode; the episode, not the endpoint digest,
 * owns the widening (DIVERGENCE D-4). */
export const OPENING_TIMEOUT_LADDER_MS: readonly number[] = [30_000, 60_000, 120_000, 240_000, 300_000]

/** A logical stream must have lived at least this long before its teardown may
 * judge the socket silent (mirrors REMOTE_STREAM_SILENT_TEARDOWN_MIN_MS). */
export const SILENT_TEARDOWN_MIN_MS = 15_000

/** Consecutive unanswered opening deadlines for ONE episode before the carrier is
 * rebuilt while frames ARE arriving (mirrors
 * REMOTE_STREAM_OPENING_ESCALATION_STREAK = 2). A frame-answering socket is left
 * alone on the first timeout because a slow-but-working Host must keep its
 * in-flight answer; only a second consecutive miss proves the request - not the
 * socket - is stuck. */
export const OPENING_STALL_STREAK = 2

/** Environment handed to the carrier reducer - tables, never literals at the
 * call site, so the executor cannot drift from the table. */
export const CARRIER_ENV = {
  rebuildWindowMs: REBUILD_WINDOW_MS,
  maxRebuildsPerWindow: MAX_REBUILDS_PER_WINDOW,
  minRebuildSpacingMs: MIN_REBUILD_SPACING_MS,
  inFlightGraceMs: IN_FLIGHT_GRACE_MS,
  openingStallStreak: OPENING_STALL_STREAK,
} as const

/** Opening deadline for an episode that has already timed out `streak` times. */
export function openingBudgetMs(streak: number): number {
  const index = Number.isFinite(streak) && streak > 0 ? Math.floor(streak) : 0
  const capped = Math.min(index, OPENING_TIMEOUT_LADDER_MS.length - 1)
  return OPENING_TIMEOUT_LADDER_MS[capped] as number
}

/**
 * The FOUR recovery ladders' thresholds, recorded here as the single table.
 *
 * These values are still OWNED by their modules (the mobile stall machine, the
 * sidebar fact-reconcile receipt chain, liveness and the health chip); the table
 * adopts them one ladder at a time. Until then
 * `scripts/gates/verify-ladder-table-parity.mjs` locks every surviving declaration to
 * the numbers below, so the table and the modules cannot drift apart while both
 * exist - the same lockstep as the Swift mirror. A module that stops
 * declaring its constant is that adoption working, not a failure.
 *
 * The numbers are measured from each module's own declarations, not chosen
 * here. Changing a value is a BEHAVIOR_CHANGES entry, never a free parameter.
 */
export const LADDER_TABLES = {
  /** mobile session-stall.ts: the phone's stall ladder. */
  mobile: {
    thresholdMs: 45_000,
    pollMs: 3_000,
    resyncCooldownMs: 120_000,
    resyncWindowMs: 600_000,
    resyncMax: 3,
    failedMs: 90_000,
  },
  /** sidebar session-fact-reconcile.ts: the 190 s-class receipt chain. */
  factReconcile: {
    maxAttempts: 2,
    retryMs: 1_500,
    attemptTimeoutMs: 20_000,
    verifyTimeoutMs: 65_000,
    correctivePhaseTimeoutMs: 5_000,
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
  ladders: LADDER_TABLES,
} as const
