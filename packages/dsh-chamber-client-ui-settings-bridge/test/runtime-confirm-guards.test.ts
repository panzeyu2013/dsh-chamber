/**
 * Gateway armed-request guard tests (2026-09-11 review-fix F2): plain node, no
 * DOM, no React.
 *
 * The probe that found the hole, replayed end to end: a request armed while the
 * server was idle, a ~3s status poll flipping the gate while the dialog stayed
 * open, and the confirm click. Before the fix the armed request carried only the
 * ARM-time guards, so the accept fired `restore-builtin@phase=installing`; the
 * runners now re-validate against the LIVE facts, and this file pins both the
 * predicates and the machine transition that drops them (see
 * confirm-machine.test.ts for the transition's own contract).
 *
 * The gates themselves come from the shared gateway core
 * (`remoteRuntimeActionGates`), which the section's render uses too — the tests
 * therefore assert the SECTION's wiring decision (which fact is re-read, which
 * captured target is compared), never a second copy of the server matrix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyNowStillValid,
  cleanupVersionStillValid,
  gatewayConfirmGates,
  preRollbackOfferable,
  recoverMetadataStillValid,
  restoreBuiltinStillValid,
  restorePreRollbackStillValid,
  retryApplyStillValid,
  retryRestoreStillValid,
  type GatewayConfirmFacts,
} from '../src/client/runtime-confirm-guards.ts';
import {
  acceptConfirm, armConfirm, IDLE_CONFIRM,
} from '../src/client/confirm-machine.ts';
import type { RemoteRuntimeStatus } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared';

function status(overrides: Partial<RemoteRuntimeStatus> = {}): RemoteRuntimeStatus {
  return {
    kind: 'dsh-chamber-gateway-runtime',
    activeVersion: '1.0.0',
    builtinVersion: '0.9.0',
    currentVersion: '1.0.0',
    selectedVersion: '1.0.0',
    hasOverride: true,
    source: 'builtin-anchor',
    phase: 'idle',
    startupBlockedReason: null,
    pending: null,
    connectionState: 'ready',
    registry: 'https://registry.npmjs.org',
    registryError: null,
    platform: 'darwin',
    mutationsAllowed: true,
    operationError: null,
    restart: null,
    restoreOutcome: null,
    snapshotCount: 0,
    latestSnapshotAt: null,
    snapshotError: null,
    restoreInProgress: false,
    preRollbackCount: 0,
    preRollbackLatestName: null,
    failure: null,
    diskUsage: null,
    diskError: null,
    diskLimitBytes: 10 * 1024 ** 3,
    diskLimitExceeded: false,
    progress: null,
    ...overrides,
  };
}

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
