/**
 * Armed-confirmation state machine (2026-09-11 upstream-alignment T2).
 *
 * One destructive action at a time: a request is ARMED (a dialog opens), then
 * either CANCELled (nothing runs — the request is dropped before its runner is
 * ever called) or ACCEPTed (the runner is launched exactly once, and the dialog
 * becomes a non-dismissible progress surface until the action settles).
 *
 * The machine is pure so the invariant that matters — no action reaches the wire
 * without an accept, and an accept launches exactly one runner — is pinned by
 * plain unit tests (test/confirm-machine.test.ts) instead of DOM rendering: the
 * dsh runtime section both arms (its own gateway mutations) and is armed for it
 * (the shared restart path), so the same transition set serves both.
 */

/** The part of an armed request the machine drives: the action to launch on accept. */
export interface ConfirmRunner {
  /** The confirmed action. It owns its own failure reporting. */
  run: () => Promise<void>
}

/** One armed request plus whether its action is in flight. */
export interface ConfirmState<R extends ConfirmRunner> {
  /** The armed request, or null when nothing is armed. */
  request: R | null
  /** True while the accepted action is still running. */
  pending: boolean
}

/** Nothing armed: the dialog is closed and no action can launch (assignable to any request type). */
export const IDLE_CONFIRM: ConfirmState<never> = { request: null, pending: false }

/** Arm one request (opens the dialog). Nothing runs yet. */
export function armConfirm<R extends ConfirmRunner>(request: R): ConfirmState<R> {
  return { request, pending: false }
}

/**
 * Dismiss the dialog. A cancel performs NOTHING: the request is dropped and its
 * runner is never called. While the action is already running the dialog is a
 * progress surface, so a dismiss is ignored rather than implying a cancellation
 * that does not exist.
 * @param state - the current machine state.
 * @returns the next state (the same object while pending).
 */
export function cancelConfirm<R extends ConfirmRunner>(state: ConfirmState<R>): ConfirmState<R> {
  return state.pending ? state : { request: null, pending: false }
}

/**
 * Accept the armed request: hand its runner to the caller's `launch` EXACTLY
 * once and move the machine into its pending state. A second accept — a
 * same-frame double click included — is a no-op, and an accept with nothing
 * armed launches nothing.
 * @param state - the current machine state.
 * @param launch - receives the runner to start (the component starts it and
 * settles the machine; tests pass a spy).
 * @returns the next state.
 */
export function acceptConfirm<R extends ConfirmRunner>(
  state: ConfirmState<R>,
  launch: (run: () => Promise<void>) => void,
): ConfirmState<R> {
  if (state.request === null || state.pending) return state
  launch(state.request.run)
  return { request: state.request, pending: true }
}

/**
 * The accepted action settled (success or failure — both are the action's own
 * reporting): the dialog closes and the next action can arm.
 * @returns the idle state.
 */
export function settleConfirm<R extends ConfirmRunner>(): ConfirmState<R> {
  return IDLE_CONFIRM
}
