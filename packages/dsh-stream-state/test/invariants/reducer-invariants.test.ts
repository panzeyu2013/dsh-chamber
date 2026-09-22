/**
 * Implementation-independent invariants.
 *
 * These are the gates every Phase B node is checked against. They hold for ANY
 * event sequence, so the suite drives a deterministic sweep instead of
 * hand-picked cases; a reducer change that violates one fails here without
 * anyone having to remember the scenario.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reduceCarrier, reduceCarrierSequence } from '../../src/carrier.ts'
import { initialCarrierState } from '../../src/state.ts'
import { CARRIER_ENV } from '../../src/tables.ts'
import type { CarrierEvent, RebuildReason, RecoveryEffect } from '../../src/state.ts'

const env = CARRIER_ENV
const REASONS: readonly RebuildReason[] = ['socketNoFrame', 'openingStall', 'teardownNoFrame', 'laneReconnect', 'handshakeTimeout']

/** Deterministic PRNG - a failing case must reproduce byte for byte. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function randomEvent(random: () => number, at: number): CarrierEvent {
  const roll = random()
  if (roll < 0.35) {
    const reason = REASONS[Math.floor(random() * REASONS.length)]
    return { kind: 'rebuildRequested', at, reason }
  }
  if (roll < 0.5) return { kind: 'carrierOpened', at }
  if (roll < 0.6) return { kind: 'carrierClosed', at }
  if (roll < 0.7) return { kind: 'streamOpened', at, streamId: 's' + String(Math.floor(random() * 3)) }
  if (roll < 0.85) return { kind: 'streamFrame', at }
  if (roll < 0.95) return { kind: 'streamClosed', at, streamId: 's' + String(Math.floor(random() * 3)) }
  return { kind: 'unrecognized' as never, at }
}

function rebuildTimes(effects: readonly RecoveryEffect[]): number[] {
  const out: number[] = []
  for (const effect of effects) if (effect.e === 'rebuildCarrier') out.push(effect.at)
  return out
}

test('totality: no event sequence makes a reducer step throw', () => {
  const random = makeRandom(3735928559)
  let state = initialCarrierState()
  let at = 0
  for (let i = 0; i < 5000; i += 1) {
    at += Math.floor(random() * 2000)
    const step = reduceCarrier(state, randomEvent(random, at), env)
    assert.ok(step.state, 'every step returns a state')
    assert.ok(Array.isArray(step.effects), 'every step returns an effect list')
    state = step.state
  }
})

test('the rebuild window bound holds for any sequence', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const random = makeRandom(seed)
    const events: CarrierEvent[] = []
    let at = 0
    for (let i = 0; i < 400; i += 1) {
      at += Math.floor(random() * 5000)
      events.push(randomEvent(random, at))
    }
    const { effects } = reduceCarrierSequence(initialCarrierState(), events, env)
    const rebuilds = rebuildTimes(effects)
    for (let i = 0; i < rebuilds.length; i += 1) {
      for (let j = i + 1; j < rebuilds.length; j += 1) {
        const earlier = rebuilds[i] as number
        const later = rebuilds[j] as number
        assert.ok(
          later - earlier >= env.minRebuildSpacingMs,
          'seed ' + String(seed) + ': rebuilds ' + String(earlier) + ' and ' + String(later) + ' are too close',
        )
      }
    }
    // Independent mirror of the table bound: no window may hold two rebuilds.
    for (const t of rebuilds) {
      const inWindow = rebuilds.filter((other) => other > t - env.rebuildWindowMs && other <= t)
      assert.ok(inWindow.length <= env.maxRebuildsPerWindow, 'window bound violated at ' + String(t))
    }
  }
})

test('every allowed rebuild is preceded by a request', () => {
  const random = makeRandom(7)
  const events: CarrierEvent[] = []
  let at = 0
  for (let i = 0; i < 300; i += 1) {
    at += Math.floor(random() * 3000)
    events.push(randomEvent(random, at))
  }
  const { effects } = reduceCarrierSequence(initialCarrierState(), events, env)
  const rebuilds = rebuildTimes(effects).length
  const requests = events.filter((event) => event.kind === 'rebuildRequested').length
  assert.ok(rebuilds <= requests, 'no rebuild without a request')
})

test('action idempotence: replaying the same event never doubles a side effect', () => {
  const random = makeRandom(11)
  let state = initialCarrierState()
  let at = 0
  for (let i = 0; i < 800; i += 1) {
    at += Math.floor(random() * 1500)
    const event = randomEvent(random, at)
    const first = reduceCarrier(state, event, env)
    const second = reduceCarrier(first.state, event, env)
    const doubled = second.effects.filter((effect) => effect.e === 'rebuildCarrier').length
    assert.equal(doubled, 0, 'duplicate rebuild for ' + JSON.stringify(event))
    state = second.state
  }
})

test('no exitless spinner: a rebuild request always yields an action or a throttle', () => {
  const random = makeRandom(13)
  let state = initialCarrierState()
  let at = 0
  for (let i = 0; i < 500; i += 1) {
    at += Math.floor(random() * 10000)
    const step = reduceCarrier(state, { kind: 'rebuildRequested', at, reason: 'socketNoFrame' }, env)
    const acted = step.effects.some((effect) => effect.e === 'rebuildCarrier')
    const throttled = step.effects.some((effect) => effect.e === 'throttled')
    assert.ok(acted || throttled, 'a request is either honored or visibly throttled')
    state = step.state
  }
})
