/**
 * Mounted-source store contract (host/mounted-sources-store.ts): ONE authority
 * for "this source's ctx published a complete snapshot". The table used to live
 * in three places at once (rendered useState + ledger ref mirror + reducer
 * lifecycle state); these cases pin the domain operations and the source lock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createMountedSourcesStore } from '../../src/host/mounted-sources-store.ts'

test('mark/withdraw publish one snapshot to render and callbacks alike', () => {
  const store = createMountedSourcesStore()
  assert.deepEqual(store.getSnapshot(), {})
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.mark('a')
  assert.deepEqual(store.getSnapshot(), { a: true }, 'the synchronous read sees the push')
  store.mark('a')
  assert.equal(notifications, 1, 're-marking a mounted source is a no-op')
  store.withdraw('a')
  assert.deepEqual(store.getSnapshot(), {})
  store.withdraw('missing')
  assert.equal(notifications, 2, 'withdrawing an absent source is a no-op')
})

test('retire drops exactly the given ids and stays identity-preserving otherwise', () => {
  const store = createMountedSourcesStore({ a: true, b: true, c: true })
  const before = store.getSnapshot()
  store.retire(['missing'])
  assert.equal(store.getSnapshot(), before, 'no matching id keeps the same table object')
  store.retire(['a', 'c'])
  assert.deepEqual(store.getSnapshot(), { b: true })
})

test('prune returns the dropped ids that drive the snapshotAt lockstep', () => {
  const store = createMountedSourcesStore({ a: true, b: true })
  const dropped = store.prune(new Set(['a']))
  assert.deepEqual([...dropped], ['b'])
  assert.deepEqual(store.getSnapshot(), { a: true })
  assert.deepEqual([...store.prune(new Set(['a']))], [], 'a clean sweep drops nothing')
})

test('the snapshot identity is stable unless membership changes', () => {
  const store = createMountedSourcesStore({ a: true })
  const first = store.getSnapshot()
  store.mark('a')
  store.withdraw('missing')
  assert.equal(store.getSnapshot(), first)
})

test('the App and its hooks keep ONE mounted-source store', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const app = read('../../src/App.tsx')
  assert.match(app, /createMountedSourcesStore/, 'one store instance')
  assert.match(app, /useSyncExternalStore\(mountedSources\.subscribe, mountedSources\.getSnapshot/, 'the render binding subscribes to the store snapshot')
  for (const file of [
    app,
    read('../../src/app-hooks/use-aggregate-refresh.ts'),
    read('../../src/app-hooks/use-bridge-subscriptions.ts'),
    read('../../src/host/source-ledger.ts'),
  ]) {
    assert.doesNotMatch(file, /snapshotSourcesRef|setSnapshotSources/,
      'the ledger ref mirror and its setter must not come back')
  }
})
