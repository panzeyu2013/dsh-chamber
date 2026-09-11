/**
 * `settings.onboarding` coordinator tests (2026-09-11 upstream-alignment T3):
 * pure facts only, no DOM, no renderer. The stage mounts exactly one ordered
 * step, and only while the instance's current session is blank or absent —
 * upstream's readiness selector, verbatim.
 *
 * The React wiring (`onboarding-hooks.ts`, which imports the renderer's hook
 * factory) is pinned by the source-text locks in
 * `upstream-alignment-locks.test.ts`; the truth table and the projection are
 * asserted here for real.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextOnboardingStep,
  onboardingActive,
  onboardingSteps,
  ONBOARDING_SLOT,
  sessionsSeatOf,
  type OnboardingLedger,
  type OnboardingSessionsState,
} from '../src/client/onboarding.ts';

/** Ledger fake: one list of entries plus the version counters a registry keeps. */
function ledger(entries: Array<{ id?: string; order?: number }>): OnboardingLedger {
  return {
    entries: key => key === ONBOARDING_SLOT ? entries.map(options => ({ options })) : [],
    getVersion: () => 0,
    subscribe: () => () => {},
  };
}

test('readiness: the session store must be live before any step mounts', () => {
  const cases: Array<[OnboardingSessionsState, boolean]> = [
    // Blank or absent current session, store ready — the first-run states.
    [{ phase: 'ready' }, true],
    [{ phase: 'ready', current: 's1', byId: { s1: { blank: true } } }, true],
    // Ready with a real (non-blank) current session: the user has content.
    [{ phase: 'ready', current: 's1', byId: { s1: { blank: false } } }, false],
    // A current id the store does not know is NOT blank (upstream `?.blank === true`).
    [{ phase: 'ready', current: 's1', byId: {} }, false],
    // The store is not live: unknown, never "blank" — no step mounts.
    [{ phase: 'loading' }, false],
    [{}, false],
    [{ phase: 'ready', current: 's1' }, false],
  ];
  for (const [state, expected] of cases) {
    assert.equal(onboardingActive(state), expected, JSON.stringify(state));
  }
});

test('projection: steps come out ordered, ties keep ledger sequence', () => {
  assert.deepEqual(
    onboardingSteps(ledger([
      { id: 'deepseek-official', order: 0 },
      { id: 'welcome-notice', order: -100 },
      { id: 'tie' },
    ])),
    [
      { id: 'welcome-notice', order: -100 },
      { id: 'deepseek-official', order: 0 },
      { id: 'tie', order: 0 },
    ],
  );
  // An undeclared (or unregistered) slot projects to nothing — the coordinator
  // then mounts nothing at all.
  assert.deepEqual(onboardingSteps(ledger([])), []);
});

test('coordinator: mounts the FIRST ordered step that is not completed', () => {
  const steps = onboardingSteps(ledger([
    { id: 'welcome-notice', order: -100 },
    { id: 'deepseek-official', order: 0 },
  ]));
  assert.equal(nextOnboardingStep(steps, new Set())?.id, 'welcome-notice');
  // Completing the first hands ownership to the next entry in the same run.
  assert.equal(nextOnboardingStep(steps, new Set(['welcome-notice']))?.id, 'deepseek-official');
  // Every step completed → nothing mounts (the stage ends).
  assert.equal(nextOnboardingStep(steps, new Set(['welcome-notice', 'deepseek-official'])), undefined);
  // A step that left the ledger cannot hold the stage back.
  assert.equal(nextOnboardingStep(steps, new Set(['welcome-notice', 'gone']))?.id, 'deepseek-official');
  assert.equal(nextOnboardingStep([], new Set()), undefined);
});

test('seat narrowing: only a delivered function counts as the sessions seat', () => {
  const seat = <S,>(selector: (state: OnboardingSessionsState) => S): S =>
    selector({ phase: 'ready' });
  assert.equal(sessionsSeatOf({ useSessions: seat }), seat);
  // Absent or non-function members read as "no session fact" — the stage stays
  // closed instead of crashing the shell on a foreign props share.
  assert.equal(sessionsSeatOf({}), undefined);
  assert.equal(sessionsSeatOf({ useSessions: undefined }), undefined);
  assert.equal(sessionsSeatOf({ useSessions: 'ready' }), undefined);
  assert.equal(sessionsSeatOf({ useSessions: null }), undefined);
});
