/**
 * The public value surface of the lifecycle reducers (refactor plan section 2).
 *
 * Everything here is a plain data type. There are deliberately NO functions in
 * this file: the reducers are the only authority, and consumers (the carrier
 * executor, the page arbiter, the Swift mirror) must not be able to encode
 * policy of their own.
 */

/** Physical carrier phase. `silent` is "WebSocket OPEN but nothing arrives" -
 * the state that neither `open` nor `closed` can express and that the whole
 * 2026-09 investigation revolved around. */
export type CarrierPhase = 'connecting' | 'open' | 'silent' | 'replacing' | 'closed'

/** Why a physical carrier rebuild was requested. At most ONE reason may be
 * stored at a time, which is what makes the "single owner" claim checkable:
 * three call sites used to be able to replace the same socket in one window. */
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
  /** An allowed event arrived while a rebuild was in flight (see DIVERGENCE.md 2). */
  | { readonly e: 'throttled'; readonly reason: RebuildReason; readonly at: number }
  /** Bounded observability, never a behavior switch. */
  | { readonly e: 'forensic'; readonly name: string; readonly detail: string }

/** Event kinds the carrier reducer understands. An unknown kind is not an
 * error: the reducer records it as ignored (total-function contract). */
export type CarrierEventKind =
  | 'carrierConnecting'
  | 'carrierOpened'
  | 'carrierClosed'
  | 'streamOpened'
  | 'streamFrame'
  | 'streamClosed'
  | 'rebuildRequested'
  /** The logical stream's consumer is gone (dispose / abort / normal end): the
   * episode's claims on the carrier end here. */
  | 'episodeClosed'

export interface CarrierEvent {
  readonly kind: CarrierEventKind
  /** Observation time (ms). The reducer NEVER reads a clock; the executor stamps. */
  readonly at: number
  /** For `rebuildRequested`. */
  readonly reason?: RebuildReason
  /** Which logical stream this event is about. For the per-stream events it is
   * the stream being framed/closed; for a `rebuildRequested` it is the stream
   * that is asking, which is what lets a DENIED rebuild still produce an exit
   * (the effect is a reopen of THIS stream - exactly what the legacy retry lane
   * did by failing the inbox, and what keeps the chain from parking in silence).
   *
   * Declared `| undefined` (not merely optional) because call sites legitimately
   * forward an optional value under `exactOptionalPropertyTypes`; the reducer treats
   * an explicit undefined exactly like an absent one. */
  readonly streamId?: string | undefined
  /** For a `rebuildRequested` whose cause is an opening stall: how many
   * consecutive opening deadlines this episode has missed. The reducer enforces
   * the threshold itself, so a call site cannot escalate on the first miss the
   * way the legacy else-branch could. An explicit undefined is NOT proof of a
   * streak (see `isStallProven`). */
  readonly streak?: number | undefined
  /** For a `rebuildRequested`: how many frames the CURRENT socket delivered
   * since this attempt sent its open frame (P3). This is the observation that lets
   * the reducer own the silent-carrier verdict: zero frames across a whole budget
   * turns an `openingStall` request into `socketNoFrame`, while a socket that DID
   * deliver can never satisfy an explicit silent reason. Absent keeps the caller's
   * reason verbatim (the pre-P3 contract). */
  readonly framesSinceSend?: number | undefined
  /** Which logical-stream EPISODE owns this request. An episode is the lifetime of
   * one logical stream (open -> ... -> consumer gone). The opening budget's
   * widening belongs to it, so when the episode closes, everything it left in
   * flight must stop blocking its successors - the legacy endpoint-digest key had
   * no owner and outlived the stream (DIVERGENCE D-4). */
  readonly episodeId?: string
}

export interface CarrierState {
  readonly phase: CarrierPhase
  /** Frame count on the CURRENT physical socket. `silent` is decided from this. */
  readonly framesOnSocket: number
  /** Logical streams currently registered on the carrier. */
  readonly openStreams: readonly string[]
  /** Replacement history (ms since epoch) - the rebuild throttle's only state. */
  readonly rebuildsAt: readonly number[]
  /** The single in-flight rebuild reason, or null. */
  readonly pendingRebuild: RebuildReason | null
  /** The episode that owns the in-flight rebuild, or null. Cleared when that
   * episode closes so a retired stream cannot hold the carrier hostage. */
  readonly pendingRebuildBy: string | null
}

export interface CarrierEnv {
  /** Rolling window for the rebuild throttle. */
  readonly rebuildWindowMs: number
  /** Max rebuilds allowed inside one window. */
  readonly maxRebuildsPerWindow: number
  /** Minimum spacing between two allowed rebuilds. */
  readonly minRebuildSpacingMs: number
  /** In-flight rebuild grace. Mirrors the executor's reconnect latency; this
   * divergence used to happen in production because a second call site could
   * replace the socket while the first connect was in flight. */
  readonly inFlightGraceMs: number
  /** Consecutive opening-deadline misses required before an `openingStall`
   * rebuild is allowed (table: OPENING_STALL_STREAK). */
  readonly openingStallStreak: number
}

export interface CarrierReduction {
  readonly state: CarrierState
  readonly effects: readonly RecoveryEffect[]
}

/** Initial carrier state: nothing connected, nothing replaced. */
export function initialCarrierState(): CarrierState {
  return {
    phase: 'connecting',
    framesOnSocket: 0,
    openStreams: [],
    rebuildsAt: [],
    pendingRebuild: null,
    pendingRebuildBy: null,
  }
}
