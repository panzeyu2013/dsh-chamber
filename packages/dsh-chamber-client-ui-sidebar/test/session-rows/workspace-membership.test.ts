/**
 * Workspace membership and runtime-fact projection (part 2 of the derive
 * split): workspace/un-grouped buckets, archived hiding, running/updatedAt
 * passthrough, relativeTimeBucket, search-query sanitizing, session order
 * and projectRuntimeFacts/mergeRuntimeFacts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveServerWorkspaces,
  mergeRuntimeFacts,
  projectRuntimeFacts,
  reconciledSessionOrder,
  relativeTimeBucket,
  sanitizeSearchQuery,
  SEARCH_QUERY_MAX_CODE_UNITS,
  UNGROUPED_WORKSPACE_ID,
} from '../../src/shared/derive.ts'
import { session, snapshot, workspace } from '../support/derive-fixtures.ts'

test('subagent sessions are hidden from workspaces and from the ungrouped bucket', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 1), session('b', 2, { origin: 'subagent' })],
    ),
    'srv-a',
    '',
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
})

test('workspace membership maps in sessionIds order with titles from the snapshot', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Alpha', ['s3', 's1', 's2'])],
      [
        session('s1', 10, { title: 'One' }),
        session('s2', 20, { title: 'Two' }),
        session('s3', 30, { title: 'Three' }),
      ],
    ),
    'srv-a',
    '',
  )
  assert.deepEqual(result, [
    {
      id: 'w1',
      title: 'Alpha',
      sessions: [
        { id: 's3', title: 'Three', displayTitle: 'Three', running: false, updatedAt: 30 },
        { id: 's1', title: 'One', displayTitle: 'One', running: false, updatedAt: 10 },
        { id: 's2', title: 'Two', displayTitle: 'Two', running: false, updatedAt: 20 },
      ],
    },
  ])
})

test('visible sessions not accounted by any workspace trail in one ungrouped bucket, recency then id tiebreak', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a'])],
      [
        session('x', 100),
        session('y', 200),
        session('z', 200),
        session('a', 1),
        session('blank-stray', 300, { blank: true }),
        session('sub-stray', 300, { origin: 'subagent' }),
      ],
    ),
    'srv-a',
    '',
  )
  assert.equal(result.length, 2)
  const ungrouped = result[1]
  assert.equal(ungrouped.id, UNGROUPED_WORKSPACE_ID)
  assert.equal(ungrouped.title, '')
  assert.equal(ungrouped.ungrouped, true)
  assert.deepEqual(ungrouped.sessions, [
    { id: 'y', title: '', displayTitle: 'y', running: false, updatedAt: 200 },
    { id: 'z', title: '', displayTitle: 'z', running: false, updatedAt: 200 },
    { id: 'x', title: '', displayTitle: 'x', running: false, updatedAt: 100 },
  ])
})

test('the ungrouped bucket carries the caller-provided title', () => {
  const result = deriveServerWorkspaces(
    snapshot([workspace('w1', 'Work', ['a'])], [session('x', 100), session('a', 1)]),
    'srv-a',
    'Ungrouped',
  )
  assert.equal(result[1].title, 'Ungrouped')
  assert.equal(result[1].ungrouped, true)
})

test('no stray sessions means no ungrouped bucket', () => {
  const result = deriveServerWorkspaces(
    snapshot([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1), session('b', 2)]),
    'srv-a',
    '',
  )
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'w1')
})

test('empty snapshot derives to an empty list', () => {
  assert.deepEqual(deriveServerWorkspaces(snapshot([], []), 'srv-a', ''), [])
})

test('members not present in the session list are skipped without breaking workspace order', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['missing', 'a'])],
      [session('a', 1, { title: 'A' })],
    ),
    'srv-a',
    '',
  )
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: 'A', displayTitle: 'A', running: false, updatedAt: 1 }])
})

test('archived sessions are hidden from workspaces and from the ungrouped bucket', () => {
  const result = deriveServerWorkspaces(
    {
      workspaces: [workspace('w1', 'Work', ['a', 'b'])],
      sessions: [session('a', 1), session('b', 2), session('archived-stray', 3)],
      archivedSessionIds: ['b', 'archived-stray'],
    },
    'srv-a',
    '',
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
  assert.equal(result[0].ungrouped, undefined)
})

test('archived members keep their accounting slot: only non-archived strays surface', () => {
  const result = deriveServerWorkspaces(
    {
      workspaces: [workspace('w1', 'Work', ['a', 'archived'])],
      sessions: [session('a', 1), session('archived', 2), session('x', 3)],
      archivedSessionIds: ['archived'],
    },
    'srv-a',
    '',
  )
  assert.equal(result.length, 2)
  assert.deepEqual(result[0].sessions, [{ id: 'a', title: '', displayTitle: 'a', running: false, updatedAt: 1 }])
  assert.deepEqual(result[1].sessions, [{ id: 'x', title: '', displayTitle: 'x', running: false, updatedAt: 3 }])
})

test('running and updatedAt pass through to workspace members and strays', () => {
  const result = deriveServerWorkspaces(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [
        session('a', 42, { title: 'A', running: true }),
        session('b', 7),
        session('s', 99, { running: true }),
      ],
    ),
    'srv-a',
    '',
  )
  assert.deepEqual(result[0].sessions, [
    { id: 'a', title: 'A', displayTitle: 'A', running: true, updatedAt: 42 },
    { id: 'b', title: '', displayTitle: 'b', running: false, updatedAt: 7 },
  ])
  assert.deepEqual(result[1].sessions, [{ id: 's', title: '', displayTitle: 's', running: true, updatedAt: 99 }])
})

test('relativeTimeBucket boundaries mirror the official relativeTime algorithm', () => {
  const now = 1_000_000_000_000
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  assert.deepEqual(relativeTimeBucket(now - (MIN - 1), now), { unit: 'now', n: 0 })
  assert.deepEqual(relativeTimeBucket(now - MIN, now), { unit: 'minutes', n: 1 })
  assert.deepEqual(relativeTimeBucket(now - (HOUR - 1), now), { unit: 'minutes', n: 59 })
  assert.deepEqual(relativeTimeBucket(now - HOUR, now), { unit: 'hours', n: 1 })
  assert.deepEqual(relativeTimeBucket(now - (DAY - 1), now), { unit: 'hours', n: 23 })
  assert.deepEqual(relativeTimeBucket(now - DAY, now), { unit: 'days', n: 1 })
  assert.deepEqual(relativeTimeBucket(now - (30 * DAY - 1), now), { unit: 'days', n: 29 })
  assert.deepEqual(relativeTimeBucket(now - 30 * DAY, now), { unit: 'months', n: 1 })
  assert.deepEqual(relativeTimeBucket(now - (365 * DAY - 1), now), { unit: 'months', n: 12 })
  assert.deepEqual(relativeTimeBucket(now - 365 * DAY, now), { unit: 'years', n: 1 })
  assert.deepEqual(relativeTimeBucket(now + 5000, now), { unit: 'now', n: 0 })
})

test('sanitizeSearchQuery strips NULs and trims', () => {
  assert.equal(sanitizeSearchQuery('a\0b\0c'), 'abc')
  assert.equal(sanitizeSearchQuery('  hello world\0  '), 'hello world')
  assert.equal(sanitizeSearchQuery(''), '')
  assert.equal(sanitizeSearchQuery('\0\0'), '')
  assert.equal(sanitizeSearchQuery('   '), '')
  assert.equal(sanitizeSearchQuery('\0  \0'), '')
})

test('sanitizeSearchQuery clamps to 500 UTF-16 code units without splitting a surrogate pair', () => {
  const plain = 'a'.repeat(600)
  assert.equal(sanitizeSearchQuery(plain).length, 500)
  assert.equal(sanitizeSearchQuery(plain), 'a'.repeat(500))
  const withPair = 'a'.repeat(499) + '\ud83d\ude00' + 'b'
  const sanitized = sanitizeSearchQuery(withPair)
  assert.equal(sanitized, 'a'.repeat(499))
  assert.equal(sanitized.includes('\ud83d'), false)
  const pairAtBoundary = 'a'.repeat(498) + '\ud83d\ude00' + 'b'.repeat(10)
  assert.equal(sanitizeSearchQuery(pairAtBoundary).length, 500)
  assert.equal(sanitizeSearchQuery(pairAtBoundary), 'a'.repeat(498) + '\ud83d\ude00')
})

test('SEARCH_QUERY_MAX_CODE_UNITS matches the wire schema clamp of 500', () => {
  assert.equal(SEARCH_QUERY_MAX_CODE_UNITS, 500)
})

test('sanitizeSearchQuery respects the SEARCH_QUERY_MAX_CODE_UNITS boundary', () => {
  const atBoundary = 'b'.repeat(SEARCH_QUERY_MAX_CODE_UNITS)
  assert.equal(sanitizeSearchQuery(atBoundary), atBoundary)
  assert.equal(sanitizeSearchQuery(atBoundary + 'b'), atBoundary)
  const withPair = 'b'.repeat(SEARCH_QUERY_MAX_CODE_UNITS - 1) + '\ud83d\ude00' + 'c'
  const sanitized = sanitizeSearchQuery(withPair)
  assert.equal(sanitized, 'b'.repeat(SEARCH_QUERY_MAX_CODE_UNITS - 1))
  assert.equal(sanitized.includes('\ud83d'), false)
})

test('reconciledSessionOrder prefers stored order, then unknown-to-stored wire ids in wire order', () => {
  assert.deepEqual(reconciledSessionOrder(['b', 'a'], ['a', 'b', 'c']), ['b', 'a', 'c'])
  assert.deepEqual(reconciledSessionOrder(['a'], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(reconciledSessionOrder([], ['c', 'a', 'b']), ['c', 'a', 'b'])
})

test('reconciledSessionOrder skips stored ids unknown to the wire', () => {
  assert.deepEqual(reconciledSessionOrder(['x', 'a', 'y'], ['a', 'b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(reconciledSessionOrder(['z'], ['a']), ['a'])
})

test('reconciledSessionOrder edge pairs: empty stored + empty wire stays empty; a stored non-prefix appends the wire remainder in wire order', () => {
  // Nothing on either side — an empty result, no reconciliation work.
  assert.deepEqual(reconciledSessionOrder([], []), [])
  // 'b' is NOT a wire-order prefix (the wire leads with 'a'): the stored-known
  // block still comes first, and the ENTIRE remaining wire (a, c, d) appends
  // in wire order — reconciliation of a scrambled stored order, not a
  // prefix-preserving splice.
  assert.deepEqual(reconciledSessionOrder(['b'], ['a', 'b', 'c', 'd']), ['b', 'a', 'c', 'd'])
})

test('projectRuntimeFacts passes current through and emits every session with its live running bit', () => {
  const report = projectRuntimeFacts({
    current: 's1',
    byId: {
      s1: { running: true, completed: true },
      s2: { running: false },
      s3: { running: true },
      s4: { running: false },
    },
  })
  assert.deepEqual(report, {
    current: 's1',
    sessions: {
      s1: { running: true, completed: true },
      s2: { running: false },
      s3: { running: true },
      s4: { running: false },
    },
  })
})

test('projectRuntimeFacts keeps completed alongside running', () => {
  const report = projectRuntimeFacts({
    byId: {
      c: { running: true, completed: true },
    },
  })
  assert.deepEqual(report.sessions, {
    c: { running: true, completed: true },
  })
  assert.equal(report.current, undefined)
})

test('projectRuntimeFacts projects pending from the ui-session registry (official visiblePendingKind mirror)', () => {
  const report = projectRuntimeFacts(
    {
      byId: {
        a: { running: true },
        b: { running: false },
        c: { running: false },
        d: { running: true },
        e: { running: false },
        f: { running: false },
      },
    },
    undefined,
    new Map([
      ['a', { key: 'k1', kind: 'approval', sessionId: 'a' }],
      ['b', { key: 'k2', kind: 'plan-review', sessionId: 'b' }],
      ['c', { key: 'k3', kind: 'question', sessionId: 'c' }],
      ['d', { key: 'k4', kind: 'unknown-future-kind', sessionId: 'd' }],
      ['missing-row', { key: 'k5', kind: 'approval', sessionId: 'missing-row' }],
    ]),
  )
  // 三个已知 kind 投影为 pending；未知 kind 恒 undefined（未来上游 kind 不得
  // 漏进 UI，与官方 visiblePendingKind 一致）；不在 byId 的会话不产生行。
  assert.deepEqual(report.sessions, {
    a: { running: true, pending: 'approval' },
    b: { running: false, pending: 'plan-review' },
    c: { running: false, pending: 'question' },
    d: { running: true },
    e: { running: false },
    f: { running: false },
  })
})

test('projectRuntimeFacts keeps pending alongside completed and subagent rows stay excluded', () => {
  const report = projectRuntimeFacts(
    {
      current: 's1',
      byId: {
        s1: { running: true, completed: true },
        sub1: { running: false, origin: 'subagent' },
      },
    },
    undefined,
    new Map([
      ['s1', { key: 'k1', kind: 'question', sessionId: 's1' }],
      // 子代理的 pending 不得进入事实报告（通知边沿防刷屏同规）。
      ['sub1', { key: 'k2', kind: 'approval', sessionId: 'sub1' }],
    ]),
  )
  assert.deepEqual(report.sessions, {
    s1: { running: true, completed: true, pending: 'question' },
  })
  assert.equal(report.current, 's1')
})

test('projectRuntimeFacts returns empty sessions for an empty snapshot', () => {
  assert.deepEqual(projectRuntimeFacts({}), { sessions: {} })
  assert.deepEqual(projectRuntimeFacts({ current: 's1' }), { current: 's1', sessions: {} })
})

test('projectRuntimeFacts drops subagent-origin rows (no notification edge / no navigation facts)', () => {
  const report = projectRuntimeFacts({
    current: 's1',
    byId: {
      s1: { running: true },
      sub1: { running: true, origin: 'subagent' },
      sub2: { running: false, completed: true, origin: 'subagent' },
      s2: { running: false, completed: true },
    },
  })
  // subagent 行（无论 running/completed/pending 如何）不进入事实报告——
  // 否则通知边沿会对子代理完成/提问发「未命名会话」通知刷屏。
  assert.deepEqual(report.sessions, {
    s1: { running: true },
    s2: { running: false, completed: true },
  })
  assert.equal(report.current, 's1')
})

test('projectRuntimeFacts treats missing running bits as false (the App edge memory uses === true)', () => {
  const report = projectRuntimeFacts({
    byId: {
      a: {},
      b: { running: undefined },
      c: { completed: false },
    },
  })
  assert.deepEqual(report.sessions, {
    a: { running: false },
    b: { running: false },
    c: { running: false },
  })
})

test('projectRuntimeFacts attaches running subagent counts (sparse, vendor lineage semantics)', () => {
  const subagentRunning = new Map<string, number>([
    ['parent1', 2],
    ['parent2', 1],
  ])
  const report = projectRuntimeFacts({
    current: 'parent1',
    byId: {
      parent1: { running: false },
      parent2: { running: true },
      plain: { running: false },
    },
  }, subagentRunning)
  assert.deepEqual(report, {
    current: 'parent1',
    sessions: {
      parent1: { running: false, runningSubagents: 2 },
      parent2: { running: true, runningSubagents: 1 },
      plain: { running: false },
    },
  })
})

test('projectRuntimeFacts omits runningSubagents without the lineage map or for zero counts', () => {
  const noMap = projectRuntimeFacts({ byId: { a: { running: false } } })
  assert.deepEqual(noMap.sessions.a, { running: false })
  const zero = projectRuntimeFacts({ byId: { a: { running: false } } }, new Map([['a', 0]]))
  assert.deepEqual(zero.sessions.a, { running: false })
  // The count coexists with the sparse completed extra (pending is gone in 0.1.2).
  const combined = projectRuntimeFacts(
    { byId: { a: { running: false, completed: true } } },
    new Map([['a', 3]]),
  )
  assert.deepEqual(combined.sessions.a, { running: false, completed: true, runningSubagents: 3 })
})

// ---- mergeRuntimeFacts (the App's deriveServers runtime union, 06 §4.2) ----

test('mergeRuntimeFacts returns undefined with no report and no armed dots', () => {
  assert.equal(mergeRuntimeFacts(undefined, undefined), undefined)
  assert.equal(mergeRuntimeFacts(undefined, {}), undefined)
  assert.equal(mergeRuntimeFacts(undefined, { x: false }), undefined) // armed=false ignored
})

test('mergeRuntimeFacts passes the report through when no App dots are armed', () => {
  const runtime = {
    current: 's1',
    sessions: {
      s1: { running: true },
      s2: { running: false, completed: true, runningSubagents: 2 },
    },
  }
  assert.deepEqual(mergeRuntimeFacts(runtime, undefined), runtime)
  assert.deepEqual(mergeRuntimeFacts(runtime, {}), runtime)
})

test('mergeRuntimeFacts 刻意丢弃对账回执（投影不得携带守卫内部事实）', () => {
  // 回执是守卫与 App 之间的**原始**通道事实（App 读 setRuntimeFacts 原始态）；一旦
  // 它随投影进入 runtime 面，status 签名/消费点会把内部诊断当作用户可见事实
  // （2026-12 三轮复核要求钉住这条边界）。
  assert.deepEqual(
    mergeRuntimeFacts({
      current: 's1',
      sessions: { s1: { running: true } },
      sessionFactReconcile: { requestedAt: 1, settledAt: 2, ok: false, attempts: 2, verdict: 'stale' },
    }, undefined),
    { current: 's1', sessions: { s1: { running: true } } },
  )
})

test('mergeRuntimeFacts：回执抖动（含 completedBySource=false 显式路径）绝不改动投影', () => {
  const base = { current: 's1', sessions: { s1: { running: true } } }
  const churned = {
    ...base,
    sessionFactReconcile: { requestedAt: 9, settledAt: 10, ok: false, attempts: 2, verdict: 'stale' as const },
  }
  // completedBySource=false 是「该来源未武装陈旧点」的**显式**输入（不是缺席）：
  // 无论哪条路径，回执都不得进入投影面（2026-12 独立复核要求钉住这条边界）。
  const completedInputs: (Record<string, boolean> | undefined)[] = [undefined, {}, { s1: false }]
  for (const completed of completedInputs) {
    assert.deepEqual(
      mergeRuntimeFacts(churned, completed),
      mergeRuntimeFacts(base, completed),
      '回执抖动不得影响投影（含显式 false 路径）',
    )
    assert.ok(
      !('sessionFactReconcile' in (mergeRuntimeFacts(churned, completed) ?? {})),
      '投影绝不携带对账回执',
    )
  }
})

test('mergeRuntimeFacts overlays App-armed dots onto the report rows, preserving live extras', () => {
  const merged = mergeRuntimeFacts(
    {
      current: 's1',
      sessions: {
        s1: { running: false },
        s2: { running: false, pending: 'question', runningSubagents: 1 },
      },
    },
    { s1: true, s3: true, s4: false },
  )
  assert.deepEqual(merged, {
    current: 's1',
    sessions: {
      s1: { running: false, completed: true },              // armed dot overlaid
      s2: { running: false, pending: 'question', runningSubagents: 1 }, // untouched
      s3: { completed: true },                              // armed dot for a session absent from the report
    },
  })
})

test('mergeRuntimeFacts attaches a bare report (empty sessions) even without armed dots', () => {
  assert.deepEqual(mergeRuntimeFacts({ current: 's1', sessions: {} }, undefined), { current: 's1', sessions: {} })
})

