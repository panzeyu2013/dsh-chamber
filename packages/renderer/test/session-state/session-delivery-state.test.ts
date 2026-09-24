import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LADDER_TABLES } from '@dsh-chamber/dsh-stream-state'
import { createSessionDeliveryOwner } from '../../src/session-delivery-state.ts'

const TABLE = LADDER_TABLES.delivery

function loadingEvidence() {
  return {
    evidence: {
      symptomSinceMs: 0,
      open: { state: 'loading' as const, openInFlight: false, resyncInFlight: false, resyncAvailable: true },
    },
  }
}

test('the owner is the only ledger: resync needs positive evidence, then the quota bounds it', () => {
  const owner = createSessionDeliveryOwner()
  const noneInFlight = owner.observe({ sessionId: 's1', ...loadingEvidence() }, 0)
  assert.deepEqual(noneInFlight.symptoms, ['open-stall'])
  assert.equal(noneInFlight.action, undefined, 'the grace window has not elapsed')
  const first = owner.observe({ sessionId: 's1', ...loadingEvidence() }, TABLE.resyncGraceMs)
  assert.equal(first.action?.tier, 'resync')
  const cooldown = owner.observe({ sessionId: 's1', ...loadingEvidence() }, TABLE.resyncGraceMs + 1_000)
  assert.equal(cooldown.action, undefined, 'a second resync inside the cooldown must hold')
  const second = owner.observe({ sessionId: 's1', ...loadingEvidence() }, TABLE.resyncGraceMs + TABLE.resyncCooldownMs)
  assert.equal(second.action?.tier, 'resync')
  const spent = owner.observe({ sessionId: 's1', ...loadingEvidence() }, TABLE.resyncGraceMs + TABLE.resyncCooldownMs * 3)
  assert.equal(spent.action, undefined)
  assert.equal(spent.hostStall, true, 'an exhausted ladder becomes a first-class host-stall fact')
})

test('an in-flight open is not a stall; a disposing resync is one but never dispatches', () => {
  const owner = createSessionDeliveryOwner()
  const inFlight = owner.observe({
    sessionId: 's1',
    evidence: { symptomSinceMs: 0, open: { state: 'loading', openInFlight: true, resyncInFlight: false, resyncAvailable: true } },
  }, TABLE.resyncGraceMs * 10)
  assert.deepEqual(inFlight.symptoms, [], 'a slow host keeps its in-flight open')
  const disposing = owner.observe({
    sessionId: 's1',
    evidence: { symptomSinceMs: 0, open: { state: 'loading', openInFlight: false, resyncInFlight: true, resyncAvailable: true } },
  }, TABLE.resyncGraceMs * 10)
  assert.deepEqual(disposing.symptoms, ['open-stall'],
    'the stall is not resolved while its recovery runs: the streak and its ledger must survive')
  assert.equal(disposing.action, undefined, 'a resync still disposing must not start a second one')
})

test('a blocked escalation neither dispatches nor spends the quota', () => {
  const owner = createSessionDeliveryOwner()
  const blocked = owner.observe({ sessionId: 's1', ...loadingEvidence(), escalationBlocked: true }, TABLE.resyncGraceMs)
  assert.equal(blocked.action, undefined)
  const after = owner.observe({ sessionId: 's1', ...loadingEvidence() }, TABLE.resyncGraceMs + 1)
  assert.equal(after.action?.tier, 'resync', 'the budget was not consumed while blocked')
})

test('a manual resync stamps the same ledger the automatic arm reads', () => {
  const owner = createSessionDeliveryOwner()
  owner.markDispatched('s1', 'resync', 0)
  const automatic = owner.observe({ sessionId: 's1', ...loadingEvidence() }, TABLE.resyncGraceMs)
  assert.equal(automatic.action, undefined, 'the manual stamp paced the automatic arm')
  const later = owner.observe({ sessionId: 's1', ...loadingEvidence() }, TABLE.resyncCooldownMs + 1)
  assert.equal(later.action?.tier, 'resync')
})

test('run identity: the host key wins and the chamber namespace is the fallback', () => {
  const owner = createSessionDeliveryOwner()
  const host = owner.observe({ sessionId: 's1', hostRunKey: 'r1', ...loadingEvidence() }, TABLE.resyncGraceMs)
  assert.equal(host.runId, 'host:r1')
  assert.equal(host.runIdConflict, false)
  const chamber = owner.observe({
    sessionId: 's2',
    chamberRun: { sourceFingerprint: 'local', generation: 1, sessionId: 's2', episode: 2 },
    evidence: { symptomSinceMs: 0 },
  }, TABLE.resyncGraceMs + 1)
  assert.match(chamber.runId ?? '', /^chamber:/)
  assert.equal(chamber.runIdConflict, false)
})
