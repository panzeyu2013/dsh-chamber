/**
 * Facts store contract (host/facts-store.ts): ONE snapshot for the rendered
 * fact tables and the event-side synchronous read. These cases pin the
 * updater/identity contract and the single `dropSession` retirement path
 * (the App and four hooks used to keep a useState plus a render-time ref
 * mirror and to delete the ref key behind React's back).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createFactsStore } from '../../src/host/facts-store.ts'

test('setSession/setRuntime publish one snapshot to render and callbacks alike', () => {
  const store = createFactsStore()
  assert.deepEqual(store.getSnapshot(), { session: {}, runtime: {} })
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.setSession(prev => ({ ...prev, a: undefined }))
  assert.deepEqual(Object.keys(store.getSnapshot().session), ['a'], 'the synchronous read sees the write')
  store.setRuntime(prev => ({ ...prev, a: undefined }))
  assert.equal(notifications, 2, 'one notification per real change')
})

test('identity-preserving updates stay silent', () => {
  const store = createFactsStore()
  store.setSession(prev => prev)
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.setSession(prev => prev)
  store.setRuntime(prev => prev)
  assert.equal(notifications, 0, 'returning the same table is not a change')
})

test('dropSession is the single retirement path (and is a no-op when absent)', () => {
  const store = createFactsStore()
  store.setSession(prev => ({ ...prev, a: undefined, b: undefined }))
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.dropSession('a')
  assert.deepEqual(Object.keys(store.getSnapshot().session), ['b'])
  assert.equal(notifications, 1)
  store.dropSession('missing')
  assert.equal(notifications, 1, 'a source without a fact row is not a change')
})

test('a dropped source can be re-added from nothing (no stale row survives)', () => {
  const store = createFactsStore()
  store.setSession(prev => ({ ...prev, a: undefined }))
  store.dropSession('a')
  assert.deepEqual(Object.keys(store.getSnapshot().session), [])
  store.setSession(prev => ({ ...prev, a: undefined }))
  assert.deepEqual(Object.keys(store.getSnapshot().session), ['a'])
})

test('the App and its hooks keep ONE facts store, not render-time ref mirrors', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const files = [
    '../../src/App.tsx',
    '../../src/app-hooks/use-aggregate-refresh.ts',
    '../../src/app-hooks/use-bridge-subscriptions.ts',
    '../../src/app-hooks/use-session-facts-lifecycle.ts',
    '../../src/app-hooks/use-unread-notifications.ts',
  ]
  const app = read(files[0])
  assert.match(app, /createFactsStore/, 'one store instance')
  assert.match(app, /factsStore\.getSnapshot\(\)/, 'reads go through the store snapshot')
  // A "previous value" ledger for edge detection (prevRuntimeFactsRef) is not a
  // mirror of the current table; every OTHER facts-shaped ref is a regression —
  // including a prefixed one like the watchdogRuntimeFactsRef this lock once
  // missed because the old pattern was case-sensitive and unanchored.
  const allowedPreviousValueLedgers = new Set(['prevRuntimeFactsRef', 'prevRuntimeFacts'])
  for (const file of files) {
    const hits = read(file).match(/[A-Za-z0-9_$]*(?:sessionFactsRef|runtimeFactsRef|setSessionFacts|setRuntimeFacts)[A-Za-z0-9_$]*/gi) ?? []
    const mirrors = hits.filter(hit => !allowedPreviousValueLedgers.has(hit))
    assert.deepEqual(mirrors, [], file + ': the render-time ref mirrors and their setters must not come back')
  }
})
