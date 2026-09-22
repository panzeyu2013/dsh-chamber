/**
 * Legacy reference trace generator - the OLD wiring, encoded as pure action
 * traces so the differential oracle (scripts/refactor/equivalence.mjs) has
 * something to compare the new reducer against.
 *
 * This file ports the THREE independent replacement entries and their
 * predicates verbatim. It deliberately does NOT import the fork: the oracle
 * must be able to run in a tree without node_modules, and the values it models
 * are pinned against the fork by test/refactor/reference-parity.test.ts.
 *
 * The old design's defining property is that deciding to replace is spread over
 * three call sites with three different bounds:
 *   1. the opening deadline's silent-socket branch  (zero frames, no cooldown)
 *   2. the opening-stall branch                     (>=2 streaks + 60 s cooldown)
 *   3. the teardown zero-frame branch               (>=15 s life, cooldown NOT consulted)
 * plus the connection lane's reconnect, which tears the socket down with no
 * throttle at all. Nothing above the call sites enforces one-at-a-time, which is
 * why the same window can carry more than one replacement - defects recorded as
 * DIVERGENCE entries rather than reproduced by the reducer.
 */
import type { CarrierEvent, RecoveryEffect } from '../../src/state.ts'

/** Port of REMOTE_STREAM_OPENING_TIMEOUT_MS=30_000 with `min(streak,4)` steps.
 * Kept byte-identical in behavior to remote-retry-policy.ts:267-271; the parity
 * test fails if the formula or the constants drift. */
export function legacyOpeningTimeoutMs(streak: number): number {
  const BASE = 30_000
  const MAX = 300_000
  if (!Number.isFinite(streak) || streak <= 0) return BASE
  const step = Math.min(Math.floor(streak), 4)
  return Math.min(BASE * 2 ** step, MAX)
}

/** Port of shouldReplaceSilentSocket (remote-retry-policy.ts:309-313). */
export function legacyShouldReplaceSilentSocket(framesReceivedSinceSend: number): boolean {
  if (!Number.isFinite(framesReceivedSinceSend)) return false
  return framesReceivedSinceSend <= 0
}

/** Port of shouldEscalateOpeningStall (remote-retry-policy.ts:210-218). The
 * cooldown marker is MUX-GLOBAL in the fork while the streak is per request -
 * a cross-request interference the new reducer removes (see DIVERGENCE.md 2). */
export const LEGACY_ESCALATION_STREAK = 2
export const LEGACY_ESCALATION_COOLDOWN_MS = 60_000
export const LEGACY_SILENT_TEARDOWN_MIN_MS = 15_000

export function legacyShouldEscalateOpeningStall(
  streak: number,
  lastEscalationAt: number | undefined,
  now: number,
): boolean {
  if (!Number.isFinite(streak) || streak < LEGACY_ESCALATION_STREAK) return false
  if (lastEscalationAt === undefined) return true
  return now - lastEscalationAt >= LEGACY_ESCALATION_COOLDOWN_MS
}

/** Events the legacy trace generator understands. */
export interface LegacyTraceEvent {
  readonly kind:
    | 'socketOpened'
    | 'framesSinceSend'
    | 'openingTimeout'
    | 'teardown'
    | 'laneReconnect'
  readonly at: number
  /** openingTimeout: frames the current socket delivered while the open was pending.
   * teardown: life of the logical stream that was torn down. */
  readonly frames?: number
  /** teardown: frame delta across the stream's whole life. */
  readonly frameDelta?: number
  /** Identifies the request whose opening streak is being tracked. */
  readonly request?: string
}

/** One replacement the OLD wiring would have issued. */
export interface LegacyReplaceAction {
  readonly reason: 'silent' | 'stall' | 'teardown-silent' | 'lane'
  readonly at: number
  readonly request?: string
}

/** Produce the OLD replacement trace for a scenario. Mirrors the call sites:
 * the deadline branch, its else-if stall branch, the teardown branch, and the
 * lane. No shared throttle is applied - that absence IS the reference behavior. */
export function legacyTrace(events: readonly LegacyTraceEvent[]): LegacyReplaceAction[] {
  const trace: LegacyReplaceAction[] = []
  const streaks = new Map<string, number>()
  let lastEscalationAt: number | undefined
  let framesSinceSend = 0
  for (const event of events) {
    if (event.kind === 'socketOpened') {
      framesSinceSend = 0
      continue
    }
    if (event.kind === 'framesSinceSend') {
      framesSinceSend = event.frames ?? 0
      continue
    }
    if (event.kind === 'openingTimeout') {
      const request = event.request ?? 'default'
      const streak = (streaks.get(request) ?? 0) + 1
      streaks.set(request, streak)
      if (legacyShouldReplaceSilentSocket(event.frames ?? framesSinceSend)) {
        trace.push({ reason: 'silent', at: event.at, request })
        framesSinceSend = 0
        continue
      }
      // The legacy else-branch is reached ONLY when frames arrived (the silent
      // branch above owns the zero-frame case) and still requires N=2. Dropping
      // this threshold would make the reference escalate on a single miss - the
      // defect the new reducer refuses to reproduce (DIVERGENCE D-5).
      if (legacyShouldEscalateOpeningStall(streak, lastEscalationAt, event.at)) {
        trace.push({ reason: 'stall', at: event.at, request })
        lastEscalationAt = event.at
        framesSinceSend = 0
      }
      continue
    }
    if (event.kind === 'teardown') {
      const life = event.frames ?? 0
      const delta = event.frameDelta ?? framesSinceSend
      if (legacyShouldReplaceSilentSocket(delta) && life >= LEGACY_SILENT_TEARDOWN_MIN_MS) {
        trace.push({ reason: 'teardown-silent', at: event.at, request: event.request })
        framesSinceSend = 0
      }
      continue
    }
    if (event.kind === 'laneReconnect') {
      trace.push({ reason: 'lane', at: event.at })
      framesSinceSend = 0
    }
  }
  return trace
}

/** The OLD trace projected onto the shared effect vocabulary so the comparator
 * can compare it with the reducer's effects. Legacy reasons map through the same
 * reason classes the normalizer folds (silent / stall / lane). */
export function legacyEffects(events: readonly LegacyTraceEvent[]): RecoveryEffect[] {
  return legacyTrace(events).map((action) => ({
    e: 'rebuildCarrier' as const,
    reason: action.reason as never,
    at: action.at,
  }))
}

/** The NEW path's events, produced from the same scenario. Kept next to the
 * legacy generator so the two readings of one scenario stay visible side by
 * side; the equivalence suite asserts the intended trace. */
export function modernCarrierEvents(events: readonly LegacyTraceEvent[]): CarrierEvent[] {
  const out: CarrierEvent[] = []
  const streaks = new Map<string, number>()
  for (const event of events) {
    if (event.kind === 'socketOpened') {
      out.push({ kind: 'carrierConnecting', at: event.at })
      out.push({ kind: 'carrierOpened', at: event.at })
      continue
    }
    if (event.kind === 'framesSinceSend') {
      const count = Math.max(0, Math.floor(event.frames ?? 0))
      for (let i = 0; i < count; i += 1) out.push({ kind: 'streamFrame', at: event.at })
      continue
    }
    if (event.kind === 'openingTimeout') {
      const request = event.request ?? 'default'
      const streak = (streaks.get(request) ?? 0) + 1
      streaks.set(request, streak)
      const zeroFrames = legacyShouldReplaceSilentSocket(event.frames ?? 0)
      out.push({
        kind: 'rebuildRequested',
        at: event.at,
        reason: zeroFrames ? 'socketNoFrame' : 'openingStall',
        streak,
      })
      continue
    }
    if (event.kind === 'teardown') {
      out.push({ kind: 'streamClosed', at: event.at })
      const life = event.frames ?? 0
      const delta = event.frameDelta ?? 0
      if (legacyShouldReplaceSilentSocket(delta) && life >= LEGACY_SILENT_TEARDOWN_MIN_MS) {
        out.push({ kind: 'rebuildRequested', at: event.at, reason: 'teardownNoFrame' })
      }
      continue
    }
    if (event.kind === 'laneReconnect') {
      out.push({ kind: 'rebuildRequested', at: event.at, reason: 'laneReconnect' })
    }
  }
  return out
}
