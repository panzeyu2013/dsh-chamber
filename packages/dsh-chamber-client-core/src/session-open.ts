/**
 * The session-face open-liveness evidence, SINGLE SOURCE.
 *
 * Two client halves used to carry this tri-state read verbatim (mobile
 * session-stall.ts and open-in session-stream-health-probe.ts); both already
 * depend on client-core, so the evidence function lives here once.
 *
 * Contract (unchanged from both copies):
 * - `undefined` — this build's face cannot say (missing member, a hostile
 *   accessor, a non-null non-thenable value): fail closed, exactly like a
 *   missing capability;
 * - `false` — ONLY an exactly-null own `openPromise` member is positive
 *   evidence of "nothing pending" (the pinned vendor marks the parked slot with
 *   `null`);
 * - `true` — an object/function value is an in-flight open.
 *
 * A build that renamed or removed the member must degrade to "unknown", never
 * to "nothing is pending" — the latter would let the recovery ladder destroy an
 * in-flight open.
 */
export function sessionOpenPromiseInFlight(session: object): boolean | undefined {
  try {
    // The member MUST exist for FALSE to be reported.
    if (!Object.hasOwn(session, 'openPromise')) return undefined
    const pending = (session as { openPromise?: unknown }).openPromise
    if (pending === null) return false
    if (typeof pending === 'object' || typeof pending === 'function') return true
    return undefined
  } catch {
    return undefined
  }
}
