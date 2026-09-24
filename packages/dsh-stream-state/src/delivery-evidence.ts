/**
 * Delivery evidence and the ONE recovery ladder.
 *
 * WHY. Content stalls, rendering-schedule stalls, input blocks and opening stalls were
 * detected and acted on by four different machines with four vocabularies (a page seat,
 * a header chip, a watchdog, a carrier reducer). This module turns all of them into
 * observations for the shared ladder engine and records what each ACTION can actually
 * reset, so the executor never guesses: a component-level reboot does not promise to
 * clear a module-level animation loop; only a document reload does.
 *
 * PURITY: imports only ./tables.ts, ./ladder.ts and ./run-id.ts (no clock, no DOM).
 */
import { planLadder, type Ladder, type LadderObservation, type LadderPlan } from './ladder.ts'
import { DELIVERY_EFFICACY, LADDER_TABLES } from './tables.ts'
import type { SessionRunId } from './run-id.ts'

export { DELIVERY_EFFICACY }

/** Every stall family the delivery owner must observe. */
export type DeliverySymptom =
  | 'schedule-stall'
  | 'input-block'
  | 'open-stall'
  | 'authority-divergence'
  | 'delivery-unresolved'

/**
 * What the executor may do, cheapest first. The tier name IS the action name.
 * JOURNAL RESTART belongs to the carrier reducer (its own table) and is recorded in
 * the efficacy table for ordering only, never dispatched here.
 */
export type DeliveryActionTier = 'resync' | 'instance-reboot' | 'document-reload'

/** One recovery action and the state it actually resets. This is the hard contract. */
export interface DeliveryEfficacy {
  readonly tier: 'journal-restart' | DeliveryActionTier | 'webcontent-crash-recovery'
  /** The state boundary this action resets. */
  readonly resets: string
  /** The evidence that must hold before the action may run. */
  readonly evidence: string
  /** Which reducer/executor owns the action. */
  readonly owner: 'carrier' | 'delivery' | 'shell'
}

/** Evidence snapshot for one session; executors fill only what their channel can see. */
export interface DeliveryEvidence {
  readonly sessionId: string
  readonly runId?: SessionRunId
  /** Rendering schedule: the document frame counter failed its watchdog strikes. */
  readonly scheduleStalled?: boolean
  /** Input/JS responsiveness: the main-process probe round trip exceeded its bound. */
  readonly inputBlocked?: boolean
  /** Opening: the concrete session face. */
  readonly open?: {
    readonly state: 'cold' | 'loading' | 'open' | 'error' | 'missing'
    readonly openInFlight?: boolean | undefined
    readonly resyncInFlight?: boolean | undefined
    readonly resyncAvailable: boolean
    /**
     * Whether the header's stage-move lever is usable for this session (current,
     * listed, with a listed neighbour). `false` means the header arm is absent OR
     * unreadable (the probe fails closed), so an `error` face would otherwise have
     * no automatic rebuild (an address-only subagent selection, a masked target);
     * the page then owns the bounded resync, whose worst case is one extra rebuild.
     * `true`/`undefined` keep the error arm with the header.
     */
    readonly healRoute?: boolean | undefined
  }
  /** The running bit diverged from the chamber's authoritative read. */
  readonly authorityDiverged?: boolean
  /** A completion whose classification could never be read back. */
  readonly unresolvedCompletion?: boolean
  /** Earliest tick of the current symptom streak (caller-owned). */
  readonly symptomSinceMs: number
  /** The caller tried and could not conclude (unlocks stronger tiers). */
  readonly stuckEvidence?: boolean
}

/** One tick's observations per symptom, ready for the ladder engine. */
export interface DeliverySymptomObservation {
  readonly symptom: DeliverySymptom
  readonly observation: LadderObservation
}

/** Map one evidence snapshot to the present symptoms (pure, order-stable). */
export function classifyDeliverySymptoms(evidence: DeliveryEvidence): readonly DeliverySymptom[] {
  const symptoms: DeliverySymptom[] = []
  if (evidence.scheduleStalled === true) symptoms.push('schedule-stall')
  if (evidence.inputBlocked === true) symptoms.push('input-block')
  const open = evidence.open
  // An in-flight OPEN is not a stall, but an in-flight RECOVERY is: the stall is not
  // resolved until the face actually converges. Reporting it keeps the streak and its
  // ledger alive across the dispose/reopen window; double dispatch is prevented where
  // it belongs (escalationBlocked below), not by erasing the symptom.
  if (open !== undefined && open.resyncAvailable) {
    // A loading face with nothing pending can settle with no retry trigger at all,
    // and re-issuing is free (no open is being interrupted).
    const loadingStall = open.state === 'loading' && open.openInFlight === false
    // The header heals an error through the stage move. When that route is
    // explicitly unusable (an address-only subagent selection, a masked target,
    // no listed neighbour), the page's own resync is the only automatic rebuild
    // left: without this arm that shape has no automatic recovery at all.
    // `!== true` (not `=== false`): the vendor writes 'error' only after its open
    // settled or failed, so unknown liveness is not an in-flight open - only a
    // provably pending promise is protected.
    const unhealableError = open.state === 'error' && open.healRoute === false
      && open.openInFlight !== true
    if (loadingStall || unhealableError) symptoms.push('open-stall')
  }
  if (evidence.authorityDiverged === true) symptoms.push('authority-divergence')
  if (evidence.unresolvedCompletion === true) symptoms.push('delivery-unresolved')
  return symptoms
}

/** The one delivery ladder; budgets come from the shared table, never from a module. */
export function deliveryLadder(): Ladder {
  const table = LADDER_TABLES.delivery
  return {
    name: 'delivery',
    quotaWindowMs: table.rebootWindowMs,
    tiers: [
      { name: 'resync', afterMs: table.resyncGraceMs, cooldownMs: table.resyncCooldownMs, quota: table.resyncMax, quotaWindowMs: table.resyncWindowMs, requiresStuckEvidence: false },
      { name: 'instance-reboot', afterMs: table.rebootAfterMs, cooldownMs: table.rebootCooldownMs, quota: table.rebootMax, quotaWindowMs: table.rebootWindowMs, requiresStuckEvidence: true },
      { name: 'document-reload', afterMs: table.reloadAfterMs, cooldownMs: table.reloadCooldownMs, quota: table.reloadMax, quotaWindowMs: table.reloadWindowMs, requiresStuckEvidence: true },
    ],
  }
}

export interface DeliveryRecoveryPlan {
  readonly symptoms: readonly DeliverySymptom[]
  /** The ladder plan for the one session key; its exhausted list carries the host-stall fact. */
  readonly plan: LadderPlan
}

/**
 * One tick for one session. The caller keeps the per-session ladder records; the
 * delivery ladder itself owns tier order, evidence gates, cooldowns and quotas.
 */
export function planDeliveryRecovery(input: {
  readonly evidence: DeliveryEvidence
  readonly records: Parameters<typeof planLadder>[1]
  readonly now: number
  readonly escalationBlocked?: boolean
}): DeliveryRecoveryPlan {
  const symptoms = classifyDeliverySymptoms(input.evidence)
  // "A resync still disposing must not start a second one" is a property of the
  // EVIDENCE, not of a caller remembering to pass a flag: derive it here so the
  // guarantee holds for every entry point (and without consuming quota).
  const escalationBlocked = input.escalationBlocked === true
    || input.evidence.open?.resyncInFlight === true
    // An open already in flight is the recovery this page would ask for: acting on
    // top of it produced resyncs for sessions that were still opening.
    || input.evidence.open?.openInFlight === true
  const observations: Record<string, LadderObservation> = {}
  // A recovery action can make the symptom TEMPORARILY UNOBSERVABLE (a resync tears
  // the carrier down, so a gateway source reports disconnected and the content
  // symptom vanishes for a tick). That must PAUSE the ledger, never delete it -
  // deletion resets cooldown/quota and re-fires the action after the next sample.
  if (symptoms.length > 0 || escalationBlocked) {
    observations[input.evidence.sessionId] = {
      sticky: true,
      symptomSinceMs: input.evidence.symptomSinceMs,
      stuckEvidence: input.evidence.stuckEvidence === true,
      progressStamp: 0,
      escalationBlocked,
    }
  }
  return { symptoms, plan: planLadder(deliveryLadder(), input.records, observations, input.now) }
}

/** Unresolved completions retry with this bounded schedule before becoming a fact. */
export function unresolvedRetryDelayMs(attempts: number): number {
  const table = LADDER_TABLES.delivery
  const exponent = Math.min(Math.max(Math.floor(attempts), 0), 8)
  return Math.min(table.unresolvedRetryMaxMs, table.unresolvedRetryBaseMs * 2 ** exponent)
}
