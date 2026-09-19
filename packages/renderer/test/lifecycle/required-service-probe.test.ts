/**
 * The required-service probe's pure bookkeeping (required-extra-rows.ts):
 * monotonic clock selection (2026-12 FIX 2) and per-member grace + bounded
 * re-check windows (2026-12 FIX 1/FIX 4).
 *
 * The probe's TIMER wiring lives in chamber-entry.ts (not importable by this
 * runner) and is pinned by required-extra-rows.test.ts's source-text locks; the
 * decisions that can be wrong on their own are pure and live here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  monotonicNowMs,
  RequiredServiceProbeWindows,
  REQUIRED_SERVICE_PROBE_DEADLINE_MS,
  REQUIRED_SERVICE_PROBE_INTERVAL_MS,
  REQUIRED_SERVICE_PROBE_RECHECK_WINDOW_MS,
} from '../../src/required-extra-rows.ts'

test('monotonicNowMs: uses the host clock when present, falls back to the wall clock', () => {
  assert.equal(monotonicNowMs({ now: () => 1234.5 }), 1234.5)
  const before = Date.now()
  const wall = monotonicNowMs({})
  const after = Date.now()
  assert.ok(wall >= before && wall <= after, 'without a performance source the wall clock is the fallback')
})

test('the probe constants keep the documented shape', () => {
  assert.equal(REQUIRED_SERVICE_PROBE_INTERVAL_MS, 250)
  assert.equal(REQUIRED_SERVICE_PROBE_DEADLINE_MS, 5000)
  assert.equal(REQUIRED_SERVICE_PROBE_RECHECK_WINDOW_MS, 30_000)
})

test('every member gets its OWN deadline: a re-armed roster member is never judged with zero grace (FIX 4)', () => {
  const windows = new RequiredServiceProbeWindows()
  windows.note(['a'], 0)
  assert.deepEqual(windows.withinGrace(['a'], REQUIRED_SERVICE_PROBE_DEADLINE_MS - 1), ['a'])
  assert.deepEqual(windows.withinGrace(['a'], REQUIRED_SERVICE_PROBE_DEADLINE_MS), [], 'the window is a full deadline long')
  // The deferred cluster's re-arm adds `b` at t=30s: it starts its OWN full
  // window instead of inheriting `a`'s long-elapsed one (the old bug judged it
  // on the very next pass).
  windows.note(['a', 'b'], 30_000)
  assert.deepEqual(windows.withinGrace(['a', 'b'], 30_000), ['b'])
  assert.deepEqual(windows.withinGrace(['a', 'b'], 30_000 + REQUIRED_SERVICE_PROBE_DEADLINE_MS - 1), ['b'])
  assert.deepEqual(windows.withinGrace(['a', 'b'], 30_000 + REQUIRED_SERVICE_PROBE_DEADLINE_MS), [])
  // Re-noting an already-seen member must NOT restart its window: the probe
  // notes the roster on every pass, and restarting would defer a real verdict
  // forever.
  windows.note(['a'], 40_000)
  assert.deepEqual(windows.withinGrace(['a'], 40_000), [])
})

test('an unknown member counts as still in grace (fail toward waiting, never an instant verdict)', () => {
  const windows = new RequiredServiceProbeWindows()
  // The probe calls note() before withinGrace(), so this is a defensive shape;
  // a member nobody has seen yet must not be judged.
  assert.deepEqual(windows.withinGrace(['unseen'], 10 ** 9), ['unseen'])
})

test('the bounded re-check ends at the newest member deadline + the revocation window (FIX 1)', () => {
  const windows = new RequiredServiceProbeWindows()
  assert.equal(windows.recheckUntilMs(), undefined, 'nothing probed yet → no bound to compute')
  windows.note(['a'], 0)
  assert.equal(
    windows.recheckUntilMs(),
    REQUIRED_SERVICE_PROBE_DEADLINE_MS + REQUIRED_SERVICE_PROBE_RECHECK_WINDOW_MS,
  )
  windows.note(['a', 'b'], 10_000)
  assert.equal(
    windows.recheckUntilMs(),
    10_000 + REQUIRED_SERVICE_PROBE_DEADLINE_MS + REQUIRED_SERVICE_PROBE_RECHECK_WINDOW_MS,
    'a late member extends the bound from its own arrival, not from the boot start',
  )
})
