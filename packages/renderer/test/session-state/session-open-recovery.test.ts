import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceSessionOpenHealth, presentedSessionOpenRecoveryPhase, sessionOpenRecoveryPhase } from '../../src/session-open-recovery.ts'

test('loading has a bounded user-visible failure; open clears the recovery surface', () => {
  assert.equal(sessionOpenRecoveryPhase('loading', 19_999), 'quiet')
  assert.equal(sessionOpenRecoveryPhase('loading', 20_000), 'waiting')
  assert.equal(sessionOpenRecoveryPhase('loading', 89_999), 'waiting')
  assert.equal(sessionOpenRecoveryPhase('loading', 90_000), 'failed')
  assert.equal(sessionOpenRecoveryPhase('open', 120_000), 'quiet')
  assert.equal(sessionOpenRecoveryPhase('error', 0), 'failed')
  assert.equal(sessionOpenRecoveryPhase('missing', 90_000), 'failed')
})

test('a transiently missing probe cannot reset the loading deadline', () => {
  const loading = advanceSessionOpenHealth(null, 's1', { openState: 'loading', resyncAvailable: true }, 0)
  assert.ok(loading !== null)
  const missing = advanceSessionOpenHealth(loading, 's1', null, 90_000)
  assert.equal(missing?.openInFlight, undefined, 'a missing face claims no in-flight resync')
  assert.equal(missing?.since, 0)
  assert.equal(sessionOpenRecoveryPhase(missing?.state, (missing?.now ?? 0) - (missing?.since ?? 0)), 'failed')
  const open = advanceSessionOpenHealth(missing, 's1', { openState: 'open', resyncAvailable: true }, 90_001)
  assert.equal(sessionOpenRecoveryPhase(open?.state, (open?.now ?? 0) - (open?.since ?? 0)), 'quiet')
  assert.equal(advanceSessionOpenHealth(loading, 's2', null, 90_000)?.state, 'missing')
})

test('an absent session face has a deadline while a genuinely blank face does not', () => {
  const missing = advanceSessionOpenHealth(null, 's1', null, 0)
  assert.equal(missing?.state, 'missing')
  const waiting = advanceSessionOpenHealth(missing, 's1', null, 20_000)
  assert.equal(presentedSessionOpenRecoveryPhase(waiting, 's1', false), 'waiting')
  assert.equal(presentedSessionOpenRecoveryPhase(waiting, 's1', true), 'quiet')
  const loading = advanceSessionOpenHealth(waiting, 's1', { openState: 'loading', resyncAvailable: true }, 90_000)
  assert.equal(loading?.since, 0, 'materializing a loading face must not restart the missing-face deadline')
  assert.equal(presentedSessionOpenRecoveryPhase(loading, 's1', true), 'failed',
    'a known blank row must not hide a real loading failure')
  assert.equal(presentedSessionOpenRecoveryPhase(loading, 's2', false), 'quiet')
  const open = advanceSessionOpenHealth(loading, 's1', { openState: 'open', resyncAvailable: true }, 90_001)
  assert.equal(presentedSessionOpenRecoveryPhase(open, 's1', false), 'quiet')
  const disappeared = advanceSessionOpenHealth(open, 's1', null, 90_002)
  assert.equal(disappeared?.since, 90_002, 'a face disappearing after a real open starts a new incident')
})

test('terminal opening evidence shows the failure now, without waiting for the timer', () => {
  const loading = advanceSessionOpenHealth(null, 's1', { openState: 'loading', resyncAvailable: true }, 0)
  assert.equal(presentedSessionOpenRecoveryPhase(loading, 's1', false), 'quiet', 'no evidence: today\'s timer stays quiet this early')
  assert.equal(presentedSessionOpenRecoveryPhase(loading, 's1', false, true), 'failed',
    'the fact is the failure, not the 20s/90s page timer')
  assert.equal(presentedSessionOpenRecoveryPhase(loading, 's2', false, true), 'quiet',
    'another session never inherits the evidence')
  assert.equal(presentedSessionOpenRecoveryPhase(loading, 's1', true, true), 'failed',
    'a known blank row is still a real loading failure candidate')
  const open = advanceSessionOpenHealth(loading, 's1', { openState: 'open', resyncAvailable: true }, 1_000)
  assert.equal(presentedSessionOpenRecoveryPhase(open, 's1', false, true), 'quiet',
    'a settled open retires the notice')
})
