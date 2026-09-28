/**
 * Observation validity — the ONE classifier every chamber liveness deadline consumes
 * (design 14 §D4，I5「缺席不作证据」推广到**活性证据**).
 *
 * Chamber's liveness machinery used to read "my deadline fired" as "the source is
 * broken". In a WKWebView that reading is wrong whenever the page itself was not
 * scheduled: WebKit throttles/suspends an occluded or unfocused window while
 * \`document.visibilityState\` still says \`visible\`, so a 5s wall-clock deadline can
 * expire with the request never having been given a chance to complete. The same
 * shape shows up when our own teardown/replacement aborts an in-flight request.
 * Neither is a fact about the source.
 *
 * Pure and clockless: callers pass what they observed (outcome, error name/message,
 * whether the page had a scheduling gap in the window). Thresholds live here so
 * every consumer classifies identically.
 */

/** Why an observation ended. Only \`answered\`/\`deadline\`/\`channel\` may book a source fact. */
export type ObservationVerdict =
  /** The source answered (success, or a legitimate not-serving-yet answer). */
  | 'answered'
  /** The page was scheduled for the whole window and the deadline still expired. */
  | 'deadline'
  /** The page was NOT scheduled inside the window (throttled/occluded/suspended). */
  | 'unscheduled'
  /** Our own teardown or a replaced generation aborted the observation. */
  | 'superseded'
  /** A transport failure: network error, non-2xx, closed socket. */
  | 'channel'
  /** The instance is not serving yet (503 instance_unavailable) — a phase, not a fault. */
  | 'unavailable'

/** Everything the classifier is allowed to look at. */
export interface ObservationEvidence {
  readonly outcome: 'answered' | 'error'
  /** Error name (\`TimeoutError\`, \`AbortError\`, \`TypeError\`, …) when outcome is error. */
  readonly errorName?: string | undefined
  /** Error message (WebKit reports an aborted fetch as \`Fetch is aborted\`). */
  readonly errorMessage?: string | undefined
  /**
   * True when the page had a scheduling gap inside the observation window
   * (\`page-schedule.ts#hadSchedulingGap\`). Absent means "unknown" → treated as
   * scheduled, because an unproven gap must not excuse a real failure.
   */
  readonly schedulingGap?: boolean | undefined
  /** True for the control plane's not-serving-yet answer (503 instance_unavailable). */
  readonly notServingYet?: boolean | undefined
}

/**
 * Cancellation evidence: WebKit reports an aborted fetch as
 * \`TypeError: Fetch is aborted\`, and a signal-fired abort as an \`AbortError\`
 * DOMException. \`TimeoutError\` is deliberately NOT a cancellation: a fetch that
 * outlived its own deadline is a deadline observation, classified separately.
 */
function isCancellationError(name?: string, message?: string): boolean {
  if (name === 'TimeoutError') return false
  if (name === 'AbortError') return true
  return typeof message === 'string' && /abort/i.test(message)
}

/** Classify one observation. Total: never throws, unknown shapes fall back to \`channel\`. */
export function classifyObservation(evidence: ObservationEvidence): ObservationVerdict {
  if (evidence.outcome === 'answered') return 'answered'
  if (evidence.notServingYet === true) return 'unavailable'
  if (isCancellationError(evidence.errorName, evidence.errorMessage)) return 'superseded'
  if (evidence.errorName === 'TimeoutError') {
    return evidence.schedulingGap === true ? 'unscheduled' : 'deadline'
  }
  return 'channel'
}

/**
 * May this verdict book a source fact (degrade, stall, baseline failure, …)?
 * \`unscheduled\`/\`superseded\` are page-local artefacts and book NOTHING;
 * \`unavailable\` is a phase the caller's serving gate owns, not a fault.
 */
export function isAdmissible(verdict: ObservationVerdict): boolean {
  return verdict === 'answered' || verdict === 'deadline' || verdict === 'channel'
}
