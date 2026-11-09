/**
 * Facts authority gate (design 19 §3.5): while the mounted producer owns a
 * source's runtime facts, the no-shell observer's transient `degraded` must not
 * be projected as that source's capability. The producer's authority is bounded by
 * the report age: a hung producer row that never cleared must not suppress the
 * observer forever.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presentedSessionFactsMode, producerOwnsSessionFacts } from '../../src/host/facts-authority.ts'
import type { InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core'

const NOW = 10_000_000

function runtime(stale?: boolean, reportedAt = NOW - 1_000): InstanceRuntimeReport {
  return { stale, reportedAt } as unknown as InstanceRuntimeReport
}

test('producerOwnsSessionFacts: presence, source connectivity, not-stale and report age', () => {
  assert.equal(producerOwnsSessionFacts(undefined, true, NOW), false)
  assert.equal(producerOwnsSessionFacts(runtime(undefined), true, NOW), true)
  assert.equal(producerOwnsSessionFacts(runtime(false), true, NOW), true)
  assert.equal(producerOwnsSessionFacts(runtime(true), true, NOW), false)
  // A disconnected source's producer row is last-known state, not live evidence:
  // the no-shell observer (same origin, same reachability) regains authority.
  assert.equal(producerOwnsSessionFacts(runtime(undefined), false, NOW), false)
  assert.equal(producerOwnsSessionFacts(runtime(false), false, NOW), false)

  // AGE BOUND（producer 在位无年龄上界）: a producer that stopped reporting without a
  // teardown hands authority back — the row is last-known state, not live evidence.
  assert.equal(producerOwnsSessionFacts(runtime(false, NOW - 1), true, NOW), true)
  assert.equal(producerOwnsSessionFacts(runtime(false, NOW - 6 * 60_000), true, NOW), false,
    'a producer report older than the bound is no longer live authority')
  // Unknown receipt time never counts as fresh authority (legacy/hand-built reports).
  const noStamp = { stale: false } as InstanceRuntimeReport
  assert.equal(producerOwnsSessionFacts(noStamp, true, NOW), false)
  assert.equal(producerOwnsSessionFacts({ stale: false, reportedAt: Number.NaN } as unknown as InstanceRuntimeReport, true, NOW), false)
  assert.equal(producerOwnsSessionFacts({ stale: false, reportedAt: 0 } as unknown as InstanceRuntimeReport, true, NOW), false)
})

test('only the stale carrier shape is suppressed while the producer owns the source', () => {
  const stale = { stale: true, degradation: 'unavailable' }
  assert.equal(presentedSessionFactsMode('degraded', stale, true), undefined)
  assert.equal(presentedSessionFactsMode('degraded', { stale: true }, true), undefined, 'stale without a version fact')
  assert.equal(presentedSessionFactsMode('degraded', undefined, true), undefined, 'unknown snapshot stays conservative')
  assert.equal(presentedSessionFactsMode('degraded', stale, false), 'degraded')
  // A FRESH degraded snapshot is a source fact (e.g. 2xx with serviceable=false).
  assert.equal(presentedSessionFactsMode('degraded', { stale: false, degradation: null }, true), 'degraded')
  assert.equal(presentedSessionFactsMode('degraded', { stale: false, degradation: 'unavailable' }, true), 'degraded')
  // Version facts are orthogonal to producer liveness: keep them even when stale.
  assert.equal(presentedSessionFactsMode('degraded', { stale: true, degradation: 'unversioned' }, true), 'degraded')
  assert.equal(presentedSessionFactsMode('degraded', { stale: true, degradation: 'forward-skew' }, true), 'degraded')
  for (const mode of ['full', 'legacy', 'disabled', undefined] as const) {
    assert.equal(presentedSessionFactsMode(mode, stale, true), mode)
    assert.equal(presentedSessionFactsMode(mode, stale, false), mode)
  }
})
