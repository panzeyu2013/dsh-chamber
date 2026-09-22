/**
 * Action equivalence normalizer.
 *
 * The differential oracle compares an old wiring against a new one; diagnostic
 * wording is expected to differ. These tests pin what the oracle must IGNORE
 * (wording, intra-tick order, added observability) and what it must CATCH
 * (a missing or changed behavioral effect).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { equivalents, normalizeEffect, reasonClassOf } from '../../src/normalize.ts'
import type { RecoveryEffect } from '../../src/state.ts'

test('wording variants fold to one reason class', () => {
  assert.equal(reasonClassOf('socketNoFrame'), 'silent')
  assert.equal(reasonClassOf('silent socket replaced on teardown'), 'silent')
  assert.equal(reasonClassOf('teardownNoFrame'), 'silent')
  assert.equal(reasonClassOf('openingStall'), 'stall')
  assert.equal(reasonClassOf('opening stall'), 'stall')
})

test('an unknown reason maps to itself so a new cause is visible', () => {
  assert.equal(reasonClassOf('a brand new cause'), 'a brand new cause')
})

test('normalization drops diagnostic wording but keeps identity and reason class', () => {
  const rebuilt = normalizeEffect({ e: 'rebuildCarrier', reason: 'socketNoFrame', at: 5 })
  assert.deepEqual(rebuilt, { kind: 'rebuildCarrier', target: 'carrier', reasonClass: 'silent' })
  const reopened = normalizeEffect({ e: 'reopenLogicalStream', streamId: 's-1', reason: 'anything' })
  assert.deepEqual(reopened, { kind: 'reopenLogicalStream', target: 's-1', reasonClass: 'anything' })
})

test('a different semantic reason is a difference even after folding', () => {
  const oldWay: RecoveryEffect[] = [{ e: 'rebuildCarrier', reason: 'socketNoFrame', at: 0 }]
  const newWay: RecoveryEffect[] = [{ e: 'rebuildCarrier', reason: 'laneReconnect', at: 0 }]
  assert.equal(equivalents(oldWay, newWay), false)
})

test('intra-tick ordering of behavioral effects is not a difference', () => {
  const a: RecoveryEffect[] = [
    { e: 'reopenLogicalStream', streamId: 's1', reason: 'r' },
    { e: 'rebuildCarrier', reason: 'socketNoFrame', at: 0 },
  ]
  const b: RecoveryEffect[] = [
    { e: 'rebuildCarrier', reason: 'socketNoFrame', at: 0 },
    { e: 'reopenLogicalStream', streamId: 's1', reason: 'r' },
  ]
  assert.equal(equivalents(a, b), true)
})

test('added observability is allowed; removed observability is not', () => {
  const oldWay: RecoveryEffect[] = [{ e: 'rebuildCarrier', reason: 'socketNoFrame', at: 0 }]
  const plusFact: RecoveryEffect[] = [
    { e: 'rebuildCarrier', reason: 'socketNoFrame', at: 0 },
    { e: 'forensic', name: 'socket-silent', detail: 'new' },
  ]
  assert.equal(equivalents(oldWay, plusFact), true)
  assert.equal(equivalents(plusFact, oldWay), false)
})

test('a missing behavioral effect is always caught', () => {
  const a: RecoveryEffect[] = [
    { e: 'rebuildCarrier', reason: 'socketNoFrame', at: 0 },
    { e: 'reconcileFacts', scope: 'running' },
  ]
  const b: RecoveryEffect[] = [{ e: 'rebuildCarrier', reason: 'socketNoFrame', at: 0 }]
  assert.equal(equivalents(a, b), false)
})
