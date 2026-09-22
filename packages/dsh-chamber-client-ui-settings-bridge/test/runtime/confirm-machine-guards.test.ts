/**
 * Armed-confirmation machine + LIVE-fact guard tests: the confirm state machine
 * and the guards that re-validate an armed request at accept time. Plain node, no DOM, no React. The machine's own
 * contract and the section wiring that re-reads live facts before an accept are one
 * contract chain (the guards import the machine).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptConfirm, armConfirm, cancelConfirm, IDLE_CONFIRM, type ConfirmRunner, type ConfirmState } from '../../src/client/confirm-machine.ts';
import { applyNowStillValid, cleanupVersionStillValid, gatewayConfirmGates, preRollbackOfferable, recoverMetadataStillValid, restoreBuiltinStillValid, restorePreRollbackStillValid, retryApplyStillValid, retryRestoreStillValid, type GatewayConfirmFacts } from '../../src/client/runtime-confirm-guards.ts';
import { remoteStatus as status } from '../support/runtime-fixtures.ts';

function armedAction(wire: string[], kind: string, stillValid?: () => boolean) {
  return {
    title: `title:${kind}`,
    description: `description:${kind}`,
    confirmLabel: `confirm:${kind}`,
    pendingLabel: `pending:${kind}`,
    run: async (): Promise<void> => { wire.push(kind) },
    ...(stillValid === undefined ? {} : { stillValid }),
  };
}

/** The component's launch wiring: start the runner and settle the machine when it ends. */
function launch(run: () => Promise<void>): void {
  void run();
}

/** Accept and keep only the next state (the existing transitions' contract). */
function accepted<R extends ConfirmRunner>(
  state: ConfirmState<R>,
  launchRun: (run: () => Promise<void>) => void,
): ConfirmState<R> {
  return acceptConfirm(state, launchRun).state;
}

test('a fresh machine arms nothing and launches nothing', () => {
  assert.deepEqual(IDLE_CONFIRM, { request: null, pending: false });
  let wire: string[] = [];
  let state: ConfirmState<ReturnType<typeof armedAction>> = IDLE_CONFIRM;
  // Accepting with nothing armed is a no-op, not a crash.
  assert.equal(acceptConfirm(state, launch).outcome, 'ignored');
  state = accepted(state, launch);
  assert.equal(state.request, null);
  assert.deepEqual(wire, []);
  // Cancelling with nothing armed is the same idle state.
  assert.deepEqual(cancelConfirm(state), IDLE_CONFIRM);
});

test('F2: an armed request that fails re-validation is dropped WITHOUT running', () => {
  const wire: string[] = [];
  // The probe's shape: armed while the gate was open, and the world moved on
  // before the confirm click — the hook reads the live facts at ACCEPT time.
  let gateOpen = true;
  const request = armedAction(wire, 'restore-builtin', () => gateOpen);
  let state = armConfirm(request);
  assert.deepEqual(wire, [], 'arming never runs the action');
  gateOpen = false;
  const acceptedResult = acceptConfirm(state, launch);
  assert.equal(acceptedResult.outcome, 'dropped');
  assert.deepEqual(acceptedResult.state, IDLE_CONFIRM, 'a dropped request leaves the dialog closed');
  assert.deepEqual(wire, [], 'a stale accept must not reach the wire');

  // The same request, still valid at accept time, runs exactly once.
  gateOpen = true;
  const ok = acceptConfirm(armConfirm(request), launch);
  assert.equal(ok.outcome, 'launched');
  assert.equal(ok.state.pending, true);
  assert.deepEqual(wire, ['restore-builtin']);
});

test('F2: the re-validation hook is consulted at accept time, not at arm time', () => {
  const wire: string[] = [];
  let checks = 0;
  // A hook that flips on its FIRST consultation: if the machine evaluated it
  // while arming (or cached the answer), this accept would launch.
  const request = armedAction(wire, 'apply-now', () => { checks += 1; return false });
  const outcome = acceptConfirm(armConfirm(request), launch);
  assert.equal(outcome.outcome, 'dropped');
  assert.equal(checks, 1, 'the hook is consulted exactly once, by the accept');
  assert.deepEqual(wire, []);
});

test('F2: a request without the hook keeps the plain yes/no contract', () => {
  const wire: string[] = [];
  const request = armedAction(wire, 'retry-apply');
  assert.equal(request.stillValid, undefined);
  const outcome = acceptConfirm(armConfirm(request), launch);
  assert.equal(outcome.outcome, 'launched');
  assert.deepEqual(wire, ['retry-apply']);
});

test('restart path: cancel performs no wire call, confirm performs it', async () => {
  const wire: string[] = [];
  const restart = armedAction(wire, 'restart');
  let state = armConfirm(restart);
  // Armed, not run: opening the dialog must never fire the action.
  assert.equal(state.request, restart);
  assert.equal(state.pending, false);
  assert.deepEqual(wire, []);
  state = cancelConfirm(state);
  assert.deepEqual(state, IDLE_CONFIRM);
  assert.deepEqual(wire, [], 'cancel must not reach the wire');

  // Same request, now accepted: the run is captured so the test can await the
  // wire call itself.
  let settled: Promise<void> | undefined;
  state = accepted(armConfirm(restart), (run) => { settled = run() });
  assert.equal(state.pending, true);
  assert.deepEqual(wire, ['restart'], 'confirm reaches the wire');
  await settled;
  // Settling is the component's own step (the runner's `finally`); the machine's
  // post-settle state is idle and re-armable.
  assert.deepEqual(IDLE_CONFIRM, { request: null, pending: false });
  assert.equal(armConfirm(restart).pending, false);
});

test('gateway mutation path: cancel performs no wire call, confirm performs it', () => {
  const wire: string[] = [];
  const cleanup = armedAction(wire, 'cleanup-version');
  let state = armConfirm(cleanup);
  state = cancelConfirm(state);
  assert.deepEqual(wire, [], 'cancel must not reach the wire');
  state = accepted(armConfirm(cleanup), launch);
  assert.equal(state.pending, true);
  assert.deepEqual(wire, ['cleanup-version']);
  assert.equal(state.request, cleanup, 'the armed request stays addressable while pending');
});

test('one accept launches exactly one runner, however many times it is called', () => {
  const wire: string[] = [];
  const apply = armedAction(wire, 'apply-now');
  let state = armConfirm(apply);
  state = accepted(state, launch);
  // A same-frame double click (and every later click) must not stack a second
  // launch: the accepted state is pending, and accept is a no-op then.
  assert.equal(acceptConfirm(state, launch).outcome, 'ignored');
  state = accepted(state, launch);
  state = accepted(state, launch);
  assert.deepEqual(wire, ['apply-now']);
  assert.equal(state.pending, true);
});

test('a pending action cannot be cancelled (the dialog is a progress surface)', () => {
  const wire: string[] = [];
  const retry = armedAction(wire, 'retry-apply');
  const pending = accepted(armConfirm(retry), launch);
  // Escape / mask / Cancel while running: the state is returned unchanged, so
  // the dialog cannot imply a cancellation that does not exist.
  assert.equal(cancelConfirm(pending), pending);
  assert.deepEqual(wire, ['retry-apply']);
});

test('re-arming replaces the previous request without running it', () => {
  const wire: string[] = [];
  const first = armedAction(wire, 'restore-builtin');
  const second = armedAction(wire, 'retry-restore');
  let state = armConfirm(first);
  state = armConfirm(second);
  assert.equal(state.request, second);
  assert.deepEqual(wire, []);
  state = accepted(state, launch);
  assert.deepEqual(wire, ['retry-restore'], 'only the armed request runs');
});

// The probe: a request armed while the server was idle, a ~3s status poll flipping
// the gate while the dialog stayed open, then the confirm click. The runners
// re-validate against the LIVE facts; these tests pin both the predicates and the
// machine transition that drops them. The gates come from the shared gateway core
// (`remoteRuntimeActionGates`), so they assert the SECTION's wiring decision, never
// a second copy of the server matrix.

/** One live fact snapshot (the section's mirror, as the accept path reads it). */
function facts(overrides: Partial<GatewayConfirmFacts> = {}): GatewayConfirmFacts {
  return { status: status(), busy: false, removableVersions: [], ...overrides };
}

test('F2 probe: the gate closes while the dialog is open → the accept is dropped, not sent', () => {
  const wire: string[] = [];
  // The live facts the section's ref mirror holds (one poll tick apart below).
  const live: { current: GatewayConfirmFacts } = { current: facts() };
  // The request the section arms: same predicate at arm time and at accept time.
  const request = {
    title: 'restore bundled dsh runtime?',
    stillValid: () => restoreBuiltinStillValid(live.current),
    run: async (): Promise<void> => { wire.push('restore-builtin') },
  };
  // 1. armed at phase=idle: the predicate is open and arming runs nothing.
  assert.equal(request.stillValid(), true);
  let machine = armConfirm(request);
  assert.deepEqual(wire, []);
  // 2. the ~3s poll answers with phase=installing: the gate is now closed.
  live.current = facts({ status: status({ phase: 'installing' }) });
  assert.equal(request.stillValid(), false);
  // 3. the user confirms: the machine re-validates and drops the request.
  const accepted = acceptConfirm(machine, (run) => { void run() });
  assert.equal(accepted.outcome, 'dropped');
  assert.deepEqual(accepted.state, IDLE_CONFIRM);
  assert.deepEqual(wire, [], 'a stale accept must not reach the wire');
  // 4. the same dialog with the world still idle does launch (no over-refusal).
  live.current = facts();
  machine = armConfirm(request);
  assert.equal(acceptConfirm(machine, (run) => { void run() }).outcome, 'launched');
  assert.deepEqual(wire, ['restore-builtin']);
});

test('F2: every arm-site predicate follows the LIVE fact, not the arm-time snapshot', () => {
  const idle = facts();
  // restore-builtin / retry-apply / retry-restore / recover-metadata: the gate
  // projection is recomputed from the snapshot each time it is asked.
  assert.equal(restoreBuiltinStillValid(idle), true);
  assert.equal(restoreBuiltinStillValid(facts({ status: status({ phase: 'installing' }) })), false);
  assert.equal(restoreBuiltinStillValid(facts({ status: status({ source: 'env' }) })), false);
  assert.equal(restoreBuiltinStillValid(facts({ busy: true })), false, 'the client busy window counts');
  assert.equal(restoreBuiltinStillValid(facts({ status: null })), false, 'no status yet = no action');

  const swapAttempted = facts({ status: status({ phase: 'swap-attempted' }) });
  assert.equal(retryApplyStillValid(swapAttempted), true);
  assert.equal(retryApplyStillValid(idle), false, 'retry-apply needs its recovery phase');
  assert.equal(retryApplyStillValid(facts({ status: null })), false);

  const restoreBlocked = facts({ status: status({ phase: 'restore-blocked' }) });
  assert.equal(retryRestoreStillValid(restoreBlocked), true);
  assert.equal(retryRestoreStillValid(idle), false);
  assert.equal(retryRestoreStillValid(facts({ status: null })), false);

  const recoverable = facts({ status: status({ canRecoverMetadata: true }) });
  assert.equal(recoverMetadataStillValid(recoverable), true);
  assert.equal(recoverMetadataStillValid(idle), false, 'recover-metadata needs the capability fact');
  assert.equal(recoverMetadataStillValid(facts({ status: null })), false);
});

test('F2: captured targets are re-checked — a stale target never reaches the route', () => {
  // cleanup-version: the captured version must still be a removable candidate.
  const withCandidates = facts({ removableVersions: ['1.1.0', '1.2.0'] });
  assert.equal(cleanupVersionStillValid(withCandidates, '1.1.0'), true);
  assert.equal(cleanupVersionStillValid(facts(), '1.1.0'), false, 'left the candidate list');
  assert.equal(cleanupVersionStillValid(withCandidates, '9.9.9'), false, 'never was a candidate');
  assert.equal(
    cleanupVersionStillValid(facts({ removableVersions: ['1.1.0'], busy: true }), '1.1.0'),
    false,
    'the busy window refuses it too',
  );

  // apply-now: the captured pending version must still be the server's pending one.
  const pending = facts({ status: status({ phase: 'pending', pending: '1.1.0' }) });
  assert.equal(applyNowStillValid(pending, '1.1.0'), true);
  assert.equal(applyNowStillValid(pending, '1.2.0'), false, 'a different pending version');
  assert.equal(applyNowStillValid(facts(), '1.1.0'), false, 'nothing pending any more');
  assert.equal(
    applyNowStillValid(facts({ status: status({ phase: 'pending', pending: '1.1.0' }), busy: true }), '1.1.0'),
    false,
  );

  // restore-pre-rollback: the captured stash must still be the LATEST stash.
  const stash = facts({ status: status({ preRollbackCount: 1, preRollbackLatestName: 'stash-a' }) });
  assert.equal(restorePreRollbackStillValid(stash, 'stash-a'), true);
  assert.equal(
    restorePreRollbackStillValid(facts({ status: status({ preRollbackCount: 2, preRollbackLatestName: 'stash-b' }) }), 'stash-a'),
    false,
    'a newer stash replaced the captured one',
  );
  assert.equal(restorePreRollbackStillValid(facts(), 'stash-a'), false, 'no stash recorded');
  assert.equal(
    restorePreRollbackStillValid(facts({ status: status({ phase: 'installing', preRollbackCount: 1, preRollbackLatestName: 'stash-a' }) }), 'stash-a'),
    false,
    'the row is gone once the phase leaves idle',
  );
});

test('F2: the row-visibility composite and the guard share one definition', () => {
  // preRollbackOfferable is what the section uses to decide whether the row
  // exists at all; the guard adds the mutation gate and the captured name. A row
  // that is not offerable can never be armed or accepted.
  assert.equal(preRollbackOfferable(status({ preRollbackCount: 1, preRollbackLatestName: 'stash-a' })), true);
  assert.equal(preRollbackOfferable(status({ preRollbackCount: 1, preRollbackLatestName: null })), false);
  assert.equal(preRollbackOfferable(status({ preRollbackCount: 0, preRollbackLatestName: 'stash-a' })), false);
  assert.equal(preRollbackOfferable(status({ phase: 'applying', preRollbackCount: 1, preRollbackLatestName: 'stash-a' })), false);
  assert.equal(
    preRollbackOfferable(status({ startupBlockedReason: 'env-probe-failed', preRollbackCount: 1, preRollbackLatestName: 'stash-a' })),
    false,
  );
  // The row keeps its STRICT null test (documented in the guard module): an
  // empty-string reason — which the shared gates read as "not blocked" — hides
  // the row instead of offering it, the conservative direction of the question.
  assert.equal(
    preRollbackOfferable(status({ startupBlockedReason: '', preRollbackCount: 1, preRollbackLatestName: 'stash-a' })),
    false,
  );
  assert.equal(preRollbackOfferable(null), false);
});

test('F2: the re-validation projection is literally the render’s gate function', () => {
  // The section renders its buttons from `remoteRuntimeActionGates(status, busy)`
  // through this same wrapper, so a re-validation can never disagree with the
  // disabled state the user just saw.
  const factsNow = facts({ status: status({ phase: 'applying' }), busy: true });
  const gates = gatewayConfirmGates(factsNow);
  assert.equal(gates.mutationDisabled, true);
  assert.equal(gates.restoreBuiltinDisabled, true);
  assert.equal(gates.restartDisabled, true);
  assert.equal(restoreBuiltinStillValid(factsNow), !gates.restoreBuiltinDisabled);
  assert.equal(retryApplyStillValid(factsNow), !gates.retryApplyDisabled);
  assert.equal(retryRestoreStillValid(factsNow), !gates.retryRestoreDisabled);
  assert.equal(recoverMetadataStillValid(factsNow), !gates.recoverMetadataDisabled);
});
