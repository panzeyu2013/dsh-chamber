import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCorrectionMarks } from '@dsh-chamber/dsh-chamber-client-core/session-correction-marks'

test('correction marks: armed before the write, consumed by the first non-running report', () => {
  const marks = createCorrectionMarks(5_000)
  marks.arm(['s1'], 1_000)
  // The first sync after the write may still project running=true (official manager microtask).
  assert.deepEqual(marks.consume({ s1: { running: true } }, 1_001), [])
  assert.equal(marks.size(), 1)
  assert.deepEqual(marks.consume({ s1: { running: false } }, 1_002), ['s1'])
  assert.equal(marks.size(), 0, 'the mark is single-use')
})

test('correction marks: a failed self-check retracts the ids the store never flipped', () => {
  // s1 landed in the store, s2 did not: only s2 could forge provenance on a later host edge.
  const marks = createCorrectionMarks(5_000)
  marks.arm(['s1', 's2'], 0)
  marks.retract(['s2'])
  assert.deepEqual(marks.consume({ s1: { running: false }, s2: { running: false } }, 10), ['s1'])
})

test('correction marks: the lease expires a mark whose edge never arrived', () => {
  const marks = createCorrectionMarks(5_000)
  marks.arm(['s1'], 1_000)
  assert.deepEqual(marks.consume({ s1: { running: false } }, 6_000), [],
    'an expired mark must not tag a later host completion')
  assert.equal(marks.size(), 0)
})

test('correction marks: a disappeared row drops its mark', () => {
  const marks = createCorrectionMarks(5_000)
  marks.arm(['s1'], 0)
  assert.deepEqual(marks.consume({}, 1), [])
  assert.equal(marks.size(), 0)
})

test('correction marks: consume reports only the marked rows', () => {
  const marks = createCorrectionMarks(5_000)
  marks.arm(['s1'], 0)
  assert.deepEqual(marks.consume({ s1: { running: false }, s2: { running: false } }, 1), ['s1'])
})
