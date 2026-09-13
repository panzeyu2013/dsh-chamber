/**
 * Armed-confirmation machine tests (2026-09-11 upstream-alignment T2; the
 * accept-time re-validation pin added by the 2026-09-11 review, F2): plain node,
 * no DOM.
 *
 * The invariant under test is the one the native `window.confirm` call sites
 * used to encode by construction — a destructive action reaches the wire only
 * after an explicit accept, and a cancel performs NOTHING. The dsh runtime
 * section arms its own gateway mutations and is armed for the shared restart
 * path, so both are exercised here with a fake wire recorder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptConfirm, armConfirm, cancelConfirm, IDLE_CONFIRM,
  type ConfirmRunner, type ConfirmState,
} from '../src/client/confirm-machine.ts';

/** One request shaped like the section's RuntimeConfirmRequest, with its action recording one wire call. */
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
