/**
 * Bounded auth-recovery driver (design 27 §3.3).
 *
 * A gateway ready push whose auth material is already dead unregisters the proxy
 * and must re-verify the session. The DECISION is pure (`auth-recovery-policy.ts`);
 * this module owns the timers and the accounting, so the wiring is testable with an
 * injected clock and timer surface (no plane, no Electron):
 *
 * - at most one recovery per `minIntervalMs` — a second bad push inside the window
 *   must not hammer the gateway;
 * - a throttled attempt is DEFERRED to the window edge, never dropped: returning
 *   into "ready but unregistered" with no future edge was the bug this replaces;
 * - the throttle is measured from the last ACTUAL attempt (not from scheduling),
 *   so a push right after a deferred attempt cannot fire a recovery one second later;
 * - one pending attempt per instance, cancels on registration/leave-ready/dispose.
 */

import { authRecoveryDecision } from './auth-recovery-policy.ts'

export interface AuthRecoveryControllerOptions {
  readonly minIntervalMs: number
  /** Perform the recovery. The callback re-checks phase/url/scope itself: the
   *  controller must not need to know what "still valid" means. */
  readonly attempt: (id: string) => void
  readonly onDecision?: (id: string, decision: 'now' | 'deferred', delayMs: number) => void
  /** Test seams. */
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface AuthRecoveryController {
  /** An auth-failed ready push: recover now, or defer to the window edge. */
  notifyFailure(id: string): void
  /** Cancel a deferred attempt (registration succeeded / left ready / disconnect). */
  cancel(id: string): void
  dispose(): void
}

/**
 * The fail-closed guard a recovery attempt must pass. Extracted from the
 * host-assembly closure so the DECISION is testable: the attempt re-observes the
 * instance after the (possibly deferred) wait, and a recovery for a transport that
 * is no longer ready / no longer the same target / no longer a password gateway
 * must do nothing at all.
 */
export interface AuthRecoveryObservation {
  readonly phase: string
  readonly readyUrlMatches: boolean
  readonly kind: string
  readonly hasPassword: boolean
  readonly scopeMatches: boolean
}

export function authRecoveryStillApplies(observation: AuthRecoveryObservation): boolean {
  return observation.phase === 'ready'
    && observation.readyUrlMatches
    && observation.kind === 'gateway'
    && observation.hasPassword
    && observation.scopeMatches
}

export function createAuthRecoveryController(options: AuthRecoveryControllerOptions): AuthRecoveryController {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  })
  const clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle) })
  const lastAttemptAt = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false

  const cancel = (id: string): void => {
    const timer = timers.get(id)
    if (timer === undefined) return
    timers.delete(id)
    clearTimer(timer)
  }

  return {
    notifyFailure(id) {
      if (disposed) return
      // One pending deferred attempt is enough; a burst of pushes collapses into it.
      if (timers.has(id)) {
        options.onDecision?.(id, 'deferred', 0)
        return
      }
      const decision = authRecoveryDecision(now(), lastAttemptAt.get(id) ?? 0, options.minIntervalMs)
      if (decision.action === 'now') {
        lastAttemptAt.set(id, now())
        options.onDecision?.(id, 'now', 0)
        options.attempt(id)
        return
      }
      options.onDecision?.(id, 'deferred', decision.delayMs)
      timers.set(id, setTimer(() => {
        timers.delete(id)
        if (disposed) return
        // The window is measured from the attempt itself, not from scheduling.
        lastAttemptAt.set(id, now())
        options.attempt(id)
      }, decision.delayMs))
    },
    cancel,
    dispose() {
      disposed = true
      for (const timer of timers.values()) clearTimer(timer)
      timers.clear()
      lastAttemptAt.clear()
    },
  }
}
