/**
 * Carrier lifecycle reducer - behavior contract (node B1 of the refactor plan).
 *
 * The oracle here is the DECIDED semantics, not the current wiring: the audit
 * found that today three entries can replace one socket in a window and that
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
  // call. The retired fork predicate failed safe here; the reducer must too.
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
  // must not hold the carrier hostage: this is the episode-ownership rule that
  // replaces the legacy endpoint-digest key (DIVERGENCE D-4).
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

