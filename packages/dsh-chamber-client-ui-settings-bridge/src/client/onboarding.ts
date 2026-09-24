/**
 * `settings.onboarding` coordinator facts.
 *
 * Upstream's settings shell mounts exactly ONE ordered `settings.onboarding` step while
 * the current session is blank or absent: the first uncompleted ledger entry, rendered
 * with its own owner props (`stepId` / `complete` / `openSection`) so the step's own
 * component — in the SAME boot ctx — owns its ctx reads, readiness gate and dialog
 * chrome; the shell paints nothing.
 *
 * Chamber parity: the shell IS that ctx's `sidebar.settings` occupant, so it coordinates
 * its OWN ctx's ledger and sessions seat — the same two facts upstream reads, both
 * already delivered (`props.useSessions`; the ctx-side ledger via
 * settings-source-face.ts). Never re-derived from the panel's selected source: two shells
 * selecting one source would mount the same step twice. This module is the pure half; the
 * React wiring lives in ./onboarding-hooks.ts.
 */
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/** The onboarding slot this coordinator projects. */
export const ONBOARDING_SLOT = 'settings.onboarding'

/** One ordered onboarding step of a ledger. */
export interface OnboardingStep {
  id: string
  order: number
}

/** Ledger read face the coordinator drives (the registry's public read API, structural). */
export interface OnboardingLedger {
  entries(key: string): readonly { options: { id?: string; order?: number } }[]
  getVersion(key: string): number
  subscribe(key: string, fn: () => void): () => void
}

/** Sessions-list state the coordinator selects over (the official `SessionListState` fields upstream's readiness selector reads). */
export interface OnboardingSessionsState {
  phase?: string
  /** Current session id; absent while the instance has no session at all. */
  current?: string
  /** Per-session summaries; `blank` marks the unused "new session" row. */
  byId?: Record<string, { blank?: boolean } | undefined>
}

/** Selector hook over one instance's session list (the renderer's `useSessions` seat). */
export type OnboardingSessionsSeat = SnapshotSelectorHook<OnboardingSessionsState>

/**
 * Upstream's readiness fact, verbatim: the session store is live AND the current
 * session is absent or still blank — the state in which a first-run user has
 * contributed nothing yet.
 */
export function onboardingActive(state: OnboardingSessionsState): boolean {
  return state.phase === 'ready'
    && (state.current === undefined || state.byId?.[state.current]?.blank === true)
}

/**
 * Project one ledger's onboarding entries into coordinator order.
 * @returns the steps, lowest `order` first (ties keep registration sequence).
 */
export function onboardingSteps(ledger: OnboardingLedger): OnboardingStep[] {
  return ledger.entries(ONBOARDING_SLOT)
    .map(entry => ({ id: entry.options.id ?? '', order: entry.options.order ?? 0 }))
    .sort((a, b) => a.order - b.order)
}

/**
 * The step the coordinator mounts: the first ordered entry not yet completed.
 * @returns the step to mount, or undefined when every step is done.
 */
export function nextOnboardingStep(
  steps: readonly OnboardingStep[],
  completed: ReadonlySet<string>,
): OnboardingStep | undefined {
  return steps.find(step => !completed.has(step.id))
}

/** Everything one derivation of the stage reads. */
export interface OnboardingStageInput {
  /** This ctx's ordered ledger steps. */
  steps: readonly OnboardingStep[]
  /** Step ids already completed in this active run. */
  completed: ReadonlySet<string>
  /** This ctx's OWN sessions fact (upstream's readiness selector result). */
  sessionsActive: boolean
  /** The App-published active-view fact: this ctx is the view on screen. */
  inActiveView: boolean
}

/** One derivation of the stage: what mounts, and whether the run ended. */
export interface OnboardingStage {
  /** The step to mount this render, or undefined while nothing mounts. */
  step: OnboardingStep | undefined
  /** Whether the completed set must be dropped — the sessions fact alone says so. */
  resetsCompleted: boolean
}

/**
 * Derive the stage from its two independent facts.
 *
 * MOUNTING is their conjunction: upstream mounts on the sessions fact alone, and the
 * chamber adds the App-published active-view fact because several instance shells are
 * mounted at once and the step's dialog is document-global — a hidden shell must never
 * pop another instance's stage over the view on screen.
 *
 * The RESET is the sessions fact ALONE (upstream's `if (onboardingActive) return;
 * setCompletedOnboarding(new Set())`). It must NOT fold in the active-view gate: a plain
 * VIEW SWITCH would then wipe every acknowledgement, so a step the user just completed
 * or explicitly deferred would re-mount when the view came back. Residual: the completed
 * set is component-local, so a shell REMOUNT still starts a fresh run.
 */
export function onboardingStage({
  steps, completed, sessionsActive, inActiveView,
}: OnboardingStageInput): OnboardingStage {
  return {
    step: sessionsActive && inActiveView
      ? nextOnboardingStep(steps, completed)
      : undefined,
    resetsCompleted: !sessionsActive,
  }
}

/**
 * Read the sessions seat the renderer handed this shell. The chamber's loose ambient
 * face erases `PropsRuntime` to `Record<string, unknown>`, so the framework seat's
 * selector signature is asserted here — and only when the member really is a function,
 * so an absent seat reads as "no session fact" instead of crashing the shell.
 */
export function sessionsSeatOf(props: object): OnboardingSessionsSeat | undefined {
  const seat = (props as Record<string, unknown>)['useSessions']
  return typeof seat === 'function' ? seat as unknown as OnboardingSessionsSeat : undefined
}
