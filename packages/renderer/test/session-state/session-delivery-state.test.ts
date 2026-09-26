import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LADDER_TABLES } from '@dsh-chamber/dsh-stream-state'
import { createSessionDeliveryOwner } from '../../src/session-delivery-state.ts'

const TABLE = LADDER_TABLES.delivery

/** The one open face the page may still rebuild automatically: an error the header cannot heal. */
function unhealableError() {
  return {
    evidence: {
      symptomSinceMs: 0,
      open: {
        state: 'error' as const, openInFlight: false, resyncInFlight: false,
        resyncAvailable: true, healRoute: false,
      },
    },
  }
}

test('a loading face is never an automatic symptom, however parked it looks', () => {
  // Requirement: the automatic resync arm no longer acts on openState=loading.
  // A pending open is never crossed, an unknown liveness is never trusted, and
  // the recovery of a loading face belongs to the user (the stream-forensics
  // evidence surfaces it) — never to this ladder.
  const owner = createSessionDeliveryOwner()
  const cases = [
    { openInFlight: false, resyncInFlight: false },
    { openInFlight: true, resyncInFlight: false },
    { openInFlight: undefined, resyncInFlight: false },
    { openInFlight: false, resyncInFlight: true },
  ]
  for (const open of cases) {
    const decision = owner.observe({
      sessionId: 's1',
      evidence: { symptomSinceMs: 0, open: { state: 'loading', resyncAvailable: true, ...open } },
    }, TABLE.resyncGraceMs * 10)
    assert.deepEqual(decision.symptoms, [], 'loading is not an open-stall for the page ladder')
    assert.equal(decision.action, undefined, 'no automatic rebuild may cross a load')
    assert.equal(decision.hostStall, false, 'a parked load is not a host stall')
  }
})

test('the error face the header cannot heal keeps the bounded automatic resync', () => {
  const owner = createSessionDeliveryOwner()
  const first = owner.observe({ sessionId: 's1', ...unhealableError() }, TABLE.resyncGraceMs)
  assert.deepEqual(first.symptoms, ['open-stall'])
  assert.equal(first.action?.tier, 'resync', 'the error path is not regressed by the loading rule')
  const cooldown = owner.observe({ sessionId: 's1', ...unhealableError() }, TABLE.resyncGraceMs + 1_000)
  assert.equal(cooldown.action, undefined, 'a second resync inside the cooldown must hold')
  const second = owner.observe({ sessionId: 's1', ...unhealableError() }, TABLE.resyncGraceMs + TABLE.resyncCooldownMs)
  assert.equal(second.action?.tier, 'resync')
  const spent = owner.observe({ sessionId: 's1', ...unhealableError() }, TABLE.resyncGraceMs + TABLE.resyncCooldownMs * 3)
  assert.equal(spent.action, undefined)
  assert.equal(spent.hostStall, true, 'an exhausted ladder becomes a first-class host-stall fact')
})

test('a healable error stays with the header, and a pending open still blocks the page arm', () => {
  const owner = createSessionDeliveryOwner()
  const healable = owner.observe({
    sessionId: 's1',
    evidence: {
      symptomSinceMs: 0,
      open: { state: 'error', openInFlight: false, resyncInFlight: false, resyncAvailable: true, healRoute: true },
    },
  }, TABLE.resyncGraceMs * 10)
  assert.deepEqual(healable.symptoms, [], 'the header owns a healable error')
  assert.equal(healable.action, undefined)
  const inFlightError = owner.observe({
    sessionId: 's1',
    evidence: {
      symptomSinceMs: 0,
      open: { state: 'error', openInFlight: true, resyncInFlight: false, resyncAvailable: true, healRoute: false },
    },
  }, TABLE.resyncGraceMs * 10)
  assert.deepEqual(inFlightError.symptoms, [], 'a pending open is never crossed')
  assert.equal(inFlightError.action, undefined)
  // A disposing rebuild is still a stall, but never a second dispatch.
  const disposing = owner.observe({
    sessionId: 's1',
    evidence: {
      symptomSinceMs: 0,
      open: { state: 'error', openInFlight: false, resyncInFlight: true, resyncAvailable: true, healRoute: false },
    },
  }, TABLE.resyncGraceMs * 10)
  assert.deepEqual(disposing.symptoms, ['open-stall'])
  assert.equal(disposing.action, undefined)
})

test('a blocked escalation neither dispatches nor spends the quota', () => {
  const owner = createSessionDeliveryOwner()
  const blocked = owner.observe({ sessionId: 's1', ...unhealableError(), escalationBlocked: true }, TABLE.resyncGraceMs)
  assert.equal(blocked.action, undefined)
  const after = owner.observe({ sessionId: 's1', ...unhealableError() }, TABLE.resyncGraceMs + 1)
  assert.equal(after.action?.tier, 'resync', 'the budget was not consumed while blocked')
})

test('a manual resync stamps the same ledger the automatic arm reads', () => {
  const owner = createSessionDeliveryOwner()
  owner.markDispatched('s1', 'resync', 0)
  const automatic = owner.observe({ sessionId: 's1', ...unhealableError() }, TABLE.resyncGraceMs)
  assert.equal(automatic.action, undefined, 'the manual stamp paced the automatic arm')
  const later = owner.observe({ sessionId: 's1', ...unhealableError() }, TABLE.resyncCooldownMs + 1)
  assert.equal(later.action?.tier, 'resync')
})

test('run identity: the host key wins and the chamber namespace is the fallback', () => {
  const owner = createSessionDeliveryOwner()
  const host = owner.observe({ sessionId: 's1', hostRunKey: 'r1', ...unhealableError() }, TABLE.resyncGraceMs)
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
