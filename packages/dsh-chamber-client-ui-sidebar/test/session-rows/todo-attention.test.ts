/**
 * deriveTodoAttention tests (sidebar todo area) — node:test. The derivation mirrors the row-level
 * state indicators exactly (pending > runningSubagents > completed > running), gates per-kind on
 * the filters, excludes the session being read (viewing source only), and orders waiting entries
 * before completed ones while preserving the projection scan order.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChamberServerAggregate, ChamberServerWorkspace, InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { deriveTodoAttention, type TodoAttentionFilters } from '@dsh-chamber/dsh-chamber-client-core/todo-attention'

const ALL: TodoAttentionFilters = { completed: true, ask: true, request: true }

/** deriveTodoAttention for the 'local' viewing source (filters default to ALL). */
const run = (
  servers: ChamberServerAggregate[],
  view: { viewingSessionId?: string; filters?: TodoAttentionFilters; offlineUnread?: boolean } = {},
) => deriveTodoAttention(servers, { viewingSourceId: 'local', filters: ALL, ...view })

function session(id: string, extra: { title?: string; running?: boolean; updatedAt?: number } = {}) {
  const title = extra.title ?? `会话 ${id}`
  // The derived row carries the official display label (I3): the ladder over
  // the fixture facts — title, then (no cwd in these fixtures) the row id.
  return {
    id,
    title,
    displayTitle: title !== '' ? title : id,
    running: extra.running,
    updatedAt: extra.updatedAt,
  }
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
  assert.deepEqual(run([server('local', [], undefined)]), [])
  const disconnected = server('r1', [workspace('w', [session('s1')])], {
    current: 's2', sessions: { s1: { completed: true } },
  }, { connected: false })
  assert.deepEqual(run([disconnected]), [])
})

test('a connected source WITHOUT a runtime snapshot yields no entries (defensive branch)', () => {
  // App 只对 connected 来源附加 merged runtime，但存在「connected 但 runtime 尚未到达/为空」的窗口：
  // `runtime === undefined` 显式再查一次是防御纵深（未知 ≠ 待办，不臆造），此用例直击该分支。
  const connectedNoRuntime = server('r1', [workspace('w', [session('s1'), session('s2')])], undefined)
  assert.deepEqual(run([connectedNoRuntime]), [], 'no runtime snapshot → no attention entries')
})

test('completed-but-unread rides the merged dot state (vendor/App union) and its display gates', () => {
  const withCompleted = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: { completed: true } } })
  const entries = run([withCompleted])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'completed')
  assert.equal(entries[0]?.sourceId, 'r1')
  assert.equal(entries[0]?.sessionId, 's1')
  // No merged completed (vendor not armed, no App dot) → no entry.
  const idle = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: {} } })
  assert.deepEqual(run([idle]), [])
  // wire running true alone is NOT a suppress: completed outranks the ring
  // in the row indicators (sessionStateDot order pending > subagents >
  // completed > running) — the vendor-completed/wire-running channel-skew
  // window must not be under-claimed.
  const runningRow = server('r1', [workspace('w', [session('s1', { running: true })])], { sessions: { s1: { running: true, completed: true } } })
  const runningEntries = run([runningRow])
  assert.equal(runningEntries.length, 1)
  assert.equal(runningEntries[0]?.kind, 'completed')
  // …a live background-subagent count does suppress the completed dot
  // (official Rows priority pending > runningSubagents > completed).
  const withSubagents = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: { completed: true, runningSubagents: 2 } } })
  assert.deepEqual(run([withSubagents]), [])
})

test('goal-active completed facts are suppressed like the row dot (v5 §4 single source)', () => {
  const active = { goalId: 'g1', revision: 1, phase: 'active' as const }
  const activeRow = server('r1', [workspace('w', [session('s1')])], {
    sessions: { s1: { completed: true, goal: active } },
  })
  assert.deepEqual(run([activeRow]), [], 'active 相位压制完成条目（activation unknown 也压制，与行尾点同门）')
  // 离开 active 即自愈（paused/blocked/complete 都不压制呈现）。
  for (const phase of ['paused', 'blocked', 'complete'] as const) {
    const healed = server('r1', [workspace('w', [session('s1')])], {
      sessions: { s1: { completed: true, goal: { ...active, phase } } },
    })
    assert.equal(run([healed]).length, 1, phase + ' 不再压制')
  }
  // 明确 null 与 unknown 都不压制（只有 active 压制）。
  const none = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: { completed: true, goal: null } } })
  assert.equal(run([none]).length, 1)
  const unknown = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: { completed: true } } })
  assert.equal(run([unknown]).length, 1)
  // 等待输入条目不受 goal 相位影响（ask/request 面与完成面不同轨）。
  const pending = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: { pending: 'question', goal: active } } })
  assert.equal(run([pending])[0]?.kind, 'question')
  // sessionTodo 三开关语义不变：completed 开关关闭时，paused 条目照样消失。
  assert.deepEqual(
    run([server('r1', [workspace('w', [session('s1')])], { sessions: { s1: { completed: true, goal: { ...active, phase: 'paused' } } } })],
      { filters: { completed: false, ask: true, request: true } }),
    [],
  )
})

test('goal-active suppression covers the offline-unread (row-absent) branch too', () => {
  const noRows = server('r1', [], {
    stale: true,
    sessions: {
      gone: { completed: true, goal: { goalId: 'g1', revision: 1, phase: 'active' } },
      other: { completed: true },
    },
  }, { connected: false })
  assert.deepEqual(run([noRows], { offlineUnread: true }).map(entry => entry.sessionId), ['other'])
})

test('per-kind filters gate entries independently', () => {
  const two = server('r1', [workspace('w', [session('done'), session('ask')])], {
    sessions: { done: { completed: true }, ask: { pending: 'question' } },
  })
  assert.equal(run([two], { filters: { completed: true, ask: false, request: true } }).length, 1)
  const onlyAsk = run([two], { filters: { completed: false, ask: true, request: false } })
  assert.equal(onlyAsk.length, 1)
  assert.equal(onlyAsk[0]?.sessionId, 'ask')
})

test('request filters gate approval AND plan-review; ask gates question', () => {
  const three = server('r1', [workspace('w', [session('approval'), session('plan'), session('question')])], {
    sessions: { approval: { pending: 'approval' }, plan: { pending: 'plan-review' }, question: { pending: 'question' } },
  })
  const requestOnly = run([three], { filters: { completed: false, ask: false, request: true } })
  assert.deepEqual(requestOnly.map(entry => entry.sessionId), ['approval', 'plan'])
  const askOnly = run([three], { filters: { completed: false, ask: true, request: false } })
  assert.deepEqual(askOnly.map(entry => entry.sessionId), ['question'])
})

test('waiting entries outrank completed ones for the same session (row priority mirror)', () => {
  const mixed = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: { pending: 'approval', completed: true } } })
  const entries = run([mixed])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'approval')
})

test('pending outranks a live subagent count too (row priority: pending first)', () => {
  const session1 = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: { pending: 'question', runningSubagents: 3 } } })
  const entries = run([session1])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'question')
})

test('a pending session whose kind gate is off never falls back to a completed entry', () => {
  // The row indicators show the PENDING badge (kind-gates are a strip-only
  // preference) — a completed fallback would claim "completed" for a session
  // the rows present as waiting. Lock the no-fallback semantics.
  const session1 = server('r1', [workspace('w', [session('s1')])], { sessions: { s1: { pending: 'question', completed: true } } })
  assert.deepEqual(run([session1], { filters: { completed: true, ask: false, request: true } }), [])
})

test('the viewing session is excluded only on the viewing source', () => {
  const local = server('local', [workspace('w', [session('cur'), session('other')])], {
    current: 'cur', sessions: { cur: { pending: 'question' }, other: { completed: true } },
  })
  const remote = server('r1', [workspace('w', [session('sameIdAsViewing')])], {
    current: 'x', sessions: { sameIdAsViewing: { pending: 'question' } },
  })
  // The visible sidebar ctx owns 'local': its current session is excluded…
  const entries = run([local, remote], { viewingSessionId: 'cur' })
  assert.deepEqual(entries.map(entry => entry.sessionId), ['sameIdAsViewing', 'other'])
  // …but the SAME session id on another source is not excluded.
  const localOnly = server('local', [workspace('w', [session('cur')])], { current: 'cur', sessions: { cur: { completed: true } } })
  const other = server('r2', [workspace('w', [session('cur')])], { current: 'y', sessions: { cur: { pending: 'approval' } } })
  const both = run([localOnly, other], { viewingSessionId: 'cur' })
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
      c1: { completed: true }, w1ask: { pending: 'question' },
      c2: { completed: true }, w2req: { pending: 'approval' },
    },
  })
  const entries = run([s])
  // 等待类在前（按扫描序 w1ask、w2req），完成未读在后（c1、c2）。
  assert.deepEqual(entries.map(entry => entry.sessionId), ['w1ask', 'w2req', 'c1', 'c2'])
  assert.deepEqual(entries.map(entry => entry.kind), ['question', 'approval', 'completed', 'completed'])
})

test('entries carry the title/workspace/updatedAt presentation facts when present', () => {
  const s = server('local', [workspace('repo-a', [session('s1', { title: '重构 API', updatedAt: 1234 })])], {
    sessions: { s1: { completed: true } },
  })
  const [entry] = run([s])
  assert.equal(entry?.title, '重构 API')
  assert.equal(entry?.displayTitle, '重构 API', 'the official display label rides the entry too (I3)')
  assert.equal(entry?.workspaceTitle, '工作区 repo-a')
  assert.equal(entry?.updatedAt, 1234)
  // An empty title stays empty in the DURABLE field — the component's unnamed
  // copy is no longer reachable for it: the entry carries the official display
  // label (here the row's id, since the derived row has no cwd fact), so the
  // todo strip can never claim 「未命名会话」 for a session the host simply
  // could not title.
  const untitled = server('local', [workspace('w', [session('s2', { title: '' })])], {
    sessions: { s2: { pending: 'question' } },
  })
  const [untitledEntry] = run([untitled])
  assert.equal(untitledEntry?.title, '')
  assert.equal(untitledEntry?.displayTitle, 's2')
})

test('workspace rows without session runtime facts never produce entries (fact == projection row)', () => {
  const s = server('local', [workspace('w', [session('noFacts'), session('withFacts')])], {
    sessions: { withFacts: { completed: true } },
  })
  const entries = run([s])
  assert.deepEqual(entries.map(entry => entry.sessionId), ['withFacts'])
})

// ---- stale facts of a disconnected source (option A + the offline-unread group) ----

test('R14 option A: a disconnected source with rows renders stale-marked facts only', () => {
  const rows = [workspace('w', [session('s1'), session('s2')])]
  // Without the explicit stale marker the rule holds: unknown ≠ attention.
  const unmarked = server('r1', rows, {
    sessions: { s1: { completed: true }, s2: { pending: 'question' } },
  }, { connected: false })
  assert.deepEqual(run([unmarked]), [], 'unmarked disconnected facts must stay invisible')
  // Marked stale (App-side decision): the facts render, every entry labelled.
  const marked = server('r1', rows, {
    stale: true,
    sessions: { s1: { completed: true }, s2: { pending: 'question' } },
  }, { connected: false })
  const entries = run([marked])
  assert.deepEqual(entries.map(entry => [entry.sessionId, entry.kind, entry.stale]), [
    ['s2', 'question', true],
    ['s1', 'completed', true],
  ])
  // The marker comes from the fact, not from the connection bit: a connected
  // source carrying a stale report is labelled too (consumers never lie).
  const connectedStale = server('r1', rows, {
    stale: true,
    sessions: { s1: { completed: true } },
  })
  assert.equal(run([connectedStale])[0]?.stale, true)
  // A connected fresh source keeps the marker absent (today's semantics).
  assert.equal('stale' in (run([server('r1', rows, { sessions: { s1: { completed: true } } })])[0] ?? {}), false)
})

test('R14 row-absent branch: the offline-unread group is opt-in and uses the sessionId fallback label', () => {
  const noRows = server('r1', [], {
    stale: true,
    sessions: { gone: { completed: true } },
  }, { connected: false })
  // Default: row-bound semantics exactly as before (no row ⇒ no entry).
  assert.deepEqual(run([noRows]), [])
  const entries = run([noRows], { offlineUnread: true })
  assert.deepEqual(entries.map(entry => [entry.sessionId, entry.kind, entry.title, entry.displayTitle, entry.stale]), [
    ['gone', 'completed', '', 'gone', true],
  ])
  // The group is UNREAD only: a pending fact on a row-less session is not an
  // offline-unread item (the criterion is about unread; the pending surface
  // remains row-bound until its own design says otherwise).
  const pendingOnly = server('r1', [], {
    stale: true,
    sessions: { asksGone: { pending: 'question' } },
  }, { connected: false })
  assert.deepEqual(run([pendingOnly], { offlineUnread: true }), [])
})

test('R14 row-absent branch: row-present ids never duplicate, and a stale subagent count never suppresses', () => {
  const mixed = server('r1', [workspace('w', [session('s1')])], {
    stale: true,
    sessions: {
      s1: { completed: true },
      gone: { completed: true },
      busyGone: { completed: true, runningSubagents: 2 },
    },
  }, { connected: false })
  const entries = run([mixed], { offlineUnread: true })
  assert.deepEqual(
    entries.map(entry => entry.sessionId),
    ['s1', 'busyGone', 'gone'],
    'row entry once + offline group; a stale subagent count is unknown and must not hide the unread entry',
  )
  // P5：残留计数仍然呈现，但带 stale 标签——用户看到的是「可能过期」，不是被静默吞掉。
  assert.equal(entries.find(entry => entry.sessionId === 'busyGone')?.stale, true)
  // completed gate off ⇒ both the row entry and the offline group disappear.
  assert.deepEqual(run([mixed], { offlineUnread: true, filters: { completed: false, ask: true, request: true } }), [])
  // The option only affects disconnected stale sources; a CONNECTED source with
  // row-less completed facts keeps today's row-bound behavior.
  const connected = server('r1', [workspace('w', [session('s1')])], {
    sessions: { s1: { completed: true }, gone: { completed: true } },
  })
  assert.deepEqual(run([connected], { offlineUnread: true }).map(entry => entry.sessionId), ['s1'])
})

test('R14 row-absent branch: viewing exclusion and waiting-first ordering survive', () => {
  const localStale = server('local', [], {
    stale: true,
    sessions: { cur: { completed: true } },
  }, { connected: false })
  assert.deepEqual(run([localStale], { offlineUnread: true, viewingSessionId: 'cur' }), [])
  assert.deepEqual(
    run([localStale], { offlineUnread: true, viewingSessionId: 'other' }).map(entry => entry.sessionId),
    ['cur'],
  )
  // Waiting entries stay first; the offline group is appended to the completed
  // list in sessionId order.
  const ordered = server('r1', [workspace('w', [session('ask'), session('done')])], {
    stale: true,
    sessions: { ask: { pending: 'question' }, done: { completed: true }, goneB: { completed: true }, goneA: { completed: true } },
  }, { connected: false })
  assert.deepEqual(
    run([ordered], { offlineUnread: true }).map(entry => [entry.sessionId, entry.kind]),
    [['ask', 'question'], ['done', 'completed'], ['goneA', 'completed'], ['goneB', 'completed']],
  )
})
