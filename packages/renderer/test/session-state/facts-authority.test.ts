/**
 * Facts authority gate (design 19 §3.5): while the mounted producer owns a
 * source's runtime facts, the no-shell observer's transient `degraded` must not
 * be projected as that source's capability.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presentedSessionFactsMode, producerOwnsSessionFacts } from '../../src/host/facts-authority.ts'
import type { InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core'

function runtime(stale?: boolean): InstanceRuntimeReport {
  return { stale } as unknown as InstanceRuntimeReport
}

test('producerOwnsSessionFacts: presence, source connectivity and not-stale', () => {
  assert.equal(producerOwnsSessionFacts(undefined, true), false)
  assert.equal(producerOwnsSessionFacts(runtime(undefined), true), true)
  assert.equal(producerOwnsSessionFacts(runtime(false), true), true)
  assert.equal(producerOwnsSessionFacts(runtime(true), true), false)
  // A disconnected source's producer row is last-known state, not live evidence:
  // the no-shell observer (same origin, same reachability) regains authority.
  assert.equal(producerOwnsSessionFacts(runtime(undefined), false), false)
  assert.equal(producerOwnsSessionFacts(runtime(false), false), false)
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
