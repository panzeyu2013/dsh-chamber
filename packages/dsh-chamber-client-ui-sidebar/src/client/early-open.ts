/**
 * Boot-time early-open arm (design 05 §2.2 revision 2026-12; 2026-12 field
 * report problem 1). Runs inside ONE instance ctx, driven by the sidebar
 * plugin's effect.
 *
 * Why it exists: a cold-booted shell runs the official workspace navigation
 * policy (`UiWorkspaceService.watchNavigation`), which — with no current
 * session, the normal case for an N-ctx shell — connects the most recent
 * workspace, REUSING or CREATING (host-side `session.create`) a blank session,
 * and opens it. The chamber App cannot compete from outside: its own dispatch
 * starts only after boot settlement. This arm runs inside the target ctx, so it
 * can act as early as the policy itself: it polls the page-wide open-intent slot
 * (arm/release owned by `App.openSession`) and opens the requested session the
 * moment it is addressable.
 *
 * Contract:
 * - NEVER reports an outcome: the App's dispatch owns the terminal report and
 *   the row-level error surface. The arm only preempts (`sessions.open` is
 *   idempotent) and gives up silently at its deadline.
 * - One open per arm, then done: after the preemption the shell is warm and the
 *   App's post-settle path is authoritative for every later request.
 * - A live-intent read (not a captured value): a newer click replaces the intent
 *   and a settled open clears it, so the arm always opens what the user last
 *   asked for and never opens a request the App already finished.
 * - A missing/throwing list face retires the arm silently: the same ctx's
 *   runtime-facts producer already warns loudly for that defect.
 *
 * The win condition is honest, not guaranteed: the policy needs BOTH baselines
 * (workspace follow + session list) while the arm only needs the session list,
 * so the arm wins whenever the workspace baseline lands later — common over a
 * tunnel, not certain. When the policy already resolved, the blank session
 * exists on the host and the chamber's view gates (projection + reveal) are
 * what keep it off screen.
 */
import {
  EARLY_OPEN_BUDGET_MS,
  EARLY_OPEN_RETRY_MS,
  shouldEarlyOpenSession,
} from '../shared/open-intent.ts'

export interface EarlyOpenArmDeps {
  /** Chamber instance id of the ctx hosting this arm (log context). */
  instanceId: string
  /** Live intent read — never a captured value (see the contract above). */
  readIntent: () => string | undefined
  /**
   * Whether one session id is addressable in this ctx. `undefined` means the
   * list face is absent or hostile (the arm retires silently); `false` means
   * the face is readable but the session is not listed yet (keep polling).
   * Deliberately a per-id probe rather than a materialized id set: the arm runs
   * on a 50ms cadence and the session list can hold thousands of rows.
   */
  isAddressable: (sessionId: string) => boolean | undefined
  /** Open on this ctx's OWN sessions service (method call, never a detached reference). */
  open: (sessionId: string) => void
  /** One loud line for a refused open (an unexpected state: the id was listed). */
  warn: (message: string) => void
  /** Clock/timer seams (node tests drive them manually). */
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * Start the arm: one immediate attempt, then the retry cadence until the
 * deadline. Returns the disposer (ctx teardown).
 */
export function startEarlyOpenArm(deps: EarlyOpenArmDeps): () => void {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? (handle => { clearTimeout(handle) })
  const deadline = now() + EARLY_OPEN_BUDGET_MS
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const finish = (): void => {
    finished = true
    if (timer !== undefined) {
      clearTimer(timer)
      timer = undefined
    }
  }

  const attempt = (): void => {
    timer = undefined
    if (finished) return
    const intent = deps.readIntent()
    // Nothing pending — either never requested (background prewarm/harvest boot)
    // or already released by the App: this arm is done for this ctx's life.
    if (intent === undefined) return finish()
    const addressable = deps.isAddressable(intent)
    if (addressable === undefined) return finish()
    if (shouldEarlyOpenSession(intent, addressable)) {
      try {
        deps.open(intent)
      } catch (error) {
        deps.warn(`boot-time early open of ${intent} on ${deps.instanceId} was refused: `
          + `${error instanceof Error ? error.message : String(error)}`)
      }
      return finish()
    }
    if (now() >= deadline) return finish()
    timer = setTimer(attempt, EARLY_OPEN_RETRY_MS)
  }

  attempt()
  return finish
}
