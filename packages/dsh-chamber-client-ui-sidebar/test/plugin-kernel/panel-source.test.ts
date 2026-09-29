/**
 * Panel projection tests (`sidebar.panellist`): the ledger is the authority, the projection
 * is serializable metadata sorted by order (registration order as the tiebreak) and it notifies only on real change.
 *
 * MUST run through the test-only vendor loader:
 * `src/client/panel-source.ts` VALUE-imports the dsh store engine (`@deepseek-ai/dsh-client-store` →
 * createSnapshotStore, the wiring upstream's ui-sidebar uses), which a plain node run cannot import (unbuilt lib/,
 * vendor-installed zustand/immer). The test loader maps the specifier to `test/support/vendor-store-double.mjs`, a
 * contract-faithful double; production wiring is pinned by a source lock and resolved by `pnpm run build:renderer`.
 *
 *   node --import ./test/support/vendor-register.mjs test/plugin-kernel/panel-source.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPanelSource, type SlotsReader } from '../../src/client/panel-source.ts'

/** Ledger fake: one list of entries per slot key, wrapped in the ledger's `{ options }` shape exactly as stored. */
const makeSlots = (entries: Array<{ id?: string; order?: number; label?: string | (() => string) }>): SlotsReader => ({
  entriesOfSlot: key => (key === 'sidebar.panellist' ? entries.map(options => ({ options })) : []),
})

/** A fresh panel source with one ledger sync applied. */
const synced = (entries: Parameters<typeof makeSlots>[0]) => {
  const source = createPanelSource()
  source.sync(makeSlots(entries))
  return source
}

test('projection maps ledger entries to {id, order, label} sorted by order', () => {
  const source = synced([{ id: 'beta', order: 20, label: 'Beta' }, { id: 'alpha', order: 10, label: 'Alpha' }])
  assert.deepEqual(source.source.getSnapshot().map(panel => [panel.id, panel.order, panel.label]),
    [['alpha', 10, 'Alpha'], ['beta', 20, 'Beta']])
})

test('ties retain registration order and a missing label falls back to the id', () => {
  const source = synced([{ id: 'first', order: 5 }, { id: 'second', order: 5, label: 'Second' }])
  assert.deepEqual(source.source.getSnapshot().map(panel => [panel.id, panel.label]),
    [['first', 'first'], ['second', 'Second']])
})

test('label thunks are resolved at read time (locale switch re-syncs)', () => {
  let label = 'One'
  const source = synced([{ id: 'one', label: () => label }])
  assert.equal(source.source.getSnapshot()[0]?.label, 'One')
  label = '一'
  source.sync(makeSlots([{ id: 'one', label: () => label }]))
  assert.equal(source.source.getSnapshot()[0]?.label, '一')
})

test('entries without an id are skipped (a list row must name its main key)', () => {
  const source = synced([{ order: 1, label: 'orphan' }, { id: '', label: 'blank' }, { id: 'ok' }])
  assert.deepEqual(source.source.getSnapshot().map(panel => panel.id), ['ok'])
})

test('subscribers fire only when the projection actually changes', () => {
  const source = createPanelSource()
  let notifications = 0
  source.source.subscribe(() => { notifications += 1 })
  source.sync(makeSlots([{ id: 'one', order: 1, label: 'One' }]))
  assert.equal(notifications, 1)
  // Identical re-sync (e.g. a locale change with unchanged copy) is a no-op.
  source.sync(makeSlots([{ id: 'one', order: 1, label: 'One' }]))
  assert.equal(notifications, 1)
  // A label change republishes.
  source.sync(makeSlots([{ id: 'one', order: 1, label: 'Uno' }]))
  assert.equal(notifications, 2)
  // Removal republishes an empty list.
  source.sync(makeSlots([]))
  assert.equal(notifications, 3)
  assert.deepEqual(source.source.getSnapshot(), [])
})

test('the observable face stays a plain array that republishes only on real change', () => {
  const panelSource = createPanelSource()
  const { sync } = panelSource
  sync(makeSlots([{ id: 'engine', order: 1, label: 'Engine' }]))
  const snapshot = panelSource.source.getSnapshot()
  assert.ok(Array.isArray(snapshot), 'the projection stays a plain array')
  assert.deepEqual(snapshot.map(panel => panel.id), ['engine'])
  // Notify-on-change survives the engine swap: the engine's set() is called only after the row comparison,
  // so an identical re-sync publishes nothing.
  let notifications = 0
  panelSource.source.subscribe(() => { notifications += 1 })
  sync(makeSlots([{ id: 'engine', order: 1, label: 'Engine' }]))
  assert.equal(notifications, 0)
  sync(makeSlots([{ id: 'engine', order: 1, label: 'Renamed' }]))
  assert.equal(notifications, 1)
})

test('production wiring: the real engine is imported and set() is the only write path', () => {
  // The node run maps the store specifier to a double (see the file header), so
  // the runtime tests above prove the READ semantics and this source lock proves
  // the production wiring: the real engine is imported, set() writes, and no
  // hand-rolled observable replaces it.
  const source = readFileSync(fileURLToPath(new URL('../../src/client/panel-source.ts', import.meta.url)), 'utf8')
  assert.match(source, /import \{ createSnapshotStore \} from '@deepseek-ai\/dsh-client-store'/,
    'panel-source.ts must value-import the dsh store engine, never hand-roll one')
  assert.match(source, /panels\.set\(next\)/, 'set() is the write path (a plain array, never an immer draft)')
  assert.doesNotMatch(source, /panels\.update\(/, 'update() would hand React an immer draft and change what it observes')
  assert.doesNotMatch(source, /new Set\(/, 'a hand-rolled listener Set must never replace the engine observable')
})
