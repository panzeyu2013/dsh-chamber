/**
 * B2: the prewarm-ledger events (Set-shaped ledgers).
 *
 * The App keeps two Set ledgers - autoPrewarmedRef (origin: this source was
 * prewarmed, not chosen) and prewarmSuppressedRef (retention must not prewarm it
 * again). They cannot be migrated with the assignment-translating view the record
 * ledgers used, because a Set is mutated through METHODS (add/delete), which no
 * property setter can intercept. These events are the mechanism those call sites
 * will dispatch instead, so each one is pinned here BEFORE any call site moves.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createHarvestView,
  createMapLedgerView,
  createSetLedgerView,
  projectAbandonedTargets,
  projectHarvest,
  initialSourceLifecycle,
  projectAutoPrewarmed,
  projectPrewarmSuppressed,
  reduceSource,
} from '../../src/index.ts'
import type { SourceEnv, SourceLifecycleState } from '../../src/index.ts'

const ENV: SourceEnv = { reclaimGraceMs: 60_000, retryableGap: () => true }

function base(): SourceLifecycleState {
  return initialSourceLifecycle({ sourceId: 'remote-1', fingerprint: 'fp' })
}

test('prewarmStarted records the origin flag only', () => {
  const before = reduceSource(base(), { kind: 'mounted', at: 0 }, ENV).state
  const after = reduceSource(before, { kind: 'prewarmStarted' }, ENV).state
  assert.equal(after.autoPrewarmed, true)
  assert.equal(after.prewarmSuppressed, before.prewarmSuppressed, 'suppression is a different question')
  assert.equal(after.mounted, true)
  assert.deepEqual([...projectAutoPrewarmed({ k: after })], ['remote-1'])
})

test('prewarmStarted does not add a hidden-window entry', () => {
  const after = reduceSource(base(), { kind: 'prewarmStarted' }, ENV).state
  assert.equal(after.hiddenSince, null)
})

test('prewarmUnsuppressed lifts suppression without asking for a boot', () => {
  // The retirement path clears suppression for a source it is dropping: it must NOT
  // produce a mount effect (that would boot a source the registry just removed).
  // A suppressed state as retention leaves it: settled, unmounted, hidden past the
  // grace. Built directly so the test is about the EVENT, not about reclaim timing.
  const settled: SourceLifecycleState = {
    ...base(),
    mounted: false,
    boot: { outcome: 'booted' },
    hiddenSince: 0,
    prewarmSuppressed: true,
  }
  const reduction = reduceSource(settled, { kind: 'prewarmUnsuppressed' }, ENV)
  assert.equal(reduction.state.prewarmSuppressed, false)
  assert.deepEqual(reduction.effects, [], 'no mount effect: this is not a user selection')
  assert.deepEqual([...projectPrewarmSuppressed({ k: reduction.state })], [])
})

test('prewarmForgotten drops the origin flag and nothing else', () => {
  // The prune paths (registry sweep, reclaim) drop the origin claim of one source
  // while every other question about it stays open.
  const started = reduceSource(
    reduceSource(base(), { kind: 'mounted', at: 0 }, ENV).state,
    { kind: 'prewarmStarted' },
    ENV,
  ).state
  const forgotten = reduceSource(started, { kind: 'prewarmForgotten' }, ENV)
  assert.equal(forgotten.state.autoPrewarmed, false)
  assert.deepEqual(forgotten.effects, [], 'forgetting is not an action')
  assert.equal(forgotten.state.mounted, true)
  assert.equal(forgotten.state.hiddenSince, started.hiddenSince)
  assert.equal(forgotten.state.prewarmSuppressed, started.prewarmSuppressed)
})

test('the Set view reads from the projection and dispatches on mutation', () => {
  // The adapter is the bridge for the three sweep loops that mutate a Set through
  // METHODS: add/delete must become events, and reads must never be a local copy.
  const state: Record<string, SourceLifecycleState> = { k: { ...base(), autoPrewarmed: true } }
  const events: string[] = []
  const view = createSetLedgerView({
    read: () => projectAutoPrewarmed(state),
    onAdd: (id) => events.push('add:' + id),
    onDelete: (id) => events.push('delete:' + id),
  })
  assert.equal(view.has('remote-1'), true, 'reads project the container')
  assert.equal(view.size, 1)
  view.add('fresh')
  view.delete('remote-1')
  assert.deepEqual(events, ['add:fresh', 'delete:remote-1'], 'one event per mutation')
})

test('the Set view survives delete-during-iteration (the sweep loops)', () => {
  // App/scheduler sweeps do: for (const id of set) if (!live.has(id)) set.delete(id).
  // On a REAL Set that is a generator hazard; on this view the iterator walks a
  // snapshot, so the loop completes and the next read sees the new state.
  // Two sources, neither alive: the sweep must remove BOTH. The hazard is that
  // deleting during iteration invalidates the iterator and one entry is skipped.
  let state: Record<string, SourceLifecycleState> = {
    a: { ...base(), autoPrewarmed: true },
    b: { ...initialSourceLifecycle({ sourceId: 'remote-2', fingerprint: 'fp' }), autoPrewarmed: true },
  }
  const bySourceId = (id: string): string | undefined =>
    Object.keys(state).find((key) => state[key]?.incarnation.sourceId === id)
  const view = createSetLedgerView({
    read: () => projectAutoPrewarmed(state),
    onAdd: () => undefined,
    onDelete: (id) => {
      // Applying the dispatch immediately is what makes the hazard real.
      const key = bySourceId(id)
      if (key === undefined) return
      const next = { ...state }
      delete next[key]
      state = next
    },
  })
  const seen: string[] = []
  for (const id of view) {
    seen.push(id)
    view.delete(id)
  }
  assert.deepEqual(seen.sort(), ['remote-1', 'remote-2'], 'both entries were visited')
  assert.equal(view.size, 0, 'and the sweep removed both (no skipped entry)')
})

test('abandoned carries its target and abandonmentCleared removes the key', () => {
  // The App's ledger is id -> the view it was switched TO, so the projection must
  // reproduce the VALUE, not just the membership.
  const marked = reduceSource(base(), { kind: 'abandoned', target: 'remote-9' }, ENV).state
  assert.equal(marked.abandoned, true)
  assert.equal(marked.abandonedTarget, 'remote-9')
  assert.deepEqual([...projectAbandonedTargets({ k: marked })], [['remote-1', 'remote-9']])
  const cleared = reduceSource(marked, { kind: 'abandonmentCleared' }, ENV).state
  assert.equal(cleared.abandoned, false)
  assert.equal(cleared.abandonedTarget, undefined, 'the key must be gone, not stale')
  assert.deepEqual([...projectAbandonedTargets({ k: cleared })], [])
})

test('the Map view reads the projection and dispatches on mutation', () => {
  let state: Record<string, SourceLifecycleState> = { k: { ...base(), abandoned: true, abandonedTarget: 'remote-9' } }
  const events: string[] = []
  const view = createMapLedgerView({
    read: () => projectAbandonedTargets(state),
    onSet: (id, target) => events.push('set:' + id + '->' + target),
    onDelete: (id) => events.push('delete:' + id),
  })
  assert.equal(view.get('remote-1'), 'remote-9')
  view.set('remote-2', 'remote-9')
  view.delete('remote-1')
  assert.deepEqual(events, ['set:remote-2->remote-9', 'delete:remote-1'])
})

test('an abandoned view is excluded from the reclaim projection after clearing', () => {
  // The sweeps read `size` first and bail early when zero: the cleared state must
  // project an EMPTY map, or the sweep would run forever on stale entries.
  const marked = reduceSource(base(), { kind: 'abandoned', target: 'x' }, ENV).state
  const cleared = reduceSource(marked, { kind: 'abandonmentCleared' }, ENV).state
  assert.equal(projectAbandonedTargets({ a: marked }).size, 1)
  assert.equal(projectAbandonedTargets({ a: cleared }).size, 0)
})

test('the harvest view reads whole records and accepts finished ones', () => {
  // The App reads a record, runs baseline-harvest's pure function, and writes the
  // RESULT back - so the container must accept a whole record (not re-derive it) and
  // an absent source must read as the legacy initial value.
  let state: Record<string, SourceLifecycleState> = {}
  const view = createHarvestView({
    read: () => projectHarvest(state),
    onWrite: (id, record) => {
      const key = Object.keys(state).find((k) => k === id) ?? id
      state = { ...state, [key]: { ...base(), harvest: record } }
    },
    onDelete: (id) => {
      const key = Object.keys(state).find((k) => k === id)
      if (key === undefined) return
      state = { ...state, [key]: { ...state[key]!, harvest: null } }
    },
    initial: () => ({ attempts: 0, mountedAt: 0, retryAt: 0, satisfied: false }),
  })
  assert.deepEqual(view['remote-1'], { attempts: 0, mountedAt: 0, retryAt: 0, satisfied: false },
    'an absent record reads as the legacy initial value, not undefined')
  const started = { attempts: 1, mountedAt: 5_000, retryAt: 125_000, satisfied: false }
  view['remote-1'] = started
  assert.deepEqual(view['remote-1'], started, 'the finished record round-trips')
  assert.deepEqual(Object.keys(projectHarvest(state)), ['remote-1'])
  delete view['remote-1']
  assert.deepEqual(projectHarvest(state), {}, 'delete clears the container entry')
})

test('the two flags are independent (origin vs suppression)', () => {
  let state = base()
  state = reduceSource(state, { kind: 'prewarmStarted' }, ENV).state
  assert.equal(state.prewarmSuppressed, false, 'a prewarmed source is not suppressed')
  state = { ...state, prewarmSuppressed: true }
  const lifted = reduceSource(state, { kind: 'prewarmUnsuppressed' }, ENV).state
  assert.equal(lifted.autoPrewarmed, true, 'lifting suppression must not forget the origin')
})
