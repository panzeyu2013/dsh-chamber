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

/** The one parked-loading shape the shared classifier accepts as an open-stall. */
function parkedLoading() {
  return {
    evidence: {
      symptomSinceMs: 0,
      open: {
        state: 'loading' as const, openInFlight: false, resyncInFlight: false, resyncAvailable: true,
      },
    },
  }
}

test('a parked loading face resyncs through the shared ladder, on its grace and cooldown', () => {
  // B1: `openInFlight === false` is the shared proof that a loading face is
  // parked (the vendor clears openPromise while staying 'loading'), so the same
  // owner, grace, cooldown and quota as the error arm now cover it.
  const owner = createSessionDeliveryOwner()
  const early = owner.observe({ sessionId: 's1', ...parkedLoading() }, TABLE.resyncGraceMs - 1)
  assert.deepEqual(early.symptoms, ['open-stall'], 'a parked load is an open-stall')
  assert.equal(early.action, undefined, 'the grace must elapse before the resync')
  const due = owner.observe({ sessionId: 's1', ...parkedLoading() }, TABLE.resyncGraceMs)
  assert.equal(due.action?.tier, 'resync', 'a parked loading is the ladder\'s to re-issue')
  const cooldown = owner.observe({ sessionId: 's1', ...parkedLoading() }, TABLE.resyncGraceMs + 1_000)
  assert.equal(cooldown.action, undefined, 'the existing cooldown paces the retry')
})

test('a loading face without the parked proof never dispatches (in-flight or unknown)', () => {
  // Invariant: an open still in flight is the host's to finish, and an unknown
  // liveness bit fails closed exactly like a missing capability — neither may be
  // crossed by an automatic action, and neither spends the lever.
  for (const openInFlight of [true, undefined] as const) {
    const owner = createSessionDeliveryOwner()
    const decision = owner.observe({
      sessionId: 's1',
      evidence: { symptomSinceMs: 0, open: { state: 'loading', openInFlight, resyncInFlight: false, resyncAvailable: true } },
    }, TABLE.resyncGraceMs * 10)
    assert.deepEqual(decision.symptoms, [], String(openInFlight) + ' is not a parked-loading proof')
    assert.equal(decision.action, undefined, 'no automatic rebuild may cross an in-flight/unknown open')
    assert.equal(decision.hostStall, false, 'no lever was spent, so no stall fact')
  }
  // A disposing rebuild IS still a stall (the ledger must survive it) but never a
  // second dispatch.
  const owner = createSessionDeliveryOwner()
  const disposing = owner.observe({
    sessionId: 's1',
    evidence: { symptomSinceMs: 0, open: { state: 'loading', openInFlight: false, resyncInFlight: true, resyncAvailable: true } },
  }, TABLE.resyncGraceMs * 10)
  assert.deepEqual(disposing.symptoms, ['open-stall'])
  assert.equal(disposing.action, undefined)
})

test('an unknown liveness bit never spends the quota, so the parked proof can still act', () => {
  const owner = createSessionDeliveryOwner()
  const unknown = owner.observe({
    sessionId: 's1',
    evidence: { symptomSinceMs: 0, open: { state: 'loading', openInFlight: undefined, resyncInFlight: false, resyncAvailable: true } },
  }, TABLE.resyncGraceMs * 5)
  assert.deepEqual(unknown.symptoms, [])
  const parked = owner.observe({ sessionId: 's1', ...parkedLoading() }, TABLE.resyncGraceMs * 5)
  assert.equal(parked.action?.tier, 'resync', 'the untrusted tick did not consume the lever')
})

test('an open-stall alone never reaches the stronger tiers', () => {
  // Invariant: the ladder's `requiresStuckEvidence` gate keeps instance-reboot
  // and document-reload out of reach without the caller's stuck report, so an
  // open face can only ever ascend to `resync` on time alone.
  const owner = createSessionDeliveryOwner()
  const parked = (at: number) => owner.observe({ sessionId: 's1', ...parkedLoading() }, at)
  const first = parked(TABLE.resyncGraceMs)
  assert.equal(first.action?.tier, 'resync')
  const second = parked(TABLE.resyncGraceMs + TABLE.resyncCooldownMs)
  assert.equal(second.action?.tier, 'resync')
  const late = parked(TABLE.resyncWindowMs - 1)
  assert.equal(late.action, undefined, 'no stuck evidence: the stronger tiers stay shut')
  assert.equal(late.hostStall, true, 'the exhausted resync arm is the host-stall fact')
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
