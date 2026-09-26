/**
 * Page recovery streak evidence (single source for the ladder's symptom start).
 *
 * The page content-stall producer was deleted: the gateway facts cursor never
 * advances on assistant text, so it could not observe content and only mislabelled
 * a dead facts channel. What remains here is the pure streak/anchor logic used by
 * the open, schedule and input symptoms; the fork's per-session journal watchdog is
 * the only real content observer and it acts on its own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDeliverySymptoms } from '@dsh-chamber/dsh-stream-state'
import {
  activeSymptomSinceMs,
  advanceContentStallStreak,
  openStallSymptomActive,
  stuckEvidenceForStreak,
  upperTierStallEvidence,
} from '../../src/session-content-stall.ts'

test('a streak anchors the observer duration in the page monotonic clock', () => {
  assert.equal(advanceContentStallStreak(null, 's1', undefined, 10_000), null, 'no evidence = no streak')
  const first = advanceContentStallStreak(null, 's1', 5_000, 10_000)!
  assert.deepEqual(first, { sessionId: 's1', start: 5_000 })
  assert.equal(advanceContentStallStreak(first, 's1', 7_000, 12_000), first,
    'a sample within the same streak keeps its original start')
  assert.deepEqual(advanceContentStallStreak(first, 's2', 1_000, 12_000), { sessionId: 's2', start: 11_000 },
    'a seat switch replaces the single slot and re-anchors')
})

test('the symptom start is the earliest ACTIVE streak, never a stale open since', () => {
  assert.equal(activeSymptomSinceMs({ openSince: 9_000, openStallActive: false }), 9_000,
    'fallback is the open clock')
  assert.equal(activeSymptomSinceMs({
    openSince: 9_000, openStallActive: false, scheduleStallStart: 4_000, inputBlockStart: 6_000,
  }), 4_000, 'the earliest desktop streak wins')
  assert.equal(activeSymptomSinceMs({
    openSince: 9_000, openStallActive: true, scheduleStallStart: 4_000,
  }), 4_000, 'an active open stall participates with its own since')
})

test('tried evidence is keyed by the streak start, not by time alone', () => {
  assert.equal(stuckEvidenceForStreak({ streakStart: undefined, resyncDispatchedFor: 5 }), false)
  assert.equal(stuckEvidenceForStreak({ streakStart: 5, resyncDispatchedFor: 5 }), true)
  assert.equal(stuckEvidenceForStreak({ streakStart: 6, resyncDispatchedFor: 5 }), false,
    'a new streak cannot inherit the previous conclusion')
})

test('an open-stall alone never authorizes the upper delivery tiers', () => {
  // A page-dispatched resync for an open streak is NOT independent evidence:
  // DELIVERY_EFFICACY budgets instance-reboot/document-reload against a stalled
  // frame counter, and a parked OPEN proves the counter is still advancing. Without
  // one, the ladder exhausts at resync and the visible host-stall notice.
  assert.equal(upperTierStallEvidence({ streakStart: 5, resyncDispatchedFor: 5 }), false)
  assert.equal(upperTierStallEvidence({ scheduleStallStart: 1, streakStart: 5, resyncDispatchedFor: 5 }), true)
  assert.equal(upperTierStallEvidence({ inputBlockStart: 1, streakStart: 5, resyncDispatchedFor: 5 }), true)
  assert.equal(upperTierStallEvidence({ scheduleStallStart: 1, streakStart: 6, resyncDispatchedFor: 5 }), false,
    'independent evidence without a survived resync for this streak is not enough either')
})

test('the open-stall shape agrees with the shared classifier', () => {
  const loading = { state: 'loading' as const, openInFlight: false, resyncInFlight: false, resyncAvailable: true }
  assert.equal(openStallSymptomActive(loading), true)
  assert.ok(classifyDeliverySymptoms({ sessionId: '', open: loading, symptomSinceMs: 0 }).includes('open-stall'))
  assert.equal(openStallSymptomActive({ ...loading, openInFlight: true }), false,
    'an open still in flight is never a parked-loading symptom')
  assert.equal(openStallSymptomActive({ ...loading, openInFlight: undefined }), false,
    'an unreadable liveness bit fails closed')
  assert.equal(openStallSymptomActive({ ...loading, resyncInFlight: true }), true,
    'an in-flight recovery is still a stall: the shape must not clear on it')
  assert.equal(openStallSymptomActive({ ...loading, state: 'open' }), false)
  const unhealableError = {
    state: 'error' as const, openInFlight: false, resyncInFlight: false,
    resyncAvailable: true, healRoute: false,
  }
  assert.equal(openStallSymptomActive(unhealableError), true,
    "an error the header cannot heal is the page's own open-stall")
  assert.equal(openStallSymptomActive({ ...unhealableError, healRoute: true }), false,
    'a healable error stays with the header arm and must not spend the page ledger')
  assert.equal(openStallSymptomActive(undefined), false)
  assert.equal(openStallSymptomActive(null), false)
})
