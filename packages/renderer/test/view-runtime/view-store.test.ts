/**
 * View pair store contract (host/view-store.ts): active (selection) and painted
 * (on screen) are ONE authority for render and callbacks. The load-bearing case
 * is retire: an authoritative roster removal must fall back for BOTH fields in
 * the same snapshot, so a callback firing before React commits can never act on
 * a retired view.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createViewStore } from '../../src/host/view-store.ts'

test('select and paint move one field each, publishing once per real change', () => {
  const store = createViewStore('local')
  assert.deepEqual(store.getSnapshot(), { active: 'local', painted: 'local' })
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.select('a')
  assert.deepEqual(store.getSnapshot(), { active: 'a', painted: 'local' }, 'a selection does not paint')
  store.select('a')
  store.paint('local')
  assert.equal(notifications, 1, 're-selecting the same view / painting the current one are no-ops')
  store.paint('a')
  assert.deepEqual(store.getSnapshot(), { active: 'a', painted: 'a' })
  assert.equal(notifications, 2)
})

test('retire falls back BOTH fields in one synchronous snapshot', () => {
  const store = createViewStore('local')
  store.select('a')
  store.paint('a')
  const seen = []
  store.subscribe(() => { seen.push(store.getSnapshot()) })
  store.retire(new Set(['a']), 'local')
  assert.deepEqual(store.getSnapshot(), { active: 'local', painted: 'local' },
    'event callbacks read the fallback immediately, before React commits')
  assert.equal(seen.length, 1, 'active and painted fall back together — no intermediate pair')
})

test('retire leaves a non-retired pair untouched and identity-preserving', () => {
  const store = createViewStore('local')
  store.select('a')
  store.paint('b')
  const before = store.getSnapshot()
  store.retire(new Set(['missing']), 'local')
  assert.equal(store.getSnapshot(), before)
})

test('the App and its hooks keep ONE view store, not render-time ref mirrors', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const app = read('../../src/App.tsx')
  assert.match(app, /createViewStore\(LOCAL_INSTANCE_ID\)/, 'one store instance')
  assert.match(app, /viewStore\.retire\(retired, LOCAL_INSTANCE_ID\)/, 'retirement is one domain operation')
  for (const file of [
    app,
    read('../../src/app-hooks/use-view-scheduler.ts'),
    read('../../src/app-hooks/use-unread-notifications.ts'),
  ]) {
    assert.doesNotMatch(file, /activeViewRef|paintedViewRef|setActiveView|setPaintedView/,
      'the render-time ref mirrors and their setters must not come back')
  }
})
