import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PURGED_REFRESH_MAX_ATTEMPTS,
  PURGED_REFRESH_RETRY_MS,
  filterPurgedRows,
  lingeringPurgedIds,
  reconcilePurgedRows,
  trackArchiveSetShrink,
} from '../src/shared/purged-rows.ts'

const set = (...ids: string[]): Set<string> => new Set(ids)

test('trackArchiveSetShrink: the first observation never arms tombstones', () => {
  // A fresh boot sees the post-purge set as its first fact; its summaries are
  // clean (first list baseline), so nothing must be suppressed.
  const first = trackArchiveSetShrink(undefined, ['a', 'b'])
  assert.deepEqual(first, { archived: ['a', 'b'], removed: [] })
})

test('trackArchiveSetShrink: a strict shrink reports exactly the removed ids', () => {
  const step = trackArchiveSetShrink(['a', 'b', 'c'], ['a', 'c'])
  assert.deepEqual(step.archived, ['a', 'c'])
  assert.deepEqual(step.removed, ['b'])
})

test('trackArchiveSetShrink: growth and unchanged sets report no removals', () => {
  assert.deepEqual(trackArchiveSetShrink(['a'], ['a', 'b']).removed, [])
  assert.deepEqual(trackArchiveSetShrink(['a', 'b'], ['a', 'b']).removed, [])
  assert.deepEqual(trackArchiveSetShrink([], []).removed, [])
})

test('trackArchiveSetShrink: non-string wire ids are stringified before comparison', () => {
  // The wire may carry branded/boxed ids; the shrink diff must compare the
  // STRING projection (the projection layer maps the same way).
  const branded = { toString: () => 'branded-1' }
  const step = trackArchiveSetShrink([String('keep'), 'branded-1'], [String('keep'), String(branded)])
  assert.deepEqual(step.archived, ['keep', 'branded-1'])
  assert.deepEqual(step.removed, [])
  assert.deepEqual(trackArchiveSetShrink(['branded-1'], []) .removed, ['branded-1'])
})

test('reconcilePurgedRows: keeps only still-listed, still-unarchived ids', () => {
  const next = reconcilePurgedRows(
    ['listed-ghost', 'dropped-row', 'rearchived'],
    set('listed-ghost', 'rearchived'),
    set('rearchived'),
  )
  assert.deepEqual(next, ['listed-ghost'])
})

test('reconcilePurgedRows: self-terminates once the official refresh drops the rows', () => {
  const armed = ['g1', 'g2']
  // Before convergence the rows are still listed and unarchived.
  assert.deepEqual(reconcilePurgedRows(armed, set('g1', 'g2', 'live'), set()), ['g1', 'g2'])
  // After a successful official refresh the raw summaries no longer list them.
  assert.deepEqual(reconcilePurgedRows(armed, set('live'), set()), [])
})

test('filterPurgedRows: identity-preserving when nothing matches', () => {
  const rows = [{ sessionId: 'live' }]
  assert.equal(filterPurgedRows(rows, set()), rows)
  assert.equal(filterPurgedRows(rows, set('other')), rows)
})

test('filterPurgedRows: drops tombstoned ids and preserves order', () => {
  const rows = [{ sessionId: 'a' }, { sessionId: 'ghost' }, { sessionId: 'b' }]
  assert.deepEqual(filterPurgedRows(rows, set('ghost')), [{ sessionId: 'a' }, { sessionId: 'b' }])
})

test('lingeringPurgedIds: reports only ids the live summaries still list', () => {
  assert.deepEqual(lingeringPurgedIds(['g1', 'g2'], set('g1', 'live')), ['g1'])
  assert.deepEqual(lingeringPurgedIds(['g1'], set('live')), [])
  assert.deepEqual(lingeringPurgedIds([], set('g1')), [])
})

test('purge lifecycle: arm on shrink, suppress while lingering, drain after convergence', () => {
  let archived: string[] | undefined
  let purged: string[] = []
  // 1. pre-purge baseline: g1/g2 archived and listed.
  let step = trackArchiveSetShrink(archived, ['g1', 'g2'])
  archived = step.archived
  purged = [...purged, ...step.removed]
  assert.deepEqual(purged, [])
  const listed = set('g1', 'g2', 'live')
  assert.deepEqual(reconcilePurgedRows(purged, listed, set(...archived)), [])
  // 2. the purge removes both ids from the set: the shrink arms tombstones.
  step = trackArchiveSetShrink(archived, [])
  archived = step.archived
  purged = [...purged, ...step.removed]
  assert.deepEqual(purged, ['g1', 'g2'])
  assert.deepEqual(reconcilePurgedRows(purged, listed, set(...archived)), ['g1', 'g2'])
  // The emitted rows carry no ghosts even though the raw summaries still do.
  const rows = [{ sessionId: 'g1' }, { sessionId: 'live' }, { sessionId: 'g2' }]
  assert.deepEqual(filterPurgedRows(rows, set(...purged)), [{ sessionId: 'live' }])
  // 3. the official refresh drops the rows -> tombstones drain.
  purged = reconcilePurgedRows(purged, set('live'), set(...archived))
  assert.deepEqual(purged, [])
  assert.equal(filterPurgedRows(rows, set(...purged)), rows)
})

test('purge lifecycle: a re-archived id is never hidden by a stale tombstone', () => {
  const purged = reconcilePurgedRows(['back'], set('back'), set('back'))
  assert.deepEqual(purged, [])
})

test('convergence retry bounds are sane', () => {
  assert.ok(PURGED_REFRESH_MAX_ATTEMPTS >= 1)
  assert.ok(PURGED_REFRESH_RETRY_MS > 0)
})
