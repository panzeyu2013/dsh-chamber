/**
 * Projected-row lookup (search surface): the three search-row derivations used to walk
 * the projected workspaces independently (label, running bit, archived bit).
 * findProjectedRow is now the single traversal; this pins its order contract.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findProjectedRow } from '../../src/client/server-section-model.ts'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'

function aggregate(workspaces: unknown[]): ChamberServerAggregate {
  return { workspaces } as unknown as ChamberServerAggregate
}

test('a projected session resolves with its owning workspace', () => {
  const server = aggregate([
    { id: 'w1', title: 'Work', ungrouped: false, sessions: [{ id: 's1', displayTitle: 'one' }] },
    { id: 'w2', title: 'Other', ungrouped: true, sessions: [{ id: 's2', displayTitle: 'two' }] },
  ])
  const first = findProjectedRow(server, 's1')
  assert.equal(first?.workspace.id, 'w1')
  assert.equal(first?.workspace.ungrouped, false)
  assert.equal(first?.session.displayTitle, 'one')
  const second = findProjectedRow(server, 's2')
  assert.equal(second?.workspace.id, 'w2')
  assert.equal(second?.workspace.ungrouped, true)
})

test('the FIRST projected row wins when an id appears twice', () => {
  // The search derivations always returned the first hit in workspace order; the
  // helper must keep that order (no last-wins surprise when a stale duplicate row
  // lingers in a second group).
  const server = aggregate([
    { id: 'w1', title: 'A', ungrouped: false, sessions: [{ id: 's1', displayTitle: 'first' }] },
    { id: 'w2', title: 'B', ungrouped: false, sessions: [{ id: 's1', displayTitle: 'second' }] },
  ])
  assert.equal(findProjectedRow(server, 's1')?.session.displayTitle, 'first')
})

test('a session outside the projection resolves to undefined', () => {
  const server = aggregate([{ id: 'w1', title: 'A', ungrouped: false, sessions: [] }])
  assert.equal(findProjectedRow(server, 'ghost'), undefined)
  assert.equal(findProjectedRow(aggregate([]), 'ghost'), undefined)
})