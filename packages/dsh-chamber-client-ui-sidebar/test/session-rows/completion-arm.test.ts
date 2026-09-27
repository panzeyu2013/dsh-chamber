/**
 * stepCompletionArm — the N-ctx correction arm: the ONLY chamber-side state in
 * the completed-unread model (authority is the vendor's own
 * sessionStatus.completionUnread, carried on the channel row).
 *
 * Invariants pinned here:
 *   1. it never produces a completed bit on its own authority: when the official
 *      bit is set the arm is irrelevant (merge ORs them);
 *   2. row-keyed and never sweeping — only the ctx's mainView-retained `current`
 *      row can arm, and reading one row clears only that row;
 *   3. memory-only signature (no storage, no clock, no watermarks, no facts);
 *   4. no second clearing rule: re-running, reading (source becomes painted with
 *      that row as current), or leaving an authoritative list (source retirement
 *      drops the whole per-source table upstream, so this step never sees it);
 *   5. fail-closed: a stale report never arms, an absent report freezes both tables.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepCompletionArm, type CompletionArmStepInput } from '@dsh-chamber/dsh-chamber-client-core'

const BASE: CompletionArmStepInput = {
  current: 's1',
  rows: { s1: { running: false } },
  painted: false,
  listComplete: true,
  stale: false,
}

function step(
  arms: Record<string, boolean>,
  running: Record<string, boolean>,
  over: Partial<CompletionArmStepInput> = {},
) {
  return stepCompletionArm(arms, running, { ...BASE, ...over })
}

test('arms the hidden source current row on a fresh running→idle edge', () => {
  const next = step({}, { s1: true })
  assert.deepEqual(next.arms, { s1: true })
  assert.deepEqual(next.running, {})
  assert.equal(next.changed, true)
})

test('a steady idle row never arms (arming needs the edge, not the state)', () => {
  const next = step({}, {})
  assert.deepEqual(next.arms, {})
  assert.equal(next.changed, false)
})

test('the painted source is reading: no arm, and an armed current clears', () => {
  assert.deepEqual(step({}, { s1: true }, { painted: true }).arms, {})
  const cleared = step({ s1: true }, { s1: true }, { painted: true })
  assert.deepEqual(cleared.arms, {})
  assert.equal(cleared.changed, true)
})

test('reading does not sweep arms of OTHER rows (no second clearing rule)', () => {
  // Both rows stay in the authoritative list, so only the READ row may clear.
  const next = step({ s2: true }, { s1: true, s2: true }, {
    painted: true,
    current: 's1',
    rows: { s1: { running: false }, s2: { running: false } },
  })
  assert.deepEqual(next.arms, { s2: true })
})

test('re-running clears the arm', () => {
  const next = step({ s1: true }, { s1: true }, { rows: { s1: { running: true } } })
  assert.deepEqual(next.arms, {})
  assert.deepEqual(next.running, { s1: true })
  assert.equal(next.changed, true)
})

test('only the mainView-retained current row can arm (a non-current completion never arms)', () => {
  const next = step({}, { s2: true }, { rows: { s1: { running: false }, s2: { running: false } } })
  assert.deepEqual(next.arms, {})
})

test('no mainView retention (current undefined) never arms', () => {
  const next = step({}, { s1: true }, { current: undefined })
  assert.deepEqual(next.arms, {})
})

test('a stale report is never arm evidence but the edge memory still advances', () => {
  const next = step({}, { s1: true }, { stale: true })
  assert.deepEqual(next.arms, {})
  assert.deepEqual(next.running, {})
  assert.equal(next.changed, true)
})

test('an absent report freezes both tables', () => {
  const next = step({ s1: true }, { s1: true }, { rows: undefined })
  assert.deepEqual(next.arms, { s1: true })
  assert.deepEqual(next.running, { s1: true })
  assert.equal(next.changed, false)
})

test('an authoritative list drops rows that left it, arm and memory together', () => {
  const dropped = step({ s1: true }, { s1: true, s9: true }, { rows: { s9: { running: true } }, listComplete: true })
  assert.deepEqual(dropped.arms, {})
  assert.deepEqual(dropped.running, { s9: true })
  const kept = step({ s1: true }, { s1: true }, { rows: { s9: { running: true } }, listComplete: false })
  assert.deepEqual(kept.arms, { s1: true })
})

test('the step is pure: inputs are never mutated', () => {
  const arms = { s2: true }
  const running = { s1: true }
  const rows = { s1: { running: false } }
  stepCompletionArm(arms, running, { ...BASE, rows })
  assert.deepEqual(arms, { s2: true })
  assert.deepEqual(running, { s1: true })
  assert.deepEqual(rows, { s1: { running: false } })
})
