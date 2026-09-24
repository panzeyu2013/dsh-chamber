/**
 * React wiring for the `settings.onboarding` coordinator (facts and projections in
 * ./onboarding.ts): it owns the two subscriptions the shell needs and is the only
 * half reaching the renderer's hook factory, so the pure half stays node-loadable.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { observableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core'
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

const useAbsentSessions = observableHook(absentSessionsSource)

/**
 * Subscribe one shell to its instance's onboarding readiness fact.
 *
 * Both branches perform exactly one selector-bound uSES read at the same position,
 * so a seat that appears or disappears (a renderer swap) never changes this
 * component's hook sequence — the absent branch reads a constant snapshot instead.
 */
export function useOnboardingActive(seat: OnboardingSessionsSeat | undefined): boolean {
  const hook = seat ?? useAbsentSessions
  return hook(onboardingActive)
}

const EMPTY_STEPS: OnboardingStep[] = []

/**
 * Subscribe one shell to its ctx's onboarding ledger.
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
 * Subscribe one shell to the chamber's active-view fact and report whether it is the
 * shell whose ctx that view is.
 *
 * WHY: the chamber mounts several instance shells at once, and a first-run dialog is
 * document-global (portals to the body, holds `#root` inert), so an ungated stage
 * would pop another instance's onboarding over the view on screen. The gate is the
 * App-published active-view fact (`chamberBridge.getActiveSource`) — an existing
 * chamber fact, not a new channel. Undefined (not yet published) reads as closed: an
 * unjustified modal is worse than one render's delay, and `onActiveSource` re-renders
 * this shell as soon as the App publishes.
 */
export function useActiveView(instanceId: string | undefined): boolean {
  const [active, setActive] = useState(() => chamberBridge.getActiveSource())
  useEffect(() => chamberBridge.onActiveSource(() => { setActive(chamberBridge.getActiveSource()) }), [])
  return instanceId !== undefined && active === instanceId
}
