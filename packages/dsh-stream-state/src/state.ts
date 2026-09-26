/**
 * Public value surface of the lifecycle reducers: plain data types only - no functions.
 * The reducers are the sole authority, and consumers must not encode policy of their own.
 */

/** Physical carrier phase. `silent` is "WebSocket OPEN but nothing arrives" - the
 * state neither `open` nor `closed` can express. */
export type CarrierPhase = 'connecting' | 'open' | 'silent' | 'replacing' | 'closed'

/**
 * One logical stream's opening phase (F1). A stream whose open frame was sent is
 * `sent`; one whose first frame arrived is `itemReceived`. Acceptance is NOT a phase
 * stored here - it is the `openingAccepted` event, the only transition that clears
 * the widening ledger, and a phase record simply disappears with its episode.
 */
export type OpeningPhase = 'sent' | 'itemReceived'

/** Why a physical carrier rebuild was requested. At most ONE reason is stored at a
 * time, so only one call site may replace the same socket in one window. */
export type RebuildReason =
  | 'socketNoFrame'      // opening deadline expired with zero frames on this socket
  | 'openingStall'       // same request unanswered twice (cooldown-guarded)
  | 'teardownNoFrame'    // a logical stream lived >= silentTeardownMinMs with zero frames
  | 'laneReconnect'      // the connection lane lost its generation
  | 'handshakeTimeout'   // the WebSocket handshake never settled

/** Typed effects: the executor performs them; the reducer never does. */
export type RecoveryEffect =
  /** The ONLY way a physical socket may be replaced. */
  | { readonly e: 'rebuildCarrier'; readonly reason: RebuildReason; readonly at: number }
  /** Reopen one logical stream on the current carrier. */
  | { readonly e: 'reopenLogicalStream'; readonly streamId: string; readonly reason: string }
  /** Arm one episode's opening deadline at the widening ladder's rung for its current
   * streak; the host never derives the budget. */
  | { readonly e: 'armOpeningDeadline'; readonly streamId: string; readonly budgetMs: number; readonly streak: number }
  /** An allowed event arrived while a rebuild was in flight. */
  | { readonly e: 'throttled'; readonly reason: RebuildReason; readonly at: number }
  /** The opening budget is exhausted: the logical stream's opening is TERMINAL. The
   * executor fails that stream's consumer with a non-carrier error (the retry lane
   * must not reopen it) and publishes the `opening-budget-exhausted` fact. */
  | { readonly e: 'failLogicalOpening'; readonly streamId: string; readonly reason: string }
  /** Bounded observability, never a behavior switch. */
  | { readonly e: 'forensic'; readonly name: string; readonly detail: string }

/** Event kinds the carrier reducer understands. An unknown kind is not an error:
 * the reducer records it as ignored (total-function contract). */
export type CarrierEventKind =
  | 'carrierConnecting'
  | 'carrierOpened'
  | 'carrierClosed'
  | 'streamOpened'
  | 'streamFrame'
  | 'streamClosed'
  | 'rebuildRequested'
  /** An open frame was sent; the reducer arms this episode's opening deadline. */
  | 'openingSent'
  /** That deadline expired; the reducer advances the episode's widening streak
   * and decides (silent carrier vs threshold-gated stall) in one step, or declares
   * the budget exhausted when every rung of the ladder was spent. */
  | 'openingExpired'
  /** The logical stream's first frame arrived (transport evidence only). It marks the
   * episode `itemReceived` and NEVER clears the widening: delivery is not acceptance. */
  | 'openingAnswered'
  /** The consumer ACCEPTED the opening item: the only transition that resets the
   * episode's widening budget (F1). Emitted by RemoteStream from the item's
   * `accept()`, behind the generation/revision guard, so a superseded generation's
   * accept can never settle a live one. */
  | 'openingAccepted'
  /** The logical stream's consumer is gone (dispose / abort / normal end): the
   * episode's claims on the carrier end here. */
  | 'episodeClosed'

export interface CarrierEvent {
  readonly kind: CarrierEventKind
  /** Observation time (ms). The reducer NEVER reads a clock; the executor stamps. */
  readonly at: number
  readonly reason?: RebuildReason
  /** Which logical stream this event is about: for the per-stream events the stream
   * being framed/closed; for a `rebuildRequested` the asker - so a DENIED rebuild still
   * produces an exit (the effect reopens THIS stream, keeping the chain out of silence).
   * Declared `| undefined` because call sites forward optional values under
   * `exactOptionalPropertyTypes`; an explicit undefined is treated exactly like absent. */
  readonly streamId?: string | undefined
  /** For an `openingStall` `rebuildRequested`: consecutive opening deadlines missed
   * by this episode. The reducer enforces the threshold, so no call site can escalate on
   * the first miss; explicit undefined is NOT proof of a streak (see `isStallProven`). */
  readonly streak?: number | undefined
  /** For a `rebuildRequested`: frames the CURRENT socket delivered since this attempt
   * sent its open frame. Zero frames across a whole budget turns an `openingStall` into
   * `socketNoFrame`, while a socket that DID deliver can never satisfy an explicit silent
   * reason. Absent keeps the caller's reason verbatim. */
  readonly framesSinceSend?: number | undefined
  /** Which logical-stream EPISODE owns this request (one stream's open -> consumer-gone
   * lifetime). When the episode closes, everything it left in flight must stop blocking
   * its successors; an ownerless endpoint-digest key would outlive the stream. */
  readonly episodeId?: string | undefined
  /** The request-episode key this stream belongs to (the host's `streamOpeningKey`);
   * required for opening events, optional for `episodeClosed` (falls back to the stream's
   * registered key). */
  readonly requestKey?: string | undefined
  /** For `episodeClosed` - true when this stream ended BECAUSE its opening deadline
   * expired: a timed-out episode keeps its widening for the retry lane's next attempt;
   * any other departure releases the key when no live sibling owns it. */
  readonly timedOut?: boolean | undefined
  /** For `episodeClosed` - true when the CARRIER ended this episode (socket
   * replacement, loss, client disposal, a denied reopen). The opening budget and its
   * widening must SURVIVE that while the item was never accepted (F1): a replaced
   * socket may not reset what a slow Host already earned. Absent = consumer-ended. */
  readonly carrierInitiated?: boolean | undefined
  /** For `episodeClosed` - whether the consumer accepted this episode's opening
   * item before it ended. An accepted opening releases its widening budget. */
  readonly accepted?: boolean | undefined
  /** For `episodeClosed` - true when this departure WAS the terminal budget-exhausted
   * verdict: the spent widening is released whatever `timedOut` says, so a later open of
   * the same request starts a fresh ladder instead of inheriting a maxed-out one. */
  readonly terminal?: boolean | undefined
}

export interface CarrierState {
  readonly phase: CarrierPhase
  /** Frame count on the CURRENT physical socket. `silent` is decided from this. */
  readonly framesOnSocket: number
  readonly openStreams: readonly string[]
  /** Replacement history (ms since epoch) - the rebuild throttle's only state. */
  readonly rebuildsAt: readonly number[]
  /** The single in-flight rebuild reason, or null. */
  readonly pendingRebuild: RebuildReason | null
  /** The episode that owns the in-flight rebuild; cleared on close so a retired stream
   * cannot hold the carrier hostage. */
  readonly pendingRebuildBy: string | null
  /** Consecutive opening-deadline misses per REQUEST-EPISODE key (the host's
   * `streamOpeningKey`). The LEDGER lives here; its lifetime is bounded by
   * {@link CarrierEnv.openingEpisodeKeysMax} with oldest-first eviction. */
  readonly openingStreaks: Readonly<Record<string, number>>
  /** Which request-episode key each live logical stream belongs to, so an episode that
   * ends without an answer can release its widening (a timed-out one keeps it). */
  readonly streamRequestKeys: Readonly<Record<string, string>>
  /** Per-episode opening phase (F1), keyed by the episode's streamId. Bounded and
   * cleared when its episode closes. An episode seen by `openingSent` is `sent`; one
   * whose first frame arrived is `itemReceived`. */
  readonly openingPhases: Readonly<Record<string, OpeningPhase>>
  /** Newest episode per request-episode key (F1): an accept arriving from a
   * superseded episode must not clear the widening its successor inherited. */
  readonly openingLatest: Readonly<Record<string, string>>
}

export interface CarrierEnv {
  /** Rolling window for the rebuild throttle. */
  readonly rebuildWindowMs: number
  /** Max rebuilds allowed inside one window. */
  readonly maxRebuildsPerWindow: number
  readonly minRebuildSpacingMs: number
  /** In-flight rebuild grace mirroring the executor's reconnect latency: a second call
   * site cannot replace the socket while the first connect is in flight. */
  readonly inFlightGraceMs: number
  /** Consecutive opening-deadline misses required before an `openingStall` rebuild
   * (table: OPENING_STALL_STREAK). */
  readonly openingStallStreak: number
  /** Bound on the opening-ledger maps (table: OPENING_EPISODE_KEYS_MAX). */
  readonly openingEpisodeKeysMax: number
  /** Consecutive opening-deadline misses at which the budget is exhausted and the
   * opening becomes terminal (table: OPENING_BUDGET_MAX_MISSES). */
  readonly openingBudgetMaxMisses: number
}

export interface CarrierReduction {
  readonly state: CarrierState
  readonly effects: readonly RecoveryEffect[]
}

export function initialCarrierState(): CarrierState {
  return {
    phase: 'connecting',
    framesOnSocket: 0,
    openStreams: [],
    rebuildsAt: [],
    pendingRebuild: null,
    pendingRebuildBy: null,
    openingStreaks: {},
    streamRequestKeys: {},
    openingPhases: {},
    openingLatest: {},
  }
}
