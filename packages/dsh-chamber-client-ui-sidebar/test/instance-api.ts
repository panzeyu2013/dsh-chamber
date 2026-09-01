import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchInstanceSnapshot } from '../src/shared/instance-api.ts'

/** One wire summary row (SessionSummary shape the unary client decodes). */
function summary(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: 's1',
    updatedAt: 100,
    running: false,
    blank: false,
    ...overrides,
  }
}

test('fetchInstanceSnapshot derives workspace groups from session cwd facts', async () => {
  const client = {
    session: {
      list: async () => ({
        ok: true as const,
        value: {
          items: [
            summary({ sessionId: 's1', cwd: '/work/a', updatedAt: 300, running: true }),
            summary({ sessionId: 's2', cwd: '/work/a', updatedAt: 200 }),
            summary({ sessionId: 's3', cwd: '/work/b', updatedAt: 400 }),
            summary({ sessionId: 's4' }), // no cwd → ungrouped
            summary({ sessionId: 'sub', origin: 'subagent', cwd: '/work/a' }),
          ],
        },
      }),
    },
  }
  const snapshot = await fetchInstanceSnapshot(client as never)
  // Groups ordered by newest session (/work/b has s3@400 first).
  assert.equal(snapshot.workspaces.length, 2)
  assert.deepEqual(snapshot.workspaces.map(w => w.title), ['b', 'a'])
  assert.equal(snapshot.workspaces[0].sessionIds.join(','), 's3')
  assert.equal(snapshot.workspaces[1].sessionIds.join(','), 's1,s2')
  // Subagent rows never surface.
  assert.deepEqual(snapshot.sessions.map(row => row.sessionId), ['s1', 's2', 's3', 's4'])
  // Archive set has no unary wire source — documented degradation.
  assert.deepEqual(snapshot.archivedSessionIds, [])
})

test('fetchInstanceSnapshot surfaces no-cwd sessions ungrouped and keeps wire rows', async () => {
  const client = {
    session: {
      list: async () => ({
        ok: true as const,
        value: { items: [summary({ sessionId: 's1' }), summary({ sessionId: 's2', cwd: '/x' })] },
      }),
    },
  }
  const snapshot = await fetchInstanceSnapshot(client as never)
  assert.equal(snapshot.workspaces.length, 1)
  assert.equal(snapshot.workspaces[0].title, 'x')
  assert.deepEqual(snapshot.workspaces[0].sessionIds, ['s2'])
  assert.deepEqual(snapshot.sessions.map(row => row.sessionId), ['s1', 's2'])
})

test('fetchInstanceSnapshot cwd grouping handles Windows separators and trailing slashes', async () => {
  const client = {
    session: {
      list: async () => ({
        ok: true as const,
        value: {
          items: [
            summary({ sessionId: 's1', cwd: 'C:\\work\\proj' }),
            summary({ sessionId: 's2', cwd: '/work/proj/' }),
            summary({ sessionId: 's3', cwd: '/' }),
          ],
        },
      }),
    },
  }
  const snapshot = await fetchInstanceSnapshot(client as never)
  assert.equal(snapshot.workspaces.length, 2)
  assert.deepEqual(snapshot.workspaces.map(w => w.title), ['proj', '/'])
  assert.deepEqual(snapshot.workspaces[0].sessionIds, ['s1'])
  assert.deepEqual(snapshot.workspaces[1].sessionIds, ['s3'])
})
