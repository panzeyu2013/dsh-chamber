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
  // cwd-derived groups are DISPLAY-ONLY: every row carries the synthetic
  // marker so the sidebar disables its host-scoped mutations (2026-11 fix).
  assert.ok(snapshot.workspaces.every(workspace => workspace.synthetic === true))
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
  assert.equal(snapshot.workspaces[0].synthetic, true)
  assert.deepEqual(snapshot.sessions.map(row => row.sessionId), ['s1', 's2'])
})

test('fetchInstanceSnapshot cwd grouping titles handle Windows separators, trailing slashes and the root', async () => {
  // Grouping keys are the EXACT cwd strings: a Windows drive path and a
  // POSIX path are distinct directories even when their basenames agree, so
  // they must never merge into one group. What the derivation DOES handle is
  // the TITLE presentation: backslash separators ('C:\work\proj' → 'proj'),
  // trailing separators ('/work/proj/' → 'proj'), and the root ('' after the
  // trim falls back to the raw cwd '/' — never an empty title). All three
  // sessions share the default updatedAt, so the stable recency sort keeps
  // insertion order.
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
  assert.equal(snapshot.workspaces.length, 3)
  assert.deepEqual(snapshot.workspaces.map(w => w.title), ['proj', 'proj', '/'])
  assert.deepEqual(snapshot.workspaces.map(w => w.workspaceId), [
    '__cwd__:C:\\work\\proj',
    '__cwd__:/work/proj/',
    '__cwd__:/',
  ])
  assert.deepEqual(snapshot.workspaces.map(w => w.sessionIds), [['s1'], ['s2'], ['s3']])
})
