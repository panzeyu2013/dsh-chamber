/**
 * Idle-eviction policy (P2, 2026-11) unit tests — pure Node: the policy is a
 * dependency-free module so the 15min/10min boundaries are pinned here (the
 * App.tsx scan just applies it).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isIdleEvictable, isWithinCooldown, type EvictionFacts } from './eviction-policy.ts'

const MIN = 60_000

test('isIdleEvictable: never evicts before settling or before the idle window', () => {
  const now = 1_000_000
  const base = { now, idleEvictMs: 15 * MIN, isActiveView: false, facts: undefined }
  assert.equal(isIdleEvictable({ ...base, settledAt: undefined }), false, 'unsettled (booting) view is not evictable')
  assert.equal(isIdleEvictable({ ...base, settledAt: now - 15 * MIN + 1 }), false, 'one ms before the window is not evictable')
  assert.equal(isIdleEvictable({ ...base, settledAt: now - 15 * MIN }), true, 'exactly at the window IS evictable')
  assert.equal(isIdleEvictable({ ...base, settledAt: now - 20 * MIN }), true, 'past the window is evictable')
})

test('isIdleEvictable: active view and running/pending sessions block eviction (design 19 §3.2)', () => {
  const now = 1_000_000
  const base = { settledAt: now - 20 * MIN, now, idleEvictMs: 15 * MIN, isActiveView: false, facts: undefined }
  assert.equal(isIdleEvictable({ ...base, isActiveView: true }), false, 'the active view is never evicted')
  const running: EvictionFacts = { sessions: { s1: { running: true } } }
  assert.equal(isIdleEvictable({ ...base, facts: running }), false, 'a running session blocks eviction')
  const pending: EvictionFacts = { sessions: { s1: { pending: 'question' } } }
  assert.equal(isIdleEvictable({ ...base, facts: pending }), false, 'a pending session blocks eviction')
  const idle: EvictionFacts = { sessions: { s1: { completed: true }, s2: {} } }
  assert.equal(isIdleEvictable({ ...base, facts: idle }), true, 'completed/empty sessions do not block')
  assert.equal(isIdleEvictable({ ...base, facts: { sessions: {} } }), true, 'empty facts do not block')
})

test('isWithinCooldown: evicted ids stay out of prewarm until the cooldown expires', () => {
  const now = 1_000_000
  const cooldownMs = 10 * MIN
  assert.equal(isWithinCooldown(undefined, now, cooldownMs), false, 'never-evicted ids are never in cooldown')
  assert.equal(isWithinCooldown(now - 10 * MIN + 1, now, cooldownMs), true, 'one ms before expiry is in cooldown')
  assert.equal(isWithinCooldown(now - 10 * MIN, now, cooldownMs), false, 'exactly at expiry is eligible again')
  assert.equal(isWithinCooldown(now - 20 * MIN, now, cooldownMs), false, 'past expiry is eligible')
})
