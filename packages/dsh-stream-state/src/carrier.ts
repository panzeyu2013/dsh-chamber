/**
 * The carrier lifecycle reducer.
 *
 * WHY THIS EXISTS. In the current wiring three different levers can replace the
 * same physical socket (open-frame silent-socket escalation, opening-stall
 * escalation, and the connection lane's reconnect), each with its own throttle;
 * `replaceSocket` also bypasses the mux's 1 s scheduling throttle. Whether two
 * replacements land in one window is therefore a property of the call graph
 * rather than of a rule. Here it is a property of a rule: every replacement,
 * whatever triggered it, passes through {@link decideRebuild}, and the reducer
 * permits exactly one at a time.
 *
 * The reducer is clockless (all times arrive on events) and total (any
 * (state, event) pair returns a state, unknown event kinds included). It never
 * imports anything: the executor owns sockets, the Swift mirror owns its own
 * copy of these tables.
 *
 * An allowed rebuild request during an in-flight rebuild produces a `throttled`
 * effect and NO second rebuild.
 */
import type {
  CarrierEnv,
  CarrierEvent,
  CarrierReduction,
  CarrierState,
  RebuildReason,
  RecoveryEffect,
} from './state.ts'

/**
 * May a physical carrier be replaced at `at`?
 *
 * Pure and dependency-free so the bound is testable and so every call site -
 * today's three and any future one - shares it. Denies when:
 *  - the carrier is already closed (nothing to replace),
 *  - a rebuild is in flight inside the grace window (the "never stabilizes"
 *    hazard: a second replace cancels the connect the first one started),
 *  - the rolling window is full, or two allowed rebuilds sit closer than the
 *    minimum spacing.
 */
export function decideRebuild(state: CarrierState, env: CarrierEnv, at: number): boolean {
  // A clock we cannot reason about NEVER authorizes a replacement. Every comparison
  // below is a ratio against `at`, and NaN makes all of them false - so without this
  // guard an unusable timestamp would SLIP THROUGH the throttle and rebuild on every
  // call.
  if (!Number.isFinite(at)) return false
  if (state.phase === 'closed') return false
  if (state.pendingRebuild !== null && at - latestRebuildAt(state) < env.inFlightGraceMs) return false
  const windowStart = at - env.rebuildWindowMs
  const inWindow = state.rebuildsAt.filter((t) => t > windowStart).length
  if (inWindow >= env.maxRebuildsPerWindow) return false
  const last = latestRebuildAt(state)
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

/**
 * One reduction step. Total function: every event kind, matched or not,
 * returns a valid state; unmatched kinds add no effects.
 */
export function reduceCarrier(state: CarrierState, event: CarrierEvent, env: CarrierEnv): CarrierReduction {
  switch (event.kind) {
    case 'carrierConnecting':
      return { state: { ...state, phase: 'connecting' }, effects: [] }

    case 'carrierOpened':
      // A live socket restarts the frame counter and clears the in-flight marker.
      return { state: { ...state, phase: 'open', framesOnSocket: 0, pendingRebuild: null }, effects: [] }

    case 'carrierClosed': {
      // Replacing a carrier fails EVERY logical stream on it, not only the one that
      // noticed (mux-self-heal ":600"). Modelling it here keeps that socket-level
      // semantics in the single owner instead of inside a call site.
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
      // Frames are the only in-band evidence that the socket is alive, so they
      // also leave the `silent` phase.
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

    case 'rebuildRequested': {
      const reason: RebuildReason = event.reason ?? 'laneReconnect'
      // A frame-answering socket is protected by the streak THRESHOLD, not by the
      // throttle: a first-miss stall is not a rebuild request at all - it stays an
      // episode-level reopen.
      // INVARIANT (no exitless spinner): whatever the verdict, a rebuild request
      // must produce a path forward for the calling episode. Denied requests reopen
      // their logical stream, so "not escalating" is never "doing nothing".
      const reopen = (why: string): RecoveryEffect[] =>
        event.streamId === undefined
          ? []
          : [{ e: 'reopenLogicalStream', streamId: event.streamId, reason: why }]
      // An unusable streak must not clear the threshold either: NaN is neither below
      // nor above it, so a bare `<` would let it through.
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
        // Denied: record it, never silently drop it, never act twice - and give the
        // episode its exit back.
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
          rebuildsAt: [...state.rebuildsAt, event.at],
        },
        effects,
      }
    }

    case 'episodeClosed': {
      // The episode's lifetime ends here. Any in-flight claim it left on the
      // carrier is released, so a retired stream can never block its successor
      // from rebuilding. A rebuild that is already connected is unaffected - only the
      // in-flight marker is episode-scoped.
      const id = event.episodeId
      if (id === undefined) return { state, effects: [] }
      const owned = state.pendingRebuildBy === id
      const nextStreams = state.openStreams.filter((s) => s !== id)
      if (!owned && nextStreams.length === state.openStreams.length) return { state, effects: [] }
      return {
        state: {
          ...state,
          openStreams: nextStreams,
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

/** Apply a sequence of events; returns the final state and the concatenated effects. */
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
