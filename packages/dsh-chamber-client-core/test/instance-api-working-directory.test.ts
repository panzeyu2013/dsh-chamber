/**
 * unary workingDirectory extraction (design 08 PR2 / P0-2): `session/list`
 * carries the alpha.2 projection in `projections.values`, and the unary row
 * must expose it (SPARSE) so cold/unmounted sources place sessions identically
 * to the mounted producer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchInstanceSnapshot } from '../src/instance-api.ts'

function summary(overrides: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: 's1', updatedAt: 100, running: false, blank: false, ...overrides }
}

function listClient(items: readonly unknown[]) {
  return { session: { list: async () => ({ ok: true as const, value: { items } }) } }
}

test('fetchInstanceSnapshot carries projections.values.workingDirectory (sparse, non-empty strings only)', async () => {
  const snapshot = await fetchInstanceSnapshot(listClient([
    summary({ sessionId: 'projected', cwd: '/repo', projections: { values: { workingDirectory: '/repo/.agents/worktrees/feat' } } }),
    summary({ sessionId: 'empty', cwd: '/repo', projections: { values: { workingDirectory: '' } } }),
    summary({ sessionId: 'number', cwd: '/repo', projections: { values: { workingDirectory: 42 } } }),
    summary({ sessionId: 'absent', cwd: '/repo', projections: { values: {} } }),
    summary({ sessionId: 'no-projections', cwd: '/repo' }),
  ]) as never)
  const byId = new Map(snapshot.sessions.map(row => [row.sessionId, row]))
  assert.equal(byId.get('projected')?.workingDirectory, '/repo/.agents/worktrees/feat')
  assert.equal(byId.get('projected')?.cwd, '/repo', 'the header cwd fact is kept')
  for (const id of ['empty', 'number', 'absent', 'no-projections']) {
    assert.equal(byId.get(id)?.workingDirectory, undefined, `${id} must stay sparse (no fabricated fact)`)
  }
  // No workingDirectory is synthesized by the cwd-derived workspace groups.
  assert.deepEqual(snapshot.workspaces.map(row => row.workspaceId), ['__cwd__:/repo'])
})
