/**
 * Echo store contract (host/echo-store.ts): ONE snapshot for the render value
 * and the event-side synchronous read. These cases pin the identity-preserving
 * update contract (a sweep that expires nothing must not notify) and a source
 * lock that the per-ledger state+ref mirrors do not come back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createEchoStore } from '../../src/host/echo-store.ts'

const pendingWorkspace = [{ workspaceId: 'w1', path: '/w', title: 'w', at: 5 }]
const pendingWorkspace2 = [{ workspaceId: 'w1', path: '/w', title: 'w', at: 6 }]
const pendingSession = [{ sessionId: 's1', blank: false, at: 1 }]
const pendingArchive = [{ sessionId: 's1', at: 2 }]
const pendingPlacement = [{ path: '/w', afterWorkspaceId: 'w0', at: 3 }]
const pendingRemoval = [{ workspaceId: 'w1', at: 4 }]

test('the synchronous snapshot is the render value: one write, both readers', () => {
  const store = createEchoStore()
  assert.deepEqual(store.getSnapshot().workspace, {})
  const seen = []
  store.subscribe(() => { seen.push(store.getSnapshot().workspace) })
  store.updateWorkspace({ a: pendingWorkspace })
  assert.deepEqual(store.getSnapshot().workspace, { a: pendingWorkspace }, 'the event-side read sees the write immediately')
  assert.equal(seen.length, 1, 'exactly one notification')
})

test('identity-preserving updates stay silent (a no-op sweep costs no render)', () => {
  const store = createEchoStore()
  const ledger = { a: pendingWorkspace }
  store.updateWorkspace(ledger)
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.updateWorkspace(ledger)
  assert.equal(notifications, 0, 'the same object is not a change')
  store.updateWorkspace({ a: pendingWorkspace2 })
  assert.equal(notifications, 1)
})

test('the echo ledgers are independent fields of one snapshot', () => {
  const store = createEchoStore()
  store.updateSession({ s: pendingSession })
  assert.deepEqual(store.getSnapshot().session, { s: pendingSession })
  assert.deepEqual(store.getSnapshot().archive, {}, 'a session echo must not touch the archive ledger')
  assert.deepEqual(store.getSnapshot().placement, {}, 'nor the placement intent ledger')
  store.updateArchive({ s: pendingArchive })
  assert.deepEqual(store.getSnapshot().archive, { s: pendingArchive })
  assert.deepEqual(store.getSnapshot().workspace, {})
  store.updatePlacement({ p: pendingPlacement })
  assert.deepEqual(store.getSnapshot().placement, { p: pendingPlacement })
  assert.deepEqual(store.getSnapshot().workspace, {}, 'a placement intent must not touch the echo ledger')
  store.updateRemoval({ r: pendingRemoval })
  assert.deepEqual(store.getSnapshot().removal, { r: pendingRemoval })
  assert.deepEqual(store.getSnapshot().placement, { p: pendingPlacement }, 'a removal intent keeps the placement ledger')
  assert.deepEqual(store.getSnapshot().workspace, {}, 'nor does it touch the echo ledger')
})

test('unsubscribed listeners are never called', () => {
  const store = createEchoStore()
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications += 1 })
  unsubscribe()
  store.updateSession({})
  assert.equal(notifications, 0)
})

test('the App and its hooks keep ONE echo store, not per-ledger mirrors', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const app = read('../../src/App.tsx')
  assert.match(app, /const \[echoStore\] = useState\(createEchoStore\)/u,
    'the store is created once as the useState initializer (import + initializer = exactly two mentions)')
  assert.equal(app.match(/\bcreateEchoStore\b/gu)?.length, 2,
    'a second store anywhere (per-ledger mirror, ad-hoc call in the body) would raise this count')
  assert.match(app, /echoStore\.getSnapshot\(\)/, 'event-side reads go through the store snapshot')
  assert.doesNotMatch(app, /workspaceEchoRef|sessionEchoRef|sessionArchiveRef/, 'the mirrored refs must not come back')
  const bridge = read('../../src/app-hooks/use-bridge-subscriptions.ts')
  const aggregates = read('../../src/app-hooks/use-aggregate-refresh.ts')
  for (const file of [bridge, aggregates]) {
    assert.doesNotMatch(file, /workspaceEchoRef|sessionEchoRef|sessionArchiveRef/, 'the hooks must read the store, not a ref mirror')
  }
})
