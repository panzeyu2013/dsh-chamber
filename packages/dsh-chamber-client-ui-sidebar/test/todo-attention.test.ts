/**
 * deriveTodoAttention tests (sidebar todo area) — node:test. The derivation
 * must mirror the row-level state indicators exactly (pending >
 * runningSubagents > completed > running), gate per-kind on the filters,
 * exclude the session being read (viewing source only), and order waiting
 * entries before completed ones while preserving the projection scan order.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChamberServerAggregate, ChamberServerWorkspace, InstanceRuntimeReport } from '../src/shared/aggregate-store.ts'
import { deriveTodoAttention, type TodoAttentionFilters } from '../src/shared/todo-attention.ts'

const ALL: TodoAttentionFilters = { completed: true, ask: true, request: true }

function session(id: string, extra: { title?: string; running?: boolean; updatedAt?: number } = {}) {
  return { id, title: extra.title ?? `会话 ${id}`, running: extra.running, updatedAt: extra.updatedAt }
}

function workspace(id: string, sessions: ReturnType<typeof session>[]): ChamberServerWorkspace {
  return { id, title: `工作区 ${id}`, sessions }
}

function server(
  id: string,
  workspaces: ChamberServerWorkspace[],
  runtime: InstanceRuntimeReport | undefined,
  extra: { connected?: boolean } = {},
): ChamberServerAggregate {
  return {
    id,
    sourceFingerprint: id === 'local' ? 'local' : 'a'.repeat(64),
    kind: id === 'local' ? 'local' : 'dsh',
    transport: 'local',
    connected: extra.connected ?? true,
    phase: 'ready',
    label: id,
    workspaces,
    runtime,
    updatedAt: 0,
  }
}

test('an empty projection or a disconnected source yields no entries', () => {
  assert.deepEqual(deriveTodoAttention([server('local', [], undefined)], { viewingSourceId: 'local', filters: ALL }), [])
  const disconnected = server('r1', [workspace('w', [session('s1')])], {
    current: 's2',
    sessions: { s1: { completed: true } },
  }, { connected: false })
  assert.deepEqual(deriveTodoAttention([disconnected], { viewingSourceId: 'local', filters: ALL }), [])
})

test('completed-but-unread rides the merged dot state (vendor/App union) and its display gates', () => {
  const withCompleted = server('r1', [workspace('w', [session('s1')])], {
    sessions: { s1: { completed: true } },
  })
  const entries = deriveTodoAttention([withCompleted], { viewingSourceId: 'local', filters: ALL })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'completed')
  assert.equal(entries[0]?.sourceId, 'r1')
  assert.equal(entries[0]?.sessionId, 's1')
  // No merged completed (vendor not armed, no App dot) → no entry.
  const idle = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: {} } })
  assert.deepEqual(deriveTodoAttention([idle], { viewingSourceId: 'local', filters: ALL }), [])
  // wire running true alone is NOT a suppress: completed outranks the ring
  // in the row indicators (sessionStateDot order pending > subagents >
  // completed > running) — the vendor-completed/wire-running channel-skew
  // window must not be under-claimed.
  const runningRow = server('r1', [workspace('w', [session('s1', { running: true })])], {
    sessions: { s1: { running: true, completed: true } },
  })
  const runningEntries = deriveTodoAttention([runningRow], { viewingSourceId: 'local', filters: ALL })
  assert.equal(runningEntries.length, 1)
  assert.equal(runningEntries[0]?.kind, 'completed')
  // …a live background-subagent count does suppress the completed dot
  // (official Rows priority pending > runningSubagents > completed).
  const withSubagents = server('r1', [workspace('w', [session('s1')])], {
    sessions: { s1: { completed: true, runningSubagents: 2 } },
  })
  assert.deepEqual(deriveTodoAttention([withSubagents], { viewingSourceId: 'local', filters: ALL }), [])
})

test('per-kind filters gate entries independently', () => {
  const two = server('r1', [workspace('w', [session('done'), session('ask')])], {
    sessions: {
      done: { completed: true },
      ask: { pending: 'question' },
    },
  })
  assert.equal(deriveTodoAttention([two], { viewingSourceId: 'local', filters: { completed: true, ask: false, request: true } }).length, 1)
  const onlyAsk = deriveTodoAttention([two], { viewingSourceId: 'local', filters: { completed: false, ask: true, request: false } })
  assert.equal(onlyAsk.length, 1)
  assert.equal(onlyAsk[0]?.sessionId, 'ask')
})

test('request filters gate approval AND plan-review; ask gates question', () => {
  const three = server('r1', [workspace('w', [session('approval'), session('plan'), session('question')])], {
    sessions: {
      approval: { pending: 'approval' },
      plan: { pending: 'plan-review' },
      question: { pending: 'question' },
    },
  })
  const requestOnly = deriveTodoAttention([three], { viewingSourceId: 'local', filters: { completed: false, ask: false, request: true } })
  assert.deepEqual(requestOnly.map(entry => entry.sessionId), ['approval', 'plan'])
  const askOnly = deriveTodoAttention([three], { viewingSourceId: 'local', filters: { completed: false, ask: true, request: false } })
  assert.deepEqual(askOnly.map(entry => entry.sessionId), ['question'])
})

test('waiting entries outrank completed ones for the same session (row priority mirror)', () => {
  const mixed = server('r1', [workspace('w', [session('s1')])], {
    sessions: { s1: { pending: 'approval', completed: true } },
  })
  const entries = deriveTodoAttention([mixed], { viewingSourceId: 'local', filters: ALL })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'approval')
})

test('pending outranks a live subagent count too (row priority: pending first)', () => {
  const session1 = server('r1', [workspace('w', [session('s1')])], {
    sessions: { s1: { pending: 'question', runningSubagents: 3 } },
  })
  const entries = deriveTodoAttention([session1], { viewingSourceId: 'local', filters: ALL })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'question')
})

test('a pending session whose kind gate is off never falls back to a completed entry', () => {
  // The row indicators show the PENDING badge (kind-gates are a strip-only
  // preference) — a completed fallback would claim "completed" for a session
  // the rows present as waiting. Lock the no-fallback semantics.
  const session1 = server('r1', [workspace('w', [session('s1')])], {
    sessions: { s1: { pending: 'question', completed: true } },
  })
  assert.deepEqual(
    deriveTodoAttention([session1], { viewingSourceId: 'local', filters: { completed: true, ask: false, request: true } }),
    [],
  )
})

test('the viewing session is excluded only on the viewing source', () => {
  const local = server('local', [workspace('w', [session('cur'), session('other')])], {
    current: 'cur',
    sessions: { cur: { pending: 'question' }, other: { completed: true } },
  })
  const remote = server('r1', [workspace('w', [session('sameIdAsViewing')])], {
    current: 'x',
    sessions: { sameIdAsViewing: { pending: 'question' } },
  })
  // The visible sidebar ctx owns 'local': its current session is excluded…
  const entries = deriveTodoAttention([local, remote], { viewingSourceId: 'local', viewingSessionId: 'cur', filters: ALL })
  assert.deepEqual(entries.map(entry => entry.sessionId), ['sameIdAsViewing', 'other'])
  // …but the SAME session id on another source is not excluded.
  const localOnly = server('local', [workspace('w', [session('cur')])], {
    current: 'cur',
    sessions: { cur: { completed: true } },
  })
  const other = server('r2', [workspace('w', [session('cur')])], {
    current: 'y',
    sessions: { cur: { pending: 'approval' } },
  })
  const both = deriveTodoAttention([localOnly, other], { viewingSourceId: 'local', viewingSessionId: 'cur', filters: ALL })
  assert.deepEqual(both.map(entry => entry.sessionId), ['cur'])
  assert.equal(both.length, 1)
  assert.equal(both[0]?.sourceId, 'r2')
})

test('ordering: waiting first, completed after; both keep the projection scan order', () => {
  const s = server('local', [
    workspace('w1', [session('c1', { title: '完成一' }), session('w1ask', { title: '提问一' })]),
    workspace('w2', [session('c2', { title: '完成二' }), session('w2req', { title: '批准一' })]),
  ], {
    sessions: {
      c1: { completed: true },
      w1ask: { pending: 'question' },
      c2: { completed: true },
      w2req: { pending: 'approval' },
    },
  })
  const entries = deriveTodoAttention([s], { viewingSourceId: 'local', filters: ALL })
  // 等待类在前（按扫描序 w1ask、w2req），完成未读在后（c1、c2）。
  assert.deepEqual(entries.map(entry => entry.sessionId), ['w1ask', 'w2req', 'c1', 'c2'])
  assert.deepEqual(entries.map(entry => entry.kind), ['question', 'approval', 'completed', 'completed'])
})

test('entries carry the title/workspace/updatedAt presentation facts when present', () => {
  const s = server('local', [workspace('repo-a', [session('s1', { title: '重构 API', updatedAt: 1234 })])], {
    sessions: { s1: { completed: true } },
  })
  const [entry] = deriveTodoAttention([s], { viewingSourceId: 'local', filters: ALL })
  assert.equal(entry?.title, '重构 API')
  assert.equal(entry?.workspaceTitle, '工作区 repo-a')
  assert.equal(entry?.updatedAt, 1234)
  // An empty title stays empty — the component falls back to its own copy.
  const untitled = server('local', [workspace('w', [session('s2', { title: '' })])], {
    sessions: { s2: { pending: 'question' } },
  })
  assert.equal(deriveTodoAttention([untitled], { viewingSourceId: 'local', filters: ALL })[0]?.title, '')
})

test('workspace rows without session runtime facts never produce entries (fact == projection row)', () => {
  const s = server('local', [workspace('w', [session('noFacts'), session('withFacts')])], {
    sessions: { withFacts: { completed: true } },
  })
  const entries = deriveTodoAttention([s], { viewingSourceId: 'local', filters: ALL })
  assert.deepEqual(entries.map(entry => entry.sessionId), ['withFacts'])
})
