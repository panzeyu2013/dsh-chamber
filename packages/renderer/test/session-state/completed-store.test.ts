/**
 * Completed-unread store contract (host/completed-store.ts): ONE authority for
 * the blue-dot table (the rendered table, the persisted edge table and the
 * event-side prevLedger read). Pins the equality-aware write and the source
 * lock; the derivation itself is covered by unread-derivation.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createCompletedStore } from '../../src/host/completed-store.ts'

test('seed installs the persisted payload and setSource publishes one snapshot', () => {
  const store = createCompletedStore()
  store.seed({ a: { s1: true } })
  assert.deepEqual(store.getSnapshot(), { a: { s1: true } }, 'the render/persistence read is synchronous')
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.setSource('a', { s1: true })
  assert.equal(notifications, 0, 're-deriving an equal table costs no render')
  store.setSource('a', { s1: true, s2: false })
  assert.deepEqual(store.getSnapshot(), { a: { s1: true, s2: false } })
  assert.equal(notifications, 1)
})

test('dropSource / prune / retire remove exactly their ids', () => {
  const store = createCompletedStore()
  store.seed({ a: { s1: true }, b: { s1: true }, c: { s1: true } })
  const before = store.getSnapshot()
  store.retire(['missing'])
  assert.equal(store.getSnapshot(), before, 'no matching id keeps the same table')
  store.dropSource('a')
  assert.deepEqual(Object.keys(store.getSnapshot()), ['b', 'c'])
  store.dropSource('a')
  store.prune(new Set(['b']))
  assert.deepEqual(Object.keys(store.getSnapshot()), ['b'])
  store.retire(['b'])
  assert.deepEqual(store.getSnapshot(), {})
})

test('the App and the unread hook keep ONE completed store, not a ref mirror', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const app = read('../../src/App.tsx')
  assert.match(app, /createCompletedStore/)
  assert.match(app, /useSyncExternalStore\(completedStore\.subscribe, completedStore\.getSnapshot/)
  const hook = read('../../src/app-hooks/use-unread-notifications.ts')
  assert.match(hook, /completedStore\.setSource\(/)
  assert.match(hook, /completedStore\.getSnapshot\(\)\[/)
  for (const file of [app, hook, read('../../src/host/source-ledger.ts')]) {
    assert.doesNotMatch(file, /edgeLedgerRef|setCompletedBySource/, 'the old render-state + ref pair must not come back')
  }
})
