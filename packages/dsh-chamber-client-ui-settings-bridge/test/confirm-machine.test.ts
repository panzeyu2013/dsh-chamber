/**
 * Armed-confirmation machine tests (2026-09-11 upstream-alignment T2): plain
 * node, no DOM.
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
  type ConfirmState,
} from '../src/client/confirm-machine.ts';

/** One request shaped like the section's RuntimeConfirmRequest, with its action recording one wire call. */
function armedAction(wire: string[], kind: string) {
  return {
    title: `title:${kind}`,
    description: `description:${kind}`,
    confirmLabel: `confirm:${kind}`,
    pendingLabel: `pending:${kind}`,
    run: async (): Promise<void> => { wire.push(kind) },
  };
}

/** The component's launch wiring: start the runner and settle the machine when it ends. */
function launch(run: () => Promise<void>): void {
  void run();
}

test('a fresh machine arms nothing and launches nothing', () => {
  assert.deepEqual(IDLE_CONFIRM, { request: null, pending: false });
  let wire: string[] = [];
  let state: ConfirmState<ReturnType<typeof armedAction>> = IDLE_CONFIRM;
  // Accepting with nothing armed is a no-op, not a crash.
  state = acceptConfirm(state, launch);
  assert.equal(state.request, null);
  assert.deepEqual(wire, []);
  // Cancelling with nothing armed is the same idle state.
  assert.deepEqual(cancelConfirm(state), IDLE_CONFIRM);
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
  state = acceptConfirm(armConfirm(restart), (run) => { settled = run() });
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
  state = acceptConfirm(armConfirm(cleanup), launch);
  assert.equal(state.pending, true);
  assert.deepEqual(wire, ['cleanup-version']);
  assert.equal(state.request, cleanup, 'the armed request stays addressable while pending');
});

test('one accept launches exactly one runner, however many times it is called', () => {
  const wire: string[] = [];
  const apply = armedAction(wire, 'apply-now');
  let state = armConfirm(apply);
  state = acceptConfirm(state, launch);
  // A same-frame double click (and every later click) must not stack a second
  // launch: the accepted state is pending, and accept is a no-op then.
  state = acceptConfirm(state, launch);
  state = acceptConfirm(state, launch);
  assert.deepEqual(wire, ['apply-now']);
  assert.equal(state.pending, true);
});

test('a pending action cannot be cancelled (the dialog is a progress surface)', () => {
  const wire: string[] = [];
  const retry = armedAction(wire, 'retry-apply');
  const pending = acceptConfirm(armConfirm(retry), launch);
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
  state = acceptConfirm(state, launch);
  assert.deepEqual(wire, ['retry-restore'], 'only the armed request runs');
});
