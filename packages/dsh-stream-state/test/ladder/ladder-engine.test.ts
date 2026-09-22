/**
 * Unified ladder engine - behavior contract.
 *
 * These are the properties the four ladders each implement separately. The
 * point of the engine is that they live in ONE file: a later edit to
 * any ladder must keep these tests green, and the ladders' own values stay inputs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  planLadder,
  sessionLivenessLadder,
  streamHealthLadder,
  mobileStallLadder,
} from '../../src/ladder.ts'
import type { Ladder, LadderObservation } from '../../src/ladder.ts'

const LADDER: Ladder = {
  name: 'test',
  quotaWindowMs: 600000,
  tiers: [
    { name: 'probe', afterMs: 60000, cooldownMs: 200000, quota: 3, requiresStuckEvidence: false },
    { name: 'escalate', afterMs: 190000, cooldownMs: 300000, quota: 1, requiresStuckEvidence: true },
    { name: 'notice', afterMs: 120000, cooldownMs: 0, quota: 1, requiresStuckEvidence: true },
  ],
}

function obs(overrides: Partial<LadderObservation> = {}): LadderObservation {
  return {
    sticky: true,
    symptomSinceMs: 0,
    stuckEvidence: false,
    progressStamp: 0,
    escalationBlocked: false,
    ...overrides,
  }
}

test('the cheapest tier fires first, and only one tier per tick', () => {
  const r = planLadder(LADDER, {}, { a: obs() }, 60000)
  assert.deepEqual(r.actions, [{ sourceId: 'a', tier: 'probe', at: 60000 }])
})

test('silence alone never escalates past the evidence-gated tier', () => {
  // Three probe windows elapse with no stuck evidence: only probes fire.
  let records = {}
  const fireTimes = [60000, 260000, 460000, 660000]
  const fired = []
  for (const at of fireTimes) {
    const r = planLadder(LADDER, records, { a: obs() }, at)
    records = r.records
    fired.push(...r.actions.map((action) => action.tier))
  }
  assert.ok(fired.every((tier) => tier === 'probe'), 'no escalation on time alone: ' + fired.join(','))
})

test('stuck evidence unlocks the escalation tier once its own delay elapsed', () => {
  const r = planLadder(LADDER, {}, { a: obs({ stuckEvidence: true }) }, 190000)
  // The probe is cheaper and due first, so the ladder still starts there -
  // escalating immediately would skip the read-only step the discipline relies on.
  assert.deepEqual(r.actions, [{ sourceId: 'a', tier: 'probe', at: 190000 }])
  // One ms later the READ-ONLY probe is still cooling down, so the ladder steps up:
  // that is the whole point of gating a tier on evidence rather than on silence.",
  const afterProbe = planLadder(LADDER, r.records, { a: obs({ stuckEvidence: true }) }, 190001)
  assert.deepEqual(afterProbe.actions, [{ sourceId: 'a', tier: 'escalate', at: 190001 }], 'evidence unlocks the next tier as soon as the cheaper one is unavailable')
})

test('a tier observes its cooldown and its quota window', () => {
  const ladder: Ladder = {
    name: 'quota',
    quotaWindowMs: 600000,
    tiers: [{ name: 'probe', afterMs: 0, cooldownMs: 0, quota: 2, requiresStuckEvidence: false }],
  }
  let records = {}
  const fired = []
  // Ten attempts inside one window: the quota caps the dispatches at two.
  for (let i = 0; i < 10; i += 1) {
    const r = planLadder(ladder, records, { a: obs() }, 1000 * i)
    records = r.records
    fired.push(...r.actions)
  }
  assert.equal(fired.length, 2, 'quota must cap the dispatches')
  // Outside the window the quota refills.
  const later = planLadder(ladder, records, { a: obs() }, 1000000)
  assert.equal(later.actions.length, 1)
})

test('a blocked escalation is suppressed WITHOUT consuming its quota', () => {
  let records = planLadder(LADDER, {}, { a: obs() }, 60000).records
  // Blocked at the escalation tier's due time: nothing dispatches, quota untouched.
  const blocked = planLadder(LADDER, records, { a: obs({ stuckEvidence: true, escalationBlocked: true }) }, 190001)
  assert.deepEqual(blocked.actions, [])
  records = blocked.records
  // Unblocked at the same moment still fires the escalation tier once.
  const unblocked = planLadder(LADDER, records, { a: obs({ stuckEvidence: true }) }, 200000)
  assert.deepEqual(unblocked.actions, [{ sourceId: 'a', tier: 'escalate', at: 200000 }])
})

test('at most one escalation per source per tick', () => {
  const r = planLadder(LADDER, {}, { a: obs({ stuckEvidence: true }) }, 999999)
  assert.ok(r.actions.length <= 1, 'correlated multi-lever dispatch must not happen')
})

test('progress resets the escalation clock even while the symptom persists', () => {
  const records = planLadder(LADDER, {}, { a: obs() }, 60000).records
  assert.ok(records.a !== undefined)
  // The watch saw real advance at t=60001, but the symptom (e.g. a session that still
  // claims to be running) is still present. The streak must re-base at 60001 so the
  // next tier needs a full delay again - not inherit the 60s already spent.
  const advanced = planLadder(LADDER, records, {
    a: obs({ progressStamp: 5, symptomSinceMs: 60001, stuckEvidence: true }),
  }, 60001)
  assert.deepEqual(advanced.actions, [], 'the reset clock is below every tier')
  assert.equal(advanced.records.a?.symptomSinceMs, 60001, 'the clock re-based on progress')
  // One tier delay later (60s after the re-base) the probe is due again, and NOT the
  // escalation tier: progress must not fast-forward the ladder.
  const later = planLadder(LADDER, advanced.records, {
    a: obs({ progressStamp: 5, symptomSinceMs: 60001, stuckEvidence: true }),
  }, 120001)
  assert.deepEqual(later.actions, [{ sourceId: 'a', tier: 'probe', at: 120001 }])
})

test('a symptom that stopped drops the record entirely', () => {
  const records = planLadder(LADDER, {}, { a: obs() }, 60000).records
  const clean = planLadder(LADDER, records, { a: obs({ sticky: false }) }, 70000)
  assert.equal(clean.records.a, undefined)
})

test('exhaustion is reported only after every lever spent its quota', () => {
  const ladder: Ladder = {
    name: 'single',
    quotaWindowMs: 600000,
    tiers: [{ name: 'probe', afterMs: 0, cooldownMs: 0, quota: 1, requiresStuckEvidence: false }],
  }
  const first = planLadder(ladder, {}, { a: obs() }, 0)
  assert.deepEqual(first.exhausted, [], 'one lever still available')
  const second = planLadder(ladder, first.records, { a: obs() }, 10)
  assert.deepEqual(second.actions, [])
  assert.deepEqual(second.exhausted, ['a'], 'nothing left: the caller must surface')
})

test('the three instantiated ladders keep their owners values', () => {
  const liveness = sessionLivenessLadder({
    refreshAfterMs: 60000,
    refreshCoalesceMs: 200000,
    maxRefreshRequests: 3,
    refreshWindowMs: 600000,
    refreshOutcomeTimeoutMs: 190000,
    reconnectBackoffMs: 300000,
    maxReconnects: 1,
    noticeAfterMs: 120000,
  })
  assert.deepEqual(liveness.tiers.map((tier) => tier.name), ['refresh', 'reconnect', 'notice'])
  assert.equal(liveness.tiers[1]?.requiresStuckEvidence, true, 'reconnect needs a failed reconcile, not silence')
  assert.equal(liveness.tiers[1]?.quota, 1)
  const health = streamHealthLadder({
    errorGraceMs: 8000,
    loadingStallMs: 20000,
    healCooldownMs: 120000,
    healBudgetWindowMs: 600000,
    healBudgetMax: 3,
  })
  assert.deepEqual(health.tiers.map((tier) => tier.name), ['heal', 'auto-resync'])
  assert.equal(health.tiers[0]?.afterMs, 8000)
  const mobile = mobileStallLadder({ thresholdMs: 45000, cooldownMs: 120000, windowMs: 600000, max: 3 })
  assert.deepEqual(mobile.tiers.map((tier) => tier.name), ['resync'])
  assert.equal(mobile.tiers[0]?.afterMs, 45000, 'the mobile copy keeps its own (uncalibrated) number for now')
})
