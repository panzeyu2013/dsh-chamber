import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authRecoveryDecision } from '../../auth-recovery-policy.ts'

test('a first auth failure recovers now', () => {
  assert.deepEqual(authRecoveryDecision(1_000, 0, 5_000), { action: 'now', delayMs: 0 })
})

test('a failure inside the window is deferred to its edge, never dropped', () => {
  assert.deepEqual(authRecoveryDecision(6_000, 5_000, 5_000), { action: 'defer', delayMs: 4_000 })
  // Exactly at the edge the window is over.
  assert.deepEqual(authRecoveryDecision(10_000, 5_000, 5_000), { action: 'now', delayMs: 0 })
})

test('a backwards clock waits a whole window instead of spinning', () => {
  assert.deepEqual(authRecoveryDecision(1_000, 9_000, 5_000), { action: 'defer', delayMs: 5_000 })
})

test('a non-finite clock never blocks the recovery', () => {
  assert.deepEqual(authRecoveryDecision(Number.NaN, 5_000, 5_000), { action: 'now', delayMs: 0 })
  assert.deepEqual(authRecoveryDecision(1_000, Number.NaN, 5_000), { action: 'now', delayMs: 0 })
})
