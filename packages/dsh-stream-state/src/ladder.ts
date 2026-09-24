/**
 * Unified recovery ladder engine: observe progress -> bounded wait -> escalate only on
 * evidence -> coalesce -> quota -> surface. Each caller supplies its signals, tier table
 * and action mapping.
 *
 * THE LOAD-BEARING DISCIPLINE: silence alone must NOT escalate past the first tier -
 * long tool runs and long reasoning are legitimate silences indistinguishable from a
 * real stall, and every escalation replays the baseline of every open session. A tier is
 * gated on EVIDENCE (the reconciler could not conclude), not on elapsed silence.
 *
 * PURITY: zero imports, no clock reads, no DOM; every time arrives on the input.
 */

import { countWithin, isUsableAt, pushWindowed } from './time.ts'


export interface LadderTier {
  readonly name: string
  /** How long the symptom must persist before this tier may act. */
  readonly afterMs: number
  /** Minimum spacing between two dispatches of THIS tier. */
  readonly cooldownMs: number
  /** Maximum dispatches inside {@link Ladder.quotaWindowMs}; null = unbounded. */
  readonly quota: number | null
  /** Whether dispatch needs the caller's stuck report; `false` = time alone may dispatch. */
  readonly requiresStuckEvidence: boolean
}

export interface Ladder {
  readonly name: string
  /** Tiers in escalation order (index 0 is the cheapest, read-only probe). */
  readonly tiers: readonly LadderTier[]
  /** Rolling window the per-tier quota counts over. */
  readonly quotaWindowMs: number
}


export interface LadderObservation {
  /** The symptom is present (a session claims running, a stream loading, a DOM phase
   *  settling...). Absent = the ladder is idle and its record collapses. */
  readonly sticky: boolean
  /** Timestamp the current symptom streak began (caller-owned). Ignored when the record
   *  had to be dropped this tick, because then a NEW streak starts now. */
  readonly symptomSinceMs: number
  /** The reconciler's last verdict availability: false = the caller tried and could
   *  not conclude. Only this unlocks tiers with `requiresStuckEvidence`. */
  readonly stuckEvidence: boolean
  /** The watch's own progress (DOM phase advanced / frames arrived). A strictly
   *  newer stamp than the previous tick resets the streak. */
  readonly progressStamp: number
  /** The caller cannot execute an escalation right now (another arm is reconnecting,
   *  a shell is absent). Dispatch is suppressed WITHOUT consuming the quota. */
  readonly escalationBlocked: boolean
}

export interface LadderRecord {
  readonly symptomSinceMs: number
  readonly progressStamp: number
  /** Per-tier: when this tier was dispatched (bounded by the quota window). */
  readonly dispatches: Readonly<Record<string, readonly number[]>>
}

export interface LadderAction {
  readonly sourceId: string
  readonly tier: string
  readonly at: number
}

export interface LadderPlan {
  readonly records: Readonly<Record<string, LadderRecord>>
  readonly actions: readonly LadderAction[]
  /** Sources whose ladder has run out of levers: the caller must surface a notice. */
  readonly exhausted: readonly string[]
}

export interface CollapseResult {
  readonly records: Readonly<Record<string, LadderRecord>>
  readonly changed: boolean
  /** Sources whose streak did NOT continue (symptom stopped, progress observed, or record
   *  evicted). Their next record starts a FRESH streak, so the escalation clock re-bases. */
  readonly fresh: ReadonlySet<string>
}

/**
 * Drop the records whose streak is over: a record survives only while the symptom stays
 * present AND the watch reports no new progress. Progress DROPS the record rather than
 * stamping it - a stamped record would leave the symptom clock running and the next tick
 * would escalate on a stale streak.
 */
export function collapseRecords(
  records: Readonly<Record<string, LadderRecord>>,
  observations: Readonly<Record<string, LadderObservation | undefined>>,
): CollapseResult {
  const next: Record<string, LadderRecord> = {}
  const fresh = new Set<string>()
  let changed = false
  for (const [sourceId, record] of Object.entries(records)) {
    const observation = observations[sourceId]
    if (observation === undefined || !observation.sticky || observation.progressStamp > record.progressStamp) {
      changed = true
      fresh.add(sourceId)
      continue
    }
    next[sourceId] = record
  }
  return { records: next, changed, fresh }
}

/**
 * Decide one tick across all sources. For each sticky source walk the tiers
 * cheapest-first and dispatch the first one that is due, allowed by its evidence gate,
 * not cooling down, inside its quota and executable. At most ONE tier dispatches per
 * source per tick: escalating two levers at once would produce correlated reconnects.
 */
export function planLadder(
  ladder: Ladder,
  records: Readonly<Record<string, LadderRecord>>,
  observations: Readonly<Record<string, LadderObservation | undefined>>,
  now: number,
): LadderPlan {
  // An unusable decision clock only ever holds: no action is authorized, records untouched.
  if (!isUsableAt(now)) return { records, actions: [], exhausted: [] }

  const collapsed = collapseRecords(records, observations)
  const next: Record<string, LadderRecord> = { ...collapsed.records }
  const actions: LadderAction[] = []
  const exhausted: string[] = []

  for (const [sourceId, observation] of Object.entries(observations)) {
    if (observation === undefined || !observation.sticky) continue
    const carried = collapsed.records[sourceId]
    // A fresh streak is based at NOW: inheriting the reset symptom's stamp would re-arm every tier.
    const fresh = collapsed.fresh.has(sourceId)
    const anchored = fresh || Number.isFinite(observation.symptomSinceMs)
    const symptomSinceMs = fresh ? now : observation.symptomSinceMs
    const previous: LadderRecord = carried ?? {
      symptomSinceMs,
      progressStamp: observation.progressStamp,
      dispatches: {},
    }
    if (!anchored) {
      // A non-finite anchor is not a streak: re-base it at NOW and dispatch nothing this tick.
      next[sourceId] = { ...previous, symptomSinceMs: now }
      continue
    }
    const elapsed = now - symptomSinceMs
    if (elapsed < 0) continue

    let dispatched = false
    for (const tier of ladder.tiers) {
      if (dispatched) break
      if (elapsed < tier.afterMs) break
      if (tier.requiresStuckEvidence && !observation.stuckEvidence) continue
      const history = previous.dispatches[tier.name] ?? []
      const last = history.length === 0 ? null : (history[history.length - 1] as number)
      if (last !== null && now - last < tier.cooldownMs) continue
      if (tier.quota !== null && countWithin(history, now, ladder.quotaWindowMs) >= tier.quota) continue
      if (observation.escalationBlocked) {
        // Suppressed WITHOUT consuming quota: an unexecutable dispatch must not eat the lever.
        break
      }
      actions.push({ sourceId, tier: tier.name, at: now })
      next[sourceId] = {
        ...previous,
        symptomSinceMs,
        // Pruning at write time keeps the array inside its quota window.
        dispatches: { ...previous.dispatches, [tier.name]: pushWindowed(history, now, now, ladder.quotaWindowMs) },
      }
      dispatched = true
    }
    if (!dispatched && next[sourceId] === undefined) {
      next[sourceId] = { ...previous, symptomSinceMs }
    }

    // Exhausted = no tier can act: every quota is spent OR its evidence gate cannot be
    // satisfied by what the caller reports. Blocked and cooling tiers still count.
    if (!dispatched) {
      const anyLever = ladder.tiers.some((tier) => {
        if (tier.requiresStuckEvidence && !observation.stuckEvidence) return false
        if (tier.quota === null) return true
        const history = (next[sourceId]?.dispatches[tier.name] ?? []) as readonly number[]
        return countWithin(history, now, ladder.quotaWindowMs) < tier.quota
      })
      if (!anyLever) exhausted.push(sourceId)
    }
  }

  return { records: next, actions, exhausted }
}

/**
 * Instantiate the known ladders from one place. Values come from the host modules and are
 * the wiring's input, not this file's policy.
 *
 * The session-fact authority's two engine instances - ONE engine, two hosts. The executor
 * runs the PROBE ladder: a read-only authority probe, dispatchable on time alone (a read
 * cannot harm the host). The App runs the ESCALATION ladder: reconnect and notice, both
 * gated on stuck evidence - never on silence alone. The ladder breaks at the first
 * not-yet-due tier, so `noticeAfterMs` must stay above `reconnectAfterMs`.
 */
export function sessionAuthorityProbeLadder(config: {
  readonly probeAfterMs: number
  readonly probeCoalesceMs: number
  readonly maxProbesPerWindow: number
  readonly probeWindowMs: number
}): Ladder {
  return {
    name: 'session-authority-probe',
    quotaWindowMs: config.probeWindowMs,
    tiers: [
      { name: 'probe', afterMs: config.probeAfterMs, cooldownMs: config.probeCoalesceMs, quota: config.maxProbesPerWindow, requiresStuckEvidence: false },
    ],
  }
}

export function sessionAuthorityEscalationLadder(config: {
  readonly reconnectAfterMs: number
  readonly reconnectCooldownMs: number
  readonly maxReconnects: number
  readonly noticeAfterMs: number
  readonly probeWindowMs: number
}): Ladder {
  return {
    name: 'session-authority-escalation',
    quotaWindowMs: config.probeWindowMs,
    tiers: [
      { name: 'reconnect', afterMs: config.reconnectAfterMs, cooldownMs: config.reconnectCooldownMs, quota: config.maxReconnects, requiresStuckEvidence: true },
      { name: 'notice', afterMs: config.noticeAfterMs, cooldownMs: 0, quota: 1, requiresStuckEvidence: true },
    ],
  }
}

/**
 * The same SCHEDULING-only mapping for the open-in stream-health ladder. The host keeps
 * its phase machine, latch, settle window, rollback guard and notice projection.
 */
export function streamHealthLadder(config: {
  readonly errorGraceMs: number
  readonly loadingStallMs: number
  readonly healCooldownMs: number
  readonly healBudgetWindowMs: number
  readonly healBudgetMax: number
}): Ladder {
  return {
    name: 'session-stream-health',
    quotaWindowMs: config.healBudgetWindowMs,
    tiers: [
      { name: 'heal', afterMs: config.errorGraceMs, cooldownMs: config.healCooldownMs, quota: config.healBudgetMax, requiresStuckEvidence: false },
      { name: 'auto-resync', afterMs: config.loadingStallMs, cooldownMs: config.healCooldownMs, quota: config.healBudgetMax, requiresStuckEvidence: true },
    ],
  }
}

export function mobileStallLadder(config: {
  readonly thresholdMs: number
  readonly cooldownMs: number
  readonly windowMs: number
  readonly max: number
}): Ladder {
  return {
    name: 'mobile-session-stall',
    quotaWindowMs: config.windowMs,
    tiers: [
      // Fires only on PROVEN loading-with-no-open; an unknown liveness bit or a session
      // with nothing in flight fails closed here instead of in a host-private gate.
      { name: 'resync', afterMs: config.thresholdMs, cooldownMs: config.cooldownMs, quota: config.max, requiresStuckEvidence: true },
    ],
  }
}
