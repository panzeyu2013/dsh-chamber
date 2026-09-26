/**
 * Carrier lifecycle reducer - behavior contract.
 *
 * The oracle here is the DECIDED semantics, not the current wiring: three
 * entries can replace one socket in a window and
 * replaceSocket bypasses the mux's own 1s throttle. These tests pin the
 * single-owner rule so the executor that follows cannot reintroduce it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reduceCarrier, reduceCarrierSequence, decideRebuild } from '../../src/carrier.ts'
import { initialCarrierState } from '../../src/state.ts'
import { CARRIER_ENV, openingBudgetMs, OPENING_TIMEOUT_LADDER_MS, SILENT_TEARDOWN_MIN_MS } from '../../src/tables.ts'
import type { CarrierEvent } from '../../src/state.ts'

const env = CARRIER_ENV

test('a connecting carrier admits one rebuild and enters replacing', () => {
  const r = reduceCarrier(initialCarrierState(), { kind: 'rebuildRequested', at: 1000, reason: 'laneReconnect' }, env)
  assert.equal(r.state.phase, 'replacing')
  assert.equal(r.state.pendingRebuild, 'laneReconnect')
  assert.deepEqual(r.state.rebuildsAt, [1000])
  assert.deepEqual(r.effects, [{ e: 'rebuildCarrier', reason: 'laneReconnect', at: 1000 }])
})

test('a second rebuild inside the window is throttled, never doubled', () => {
  const first = reduceCarrier(initialCarrierState(), { kind: 'rebuildRequested', at: 1000, reason: 'socketNoFrame' }, env)
  const second = reduceCarrier(first.state, { kind: 'rebuildRequested', at: 1000, reason: 'openingStall', streak: 2 }, env)
  assert.equal(second.state.rebuildsAt.length, 1)
  assert.deepEqual(second.effects, [{ e: 'throttled', reason: 'openingStall', at: 1000 }])
})

test('an unusable clock never authorizes a rebuild (fail safe)', () => {
  // Every throttle comparison is a ratio against `at`, and NaN makes all of them
  // false - so without a guard a NaN clock would SLIP THROUGH and rebuild on every
  // call. The reducer must fail safe here.
  const state = initialCarrierState()
  for (const at of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const r = reduceCarrier(state, { kind: 'rebuildRequested', at, reason: 'openingStall', streak: 2 }, CARRIER_ENV)
    assert.ok(!r.effects.some((effect) => effect.e === 'rebuildCarrier'), 'at=' + String(at) + ' must not rebuild')
    assert.ok(r.effects.some((effect) => effect.e === 'throttled'), 'and the refusal must be recorded')
  }
})

test('an unusable streak never clears the threshold', () => {
  const r = reduceCarrier(
    initialCarrierState(),
    { kind: 'rebuildRequested', at: 1000, reason: 'openingStall', streak: Number.NaN },
    CARRIER_ENV,
  )
  assert.ok(!r.effects.some((effect) => effect.e === 'rebuildCarrier'),
    'NaN is neither below nor above the threshold: a bare < would let it through')
  assert.ok(r.effects.some((effect) => effect.e === 'forensic' && effect.name === 'stall-below-threshold'))
})

test('an opening stall below the streak threshold is not a rebuild request', () => {
  // The legacy else-branch escalated whenever the time-based cooldown allowed it;
  // the reducer requires the N=2 streak instead. A first miss must therefore stay
  // a forensic fact, not become a replacement.
  const state = initialCarrierState()
  const below = reduceCarrier(state, { kind: 'rebuildRequested', at: 1000, reason: 'openingStall', streak: 1 }, env)
  assert.deepEqual(below.effects, [{ e: 'forensic', name: 'stall-below-threshold', detail: '1' }])
  assert.equal(below.state.phase, 'connecting')
  assert.equal(below.state.rebuildsAt.length, 0)
  const atThreshold = reduceCarrier(state, { kind: 'rebuildRequested', at: 1000, reason: 'openingStall', streak: 2 }, env)
  assert.equal(atThreshold.effects[0]?.e, 'rebuildCarrier')
})

test('an allowed event during the in-flight connect is denied (never-stabilizes hazard)', () => {
  const first = reduceCarrier(initialCarrierState(), { kind: 'rebuildRequested', at: 10000, reason: 'socketNoFrame' }, env)
  const during = reduceCarrier(first.state, { kind: 'rebuildRequested', at: 10500, reason: 'laneReconnect' }, env)
  assert.equal(during.state.rebuildsAt.length, 1)
  assert.equal(during.effects[0]?.e, 'throttled')
})

test('after the window and spacing expire a new rebuild is admitted', () => {
  const first = reduceCarrier(initialCarrierState(), { kind: 'rebuildRequested', at: 0, reason: 'socketNoFrame' }, env)
  const later = reduceCarrier(first.state, { kind: 'rebuildRequested', at: 61000, reason: 'laneReconnect' }, env)
  // The ledger keeps only what the throttle window can still see: the stamp at 0 is
  // outside (0 > 1000 is false), so the admission replaces it rather than stacking
  // (G-C pins the general bound).
  assert.deepEqual(later.state.rebuildsAt, [61000])
  assert.equal(later.effects[0]?.e, 'rebuildCarrier')
})

test('carrierOpened clears the in-flight marker and resets the frame counter', () => {
  const replacing = reduceCarrier(initialCarrierState(), { kind: 'rebuildRequested', at: 1000, reason: 'socketNoFrame' }, env)
  const framed = reduceCarrier(replacing.state, { kind: 'streamFrame', at: 1100 }, env)
  const opened = reduceCarrier(framed.state, { kind: 'carrierOpened', at: 1200 }, env)
  assert.equal(opened.state.phase, 'open')
  assert.equal(opened.state.framesOnSocket, 0)
  assert.equal(opened.state.pendingRebuild, null)
})

test('a frame advances the socket counter', () => {
  const opened = reduceCarrier(initialCarrierState(), { kind: 'carrierOpened', at: 0 }, env)
  const framed = reduceCarrier(opened.state, { kind: 'streamFrame', at: 5 }, env)
  assert.equal(framed.state.framesOnSocket, 1)
  assert.equal(framed.state.phase, 'open')
})

test('a closed carrier refuses rebuilds (nothing left to replace)', () => {
  const closed = reduceCarrier(initialCarrierState(), { kind: 'carrierClosed', at: 0 }, env)
  const denied = reduceCarrier(closed.state, { kind: 'rebuildRequested', at: 1, reason: 'laneReconnect' }, env)
  assert.equal(denied.state.phase, 'closed')
  assert.equal(denied.state.rebuildsAt.length, 0)
  assert.equal(denied.effects[0]?.e, 'throttled')
})

test('logical stream bookkeeping is idempotent', () => {
  const opened = reduceCarrier(initialCarrierState(), { kind: 'streamOpened', at: 0, streamId: 'a' }, env)
  const again = reduceCarrier(opened.state, { kind: 'streamOpened', at: 1, streamId: 'a' }, env)
  assert.deepEqual(again.state.openStreams, ['a'])
  const closed = reduceCarrier(again.state, { kind: 'streamClosed', at: 2, streamId: 'a' }, env)
  assert.deepEqual(closed.state.openStreams, [])
  const unknown = reduceCarrier(closed.state, { kind: 'streamClosed', at: 3, streamId: 'a' }, env)
  assert.deepEqual(unknown.state.openStreams, [])
})

test('an unknown event kind is total: same state, no effects', () => {
  const state = initialCarrierState()
  const r = reduceCarrier(state, { kind: 'nonsense' as never, at: 1 }, env)
  assert.equal(r.state, state)
  assert.deepEqual(r.effects, [])
})

test('decideRebuild is a pure predicate over the same tables', () => {
  const state = initialCarrierState()
  assert.equal(decideRebuild(state, env, 0), true)
  const replaced = reduceCarrier(state, { kind: 'rebuildRequested', at: 0, reason: 'socketNoFrame' }, env)
  // In the in-flight grace: denied.
  assert.equal(decideRebuild(replaced.state, env, 500), false)
  // Exactly one window later the first rebuild has LEFT the half-open window
  // (window = (at - windowMs, at]) so the throttle admits again - this is the
  // boundary the rule is defined on, and it is pinned here on purpose.
  assert.equal(decideRebuild(replaced.state, env, 60000), true)
  // One millisecond inside the same window it is denied again.
  assert.equal(decideRebuild(replaced.state, env, 59500), false)
})

test('the opening-budget ladder is the recorded widening', () => {
  assert.deepEqual(OPENING_TIMEOUT_LADDER_MS, [30000, 60000, 120000, 240000, 300000])
  assert.equal(openingBudgetMs(0), 30000)
  assert.equal(openingBudgetMs(1), 60000)
  assert.equal(openingBudgetMs(2), 120000)
  assert.equal(openingBudgetMs(3), 240000)
  assert.equal(openingBudgetMs(4), 300000)
  assert.equal(openingBudgetMs(99), 300000)
  assert.equal(openingBudgetMs(-1), 30000)
})

test('the silent-teardown floor is the recorded value', () => {
  assert.equal(SILENT_TEARDOWN_MIN_MS, 15000)
})

test('a sequence never produces two rebuilds inside one window', () => {
  const events: CarrierEvent[] = [
    { kind: 'carrierConnecting', at: 0 },
    { kind: 'rebuildRequested', at: 0, reason: 'socketNoFrame' },
    { kind: 'rebuildRequested', at: 0, reason: 'openingStall' },
    { kind: 'carrierOpened', at: 30 },
    { kind: 'rebuildRequested', at: 5000, reason: 'laneReconnect' },
    { kind: 'rebuildRequested', at: 70000, reason: 'laneReconnect' },
  ]
  const { effects } = reduceCarrierSequence(initialCarrierState(), events, env)
  const rebuilds = effects.filter((e) => e.e === 'rebuildCarrier')
  assert.equal(rebuilds.length, 2)
})
test('T3 denied rebuild still gives the episode an exit (reopen, never silence)', () => {
  const state = initialCarrierState()
  const denied = reduceCarrier(
    state,
    { kind: 'rebuildRequested', at: 1000, reason: 'openingStall', streak: 1, streamId: 'ep-1', episodeId: 'ep-1' },
    env,
  )
  const kinds = denied.effects.map((effect) => effect.e)
  assert.ok(kinds.includes('reopenLogicalStream'), 'a denied request must reopen its logical stream')
  const throttled = reduceCarrier(
    reduceCarrier(state, { kind: 'rebuildRequested', at: 0, reason: 'socketNoFrame', streamId: 'ep-1' }, env).state,
    { kind: 'rebuildRequested', at: 500, reason: 'socketNoFrame', streamId: 'ep-2' },
    env,
  )
  const throttleEffects = throttled.effects.map((effect) => effect.e)
  assert.ok(throttleEffects.includes('throttled'))
  assert.ok(throttleEffects.includes('reopenLogicalStream'), 'a throttled request must also reopen')
})

test('T1 a closed episode releases the in-flight rebuild it owned', () => {
  // Episode A starts a rebuild, then its consumer disappears. The marker A left
  // must not hold the carrier hostage: the in-flight marker is owned by the
  // episode that placed it.
  const started = reduceCarrier(
    initialCarrierState(),
    { kind: 'rebuildRequested', at: 1000, reason: 'socketNoFrame', streamId: 'ep-a', episodeId: 'ep-a' },
    env,
  )
  assert.equal(started.state.pendingRebuildBy, 'ep-a')
  const closed = reduceCarrier(started.state, { kind: 'episodeClosed', at: 1200, episodeId: 'ep-a' }, env)
  assert.equal(closed.state.pendingRebuild, null)
  assert.equal(closed.state.pendingRebuildBy, null)
  assert.deepEqual(closed.effects, [{ e: 'forensic', name: 'episode-claim-released', detail: 'ep-a' }])
  // A different episode closing never releases someone else's claim.
  const other = reduceCarrier(started.state, { kind: 'episodeClosed', at: 1200, episodeId: 'ep-b' }, env)
  assert.equal(other.state.pendingRebuildBy, 'ep-a')
})

test('T2 a replaced carrier fails EVERY logical stream, not only the one that noticed', () => {
  const opened = reduceCarrierSequence(initialCarrierState(), [
    { kind: 'carrierConnecting', at: 0 },
    { kind: 'carrierOpened', at: 1 },
    { kind: 'streamOpened', at: 2, streamId: 's1' },
    { kind: 'streamOpened', at: 3, streamId: 's2' },
    { kind: 'streamOpened', at: 4, streamId: 's3' },
  ], env)
  assert.equal(opened.state.openStreams.length, 3)
  const closed = reduceCarrier(opened.state, { kind: 'carrierClosed', at: 5000 }, env)
  assert.deepEqual(closed.state.openStreams, [], 'socket-level failure clears every stream')
})


test('P3: zero frames turn an opening stall into a dead-carrier rebuild, without the streak gate', () => {
  // A below-threshold stall (streak 0) on a socket that delivered NOTHING is the
  // silent-carrier case: the reducer derives socketNoFrame, and the threshold no
  // longer applies because the whole budget WAS the evidence window.
  const silent = reduceCarrier(initialCarrierState(), {
    kind: 'rebuildRequested', at: 1000, reason: 'openingStall', streak: 0, streamId: 's1', framesSinceSend: 0,
  }, env)
  assert.deepEqual(silent.effects, [{ e: 'rebuildCarrier', reason: 'socketNoFrame', at: 1000 }])
  assert.equal(silent.state.pendingRebuild, 'socketNoFrame')
})

test('P3: a socket that delivered keeps the stall threshold and cannot be called silent', () => {
  const delivered = reduceCarrier(initialCarrierState(), {
    kind: 'rebuildRequested', at: 1000, reason: 'openingStall', streak: 0, streamId: 's1', framesSinceSend: 3,
  }, env)
  assert.ok(!delivered.effects.some((effect) => effect.e === 'rebuildCarrier'), 'first miss on a live socket is not a rebuild')
  assert.ok(delivered.effects.some((effect) => effect.e === 'forensic' && effect.name === 'stall-below-threshold'))
  // Proven threshold + delivered frames = a threshold-gated stall, not silence.
  const proven = reduceCarrier(initialCarrierState(), {
    kind: 'rebuildRequested', at: 1000, reason: 'openingStall', streak: 2, streamId: 's1', framesSinceSend: 3,
  }, env)
  assert.deepEqual(proven.effects, [{ e: 'rebuildCarrier', reason: 'openingStall', at: 1000 }])
  // An EXPLICIT silent reason on a socket that delivered is denied outright.
  const denied = reduceCarrier(initialCarrierState(), {
    kind: 'rebuildRequested', at: 1000, reason: 'socketNoFrame', streamId: 's1', framesSinceSend: 3,
  }, env)
  assert.deepEqual(denied.effects, [
    { e: 'forensic', name: 'silent-not-proven', detail: '3' },
    { e: 'reopenLogicalStream', streamId: 's1', reason: 'silent-not-proven' },
  ])
})

test('P3: an unusable frame delta is never proof of silence', () => {
  // Absent keeps the pre-P3 contract (the threshold decides a stall)...
  const absent = reduceCarrier(initialCarrierState(), {
    kind: 'rebuildRequested', at: 1000, reason: 'openingStall', streak: 0, streamId: 's1',
  }, env)
  assert.ok(!absent.effects.some((effect) => effect.e === 'rebuildCarrier'))
  // ...and a non-finite delta cannot satisfy an explicit silent reason either.
  const nan = reduceCarrier(initialCarrierState(), {
    kind: 'rebuildRequested', at: 1000, reason: 'teardownNoFrame', streamId: 's1', framesSinceSend: Number.NaN,
  }, env)
  assert.ok(!nan.effects.some((effect) => effect.e === 'rebuildCarrier'))
  assert.ok(nan.effects.some((effect) => effect.e === 'reopenLogicalStream'))
})

test('P3: an opening is armed with the widening budget for its own episode', () => {
  const first = reduceCarrier(initialCarrierState(), { kind: 'openingSent', at: 1000, streamId: 's1', requestKey: 'k1' }, env)
  assert.deepEqual(first.effects, [{ e: 'armOpeningDeadline', streamId: 's1', budgetMs: 30_000, streak: 0 }])
  assert.equal(first.state.streamRequestKeys.s1, 'k1')
  // First expiry widens the NEXT attempt; a frame-answering socket is below the
  // stall threshold, so nothing rebuilds yet.
  const expired = reduceCarrier(first.state, { kind: 'openingExpired', at: 2000, streamId: 's1', requestKey: 'k1', framesSinceSend: 3 }, env)
  assert.equal(expired.state.openingStreaks.k1, 1)
  assert.ok(!expired.effects.some((effect) => effect.e === 'rebuildCarrier'), 'first miss is below the stall threshold')
  const second = reduceCarrier(expired.state, { kind: 'openingSent', at: 3000, streamId: 's2', requestKey: 'k1' }, env)
  assert.deepEqual(second.effects, [{ e: 'armOpeningDeadline', streamId: 's2', budgetMs: 60_000, streak: 1 }])
})

test('P3: only an ACCEPTED opening resets its own episode widening', () => {
  let state = initialCarrierState()
  state = reduceCarrier(state, { kind: 'openingSent', at: 1000, streamId: 's1', requestKey: 'k1' }, env).state
  state = reduceCarrier(state, { kind: 'openingExpired', at: 2000, streamId: 's1', requestKey: 'k1', framesSinceSend: 1 }, env).state
  state = reduceCarrier(state, { kind: 'openingSent', at: 3000, streamId: 's2', requestKey: 'k2' }, env).state
  assert.equal(state.openingStreaks.k1, 1)
  // F1: ACCEPTANCE is what resets the widening; mere delivery (openingAnswered) does not.
  const answered = reduceCarrier(state, { kind: 'openingAnswered', at: 3500, streamId: 's1', requestKey: 'k1' }, env)
  assert.equal(answered.state.openingPhases.s1, 'itemReceived')
  assert.equal(answered.state.openingStreaks.k1, 1, 'a delivered item is not an acceptance')
  const accepted = reduceCarrier(answered.state, { kind: 'openingAccepted', at: 4000, streamId: 's1', requestKey: 'k1' }, env)
  assert.equal(accepted.state.openingStreaks.k1, undefined)
  assert.equal(accepted.state.openingStreaks.k2, undefined, 'an unrelated episode is untouched')
})

test('F1: a carrier-ended unaccepted episode keeps its budget and streak', () => {
  let state = reduceCarrier(initialCarrierState(), { kind: 'openingSent', at: 1000, streamId: 's1', requestKey: 'k1' }, env).state
  state = reduceCarrier(state, { kind: 'openingExpired', at: 2000, streamId: 's1', requestKey: 'k1', framesSinceSend: 1 }, env).state
  assert.equal(state.openingStreaks.k1, 1)
  // The socket is replaced before the consumer ever accepted: the successor must
  // inherit the 60 s rung, not restart at 30 s.
  const replaced = reduceCarrier(state, {
    kind: 'episodeClosed', at: 3000, episodeId: 's1', requestKey: 'k1', carrierInitiated: true, accepted: false,
  }, env)
  assert.equal(replaced.state.openingStreaks.k1, 1, 'a replaced socket may not reset the budget')
  const successor = reduceCarrier(replaced.state, { kind: 'openingSent', at: 4000, streamId: 's2', requestKey: 'k1' }, env)
  assert.deepEqual(successor.effects, [{ e: 'armOpeningDeadline', streamId: 's2', budgetMs: 60_000, streak: 1 }])
  // A consumer-ended episode still releases it (D-4)...
  const abandoned = reduceCarrier(replaced.state, {
    kind: 'episodeClosed', at: 5000, episodeId: 's2', requestKey: 'k1', carrierInitiated: false, accepted: false,
  }, env)
  assert.equal(abandoned.state.openingStreaks.k1, undefined, 'the consumer leaving releases the key')
  // ...and so does an accepted carrier-ended episode.
  const accepted = reduceCarrier(replaced.state, {
    kind: 'episodeClosed', at: 6000, episodeId: 's2', requestKey: 'k1', carrierInitiated: true, accepted: true,
  }, env)
  assert.equal(accepted.state.openingStreaks.k1, undefined, 'an accepted opening releases the key')
})

test('F1: spending every ladder rung is a TERMINAL verdict, never another reopen', () => {
  const max = env.openingBudgetMaxMisses
  assert.equal(max, OPENING_TIMEOUT_LADDER_MS.length)
  let state = initialCarrierState()
  for (let miss = 1; miss < max; miss += 1) {
    const streamId = 's' + String(miss)
    state = reduceCarrier(state, { kind: 'openingSent', at: miss * 1000, streamId, requestKey: 'k1' }, env).state
    state = reduceCarrier(state, {
      kind: 'openingExpired', at: miss * 1000 + 1, streamId, requestKey: 'k1', framesSinceSend: 1,
    }, env).state
    assert.equal(state.openingStreaks.k1, miss)
    // Below the cap the episode still gets its retry path (a rebuild or a throttle).
    const decisions = reduceCarrier(state, {
      kind: 'rebuildRequested', at: miss * 1000 + 2, reason: 'openingStall', streak: miss, streamId: 'sx', episodeId: 'sx',
    }, env)
    assert.ok(decisions.effects.some((effect) => effect.e === 'reopenLogicalStream' || effect.e === 'rebuildCarrier'))
  }
  // The last rung: streak reaches the ladder length, the budget is spent, and the
  // verdict is FINAL - a failLogicalOpening with no reopen and no rebuild.
  const final = reduceCarrier(state, {
    kind: 'openingExpired', at: 99_000, streamId: 's-last', requestKey: 'k1', framesSinceSend: 1,
  }, env)
  assert.equal(final.state.openingStreaks.k1, max)
  // ONE effect: the verdict. The FACT names (opening-timeout/opening-orphaned +
  // opening-budget-exhausted) belong to the host, which publishes them with the
  // endpoint/stream/timing detail this clockless reducer does not carry.
  assert.deepEqual(final.effects, [{ e: 'failLogicalOpening', streamId: 's-last', reason: 'k1' }])
  assert.ok(!final.effects.some((effect) => effect.e === 'rebuildCarrier'
    || effect.e === 'reopenLogicalStream' || effect.e === 'throttled'), 'the terminal verdict reopens nothing')
})

test('F1: a terminal verdict releases the spent widening so a manual reopen gets rung 0', () => {
  const max = env.openingBudgetMaxMisses
  let state = initialCarrierState()
  let at = 1000
  for (let miss = 1; miss <= max; miss += 1) {
    const streamId = 's' + String(miss)
    state = reduceCarrier(state, { kind: 'openingSent', at, streamId, requestKey: 'k1' }, env).state
    at += 10
    state = reduceCarrier(state, { kind: 'openingExpired', at, streamId, requestKey: 'k1', framesSinceSend: 1 }, env).state
  }
  assert.equal(state.openingStreaks.k1, max, 'the ladder is fully spent')
  // The terminal episode closes with timedOut=true AND terminal=true: the spent widening
  // must be released, not bequeathed to the next logical opening of the same request.
  const closed = reduceCarrier(state, {
    kind: 'episodeClosed', at: at + 1, episodeId: 's' + String(max), requestKey: 'k1', timedOut: true, terminal: true,
  }, env)
  assert.equal(closed.state.openingStreaks.k1, undefined, 'a terminal verdict releases the spent widening')
  const reopened = reduceCarrier(closed.state, { kind: 'openingSent', at: at + 2, streamId: 'fresh', requestKey: 'k1' }, env)
  assert.deepEqual(reopened.effects, [{ e: 'armOpeningDeadline', streamId: 'fresh', budgetMs: openingBudgetMs(0), streak: 0 }],
    'a manual reopen starts a fresh ladder')
})

test('F1: an orphaned opening (item received, never accepted) names itself', () => {
  let state = reduceCarrier(initialCarrierState(), { kind: 'openingSent', at: 1000, streamId: 's1', requestKey: 'k1' }, env).state
  state = reduceCarrier(state, { kind: 'openingAnswered', at: 1100, streamId: 's1', requestKey: 'k1' }, env).state
  const max = env.openingBudgetMaxMisses
  state = reduceCarrier(state, {
    kind: 'openingExpired', at: 2000, streamId: 's1', requestKey: 'k1', framesSinceSend: 0,
  }, env).state
  // Below the cap the miss is still an episode reopen (no terminal); the final miss ends
  // it. The reducer reports the VERDICT only - an item that arrived but was never accepted
  // is named `opening-orphaned` by the host, which alone sees the acceptance channel.
  const final = reduceCarrier(
    { ...state, openingStreaks: { k1: max - 1 } },
    { kind: 'openingExpired', at: 3000, streamId: 's1', requestKey: 'k1', framesSinceSend: 0 },
    env,
  )
  assert.deepEqual(final.effects, [{ e: 'failLogicalOpening', streamId: 's1', reason: 'k1' }])
})

test('F1: a superseded episode accept cannot clear its successor widening', () => {
  let state = reduceCarrier(initialCarrierState(), { kind: 'openingSent', at: 1000, streamId: 's1', requestKey: 'k1' }, env).state
  state = reduceCarrier(state, { kind: 'openingExpired', at: 2000, streamId: 's1', requestKey: 'k1', framesSinceSend: 1 }, env).state
  // s1 is replaced by s2 for the SAME request; a late accept for s1 arrives afterwards.
  state = reduceCarrier(state, { kind: 'episodeClosed', at: 2500, episodeId: 's1', requestKey: 'k1', carrierInitiated: true }, env).state
  state = reduceCarrier(state, { kind: 'openingSent', at: 3000, streamId: 's2', requestKey: 'k1' }, env).state
  const late = reduceCarrier(state, { kind: 'openingAccepted', at: 4000, streamId: 's1', requestKey: 'k1' }, env)
  assert.equal(late.state.openingStreaks.k1, 1, "an old generation's accept must not settle the live attempt")
  const current = reduceCarrier(late.state, { kind: 'openingAccepted', at: 5000, streamId: 's2', requestKey: 'k1' }, env)
  assert.equal(current.state.openingStreaks.k1, undefined, 'the live attempt still settles itself')
})

test('F1: an accept from a still-live superseded episode never clears the successor widening', () => {
  // The AND-shaped guard this pins used to pass exactly here: the superseded episode
  // still HAD an opening phase (it was live - a journal sibling probe on the same
  // request, or a second generation), so only the latest-claim test can reject its
  // accept. Letting it through cleared the successor's widening and published a bogus
  // opening-accepted fact (reducer-script repro from review).
  let state = reduceCarrier(initialCarrierState(), { kind: 'openingSent', at: 1000, streamId: 's1', requestKey: 'k1' }, env).state
  state = reduceCarrier(state, { kind: 'openingExpired', at: 2000, streamId: 's1', requestKey: 'k1', framesSinceSend: 1 }, env).state
  assert.equal(state.openingStreaks.k1, 1)
  // s2 claims the same key while s1 is STILL live: no episodeClosed in between.
  state = reduceCarrier(state, { kind: 'openingSent', at: 3000, streamId: 's2', requestKey: 'k1' }, env).state
  const late = reduceCarrier(state, { kind: 'openingAccepted', at: 4000, streamId: 's1', requestKey: 'k1' }, env)
  assert.equal(late.state.openingStreaks.k1, 1, "a live predecessor's accept must not clear the successor ladder")
  assert.deepEqual(late.effects, [], 'no opening-accepted fact for a superseded episode')
  assert.equal(late.state.openingPhases.s1, 'sent', 'the superseded episode keeps its own phase untouched')
  const current = reduceCarrier(late.state, { kind: 'openingAccepted', at: 5000, streamId: 's2', requestKey: 'k1' }, env)
  assert.equal(current.state.openingStreaks.k1, undefined, 'the newest attempt still settles itself')
})

test('P3: a closing episode releases its widening unless it timed out or a sibling owns it', () => {
  const expire = (state: ReturnType<typeof initialCarrierState>, streamId: string, requestKey: string) =>
    reduceCarrier(state, { kind: 'openingExpired', at: 2000, streamId, requestKey, framesSinceSend: 1 }, env).state
  let unshared = reduceCarrier(initialCarrierState(), { kind: 'openingSent', at: 1000, streamId: 's1', requestKey: 'k1' }, env).state
  unshared = expire(unshared, 's1', 'k1')
  const closed = reduceCarrier(unshared, { kind: 'episodeClosed', at: 3000, episodeId: 's1' }, env)
  assert.equal(closed.state.openingStreaks.k1, undefined, 'a consumer-ended episode starts the next one tight')
  assert.equal(closed.state.streamRequestKeys.s1, undefined)
  let timedOut = reduceCarrier(initialCarrierState(), { kind: 'openingSent', at: 1000, streamId: 's1', requestKey: 'k1' }, env).state
  timedOut = expire(timedOut, 's1', 'k1')
  const kept = reduceCarrier(timedOut, { kind: 'episodeClosed', at: 3000, episodeId: 's1', timedOut: true }, env)
  assert.equal(kept.state.openingStreaks.k1, 1, 'the retry lane inherits the widening it earned')
  let shared = reduceCarrier(initialCarrierState(), { kind: 'openingSent', at: 1000, streamId: 's1', requestKey: 'k1' }, env).state
  shared = expire(shared, 's1', 'k1')
  shared = reduceCarrier(shared, { kind: 'openingSent', at: 2500, streamId: 's2', requestKey: 'k1' }, env).state
  const siblingClosed = reduceCarrier(shared, { kind: 'episodeClosed', at: 3000, episodeId: 's1' }, env)
  assert.equal(siblingClosed.state.openingStreaks.k1, 1, 'a live sibling still owns the key')
})

test('P3: the opening ledger is bounded and evicts oldest-first', () => {
  let state = initialCarrierState()
  const max = env.openingEpisodeKeysMax
  for (let index = 0; index < max + 8; index += 1) {
    const streamId = 's' + String(index)
    const requestKey = 'k' + String(index)
    state = reduceCarrier(state, { kind: 'openingSent', at: 1000 + index, streamId, requestKey }, env).state
    state = reduceCarrier(state, { kind: 'openingExpired', at: 2000 + index, streamId, requestKey, framesSinceSend: 1 }, env).state
  }
  assert.equal(Object.keys(state.openingStreaks).length, max)
  assert.equal(state.openingStreaks.k0, undefined, 'the oldest key is evicted first')
  assert.equal(state.openingStreaks['k' + String(max + 7)], 1)
})
