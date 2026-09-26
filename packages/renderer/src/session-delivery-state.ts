/**
 * The page-level delivery state owner (design 14 §D4).
 *
 * WHY. The loading rebuild, the frame watchdog, the content tail and the header chip each
 * kept their own ledger and thresholds; this module is the ONE session-level state machine
 * they feed: evidence in, ladder actions out. Seats are views over this state - they never
 * own a cooldown, a budget or a progress memory.
 *
 * The run identity spine: every sample carries the optional host run key and the chamber
 * episode parts; the owner mints the one SessionRunId for the session (host wins, a
 * same-family disagreement is reported as a conflict instead of being merged).
 */
import { recordIncident } from './incident.ts'
import {
  DELIVERY_EFFICACY,
  LADDER_TABLES,
  chamberRunId,
  classifyDeliverySymptoms,
  deliveryLadder,
  hostRunId,
  runIdFamily,
  describeRunId,
  planDeliveryRecovery,
  preferRunId,
  unresolvedRetryDelayMs,
  type ChamberRunParts,
  type DeliveryEvidence,
  type DeliverySymptom,
  type LadderRecord,
  type SessionRunId,
} from '@dsh-chamber/dsh-stream-state'

export { DELIVERY_EFFICACY, classifyDeliverySymptoms, deliveryLadder, describeRunId, unresolvedRetryDelayMs }
export type { DeliverySymptom, SessionRunId }

/** What the owner asks the shell to do this tick (at most one action per tick). */
export interface DeliveryAction {
  readonly sessionId: string
  readonly tier: 'resync' | 'instance-reboot' | 'document-reload'
  readonly symptoms: readonly DeliverySymptom[]
}

export interface DeliveryDecision {
  readonly runId: SessionRunId | undefined
  readonly symptoms: readonly DeliverySymptom[]
  readonly action: DeliveryAction | undefined
  /** The ladder has run out of levers: a first-class degraded fact, not a counter. */
  readonly hostStall: boolean
  /** Two ids of one family disagreed; instrument it, never merge. */
  readonly runIdConflict: boolean
}

export interface DeliveryObservationInput {
  readonly sessionId: string
  /** The host's own opaque run key, when the host provides one (minted by the owner). */
  readonly hostRunKey?: string
  readonly chamberRun?: ChamberRunParts
  /** Everything the executors of this page can see for the session. */
  readonly evidence: Omit<DeliveryEvidence, 'sessionId' | 'runId'>
  /** A resync may not run while another arm is disposing or reconnecting. */
  readonly escalationBlocked?: boolean
}

export interface SessionDeliveryOwner {
  /**
   * Plan one recovery tick. `commit: false` returns the decision WITHOUT writing the
   * dispatch ledger: the caller must account the action with markDispatched once it
   * actually ran, so a no-op attempt never authorizes a stronger tier.
   */
  observe(input: DeliveryObservationInput, now: number, options?: { readonly commit?: boolean }): DeliveryDecision
  /** Account a user-initiated action in the same ledger the automatic arm reads. */
  markDispatched(sessionId: string, tier: DeliveryAction['tier'], now: number): void
  /** Drop every ladder memory for a session that left the stage. */
  forget(sessionId: string): void
  /** Bounded diagnostics for the incident instrument. */
  describe(sessionId: string): string
}

export function createSessionDeliveryOwner(): SessionDeliveryOwner {
  const records = new Map<string, LadderRecord>()
  const conflicts = new Set<string>()
  const lastRuns = new Map<string, SessionRunId>()

  return {
    observe(input, now, options) {
      const { runId, conflict } = preferRunId(
        input.hostRunKey === undefined ? undefined : hostRunId(input.hostRunKey),
        input.chamberRun === undefined ? undefined : chamberRunId(input.chamberRun),
      )
      if (runId !== undefined) lastRuns.set(input.sessionId, runId)
      else lastRuns.delete(input.sessionId)
      // A `loading` face is NOT an automatic-recovery symptom: an open still in
      // flight is the host's to finish, and a parked one is the user's decision
      // (the stream-forensics evidence surfaces it; the page never re-issues an
      // open on a timer). The face is dropped BEFORE the shared classifier, and
      // its in-flight bits still block every other tier, so "an automatic action
      // never crosses a pending open" is unchanged.
      const loadingFace = input.evidence.open?.state === 'loading' ? input.evidence.open : undefined
      const evidence = loadingFace === undefined
        ? input.evidence
        : { ...input.evidence, open: undefined }
      const outcome = planDeliveryRecovery({
        evidence: {
          sessionId: input.sessionId,
          ...(runId === undefined ? {} : { runId }),
          ...evidence,
        },
        records: records.has(input.sessionId) ? { [input.sessionId]: records.get(input.sessionId) as LadderRecord } : {},
        now,
        escalationBlocked: input.escalationBlocked === true
          || (loadingFace !== undefined
            && (loadingFace.openInFlight === true || loadingFace.resyncInFlight === true)),
      })
      if (options?.commit !== false) {
        const nextRecord = outcome.plan.records[input.sessionId]
        if (nextRecord === undefined) records.delete(input.sessionId)
        else records.set(input.sessionId, nextRecord)
      }
      if (conflict) conflicts.add(input.sessionId)
      else conflicts.delete(input.sessionId)
      const action = outcome.plan.actions[0]
      return {
        runId,
        symptoms: outcome.symptoms,
        action: action === undefined ? undefined : {
          sessionId: input.sessionId,
          tier: action.tier as DeliveryAction['tier'],
          symptoms: outcome.symptoms,
        },
        hostStall: outcome.plan.exhausted.includes(input.sessionId),
        runIdConflict: conflict,
      }
    },
    /** Account a user-initiated action in the same ledger the automatic arm reads. */
    markDispatched(sessionId, tier, now) {
      const record = records.get(sessionId) ?? { symptomSinceMs: now, progressStamp: 0, dispatches: {} }
      const stamps = (record.dispatches[tier] ?? []).filter(at => now - at < LADDER_TABLES.delivery.rebootWindowMs)
      records.set(sessionId, { ...record, dispatches: { ...record.dispatches, [tier]: [...stamps, now] } })
      recordIncident({
        at: now, source: 'renderer', kind: 'delivery-dispatch', sessionId, action: tier,
        ...(lastRuns.get(sessionId) === undefined ? {} : { runId: lastRuns.get(sessionId) as string }),
      })
    },
    forget(sessionId) {
      records.delete(sessionId)
      conflicts.delete(sessionId)
      lastRuns.delete(sessionId)
    },
    describe(sessionId) {
      const record = records.get(sessionId)
      const run = lastRuns.get(sessionId)
      const conflict = conflicts.has(sessionId) ? ' conflict' : ''
      return 'delivery:' + sessionId + (record === undefined ? ' idle' : ' streak')
        + (run === undefined ? '' : ' ' + runIdFamily(run)) + conflict
    },
  }
}


