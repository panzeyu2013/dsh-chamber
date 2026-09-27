/**
 * Completed-point store contract (host/completed-store.ts): ONE authority for
 * the App's N-ctx correction arm — the rendered table and the event-side read.
 * The official completion-unread bit lives on the channel row
 * (uiSession.sessionStatus.completionUnread), so this store is memory-only:
 * never seeded from disk, never persisted. These cases pin the equality-aware
 * write, the retirement paths and the source lock (no seed, no ref mirror).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createCompletedStore } from '../../src/host/completed-store.ts'

test('setSource publishes one snapshot and an equal table costs no render', () => {
  const store = createCompletedStore()
  assert.deepEqual(store.getSnapshot(), {}, 'the correction-arm store starts empty (memory-only)')
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.setSource('a', { s1: true })
  assert.equal(notifications, 1, 'a real change publishes the new source table')
  store.setSource('a', { s1: true })
  assert.equal(notifications, 1, 're-stepping an equal table costs no render')
  store.setSource('a', { s1: true, s2: false })
  assert.equal(notifications, 1, 'true-only equality: a false entry is absent, so this is not a change')
  assert.deepEqual(store.getSnapshot(), { a: { s1: true } }, 'the tables never store false')
  store.setSource('a', { s1: true, s2: true })
  assert.deepEqual(store.getSnapshot(), { a: { s1: true, s2: true } })
  assert.equal(notifications, 2)
})

test('prune / retire remove exactly their ids', () => {
  const store = createCompletedStore()
  store.setSource('a', { s1: true })
  store.setSource('b', { s1: true })
  store.setSource('c', { s1: true })
  const before = store.getSnapshot()
  store.retire(['missing'])
  assert.equal(store.getSnapshot(), before, 'no matching id keeps the same table')
  store.prune(new Set(['b']))
  assert.deepEqual(Object.keys(store.getSnapshot()), ['b'])
  store.retire(['b'])
  assert.deepEqual(store.getSnapshot(), {})
})

test('the App and the notifications hook keep ONE completed store, and it has no seed', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const app = read('../../src/App.tsx')
  assert.ok(app.includes('createCompletedStore'), 'the App owns the one store instance')
  assert.ok(app.includes('useSyncExternalStore(completedStore.subscribe, completedStore.getSnapshot'),
    'render and event callbacks read the same store snapshot')
  const store = read('../../src/host/completed-store.ts')
  assert.ok(!store.includes('seed('),
    'the disk-seeded table must not come back: the official bit is the channel row, the store holds only the memory arm')
  const hook = read('../../src/app-hooks/use-notifications.ts')
  assert.ok(hook.includes('completedStore.setSource('), 'the step writes through the one store')
  assert.ok(hook.includes('completedStore.getSnapshot()['), 'the step reads the synchronous snapshot')
  for (const file of [app, hook, read('../../src/host/source-ledger.ts')]) {
    assert.ok(!/edgeLedgerRef|setCompletedBySource/.test(file), 'the old render-state + ref pair must not come back')
  }
})
