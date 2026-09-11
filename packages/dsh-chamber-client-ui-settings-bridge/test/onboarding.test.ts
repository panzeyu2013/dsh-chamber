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
  onboardingStage,
  onboardingSteps,
  ONBOARDING_SLOT,
  sessionsSeatOf,
  type OnboardingLedger,
  type OnboardingSessionsState,
  type OnboardingStage,
  type OnboardingStageInput,
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

// ---- F1 (2026-09-11 review): the two axes of the stage ----
//
// The probe that found the two-axis bug, replayed against the pure projection:
// mount(blank, local) → welcome-notice; complete it → deepseek-official; switch
// the view to another source; switch back → welcome-notice used to mount AGAIN
// while the session was still blank, because the reset was derived from the
// COMPOSITE (sessions AND active view) instead of upstream's sessions fact.

/** The two shipped steps, in ledger order (welcome-notice first). */
const SHIPPED_STEPS = onboardingSteps(ledger([
  { id: 'welcome-notice', order: -100 },
  { id: 'deepseek-official', order: 0 },
]));

/** One derivation with the probe's coordinates. */
function stageWith(overrides: Partial<OnboardingStageInput>): OnboardingStage {
  return onboardingStage({
    steps: SHIPPED_STEPS,
    completed: new Set<string>(),
    sessionsActive: true,
    inActiveView: true,
    ...overrides,
  });
}

test('F1 probe: a view switch keeps the completed set, so an acknowledged step stays acknowledged', () => {
  // 1. mount(blank session, active view): the first ordered step mounts.
  assert.deepEqual(stageWith({}), { step: { id: 'welcome-notice', order: -100 }, resetsCompleted: false });
  // 2. the user completes it — the session is STILL blank (both shipped steps
  //    complete while it is), so the stage hands over to the next entry.
  const completed = new Set(['welcome-notice']);
  assert.equal(stageWith({ completed }).step?.id, 'deepseek-official');
  // 3. the view switches to another source: nothing mounts (the composite gate),
  //    and crucially the run has NOT ended — no reset.
  const away = stageWith({ completed, inActiveView: false });
  assert.equal(away.step, undefined, 'a hidden shell mounts no step');
  assert.equal(away.resetsCompleted, false, 'a view switch must not wipe acknowledgements');
  // 4. back to this source: the acknowledged step must NOT re-mount; the stage
  //    resumes where it was (the deferred credential dialog would genuinely
  //    re-open otherwise).
  const back = stageWith({ completed });
  assert.equal(back.step?.id, 'deepseek-official', 'the acknowledged step must not re-mount');
  assert.equal(back.resetsCompleted, false);
  // 5. every step acknowledged → the stage ends, and stays ended across a view
  //    switch (the run is still the same run).
  const all = new Set(['welcome-notice', 'deepseek-official']);
  assert.equal(stageWith({ completed: all }).step, undefined);
  assert.equal(stageWith({ completed: all, inActiveView: false }).step, undefined);
});

test('F1: the reset follows the sessions fact alone (a real new run starts the stage over)', () => {
  // The sessions fact going false IS upstream's end-of-run signal: the set is
  // dropped, so the next blank session mounts the first step again.
  const completed = new Set(['welcome-notice', 'deepseek-official']);
  const ended = stageWith({ completed, sessionsActive: false });
  assert.equal(ended.step, undefined, 'no step mounts outside a blank/absent session');
  assert.equal(ended.resetsCompleted, true, 'the sessions fact alone ends the run');
  // …and an end-of-run that happens while this ctx is NOT the view still resets
  // (mounting waits for the view, the reset does not).
  assert.equal(stageWith({ completed, sessionsActive: false, inActiveView: false }).resetsCompleted, true);
  // A run that ENDS and restarts with the view on another source resets too —
  // the reset is never gated on the active-view axis.
  const fresh = stageWith({ completed: new Set() });
  assert.equal(fresh.step?.id, 'welcome-notice');
});

test('F1: mounting is the CONJUNCTION of both axes, never their disjunction', () => {
  // `||` would mount a hidden shell's stage (the exact failure the active-view
  // gate exists to prevent) and would mount outside a blank session.
  assert.equal(stageWith({ inActiveView: false }).step, undefined, 'hidden shell mounts nothing');
  assert.equal(stageWith({ sessionsActive: false }).step, undefined, 'non-blank run mounts nothing');
  assert.equal(stageWith({ sessionsActive: false, inActiveView: false }).step, undefined);
  assert.equal(stageWith({}).step?.id, 'welcome-notice', 'both axes true mounts the first incomplete step');
});
