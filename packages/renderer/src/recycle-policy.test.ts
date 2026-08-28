/**
 * N-ctx reclamation policy (design 05 §4) unit tests — pure Node: the decision
 * functions are dependency-free, so the multi-key-space reap discipline of
 * App.tsx's reclamation effect (registry removal → teardown + active-view
 * fallback + dead-key pruning across the parallel per-instance key spaces) is
 * pinned here; App.tsx just applies the plan.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deadKeys, deadSetKeys, nextActiveView, planViewRecycle, pruneRecordKeys, rawStatusLiveIds } from './recycle-policy.ts'

test('planViewRecycle: removes only mounted views absent from the live registry projection', () => {
  const live = new Set(['local', 'ssh-a'])
  assert.deepEqual(
    planViewRecycle({ mountedViews: ['local', 'ssh-a', 'ssh-b'], liveViewIds: live }).removedViews,
    ['ssh-b'],
    'a removed registry source reaps its mounted view',
  )
  assert.deepEqual(
    planViewRecycle({ mountedViews: ['local', 'ssh-a'], liveViewIds: live }).removedViews,
    [],
    'nothing removed when every mounted view is live',
  )
  assert.deepEqual(
    planViewRecycle({ mountedViews: [], liveViewIds: new Set() }).removedViews,
    [],
    'empty mounted set removes nothing',
  )
  assert.deepEqual(
    planViewRecycle({ mountedViews: ['ssh-a', 'ssh-b'], liveViewIds: new Set(['local']) }).removedViews,
    ['ssh-a', 'ssh-b'],
    'all non-live mounted views reap when the projection shrinks',
  )
})

test('nextActiveView: keeps the fallback and live views; falls back only when the active view is gone', () => {
  const live = new Set(['local', 'ssh-a'])
  const fallback = 'local'
  assert.equal(nextActiveView('local', live, fallback), 'local', 'the fallback view itself is kept')
  assert.equal(nextActiveView('ssh-a', live, fallback), 'ssh-a', 'a live view is kept')
  assert.equal(nextActiveView('ssh-b', live, fallback), 'local', 'a removed active view falls back')
  assert.equal(nextActiveView('local', new Set(['ssh-a']), fallback), 'local',
    'local is kept even when absent from the projection (常驻)')
  assert.equal(nextActiveView('ssh-b', new Set(), fallback), 'local', 'an empty projection falls every non-local view back')
})

test('deadKeys: only keys absent from the live set; undefined/empty records have none', () => {
  const live = new Set(['local', 'ssh-a'])
  assert.deepEqual(deadKeys({ local: 1, 'ssh-a': 2, 'ssh-b': 3 }, live), ['ssh-b'])
  assert.deepEqual(deadKeys({}, live), [])
  assert.deepEqual(deadKeys(undefined, live), [])
  assert.deepEqual(deadKeys({ 'ssh-b': 1 }, new Set(['local'])), ['ssh-b'], 'all dead when nothing is live')
  assert.deepEqual(deadKeys({ local: 1, 'ssh-a': 2 }, live), [], 'fully live record has no dead keys')
})

test('deadSetKeys: same dead-key discipline for Set-backed key spaces', () => {
  const live = new Set(['local', 'ssh-a'])
  assert.deepEqual(deadSetKeys(new Set(['local', 'ssh-a', 'ssh-b']), live), ['ssh-b'])
  assert.deepEqual(deadSetKeys(new Set(), live), [])
  assert.deepEqual(deadSetKeys(new Set(['ssh-b']), new Set(['local'])), ['ssh-b'], 'all dead when nothing is live')
  assert.deepEqual(deadSetKeys(new Set(['local', 'ssh-a']), live), [], 'fully live set has no dead members')
})

test('pruneRecordKeys: prunes dead keys and is identity-preserving when nothing is dead', () => {
  const live = new Set(['local', 'ssh-a'])
  const record = { local: 1, 'ssh-a': 2, 'ssh-b': 3 }
  const pruned = pruneRecordKeys(record, live)
  assert.deepEqual(pruned, { next: { local: 1, 'ssh-a': 2 }, changed: true })
  assert.notEqual(pruned.next, record, 'a prune allocates a fresh record')
  const intact = { local: 1, 'ssh-a': 2 }
  const kept = pruneRecordKeys(intact, live)
  assert.equal(kept.next, intact, 'no dead keys keeps the SAME reference (no re-render)')
  assert.equal(kept.changed, false)
  assert.deepEqual(pruneRecordKeys({}, live), { next: {}, changed: false }, 'empty record is unchanged')
})

test('rawStatusLiveIds: maps the ssh-<id> view ids back to raw registry ids', () => {
  const servers = [
    { id: 'local', kind: 'local' },
    { id: 'ssh-abc', kind: 'ssh' },
    { id: 'ssh-xyz', kind: 'ssh' },
  ]
  assert.deepEqual([...rawStatusLiveIds(servers)], ['local', 'abc', 'xyz'])
  assert.deepEqual([...rawStatusLiveIds([])], [], 'empty projection → no raw ids')
  assert.deepEqual(
    [...rawStatusLiveIds([{ id: 'ssh-a-b', kind: 'ssh' }])],
    ['a-b'],
    'only the 4-char ssh- prefix is stripped',
  )
})
