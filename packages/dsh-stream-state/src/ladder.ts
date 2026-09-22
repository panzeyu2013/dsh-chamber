/**
 * Unified recovery ladder engine (B4 core).
 *
 * WHY. Four ladders implement one shape with four vocabularies:
 *   session-liveness.ts        (running bit)       tiers: refresh / reconnect / notice
 *   session-fact-reconcile.ts  (reconcile receipt) phases + single-flight retries
 *   session-stream-health.ts   (openState/phase)   tiers: heal / resync / auto-resync
 *   mobile session-stall.ts    (DOM phase)         a 975-line COPY of the above
 * They differ in their SIGNALS and their ACTION NAMES, not in their skeleton:
 * observe progress -> hold a bounded wait -> escalate only on evidence -> coalesce
 * -> quota -> surface. This module owns that skeleton once; each caller supplies
 * its signals, its tier table and its action mapping.
 *
 * THE LOAD-BEARING DISCIPLINE (kept from session-liveness.ts:34-41): silence alone
 * must NOT escalate past the first tier. Long tool runs and long reasoning are
 * legitimate silences indistinguishable from a real stall at this layer, and every
 * escalation replays the baseline of every open session. So a tier is gated on
 * EVIDENCE ("the reconciler could not conclude"), not on elapsed silence - elapsed
 * time only decides when to ask for evidence.
 *
 * PURITY: zero imports, no clock reads, no DOM. Every time arrives on the input.
 */

import { countWithin, isUsableAt, pushWindowed } from './time.ts'

/** One tier of a ladder. */
export interface LadderTier {
  /** Diagnostic name, used in actions and notes. */
  readonly name: string
  /** How long the symptom must persist before this tier may act. */
  readonly afterMs: number
  /** Minimum spacing between two dispatches of THIS tier. */
  readonly cooldownMs: number
  /** Maximum dispatches inside {@link Ladder.quotaWindowMs}; null = unbounded. */
  readonly quota: number | null
  /** Whether dispatching this tier requires the caller to have reported that the
   *  previous tier could not conclude. `false` = time alone may dispatch it. */
  readonly requiresStuckEvidence: boolean
}

export interface Ladder {
  readonly name: string
  /** Tiers in escalation order (index 0 is the cheapest, read-only probe). */
  readonly tiers: readonly LadderTier[]
  /** Rolling window the per-tier quota counts over. */
  readonly quotaWindowMs: number
}

/** What the caller observed for one source this tick. */
export interface LadderObservation {
  /** The symptom is present (a session claims to be running, a stream claims to be
   *  loading, a DOM phase claims to be settling...). Absent = the ladder is idle and
   *  its record collapses. */
  readonly sticky: boolean
  /** Timestamp the current symptom streak began (caller-owned: only the caller knows
   *  whether a new spell started, e.g. the running-set overlap rule). Ignored when the
   *  record had to be dropped this tick, because then a NEW streak starts now. */
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
  /** Sources whose streak did NOT continue: the symptom stopped, or real progress
   *  was observed, or the record was evicted. Their next record starts a FRESH
   *  streak, so the escalation clock is re-based instead of inherited. */
  readonly fresh: ReadonlySet<string>
}

/**
 * Drop the records whose streak is over. A record survives only while the symptom
 * stays present AND the watch reports no new progress.
 *
 * Progress DROPS the record rather than stamping it: keeping a stamped record would
 * leave the symptom clock running, and the next tick would escalate on a stale
 * streak - exactly the "escalate on time alone" failure this engine forbids.
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
 * Decide one tick across all sources.
 *
 * For each sticky source, walk the tiers cheapest-first and dispatch the first one
 * that is (a) due, (b) allowed by its evidence gate, (c) not cooling down, (d) inside
 * its quota, and (e) executable (not blocked). At most ONE tier dispatches per source
 * per tick: escalating two levers at once is how the old layout produced correlated
 * reconnects nobody asked for.
 */
export function planLadder(
  ladder: Ladder,
  records: Readonly<Record<string, LadderRecord>>,
  observations: Readonly<Record<string, LadderObservation | undefined>>,
  now: number,
): LadderPlan {
  // An unusable decision clock only ever holds: no action is authorized, and the
  // records are returned untouched so the caller can retry once the clock is real.
  if (!isUsableAt(now)) return { records, actions: [], exhausted: [] }

  const collapsed = collapseRecords(records, observations)
  const next: Record<string, LadderRecord> = { ...collapsed.records }
  const actions: LadderAction[] = []
  const exhausted: string[] = []

  for (const [sourceId, observation] of Object.entries(observations)) {
    if (observation === undefined || !observation.sticky) continue
    const carried = collapsed.records[sourceId]
    // A fresh streak is based at NOW: the caller's symptomSinceMs describes the
    // symptom that just reset, and inheriting it would re-arm every tier at once
    // (the mid-streak recreation bug the ladder test caught).
    const fresh = collapsed.fresh.has(sourceId)
    const anchored = fresh || Number.isFinite(observation.symptomSinceMs)
    const symptomSinceMs = fresh ? now : observation.symptomSinceMs
    const previous: LadderRecord = carried ?? {
      symptomSinceMs,
      progressStamp: observation.progressStamp,
      dispatches: {},
    }
    if (!anchored) {
      // A non-finite anchor is not a streak: re-base it at NOW and dispatch nothing
      // this tick. Reading NaN as "due" dispatched the most expensive tier (I4).
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
        // Suppressed WITHOUT consuming quota: a dispatch the caller cannot execute
        // must not silently eat the lever (the 2026-12 review's accounting gap).
        break
      }
      actions.push({ sourceId, tier: tier.name, at: now })
      next[sourceId] = {
        ...previous,
        symptomSinceMs,
        // The only writer of a dispatch ledger: pruning at write time keeps the
        // array inside its quota window (G-C) instead of growing for the process
        // lifetime.
        dispatches: { ...previous.dispatches, [tier.name]: pushWindowed(history, now, now, ladder.quotaWindowMs) },
      }
      dispatched = true
    }
    if (!dispatched && next[sourceId] === undefined) {
      next[sourceId] = { ...previous, symptomSinceMs }
    }

    // Exhausted = no tier can act: every quota is spent OR its evidence gate cannot
    // be satisfied with what the caller reports. Counting evidence-gated tiers as
    // live levers kept the ladder from ever declaring exhaustion, so a caller whose
    // reconciler never concludes parked forever with no notice (F18). Blocked and
    // cooling tiers still count - those are transient.
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

/** Instantiate the known ladders from one place, so their shapes can be compared
 * instead of discovered. Values come from the modules being retired and are the
 * wiring's input, not this file's policy. */
/**
 * B4 boundary (2026-12 预核结论, plan §84): this factory maps ONLY the SCHEDULING half of
 * the renderer's session-liveness ladder - the per-tier thresholds, cooldowns and the
 * rolling quota. The host module's planner (`planSessionLiveness`) keeps everything this
 * engine has no concept of: its phase machine, per-source progress stamps, the stalled-set
 * projection and the notice tier's message keys.
 *
 * WHY THIS NOTE EXISTS: the factory has no production consumer, so a reader could mistake
 * it for a wired single source. It is a SHAPE reference - the engine's expressiveness is
 * narrower than these two ladders, so wiring them would mean adding a phase machine to the
 * engine (a design change, not a B4 refactor). See §84 for the field-by-field对照.
 *
 * @param config - the scheduling fields, field-for-field the module's own config object.
 */
export function sessionLivenessLadder(config: {
  readonly refreshAfterMs: number
  readonly refreshCoalesceMs: number
  readonly maxRefreshRequests: number
  readonly refreshWindowMs: number
  readonly refreshOutcomeTimeoutMs: number
  readonly reconnectBackoffMs: number
  readonly maxReconnects: number
  readonly noticeAfterMs: number
}): Ladder {
  return {
    name: 'session-liveness',
    quotaWindowMs: config.refreshWindowMs,
    tiers: [
      { name: 'refresh', afterMs: config.refreshAfterMs, cooldownMs: config.refreshCoalesceMs, quota: config.maxRefreshRequests, requiresStuckEvidence: false },
      { name: 'reconnect', afterMs: config.refreshOutcomeTimeoutMs, cooldownMs: config.reconnectBackoffMs, quota: config.maxReconnects, requiresStuckEvidence: true },
      { name: 'notice', afterMs: config.noticeAfterMs, cooldownMs: 0, quota: 1, requiresStuckEvidence: true },
    ],
  }
}

/**
 * B4 boundary: the same SCHEDULING-only mapping as `sessionLivenessLadder` above, for the
 * open-in stream-health ladder (tiers `heal` / `auto-resync`). The host module keeps its
 * phase machine, `healFailedLatched`, the healing settle window, the clock-rollback guard
 * and the notice projection - none of which this engine models. See §84.
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
      { name: 'resync', afterMs: config.thresholdMs, cooldownMs: config.cooldownMs, quota: config.max, requiresStuckEvidence: false },
    ],
  }
}
