/**
 * The carrier lifecycle reducer.
 *
 * Three levers can replace the same physical socket (open-frame silent-socket escalation,
 * opening-stall escalation, the lane's reconnect), each with its own throttle. Here the
 * rule owns it: every replacement passes through {@link decideRebuild}, which permits
 * exactly one at a time, and an allowed request during an in-flight rebuild yields a
 * `throttled` effect and NO second rebuild.
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

    case 'carrierClosed': {
      // Replacing a carrier fails EVERY logical stream on it, not only the one that
      // noticed; that socket-level semantics lives in the single owner, not a call site.
      const effects: RecoveryEffect[] = [{ e: 'forensic', name: 'carrier-closed', detail: String(event.at) }]
      return {
        state: { ...state, phase: 'closed', framesOnSocket: 0, pendingRebuild: null, openStreams: [] },
        effects,
      }
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
          streamRequestKeys: boundOpeningKeys(
            { ...state.streamRequestKeys, [streamId]: key },
            env.openingEpisodeKeysMax,
          ) as Readonly<Record<string, string>>,
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
        openingStreaks: boundOpeningKeys(
          { ...state.openingStreaks, [key]: streak },
          env.openingEpisodeKeysMax,
        ) as Readonly<Record<string, number>>,
      }
      return reduceCarrierStep(withStreak, { ...event, kind: 'rebuildRequested', reason: 'openingStall', streak }, env)
    }

    case 'openingAnswered': {
      // The frame reset is the host's evidence, the ledger change is ours.
      const key = event.requestKey
      if (key === undefined || state.openingStreaks[key] === undefined) return { state, effects: [] }
      const openingStreaks = { ...state.openingStreaks }
      delete openingStreaks[key]
      return { state: { ...state, openingStreaks }, effects: [] }
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
      const streamRequestKeys = { ...state.streamRequestKeys }
      const hadKey = streamRequestKeys[id] !== undefined
      delete streamRequestKeys[id]
      let openingStreaks: Readonly<Record<string, number>> = state.openingStreaks
      if (event.timedOut !== true && key !== undefined && openingStreaks[key] !== undefined) {
        const shared = Object.values(streamRequestKeys).some((other) => other === key)
        if (!shared) {
          const next = { ...openingStreaks }
          delete next[key]
          openingStreaks = next
        }
      }
      const owned = state.pendingRebuildBy === id
      const nextStreams = state.openStreams.filter((s) => s !== id)
      if (!owned && nextStreams.length === state.openStreams.length && !hadKey && openingStreaks === state.openingStreaks) {
        return { state, effects: [] }
      }
      return {
        state: {
          ...state,
          openStreams: nextStreams,
          streamRequestKeys,
          openingStreaks,
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
