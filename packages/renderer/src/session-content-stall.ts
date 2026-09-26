/**
 * Page-level content-stall streak (design 14 §D4 evidence chain).
 *
 * WHY this is a module and not arithmetic inside the view: the content observers
 * (currently only a gateway facts source; the mux watchdog is carrier recovery and
 * publishes NO content evidence) measure silence in THEIR clock
 * (Date.now by default), while the delivery ladder runs on the page's monotonic
 * clock (performance.now). `Math.min` of the two absolute values, or reusing the
 * open-health `since` - which is re-anchored on every sample while the session is
 * open by construction - makes the ladder's `afterMs` gate unreachable: an already
 * open session whose content channel died never recovers. The rule that turns an
 * observed DURATION into a page-clock streak start, and the rule that decides which
 * symptoms are active this tick, live here so both are unit-testable in plain Node.
 */
import { classifyDeliverySymptoms } from '@dsh-chamber/dsh-stream-state'

/** The presented session's content-stall streak, in the page clock. */
export interface ContentStallStreak {
  readonly sessionId: string
  readonly start: number
}

/**
 * Anchor an observer-reported silence duration in the page clock.
 * @param previous - the single-slot streak; a session switch replaces it.
 * @param elapsedMs - observer duration; undefined once content is flowing again.
 */
export function advanceContentStallStreak(
  previous: ContentStallStreak | null,
  sessionId: string,
  elapsedMs: number | undefined,
  at: number,
): ContentStallStreak | null {
  if (elapsedMs === undefined) return null
  if (previous?.sessionId === sessionId) return previous
  return { sessionId, start: at - Math.max(0, elapsedMs) }
}

/**
 * The earliest start among the symptoms ACTIVE this tick - the caller-owned value
 * `DeliveryEvidence.symptomSinceMs` expects. `openSince` only counts when the open
 * symptom is actually present: while a session is open it has no age by design and
 * must not donate its freshly-reset `since` to another symptom.
 */
export function activeSymptomSinceMs(input: {
  readonly openSince: number
  readonly openStallActive: boolean
  /** Desktop-observed schedule stall (frame counter), when present this tick. */
  readonly scheduleStallStart?: number | undefined
  /** Desktop-observed input block (JS thread RTT), when present this tick. */
  readonly inputBlockStart?: number | undefined
}): number {
  const starts: number[] = []
  if (input.openStallActive) starts.push(input.openSince)
  if (input.scheduleStallStart !== undefined) starts.push(input.scheduleStallStart)
  if (input.inputBlockStart !== undefined) starts.push(input.inputBlockStart)
  if (starts.length === 0) return input.openSince
  return Math.min(...starts)
}

/**
 * The caller-owned "tried and could not conclude" bit for the ladder's
 * `requiresStuckEvidence` tiers (instance-reboot, document-reload): a resync was
 * already dispatched for THIS symptom streak and the symptom survived it. Keyed by
 * the streak start so a new streak cannot inherit the previous one's conclusion;
 * the tiers' own afterMs gates still decide when they become due.
 */
export function stuckEvidenceForStreak(input: {
  readonly streakStart: number | undefined
  readonly resyncDispatchedFor: number | undefined
}): boolean {
  return input.streakStart !== undefined && input.resyncDispatchedFor === input.streakStart
}

/**
 * The upper-tier evidence gate for instance-reboot/document-reload. A resync the
 * page dispatched for its OWN open-stall is not enough: an OPEN stall proves the
 * document's frame counter is still advancing, while DELIVERY_EFFICACY budgets
 * those tiers against an independently observed stall (schedule frame counter,
 * input-block RTT). Without one, an open-stall escalates no further than resync:
 * a parked session's open is re-issued, never a whole instance reboot or reload.
 */
export function upperTierStallEvidence(input: {
  readonly scheduleStallStart?: number | undefined
  readonly inputBlockStart?: number | undefined
  readonly streakStart: number | undefined
  readonly resyncDispatchedFor: number | undefined
}): boolean {
  if (input.scheduleStallStart === undefined && input.inputBlockStart === undefined) return false
  return stuckEvidenceForStreak({
    streakStart: input.streakStart,
    resyncDispatchedFor: input.resyncDispatchedFor,
  })
}

/**
 * The open-stall shape the shared classifier uses (loading with no open in flight,
 * or an error the header cannot heal, with resync available). An in-flight RECOVERY
 * is still a stall, so it does not clear the shape. Kept here so the streak and the
 * evidence agree; the parity test pins it against `classifyDeliverySymptoms`.
 */
export function openStallSymptomActive(open: {
  readonly state: 'cold' | 'loading' | 'open' | 'error' | 'missing'
  readonly openInFlight?: boolean | undefined
  readonly resyncInFlight?: boolean | undefined
  readonly resyncAvailable: boolean
  readonly healRoute?: boolean | undefined
} | undefined | null): boolean {
  if (open === undefined || open === null) return false
  // Single-sourced with the ladder's own classifier: a new upstream condition can
  // never make the streak and the evidence disagree.
  return classifyDeliverySymptoms({ sessionId: '', open, symptomSinceMs: 0 }).includes('open-stall')
}
