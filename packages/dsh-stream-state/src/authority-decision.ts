/**
 * B4: the sidebar's receipt chain as a DECISION, not as imperative branches.
 *
 * WHY THIS EXISTS. The 190s-class reconcile chain (`SessionFactReconciler`) had its
 * policy buried inside an async method: after the independent authority probe
 * returned, four cases were decided by inline `if`s, and the tier-3 write-back was
 * entangled with the settle fence. That made the policy untestable in isolation and
 * invisible to review - the exact shape this refactor removes.
 *
 * WHAT MOVED. The async ORCHESTRATION stays in the sidebar (timers, seams, the
 * settle fence: those are the host's job). What moves here is the DECISION:
 * "given the probe's verdict and which seams exist, what must happen next" and
 * "given the write-back's outcome, how does the round settle". Both are pure, and
 * both are what the chain's five review rounds actually argued about.
 *
 * NOT MOVED (deliberately): the two phase timers, the dispose fence, and the
 * "abandoned verify may not write" rule - those are timing/lifetime facts about the
 * host, not policy. See the plan's §73.1 for the eight semantics that must not be
 * lost if this is ever taken further.
 */

/** The probe's verdict (mirrors the sidebar's `SessionFactVerdict`). */
export type AuthorityVerdict = 'converged' | 'stale' | 'unknown'

/** What the chain must do after the authority probe returned. */
export type AuthorityStep =
  /** Settle the attempt now: `ok` is the receipt's success bit. */
  | { readonly step: 'settle'; readonly ok: boolean; readonly corrected: boolean; readonly note: string }
  /** Try the tier-3 write-back (only reachable when the seam exists). */
  | { readonly step: 'writeBack' }

/**
 * The decision after the authority probe. Verdict semantics (from the chain's own
 * documentation, 2026-12 five review rounds):
 *  - `converged`: the authority agrees with the official fact - settle ok.
 *  - `unknown`: the probe could not conclude - settle NOT ok, without escalating
 *    (a broken auxiliary carrier must not look like a stale fact).
 *  - `stale` + a write-back seam: try to correct the official store FIRST; the
 *    round only settles after that attempt reports back.
 *  - `stale` + no seam: settle NOT ok, which is what lets the guard escalate.
 */
export function decideAfterAuthorityProbe(
  verdict: AuthorityVerdict,
  hasWriteBackSeam: boolean,
): AuthorityStep {
  if (verdict === 'converged') {
    return { step: 'settle', ok: true, corrected: false, note: 'authority converged' }
  }
  if (verdict === 'unknown') {
    return {
      step: 'settle',
      ok: false,
      corrected: false,
      note: 'session-fact reconcile probe is unavailable (no authority this round)',
    }
  }
  if (hasWriteBackSeam) return { step: 'writeBack' }
  return {
    step: 'settle',
    ok: false,
    corrected: false,
    note: 'session-fact reconcile did not converge to an authoritative baseline',
  }
}

/**
 * The decision after the write-back attempt. A write-back that did NOT verify must
 * still settle as stale - it must not be reported as a correction, or the guard
 * would stop escalating on a store that never changed.
 */
export function decideAfterWriteBack(corrected: boolean): AuthorityStep {
  if (corrected) {
    return { step: 'settle', ok: true, corrected: true, note: 'authoritative running bit corrected (tier-3)' }
  }
  return {
    step: 'settle',
    ok: false,
    corrected: false,
    note: 'session-fact reconcile did not converge to an authoritative baseline',
  }
}

/**
 * Whether the round must warn because the OFFICIAL refresh was broken while the
 * independent authority still concluded. Without this line a persistently broken
 * official channel degrades silently (2026-12 four-round review).
 */
export function shouldWarnAboutBrokenRefresh(refreshFailed: boolean, step: AuthorityStep): boolean {
  // Only a SUCCESSFUL settle warns: a non-converging round already carries the refresh
  // failure inside its settle message, so warning twice would double-report it.
  return refreshFailed && step.step === 'settle' && step.ok
}
