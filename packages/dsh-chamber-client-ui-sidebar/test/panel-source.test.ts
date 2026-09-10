/**
 * Global panel projection tests (alpha.2 `sidebar.panellist`): the ledger is
 * the authority, the projection is serializable metadata sorted by order with
 * registration order as the tiebreak, and it notifies only on real change.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPanelSource, type SlotsReader } from '../src/client/panel-source.ts'

/** Ledger fake: one list of entries per slot key, wrapped in the ledger's
 *  `{ options }` shape exactly as the slots service stores them. */
function makeSlots(entries: Array<{ id?: string; order?: number; label?: string | (() => string) }>): SlotsReader {
  return {
    entriesOfSlot: key => (key === 'sidebar.panellist' ? entries.map(options => ({ options })) : []),
  }
}

test('projection maps ledger entries to {id, order, label} sorted by order', () => {
  const source = createPanelSource()
  source.sync(makeSlots([
    { id: 'beta', order: 20, label: 'Beta' },
    { id: 'alpha', order: 10, label: 'Alpha' },
  ]))
  assert.deepEqual(
    source.source.getSnapshot().map(panel => [panel.id, panel.order, panel.label]),
    [['alpha', 10, 'Alpha'], ['beta', 20, 'Beta']],
  )
})

test('ties retain registration order and a missing label falls back to the id', () => {
  const source = createPanelSource()
  source.sync(makeSlots([
    { id: 'first', order: 5 },
    { id: 'second', order: 5, label: 'Second' },
  ]))
  assert.deepEqual(
    source.source.getSnapshot().map(panel => [panel.id, panel.label]),
    [['first', 'first'], ['second', 'Second']],
  )
})

test('label thunks are resolved at read time (locale switch re-syncs)', () => {
  const source = createPanelSource()
  let label = 'One'
  source.sync(makeSlots([{ id: 'one', label: () => label }]))
  assert.equal(source.source.getSnapshot()[0]?.label, 'One')
  label = '一'
  source.sync(makeSlots([{ id: 'one', label: () => label }]))
  assert.equal(source.source.getSnapshot()[0]?.label, '一')
})

test('entries without an id are skipped (a list row must name its main key)', () => {
  const source = createPanelSource()
  source.sync(makeSlots([{ order: 1, label: 'orphan' }, { id: '', label: 'blank' }, { id: 'ok' }]))
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
