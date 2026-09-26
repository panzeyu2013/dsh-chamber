/**
 * The carrier lifecycle reducer.
 *
 * Four levers can replace the same physical socket (open-frame silent-socket escalation,
 * opening-stall escalation, the teardown-no-frame escalation, the lane's reconnect), each
 * with its own throttle. Here the rule owns it: every replacement passes through
 * {@link decideRebuild}, which permits exactly one at a time, and an allowed request
 * during an in-flight rebuild yields a `throttled` effect and NO second rebuild.
 *
 * The opening phase machine (F1) is the fifth lever's counterpart: it never replaces a
 * socket, it ENDS the opening. `openingSent` arms the deadline, `openingAnswered` only
 * marks the phase, `openingAccepted` is the single settling transition, and exhausting
 * the widening ladder yields the terminal `failLogicalOpening`.
 *
 * Clockless (all times arrive on events) and total (any (state, event) pair returns a
 * state); the executor owns sockets, the Swift mirror owns its own copy of these tables.
 */
import { countWithin, isUsableAt, pushWindowed } from './time.ts'
import { openingBudgetMs } from './tables.ts'
import type {
  CarrierEnv,
  CarrierEvent,
  CarrierReduction,
  CarrierState,
  OpeningPhase,
  RebuildReason,
  RecoveryEffect,
} from './state.ts'

/**
 * May a physical carrier be replaced at `at`? Pure and dependency-free so every call
 * site shares it. Denies when the carrier is already closed, when a rebuild is in
 * flight inside the grace window (a second replace would cancel the connect the first
 * one started), or when the rolling window is full / two allowed rebuilds sit closer
 * than the minimum spacing.
 */
export function decideRebuild(state: CarrierState, env: CarrierEnv, at: number): boolean {
  // A clock we cannot reason about NEVER authorizes a replacement: every comparison
  // below is a ratio against `at`, and NaN would slip through the throttle.
  if (!isUsableAt(at)) return false
  if (state.phase === 'closed') return false
  const last = latestRebuildAt(state)
  // A clock that went backwards is not evidence the window is empty; holding is the only
  // conservative answer (a rollback must never authorize a replacement).
  if (Number.isFinite(last) && last >= 0 && at < last) return false
  if (state.pendingRebuild !== null && at - last < env.inFlightGraceMs) return false
  // countWithin only counts stamps the window can still see; the ledger is pruned every reduction.
  if (countWithin(state.rebuildsAt, at, env.rebuildWindowMs) >= env.maxRebuildsPerWindow) return false
  if (Number.isFinite(last) && last >= 0 && at - last < env.minRebuildSpacingMs) return false
  return true
}

/** Whether an opening-stall count has PROVEN the streak threshold (finite only). */
function isStallProven(streak: number | undefined, threshold: number): boolean {
  if (streak === undefined || !Number.isFinite(streak)) return false
  return streak >= threshold
}

function latestRebuildAt(state: CarrierState): number {
  let latest = Number.NEGATIVE_INFINITY
  for (const at of state.rebuildsAt) if (at > latest) latest = at
  return latest
}

function withStreams(state: CarrierState, next: readonly string[]): CarrierState {
  return { ...state, openStreams: next }
}

/** Oldest-first eviction for the opening-ledger maps (insertion order is stable for
 * string keys). Returns the SAME record when nothing was evicted, so a no-op keeps state. */
function boundOpeningKeys<T>(record: Readonly<Record<string, T>>, max: number): Readonly<Record<string, T>> {
  const keys = Object.keys(record)
  if (keys.length <= max) return record
  const next: Record<string, T> = { ...record }
  for (const key of keys.slice(0, keys.length - max)) delete next[key]
  return next
}

/** Write one key as the MOST RECENT entry before bounding. Re-writing an existing key
 * must move it to the back: a key that keeps expiring while new keys arrive would age
 * out of the ledger, and its widening would silently restart from rung 0 - the terminal
 * rung could then never be reached (review finding F1-LEDGER). The cap still bounds the
 * ledger absolutely: a key survives only while fewer than `max` fresh keys arrive
 * between two of its own writes (one key per opening attempt in practice). */
function touchOpeningKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T,
  max: number,
): Readonly<Record<string, T>> {
  const next: Record<string, T> = { ...record }
  delete next[key]
  next[key] = value
  return boundOpeningKeys(next, max)
}
/**
 * One reduction step. Total function; unmatched kinds add no effects. The rebuild ledger
 * is pruned against EVERY event's timestamp (not only when an entry is admitted), so a
 * long denial streak cannot leave out-of-window stamps in memory.
 */
export function reduceCarrier(state: CarrierState, event: CarrierEvent, env: CarrierEnv): CarrierReduction {
  return reduceCarrierStep(pruneCarrierLedger(state, event.at, env), event, env)
}

function pruneCarrierLedger(state: CarrierState, at: number, env: CarrierEnv): CarrierState {
  if (!isUsableAt(at) || state.rebuildsAt.length === 0) return state
  const start = at - env.rebuildWindowMs
  const next = state.rebuildsAt.filter((stamp) => stamp > start)
  return next.length === state.rebuildsAt.length ? state : { ...state, rebuildsAt: next }
}

function reduceCarrierStep(state: CarrierState, event: CarrierEvent, env: CarrierEnv): CarrierReduction {
  switch (event.kind) {
    case 'carrierConnecting':
      return { state: { ...state, phase: 'connecting' }, effects: [] }

    case 'carrierOpened':
      // A live socket restarts the frame counter and clears the in-flight marker.
      return { state: { ...state, phase: 'open', framesOnSocket: 0, pendingRebuild: null }, effects: [] }

    case 'carrierClosed':
      // Replacing a carrier fails EVERY logical stream on it, not only the one that
      // noticed; that socket-level semantics lives in the single owner, not a call site.
      // No forensic effect: the host publishes the fact with the socket/stream detail,
      // and this reducer's `carrier-closed` name reached no executor in production.
      return {
        state: { ...state, phase: 'closed', framesOnSocket: 0, pendingRebuild: null, openStreams: [] },
        effects: [],
      }

    case 'streamOpened': {
      const id = event.streamId
      if (id === undefined || state.openStreams.includes(id)) return { state, effects: [] }
      return { state: withStreams(state, [...state.openStreams, id]), effects: [] }
    }

    case 'streamFrame':
      // Frames are the only in-band evidence the socket is alive, so they leave `silent`.
      return {
        state: { ...state, framesOnSocket: state.framesOnSocket + 1, phase: state.phase === 'silent' ? 'open' : state.phase },
        effects: [],
      }

    case 'streamClosed': {
      const id = event.streamId
      if (id === undefined) return { state, effects: [] }
      const next = state.openStreams.filter((s) => s !== id)
      if (next.length === state.openStreams.length) return { state, effects: [] }
      return { state: withStreams(state, next), effects: [] }
    }

    case 'openingSent': {
      // The reducer arms the deadline so the host never derives the budget.
      const streamId = event.streamId
      const key = event.requestKey
      if (streamId === undefined || key === undefined) return { state, effects: [] }
      const streak = state.openingStreaks[key] ?? 0
      return {
        state: {
          ...state,
          streamRequestKeys: touchOpeningKey(state.streamRequestKeys, streamId, key, env.openingEpisodeKeysMax) as Readonly<Record<string, string>>,
          // F1: the phase and the latest-episode fence are what keep an accept from a
          // superseded generation from clearing a live one's budget.
          openingPhases: touchOpeningKey(state.openingPhases, streamId, 'sent', env.openingEpisodeKeysMax) as Readonly<Record<string, OpeningPhase>>,
          openingLatest: touchOpeningKey(state.openingLatest, key, streamId, env.openingEpisodeKeysMax) as Readonly<Record<string, string>>,
        },
        effects: [{ e: 'armOpeningDeadline', streamId, budgetMs: openingBudgetMs(streak), streak }],
      }
    }

    case 'openingExpired': {
      const key = event.requestKey
      if (key === undefined) return { state, effects: [] }
      // The widening ledger is the ONLY thing this case owns; the verdict (silent vs
      // threshold-gated stall) and the rebuild gate belong to the rebuild path.
      const streak = (state.openingStreaks[key] ?? 0) + 1
      const withStreak: CarrierState = {
        ...state,
        openingStreaks: touchOpeningKey(state.openingStreaks, key, streak, env.openingEpisodeKeysMax) as Readonly<Record<string, number>>,
      }
      // F1: the ladder IS the budget. Every rung spent without acceptance means
      // re-issuing can only extend a hang the consumer has already proved it cannot
      // settle, so the phase machine reports a TERMINAL instead of another reopen.
      const max = env.openingBudgetMaxMisses
      if (Number.isFinite(max) && streak >= max) {
        // The reducer owns the VERDICT; the host owns the FACT. It publishes the
        // terminal names (opening-orphaned when the item arrived but was never
        // accepted / opening-timeout when nothing arrived, plus opening-budget-
        // exhausted) with endpoint, streamId, waitedMs and the best-effort session -
        // strictly richer than the request key this clockless reducer could carry, and
        // an unconsumed forensic effect would only be a second, weaker definition.
        return {
          state: withStreak,
          effects: event.streamId === undefined
            ? []
            : [{ e: 'failLogicalOpening' as const, streamId: event.streamId, reason: key }],
        }
      }
      return reduceCarrierStep(withStreak, { ...event, kind: 'rebuildRequested', reason: 'openingStall', streak }, env)
    }

    case 'openingAnswered': {
      // The transport delivered this stream's first frame: that is evidence the socket
      // is alive, NOT that the consumer settled its opening. The widening ledger stays
      // untouched here (F1) - only `openingAccepted` may clear it.
      const id = event.streamId
      if (id === undefined || state.openingPhases[id] === undefined) return { state, effects: [] }
      if (state.openingPhases[id] === 'itemReceived') return { state, effects: [] }
      return {
        // Bounded like every other opening-ledger write: a bare spread could re-insert
        // an id the capacity bound had already evicted (review finding 9).
        state: {
          ...state,
          openingPhases: touchOpeningKey(state.openingPhases, id, 'itemReceived', env.openingEpisodeKeysMax) as Readonly<Record<string, OpeningPhase>>,
        },
        effects: [],
      }
    }

    case 'openingAccepted': {
      // The ONE transition that settles an opening (F1). Accepted only when this
      // episode is still the newest attempt for its request key: an accept that
      // crossed a carrier generation must not clear its successor's widening.
      const id = event.streamId
      const key = event.requestKey ?? (id === undefined ? undefined : state.streamRequestKeys[id])
      if (id === undefined || key === undefined) return { state, effects: [] }
      // Two independent rejections: an accept for an episode this ledger no longer
      // tracks (its phase was released), and an accept from a SUPERSEDED episode whose
      // successor already claimed the key. The second test must not require the
      // successor to have closed the predecessor first - a live old episode (a journal
      // sibling probe, a second generation) still passes `openingPhases[id]`, and letting
      // it through would clear the successor's widening.
      const latest = state.openingLatest[key]
      if (state.openingPhases[id] === undefined) return { state, effects: [] }
      if (latest !== undefined && latest !== id) return { state, effects: [] }
      const openingStreaks = { ...state.openingStreaks }
      delete openingStreaks[key]
      const openingPhases = { ...state.openingPhases }
      delete openingPhases[id]
      const openingLatest = { ...state.openingLatest }
      if (openingLatest[key] === id) delete openingLatest[key]
      // No forensic effect: the host publishes the acceptance fact with its timing and
      // best-effort session attribution right where the consumer called accept().
      return {
        state: { ...state, openingStreaks, openingPhases, openingLatest },
        effects: [],
      }
    }

    case 'rebuildRequested': {
      const requested: RebuildReason = event.reason ?? 'laneReconnect'
      // INVARIANT (no exitless spinner): whatever the verdict, a rebuild request must
      // produce a path forward; denied requests reopen their logical stream.
      const reopen = (why: string): RecoveryEffect[] =>
        event.streamId === undefined
          ? []
          : [{ e: 'reopenLogicalStream', streamId: event.streamId, reason: why }]
      // The silent-carrier VERDICT belongs here: with a caller-reported frame delta, a
      // socket that delivered nothing across a whole budget is a dead carrier, so the
      // stall is really `socketNoFrame` and the threshold must not gate it; a socket that
      // DID deliver can never prove silence. An absent delta keeps the caller's reason.
      const frames = event.framesSinceSend
      const silent = frames !== undefined && Number.isFinite(frames) && frames <= 0
      const delivered = frames !== undefined && (!Number.isFinite(frames) || frames > 0)
      if (delivered && (requested === 'socketNoFrame' || requested === 'teardownNoFrame')) {
        return {
          state,
          effects: [
            { e: 'forensic', name: 'silent-not-proven', detail: String(frames) },
            ...reopen('silent-not-proven'),
          ],
        }
      }
      const reason: RebuildReason = requested === 'openingStall' && silent ? 'socketNoFrame' : requested
      // A frame-answering socket is protected by the streak THRESHOLD: a first-miss stall
      // stays an episode-level reopen. An unusable streak must not clear it either.
      if (reason === 'openingStall' && !isStallProven(event.streak, env.openingStallStreak)) {
        return {
          state,
          effects: [
            { e: 'forensic', name: 'stall-below-threshold', detail: String(event.streak ?? 0) },
            ...reopen('stall-below-threshold'),
          ],
        }
      }
      if (!decideRebuild(state, env, event.at)) {
        // Denied: record it (never silently drop), act once, and give the episode its exit back.
        return {
          state,
          effects: [{ e: 'throttled', reason, at: event.at }, ...reopen('rebuild-throttled')],
        }
      }
      const effects: RecoveryEffect[] = [{ e: 'rebuildCarrier', reason, at: event.at }]
      return {
        state: {
          ...state,
          phase: 'replacing',
          framesOnSocket: 0,
          pendingRebuild: reason,
          pendingRebuildBy: event.episodeId ?? null,
          // pushWindowed is the ledger's only writer: a new entry cannot outlive its window.
          rebuildsAt: pushWindowed(state.rebuildsAt, event.at, event.at, env.rebuildWindowMs),
        },
        effects,
      }
    }

    case 'episodeClosed': {
      // The episode's lifetime ends here: release the in-flight rebuild claim (a retired
      // stream must never block its successor) and - unless this departure WAS the opening
      // timeout - the widening streak, but only when no live sibling still owns the key.
      // An already-connected rebuild is unaffected; only the in-flight marker is scoped.
      const id = event.episodeId
      if (id === undefined) return { state, effects: [] }
      const key = state.streamRequestKeys[id] ?? event.requestKey
      // Value-free early exit (review O2): an episode this ledger never recorded - the
      // common close of a refused open or an unarmed sibling - must not expand three
      // bounded tables (V8 dictionary mode from ~64 keys: measured 13-61us at 64/256)
      // to answer "nothing changed". This conjunction is exactly the no-change test
      // below, evaluated before the copies.
      if (state.streamRequestKeys[id] === undefined
        && state.openingPhases[id] === undefined
        && (key === undefined || state.openingLatest[key] !== id)
        && (key === undefined || state.openingStreaks[key] === undefined)
        && state.pendingRebuildBy !== id
        && !state.openStreams.includes(id)) {
        return { state, effects: [] }
      }
      const streamRequestKeys = { ...state.streamRequestKeys }
      const hadKey = streamRequestKeys[id] !== undefined
      delete streamRequestKeys[id]
      const openingPhases = { ...state.openingPhases }
      const hadPhase = openingPhases[id] !== undefined
      delete openingPhases[id]
      const openingLatest = { ...state.openingLatest }
      const hadLatest = key !== undefined && openingLatest[key] === id
      if (hadLatest && key !== undefined) delete openingLatest[key]
      let openingStreaks: Readonly<Record<string, number>> = state.openingStreaks
      if (event.terminal === true && key !== undefined && openingStreaks[key] !== undefined) {
        // F1: a TERMINAL verdict releases the spent widening whatever `timedOut` says. A
        // non-terminal timeout must keep it (that is the retry lane's inheritance), but
        // the terminal verdict ends the episode: the next open of the same request arms
        // rung 0 again instead of expiring immediately on a maxed-out ladder.
        const next = { ...openingStreaks }
        delete next[key]
        openingStreaks = next
      } else if (event.timedOut !== true && key !== undefined && openingStreaks[key] !== undefined) {
        const shared = Object.values(streamRequestKeys).some((other) => other === key)
        // F1: a CARRIER-ended episode that never reached acceptance keeps its budget and
        // widening - a replaced socket, a lost carrier or a denied reopen may not reset
        // what the retry lane already spent. A consumer-ended (or accepted) episode
        // releases the key, as does the terminal budget-exhausted verdict.
        const keep = event.accepted !== true && event.carrierInitiated === true
        if (!shared && !keep) {
          const next = { ...openingStreaks }
          delete next[key]
          openingStreaks = next
        }
      }
      const owned = state.pendingRebuildBy === id
      const nextStreams = state.openStreams.filter((s) => s !== id)
      if (!owned && nextStreams.length === state.openStreams.length && !hadKey
        && !hadPhase && !hadLatest && openingStreaks === state.openingStreaks) {
        return { state, effects: [] }
      }
      return {
        state: {
          ...state,
          openStreams: nextStreams,
          streamRequestKeys,
          openingStreaks,
          openingPhases,
          openingLatest,
          pendingRebuild: owned ? null : state.pendingRebuild,
          pendingRebuildBy: owned ? null : state.pendingRebuildBy,
        },
        effects: owned
          ? [{ e: 'forensic', name: 'episode-claim-released', detail: id }]
          : [],
      }
    }

    default:
      // Unknown kind: total function, no throw, no effect.
      return { state, effects: [] }
  }
}

export function reduceCarrierSequence(
  state: CarrierState,
  events: readonly CarrierEvent[],
  env: CarrierEnv,
): CarrierReduction {
  let current = state
  const effects: RecoveryEffect[] = []
  for (const event of events) {
    const step = reduceCarrier(current, event, env)
    current = step.state
    effects.push(...step.effects)
  }
  return { state: current, effects }
}
