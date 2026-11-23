/**
 * derive.ts runtime-facts completion-failure contract (design 14 §D4; alpha.1
 * `sessionStatus.completionFailed`): the official failure bit rides the SEVENTH
 * projection argument of `projectRuntimeFacts` and writes the row field
 * SPARSELY (`failed: true` only; absent = no such fact). The presentation read
 * is the sidebar's typed `failedFactOf`; the notification edge never reads it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectRuntimeFacts } from '../src/derive.ts'

const EMPTY_ROW = { running: false, subagentActivity: 'unknown' } as const

test('statusFailed writes failed:true per existing row and never invents rows', () => {
  const report = projectRuntimeFacts(
    { byId: { a: { running: false }, b: { running: true }, ghost: { running: false } } },
    undefined, undefined, undefined, undefined,
    new Set(['a', 'ghost']), new Set(['b', 'missing']),
  )
  assert.deepEqual(report.sessions.a, { ...EMPTY_ROW, completed: true }, 'completed-only rows stay failed-free')
  assert.deepEqual(report.sessions.b, { running: true, failed: true, subagentActivity: 'unknown' },
    'failed rides independently of the completed bit')
  assert.equal(Object.hasOwn(report.sessions.ghost, 'failed'), false, 'sparse: absent, never false')
  assert.equal('missing' in report.sessions, false, 'an id without a row (subagent/purged/filtered) takes no fact')
})

test('absent statusFailed leaves every row byte-compatible (no failed key, no false writes)', () => {
  const report = projectRuntimeFacts({ byId: { a: { running: false } } })
  assert.deepEqual(report.sessions.a, EMPTY_ROW)
  assert.equal(Object.hasOwn(report.sessions.a, 'failed'), false)
})

test('subagent rows take no failure fact (navigation/notification parity)', () => {
  const report = projectRuntimeFacts(
    { byId: { child: { running: false, origin: 'subagent' } } },
    undefined, undefined, undefined, undefined, undefined, new Set(['child']),
  )
  assert.deepEqual(report.sessions, {})
})

test('both official bits land on one row without clearing each other', () => {
  const report = projectRuntimeFacts(
    { byId: { a: { running: false } } },
    undefined, undefined, undefined, undefined,
    new Set(['a']), new Set(['a']),
  )
  assert.deepEqual(report.sessions.a, { ...EMPTY_ROW, completed: true, failed: true })
})
