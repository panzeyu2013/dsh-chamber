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

/** Consecutive unanswered opening deadlines for ONE logical stream at which its
 * opening budget is EXHAUSTED: every rung of {@link OPENING_TIMEOUT_LADDER_MS} was
 * spent without the consumer ever accepting, so the phase machine reports a
 * terminal instead of re-issuing forever (the ladder total is the budget). Consumed
 * through {@link CARRIER_ENV}/`TABLE_SNAPSHOT`, never imported as a bare constant. */
const OPENING_BUDGET_MAX_MISSES = OPENING_TIMEOUT_LADDER_MS.length

/** Consecutive unanswered opening deadlines for ONE episode before the carrier is
 * rebuilt while frames ARE arriving (the single-sourced sibling of the ladder above;
 * the retired host-side constant it used to mirror is gone). A frame-answering socket
 * is left alone on the first timeout because a slow-but-working Host must keep its
 * in-flight answer; only a second consecutive miss proves the request - not the
 * socket - is stuck. */
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

/** Recovery efficacy (semantic, not numeric): the state boundary each action resets,
 * and the evidence required before it may run. Mirrored into tables.json, consumed by
 * delivery-evidence.ts and locked by the parity gate - an executor may not substitute
 * a cheaper action for a stronger one without editing this table. */
export const DELIVERY_EFFICACY = [
  { tier: 'journal-restart', resets: 'the physical socket and every logical window on it', evidence: 'zero-frame socket or a stalled live tail', owner: 'carrier' },
  { tier: 'resync', resets: "this session's event-stream window", evidence: 'open state is loading with no open in flight, or an error the header cannot heal, and no resync disposing', owner: 'delivery' },
  { tier: 'instance-reboot', resets: 'one instance shell: component and React state', evidence: 'that instance is stalled while the document frame counter still advances', owner: 'delivery' },
  { tier: 'document-reload', resets: 'module-level state and the whole JS context', evidence: 'the document frame counter is stalled', owner: 'delivery' },
  { tier: 'webcontent-crash-recovery', resets: 'the WebContent process', evidence: 'the navigation process terminated', owner: 'shell' },
] as const

/** Environment handed to the carrier reducer - tables, never literals at the
 * call site, so the executor cannot drift from the table. */
export const CARRIER_ENV = {
  rebuildWindowMs: REBUILD_WINDOW_MS,
  maxRebuildsPerWindow: MAX_REBUILDS_PER_WINDOW,
  minRebuildSpacingMs: MIN_REBUILD_SPACING_MS,
  inFlightGraceMs: IN_FLIGHT_GRACE_MS,
  openingStallStreak: OPENING_STALL_STREAK,
  openingEpisodeKeysMax: OPENING_EPISODE_KEYS_MAX,
  openingBudgetMaxMisses: OPENING_BUDGET_MAX_MISSES,
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
  /** The phone's stall ladder. */
  mobile: {
    thresholdMs: 45_000,
    pollMs: 3_000,
    resyncCooldownMs: 120_000,
    resyncWindowMs: 600_000,
    resyncMax: 3,
    failedMs: 90_000,
  },
  /**
   * The session-fact authority:
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
  },
  /**
   * The delivery owner: ONE ladder for every stall family (content / schedule /
   * input / open / authority / unresolved). Tier budgets are the page-level
   * recovery bounds; the carrier's own rebuild table stays separate because its
   * action resets a different boundary (see DELIVERY_EFFICACY).
   */
  delivery: {
    /** First automatic rebuild of a stuck opening. */
    resyncGraceMs: 2_000,
    resyncCooldownMs: 15_000,
    resyncWindowMs: 300_000,
    resyncMax: 2,
    /** The visible-page frame probe both shells run (Electron and Swift watchdog). */
    scheduleProbe: {
      intervalMs: 5_000,
      timeoutMs: 3_000,
      strikes: 3,
      /** Main-process probe round trip above which the JS thread is input-blocked. */
      inputBlockRttMs: 1_000,
    },
    /** Stronger tiers: they need stuck evidence (a probe that could not conclude). */
    rebootAfterMs: 90_000,
    rebootCooldownMs: 120_000,
    rebootWindowMs: 600_000,
    rebootMax: 2,
    reloadAfterMs: 120_000,
    reloadCooldownMs: 300_000,
    reloadWindowMs: 600_000,
    reloadMax: 3,
    /** An unresolved completion retries with this bounded backoff before becoming a fact. */
    unresolvedRetryBaseMs: 6_000,
    unresolvedRetryMaxMs: 60_000,
    unresolvedRetryMax: 5,
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
  openingBudgetMaxMisses: OPENING_BUDGET_MAX_MISSES,
  handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  presentation: PRESENTATION_THRESHOLDS,
  ladders: LADDER_TABLES,
  deliveryEfficacy: DELIVERY_EFFICACY,
} as const
