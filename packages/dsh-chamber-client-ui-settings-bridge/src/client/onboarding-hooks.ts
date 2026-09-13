/**
 * React wiring for the `settings.onboarding` coordinator (2026-09-11
 * upstream-alignment T3). The facts and projections live in ./onboarding.ts;
 * this module owns the two subscriptions the shell needs, and it is the only
 * half that reaches the renderer's hook factory (so the pure half stays
 * loadable by plain node tests).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { observableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import {
  ONBOARDING_SLOT, onboardingActive, onboardingSteps,
  type OnboardingLedger, type OnboardingSessionsSeat, type OnboardingSessionsState, type OnboardingStep,
} from './onboarding.ts'

/** Constant-snapshot source behind the absent-seat branch (upstream maybeObservableHook's absentSource). */
const ABSENT_SESSIONS: OnboardingSessionsState = {}
const absentSessionsSource: HostObservable<OnboardingSessionsState> = {
  getSnapshot: () => ABSENT_SESSIONS,
  subscribe: () => () => {},
}

/** Bound selector hook over the absent source: one uSES read that always selects `false`. */
const useAbsentSessions = observableHook(absentSessionsSource)

/**
 * Subscribe one shell to its instance's onboarding readiness fact.
 *
 * Both branches perform exactly one selector-bound uSES read at the same
 * position, so a seat that appears or disappears (a renderer swap) never
 * changes this component's hook sequence — the absent branch reads a constant
 * snapshot instead (upstream's `maybeObservableHook` absentSource pattern).
 * @param seat - the instance's sessions seat, when the renderer delivered one.
 * @returns whether the onboarding stage is active for this instance.
 */
export function useOnboardingActive(seat: OnboardingSessionsSeat | undefined): boolean {
  const hook = seat ?? useAbsentSessions
  return hook(onboardingActive)
}

const EMPTY_STEPS: OnboardingStep[] = []

/**
 * Subscribe one shell to its ctx's onboarding ledger.
 * @param ledger - the ctx's slot registry, or undefined while its face is unpublished.
 * @returns the ordered steps (empty while the slot is undeclared or unregistered).
 */
export function useOnboardingSteps(ledger: OnboardingLedger | undefined): OnboardingStep[] {
  const subscribe = useMemo(
    () => (fn: () => void) => ledger === undefined ? () => {} : ledger.subscribe(ONBOARDING_SLOT, fn),
    [ledger],
  )
  const getVersion = useMemo(
    () => () => ledger === undefined ? 0 : ledger.getVersion(ONBOARDING_SLOT),
    [ledger],
  )
  const version = useSyncExternalStore(subscribe, getVersion)
  return useMemo(() => ledger === undefined ? EMPTY_STEPS : onboardingSteps(ledger), [ledger, version])
}

/**
 * Subscribe one shell to the chamber's active-view fact and report whether it is
 * the shell whose ctx that view is.
 *
 * WHY the stage needs it: the chamber mounts several instance shells at once
 * (the active view, the retained hidden shell, and — while the settings panel is
 * open — the panel's own target), and a first-run dialog is document-global: it
 * portals to the body and holds `#root` inert. An ungated stage would therefore
 * pop another instance's onboarding over the view the user is looking at. The
 * gate is the App-published active-view fact (`chamberBridge.getActiveSource`,
 * the same gate the ui-layout document-theme projection uses for its
 * document-global writes) — an existing chamber fact, not a new channel.
 * Undefined (the App has not published yet) reads as closed: an unjustified
 * modal is worse than one render's delay, and `onActiveSource` re-renders this
 * shell as soon as the App publishes.
 * @param instanceId - this shell's source id, when known.
 * @returns whether this shell's ctx is the view on screen.
 */
export function useActiveView(instanceId: string | undefined): boolean {
  const [active, setActive] = useState(() => chamberBridge.getActiveSource())
  useEffect(() => chamberBridge.onActiveSource(() => { setActive(chamberBridge.getActiveSource()) }), [])
  return instanceId !== undefined && active === instanceId
}
