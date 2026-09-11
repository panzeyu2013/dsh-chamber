/**
 * `settings.onboarding` coordinator facts (2026-09-11 upstream-alignment T3).
 *
 * Upstream's settings shell mounts exactly ONE ordered `settings.onboarding`
 * step while the current session is blank or absent
 * (ui-settings-general/src/client/SettingsRoot.tsx): the first ledger entry the
 * user has not completed, rendered with its own owner props
 * (`stepId` / `complete` / `openSection`) so the step's own component — which
 * lives in the SAME boot ctx — owns its ctx reads, its readiness gate and its
 * dialog chrome. The shell paints nothing of its own for this stage.
 *
 * Chamber parity: the chamber shell IS that ctx's `sidebar.settings` occupant
 * (one per instance boot ctx), so it coordinates its OWN ctx's ledger and its
 * OWN sessions seat — the same two facts upstream reads, and both already
 * delivered to this component by the renderer (`props.useSessions`) and by the
 * bridge's own face publication (the ctx-side ledger, settings-source-face.ts).
 * No new fact channel is introduced, and the stage is never re-derived from the
 * panel's selected source: a foreign ctx's onboarding would have to be driven
 * through a foreign hook, and two mounted shells selecting the same source
 * would mount the same step twice (duplicate first-run dialogs).
 *
 * This module is the pure half (projection + readiness fact + seat narrowing) so
 * the coordinator's truth table is pinned by plain unit tests; the React wiring
 * lives in ./onboarding-hooks.ts (it imports the renderer's hook factory, which
 * only the bundle can resolve).
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

/**
 * Sessions-list state the coordinator selects over (the official
 * `SessionListState` fields upstream's readiness selector reads).
 */
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
 * Upstream's readiness fact, verbatim (SettingsRoot.tsx): the session store is
 * live AND the current session is absent or still blank — the state in which a
 * first-run user has contributed nothing yet.
 * @param state - the instance's session-list state.
 * @returns whether the onboarding stage owns the instance right now.
 */
export function onboardingActive(state: OnboardingSessionsState): boolean {
  return state.phase === 'ready'
    && (state.current === undefined || state.byId?.[state.current]?.blank === true)
}

/**
 * Project one ledger's onboarding entries into coordinator order.
 * @param ledger - that ctx's slot registry (read face).
 * @returns the steps, lowest `order` first (ties keep registration sequence).
 */
export function onboardingSteps(ledger: OnboardingLedger): OnboardingStep[] {
  return ledger.entries(ONBOARDING_SLOT)
    .map(entry => ({ id: entry.options.id ?? '', order: entry.options.order ?? 0 }))
    .sort((a, b) => a.order - b.order)
}

/**
 * The step the coordinator mounts: the first ordered entry not yet completed.
 * @param steps - ordered steps.
 * @param completed - step ids already completed in this active run.
 * @returns the step to mount, or undefined when every step is done.
 */
export function nextOnboardingStep(
  steps: readonly OnboardingStep[],
  completed: ReadonlySet<string>,
): OnboardingStep | undefined {
  return steps.find(step => !completed.has(step.id))
}

/**
 * Read the sessions seat the renderer handed this shell. The chamber's loose
 * ambient face erases `PropsRuntime` to `Record<string, unknown>`, so the
 * framework seat's selector signature (upstream `UseSessions`) is asserted here
 * — and only when the member really is a function, so an absent seat reads as
 * "no session fact" instead of crashing the shell.
 * @param props - the slot component's props share.
 * @returns the selector hook, or undefined when no seat was delivered.
 */
export function sessionsSeatOf(props: object): OnboardingSessionsSeat | undefined {
  const seat = (props as Record<string, unknown>)['useSessions']
  return typeof seat === 'function' ? seat as unknown as OnboardingSessionsSeat : undefined
}
