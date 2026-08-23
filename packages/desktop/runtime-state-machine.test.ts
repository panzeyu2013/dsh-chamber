/**
 * runtime-state-machine.ts tests (design 18 §3.6) — node:test, pure logic.
 * Covers the full transition table: main chain, probe-fail/rollback-exhausted,
 * reset-builtin, error recovery, terminal judgement, and the terminal gate
 * (pending only reset-builtin; applying is an atomic critical section).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition, transitionLifecycleProjection, allowedActions, isTerminal } from './runtime-state-machine.ts';
import type { RuntimePhase } from './runtime-state-machine.ts';

test('main chain: idle → checking → available → installing → pending → applying → applied → checking', () => {
  let s: RuntimePhase = 'idle';
  s = transition(s, { type: 'check' });
  assert.equal(s, 'checking');
  s = transition(s, { type: 'check-done', available: true });
  assert.equal(s, 'available');
  s = transition(s, { type: 'install-confirm' });
  assert.equal(s, 'installing');
  s = transition(s, { type: 'install-done' });
  assert.equal(s, 'pending');
  s = transition(s, { type: 'apply-start' });
  assert.equal(s, 'applying');
  s = transition(s, { type: 'probe-pass' });
  assert.equal(s, 'applied');
  s = transition(s, { type: 'check' });
  assert.equal(s, 'checking');
});

test('check-done available:false → idle (no new version)', () => {
  assert.equal(transition('checking', { type: 'check-done', available: false }), 'idle');
});

test('probe-fail → rollback ; rollback-exhausted → failed', () => {
  assert.equal(transition('applying', { type: 'probe-fail' }), 'rollback');
  assert.equal(transition('applying', { type: 'rollback-exhausted' }), 'failed');
});

test('reset-builtin from pending/applying/applied/rollback/failed/error → idle', () => {
  for (const s of ['pending', 'applying', 'applied', 'rollback', 'failed', 'error'] as const) {
    assert.equal(transition(s, { type: 'reset-builtin' }), 'idle');
  }
});

test('error reachable from any state ; error → check → checking', () => {
  assert.equal(transition('idle', { type: 'error' }), 'error');
  assert.equal(transition('applying', { type: 'error' }), 'error');
  assert.equal(transition('error', { type: 'check' }), 'checking');
});

test('invalid combos absorb (no state change)', () => {
  assert.equal(transition('idle', { type: 'install-done' }), 'idle');
  assert.equal(transition('pending', { type: 'probe-pass' }), 'pending');
  assert.equal(transition('checking', { type: 'apply-start' }), 'checking');
});

test('isTerminal: rollback/failed terminal, applied not', () => {
  assert.equal(isTerminal('rollback'), true);
  assert.equal(isTerminal('failed'), true);
  assert.equal(isTerminal('applied'), false);
  assert.equal(isTerminal('pending'), false);
});

test('allowedActions is the complete privileged action matrix', () => {
  assert.deepEqual(allowedActions('pending'), ['reset-builtin']);
  assert.deepEqual(allowedActions('applying'), ['reset-builtin']);
  assert.deepEqual(allowedActions('checking'), []);
  assert.deepEqual(allowedActions('downloading'), []);
  assert.deepEqual(allowedActions('installing'), []);
  assert.ok(allowedActions('idle').includes('install'));
  assert.ok(allowedActions('available').includes('install'));
  assert.ok(allowedActions('error').includes('check'));
  assert.ok(allowedActions('applied').includes('install'));
  assert.ok(allowedActions('rollback').includes('select-version'));
  assert.ok(allowedActions('failed').includes('select-version'));
  assert.deepEqual(allowedActions('snapshot-failed', { canRetryApply: true }), ['retry-apply', 'reset-builtin']);
  assert.ok(allowedActions('failed', { canRetryApply: true }).includes('retry-apply'));
  assert.ok(allowedActions('failed', { canRetryRestore: true }).includes('retry-restore'));
  assert.equal(allowedActions('failed', { canRetryRestore: true, canRecoverMetadata: true }).includes('recover-metadata'), false);
  assert.equal(allowedActions('idle', { canRecoverMetadata: true })[0], 'recover-metadata');
  assert.equal(allowedActions('failed', { canRecoverMetadata: true })[0], 'recover-metadata');
  assert.ok(allowedActions('idle').includes('cleanup-version'));
});

test('privileged lifecycle projection accepts startup/apply outcomes and reset completion', () => {
  assert.equal(transitionLifecycleProjection('idle', 'applying'), 'applying');
  assert.equal(transitionLifecycleProjection('applying', 'applied'), 'applied');
  assert.equal(transitionLifecycleProjection('applying', 'rollback'), 'rollback');
  assert.equal(transitionLifecycleProjection('applying', 'failed'), 'failed');
  assert.equal(transitionLifecycleProjection('snapshot-failed', 'applying'), 'applying', 'explicit snapshot retry');
  assert.equal(transitionLifecycleProjection('applying', 'idle'), 'idle', 'verified reset-builtin completion');
  assert.equal(transitionLifecycleProjection('error', 'idle'), 'idle', 'successful disk-maintenance recovery');
});

test('privileged lifecycle projection absorbs stale or impossible edges', () => {
  assert.equal(transitionLifecycleProjection('checking', 'rollback'), 'checking');
  assert.equal(transitionLifecycleProjection('installing', 'failed'), 'installing');
  assert.equal(transitionLifecycleProjection('idle', 'applied'), 'idle');
});
