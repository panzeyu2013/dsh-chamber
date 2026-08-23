/**
 * runtime-state-machine.ts tests (design 16 §3.6) — node:test, pure logic.
 * Covers the full transition table: main chain, probe-fail/rollback-exhausted,
 * reset-builtin, error recovery, terminal judgement, and the terminal gate
 * (pending/applying only reset-builtin).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition, allowedActions, isTerminal } from './runtime-state-machine.ts';
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

test('allowedActions terminal gate: pending/applying only reset-builtin', () => {
  assert.deepEqual(allowedActions('pending'), ['reset-builtin']);
  assert.deepEqual(allowedActions('applying'), ['reset-builtin']);
  assert.deepEqual(allowedActions('downloading'), ['none']);
  assert.deepEqual(allowedActions('installing'), ['none']);
  assert.ok(allowedActions('available').includes('install'));
  assert.ok(allowedActions('error').includes('retry-apply'));
  assert.ok(allowedActions('rollback').includes('select-version'));
  assert.ok(allowedActions('failed').includes('select-version'));
});
