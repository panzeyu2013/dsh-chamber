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

/** Bound on the reducer's opening-ledger maps (provenance:
 * OPENING_BUDGET_KEYS_MAX = 256 in the retired mux copy): a page that times out on
 * many sessions must not grow the ledger without a limit. Oldest-first eviction
 * only resets a key's widening; it never changes a decision already made. */
const OPENING_EPISODE_KEYS_MAX = 256

/** Deadline for one WebSocket handshake (provenance:
 * REMOTE_STREAM_HANDSHAKE_TIMEOUT_MS). A socket that never fires open/error/close
 * must fail the attempt, not park every open() until the connection lane's own
 * readiness timeout. G-G locks the fork-side constant to this value until P3
 * moves the decision into the carrier reducer. */
export const HANDSHAKE_TIMEOUT_MS = 30_000

/** Presentation-arbiter thresholds (provenance: source-readiness.ts
 * VEIL_ACTIONS_AFTER_MS, session-surface.ts SURFACE_MAX_HOLD_MS /
 * SURFACE_ABSENT_FALLBACK_MS). P2 moved them here so the renderer imports ONE table
 * instead of owning module-local copies; the frame carries the resulting absolute
 * release deadline. */
export const PRESENTATION_THRESHOLDS = {
  veilActionsAfterMs: 10_000,
  surfaceMaxHoldMs: 70_000,
  surfaceAbsentFallbackMs: 2_000,
} as const

/** Environment handed to the carrier reducer - tables, never literals at the
 * call site, so the executor cannot drift from the table. */
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
 * The FOUR recovery ladders' thresholds, recorded here as the single table.
 *
 * Every ladder READS this table instead of declaring its own literals: the mobile
 * stall machine (dsh-chamber-client-ui-mobile), the sidebar's authority probe (the
 * former fact-reconcile receipt chain), the renderer's authority escalation (the
 * former liveness guard) and the open-in stream-health chip.
 * `scripts/gates/verify-ladder-table-parity.mjs` keeps the collection honest in both
 * directions: each retired declaration/leaf literal must stay absent from its module
 * (the table is the authority), and every named consumer must reference
 * `LADDER_TABLES.<ladder>` in code - a module that starts carrying its own copy
 * again turns the gate red instead of drifting silently.
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
  /**
   * The session-fact authority (docs/progress/todo/session-authority-refactor.md):
   * ONE set of numbers for two hosts of the same engine - the sidebar executor's
   * probe cadence and the App's reconnect/notice escalation. They replace the
   * former renderer-local SESSION_LIVENESS_DEFAULTS and the sidebar's 190 s
   * receipt chain (both retired by P2).
   */
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
    /** Notice = reconnectAfterMs + the former 120 s grace, preserving tier order. */
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
