/**
 * Completed-dot state machine and publish signatures (part 3 of the derive
 * split): the local reconcile wrapper over reconcileCompletedFacts,
 * instanceSnapshotSignature, runtimeReportSignature/bits, runningRingVisible
 * and serversProjectionSignature stability.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  instanceSnapshotSignature,
  reconcileCompletedFacts,
  runningRingVisible,
  runtimeReportSignature,
  serversProjectionSignature,
} from '../../src/shared/derive.ts'
import type { InstanceRuntimeReport } from '../../src/shared/aggregate-store.ts'
import { server, session, snapshot, workspace } from '../support/derive-fixtures.ts'

// ---- reconcileCompletedFacts (the App-owned completed-dot state machine) ----

function reconcile(
  prevCompleted: Record<string, boolean>,
  prevRunning: Record<string, boolean>,
  sessions: Record<string, { running?: boolean }>,
  readingCurrent: string | undefined,
): { completed: Record<string, boolean>; changed: boolean; running: Record<string, boolean> } {
  const nextRunning: Record<string, boolean> = {}
  for (const [id, row] of Object.entries(sessions)) nextRunning[id] = row?.running === true
  const result = reconcileCompletedFacts({ sessions, nextRunning, prevRunning, prevCompleted, readingCurrent })
  return { ...result, running: nextRunning }
}

test('reconcile arms a running→idle edge of a background session (the vendor stale-selection gap)', () => {
  const out = reconcile({}, { x: true }, { x: { running: false } }, undefined)
  assert.deepEqual(out.completed, { x: true })
  assert.equal(out.changed, true)
})

test('reconcile never arms for a session being read (the active view current)', () => {
  const out = reconcile({}, { x: true }, { x: { running: false } }, 'x')
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, false)
})

test('reconcile arms other sessions while one is being read', () => {
  const out = reconcile({}, { x: true, y: true }, { x: { running: false }, y: { running: false } }, 'x')
  assert.deepEqual(out.completed, { y: true })
})

test('reconcile first observation only records the running bit (no edge yet)', () => {
  const out = reconcile({}, {}, { x: { running: false } }, undefined)
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, false)
})

test('reconcile keeps an armed dot across later idle reports (no re-edge, no re-run)', () => {
  const out = reconcile({ x: true }, { x: false }, { x: { running: false } }, undefined)
  assert.deepEqual(out.completed, { x: true })
  assert.equal(out.changed, false)
})

test('reconcile returns the prevCompleted identity when nothing changes', () => {
  const prev = { x: true }
  const out = reconcile(prev, { x: false }, { x: { running: false } }, undefined)
  assert.equal(out.completed, prev)
})

test('reconcile disarms on re-run', () => {
  const out = reconcile({ x: true }, { x: false }, { x: { running: true } }, undefined)
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, true)
})

test('reconcile disarms when the user starts reading the armed session (active view current)', () => {
  const out = reconcile({ x: true }, { x: false }, { x: { running: false } }, 'x')
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, true)
})

test('reconcile drops the armed dot and the edge memory when the session leaves the list', () => {
  const out = reconcile({ x: true }, { x: false }, {}, undefined)
  assert.deepEqual(out.completed, {})
  assert.equal(out.changed, true)
  assert.deepEqual(out.running, {})
})

test('reconcile composes across reports without losing earlier arms (the batched-updater race)', () => {
  // Report A: x finishes (arms). Report B: y finishes (arms). Both apply to
  // the same base — the functional-updater composition must keep both.
  const stepA = reconcile({}, { x: true }, { x: { running: false }, y: { running: false } }, undefined)
  assert.deepEqual(stepA.completed, { x: true })
  const stepB = reconcile(stepA.completed, { x: false, y: true }, { x: { running: false }, y: { running: false } }, undefined)
  assert.deepEqual(stepB.completed, { x: true, y: true })
})

test('reconcile keeps sibling arms when one session re-runs', () => {
  const out = reconcile({ x: true, y: true }, { x: false, y: false }, { x: { running: true }, y: { running: false } }, undefined)
  assert.deepEqual(out.completed, { y: true })
})

// ---- content signatures (2026-08 perf pass: identity-preserving state) ----

test('instanceSnapshotSignature is stable for identical content and differs on any row change', () => {
  const base = snapshot(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1, { title: 'A' }), session('b', 2, { running: true })],
  )
  const same = snapshot(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1, { title: 'A' }), session('b', 2, { running: true })],
  )
  assert.equal(instanceSnapshotSignature(base), instanceSnapshotSignature(same))
  // A fresh object with the same content is byte-identical — this is exactly
  // the 10s-poll no-change case the App layer must not turn into a re-render.
  const rerun = snapshot(
    [workspace('w1', 'Work', ['a', 'b'])],
    [session('a', 1, { title: 'A' }), session('b', 2, { running: true })],
  )
  assert.equal(instanceSnapshotSignature(base), instanceSnapshotSignature(rerun))
  // Any render-relevant change flips the signature.
  assert.notEqual(instanceSnapshotSignature(base), instanceSnapshotSignature(
    snapshot([workspace('w1', 'Work', ['a'])], [session('a', 1, { title: 'A' }), session('b', 2, { running: true })]),
  ))
  assert.notEqual(instanceSnapshotSignature(base), instanceSnapshotSignature(
    snapshot([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1, { title: 'A' }), session('b', 2, { running: false })]),
  ))
  assert.notEqual(instanceSnapshotSignature(base), instanceSnapshotSignature(
    snapshot([workspace('w1', 'Work', ['a', 'b'])], [session('a', 1, { title: 'A' }), session('b', 3, { running: true })]),
  ))
})

test('runtimeReportSignature distinguishes undefined, content, running bits and subagent counts', () => {
  const a: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }
  const b: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }
  assert.equal(runtimeReportSignature(a), runtimeReportSignature(b))
  assert.equal(runtimeReportSignature(undefined), '')
  assert.notEqual(runtimeReportSignature(undefined), runtimeReportSignature(a))
  // Running bits matter (the App completed-dot reconciliation reads them).
  assert.notEqual(runtimeReportSignature(a), runtimeReportSignature({ current: 's1', sessions: { s1: { running: false }, s2: { completed: true } } }))
  // Insertion order must not matter (the producer emits map order).
  assert.equal(
    runtimeReportSignature({ current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }),
    runtimeReportSignature({ current: 's1', sessions: { s2: { completed: true }, s1: { running: true } } }),
  )
  // Subagent counts are part of the signature (sparse, but visible as rings).
  assert.notEqual(
    runtimeReportSignature({ sessions: { p: { running: false } } }),
    runtimeReportSignature({ sessions: { p: { running: false, runningSubagents: 2 } } }),
  )
  // 运行位活性守卫的 L1 对账回执必须进签名（2026-12）：App 的运行时事实提交按
  // 本签名去重，回执若不入签名，一次「事实未变、只有回执结算」的上报会被整个
  // 丢弃 ⇒ 守卫永远看不到结论，等回执期限（150s）后误判为「对账通道无回执」而假升级。
  const stale: InstanceRuntimeReport = {
    sessions: { p: { running: true } },
    sessionFactReconcile: { requestedAt: 1_000, settledAt: 2_000, ok: true, attempts: 1 },
  }
  assert.notEqual(runtimeReportSignature({ sessions: { p: { running: true } } }), runtimeReportSignature(stale))
  assert.notEqual(runtimeReportSignature(stale), runtimeReportSignature({
    sessions: { p: { running: true } },
    sessionFactReconcile: { requestedAt: 1_000, settledAt: 3_000, ok: false, attempts: 2 },
  }))
  assert.equal(runtimeReportSignature(stale), runtimeReportSignature({
    sessions: { p: { running: true } },
    sessionFactReconcile: { requestedAt: 1_000, settledAt: 2_000, ok: true, attempts: 1 },
  }), '同一份回执必须稳定（不得每次上报都换签名）')
  // 空报告（无行、无 current）但**只有回执**变化时也必须换签名：会话被清空那一瞬
  // 结算的回执不能被「no runtime attached」的早退吞掉（2026-12 二轮复核）。
  assert.notEqual(runtimeReportSignature({
    sessions: {},
    sessionFactReconcile: { requestedAt: 1_000, settledAt: 2_000, ok: true, attempts: 1 },
  }), '', '回执本身就是内容：空报告 + 回执不得退化成「没有运行时事实」')
  assert.equal(runtimeReportSignature({ sessions: {} }), '', '真正没有内容时仍是空签名')
  // Pending kinds drive the amber badges and the design-19 ask/request edges —
  // a pending change MUST re-sign (also with includeRunning=false, the
  // projection-signature mode).
  assert.notEqual(
    runtimeReportSignature({ sessions: { p: { running: false } } }),
    runtimeReportSignature({ sessions: { p: { running: false, pending: 'approval' } } }),
  )
  assert.notEqual(
    runtimeReportSignature({ sessions: { p: { pending: 'approval' } } }, undefined, false),
    runtimeReportSignature({ sessions: { p: { pending: 'question' } } }, undefined, false),
  )
  assert.equal(
    runtimeReportSignature({ sessions: { p: { pending: 'approval' } } }, undefined, false),
    runtimeReportSignature({ sessions: { p: { pending: 'approval' } } }, undefined, false),
  )
})

test('runningRingVisible is poll-only: the channel running bit never renders the ring', () => {
  // 轮询权威:只要轮询位 true,无论通道如何,都显示运行环。
  assert.equal(runningRingVisible(false, true), true)
  assert.equal(runningRingVisible(true, true), true)
  assert.equal(runningRingVisible(undefined, true), true)
  // 通道不参与渲染:通道 true 而轮询 false 时不显示——陈旧通道不得伪造
  // 运行环(2026-08 误报窗口),代价是运行开始的环延迟 ≤ 一个轮询周期。
  assert.equal(runningRingVisible(true, false), false)
  assert.equal(runningRingVisible(true, undefined), false)
  assert.equal(runningRingVisible(false, false), false)
  assert.equal(runningRingVisible(undefined, undefined), false)
})

test('runtimeReportSignature includeRunning=false drops the running bit (projection path only)', () => {
  const runningA: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: true } } }
  const runningB: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: false } } }
  // Default (App runtimeFacts identity + completed-dot state machine): the
  // running bit stays in the signature — the reconciliation reads it.
  assert.notEqual(runtimeReportSignature(runningA), runtimeReportSignature(runningB))
  // Projection path (serversProjectionSignature): a channel-only running flip
  // is ignored — the ring is poll-driven, nothing rendered changes.
  assert.equal(runtimeReportSignature(runningA, undefined, false), runtimeReportSignature(runningB, undefined, false))
  // Rendered facts (completed) still matter in the projection path.
  assert.notEqual(
    runtimeReportSignature({ current: 's1', sessions: { s1: { completed: true } } }, undefined, false),
    runtimeReportSignature({ current: 's1', sessions: { s1: {} } }, undefined, false),
  )
})

test('runtimeReportSignature onlyIds restricts the signature to the given session subset', () => {
  const a: InstanceRuntimeReport = { current: 's1', sessions: { s1: { running: true }, s2: { completed: true } } }
  // A hidden session (absent from onlyIds) flipping its facts does not change
  // the restricted signature — this is what keeps hidden rows (subagent /
  // archived / blank-non-current) from re-rendering the projection.
  assert.equal(
    runtimeReportSignature(a, new Set(['s1'])),
    runtimeReportSignature(
      { current: 's1', sessions: { s1: { running: true }, s2: { completed: true, running: true } } },
      new Set(['s1']),
    ),
  )
  // Different visible subsets yield different signatures.
  assert.notEqual(runtimeReportSignature(a, new Set(['s1'])), runtimeReportSignature(a, new Set(['s2'])))
  // Without onlyIds the full report is compared (the App's runtimeFacts identity).
  assert.notEqual(
    runtimeReportSignature(a),
    runtimeReportSignature({ current: 's1', sessions: { s1: { running: true }, s2: { completed: true, running: true } } }),
  )
})

test('serversProjectionSignature ignores the per-call updatedAt stamp but tracks rendered fields and source ownership', () => {
  const a = [server('local'), server('ssh-r1')]
  const b = [server('local', { updatedAt: 123456789 }), server('ssh-r1', { updatedAt: 987654321 })]
  assert.equal(serversProjectionSignature(a), serversProjectionSignature(b))
  // A same-id authoritative replacement must publish even when every visible
  // field is identical, so source-owned child contexts can retire the old
  // incarnation instead of reusing it.
  assert.notEqual(
    serversProjectionSignature(a),
    serversProjectionSignature([server('local'), server('ssh-r1', { sourceFingerprint: 'b'.repeat(64) })]),
  )
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1')]),
    serversProjectionSignature([server('ssh-r1', { kind: 'gateway' })]),
    'gateway remains a first-class kind in the shared aggregate contract',
  )
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1')]),
    serversProjectionSignature([server('ssh-r1', { transport: 'http' })]),
    'transport is independent from target kind',
  )
  // 托管停机事实是渲染相关的（来源说明行/设置面板文案），必须进发布门——
  // 否则"托管 dsh 停机 + 传输断开"的跃迁被去重、说明行冻结（2026-12 复查 MINOR）。
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1')]),
    serversProjectionSignature([server('ssh-r1', { managedRuntimeDown: true })]),
    'the managed-down fact is render-relevant',
  )
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1', { rawId: 'r1' })]),
    serversProjectionSignature([server('ssh-r1', { rawId: 'other' })]),
    'raw IPC identity is part of the bridge contract',
  )
  // 降级事实同样进发布门（2026-12，05 §4「降级呈现」第二批）：来源行的降级说明与
  // 连接页口径都从这条投影读，缺口单独翻转必须移动签名字节，否则提示冻结在上
  // 一代（例如自愈成功、缺口消失后来源行仍挂着旧警示）。
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1')]),
    serversProjectionSignature([server('ssh-r1', { bootGap: { kind: 'graph-unavailable' } })]),
    'a gap-only flip must republish (the source row renders it)',
  )
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1', { bootGap: { kind: 'graph-unavailable' } })]),
    serversProjectionSignature([server('ssh-r1', { bootGap: { kind: 'required-services-missing', services: ['sidebarRight'] } })]),
    'a different kind (or a different payload) is a different gap',
  )
  assert.equal(
    serversProjectionSignature([server('ssh-r1', { bootGap: { kind: 'graph-unavailable' } })]),
    serversProjectionSignature([server('ssh-r1', { bootGap: { kind: 'graph-unavailable', services: [], injectedBy: [], failedIds: [] } })]),
    'absent and empty structured fields are the same fact (the projection normalizes them)',
  )
  assert.notEqual(
    serversProjectionSignature([server('ssh-r1')]),
    serversProjectionSignature([server('ssh-r1', { dshVersion: '1.2.3' })]),
    'live host version reaches settings consumers',
  )
  // Session-level updatedAt IS part of the signature since the 2026-08
  // updated-mode alignment (updated = manual order + activity promotion): a
  // session's last-activity tick must re-publish the projection so the
  // sidebar's per-account derivation can promote the session.
  assert.notEqual(
    serversProjectionSignature(a),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, updatedAt: 999 }] }] }),
    ]),
  )
  // The same session with the same updatedAt still signs identically.
  assert.equal(
    serversProjectionSignature(a),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: false, updatedAt: 1 }] }] }),
    ]),
  )
  // Runtime facts of sessions NOT visible in the projection (subagent-origin /
  // archived / blank-non-current rows) never re-render the list.
  assert.equal(
    serversProjectionSignature(a),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { runtime: { sessions: { hidden: { running: true } } } }),
    ]),
  )
  // A visible session's CHANNEL running flip does NOT re-render the sidebar
  // (2026-08 fix): the ring is poll-driven (runningRingVisible), so the
  // projection signature excludes the channel running bit — a report whose
  // only change is the running bit yields the same signature.
  assert.equal(
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { runtime: { sessions: { s1: { running: true } } } }),
    ]),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { runtime: { sessions: { s1: { running: false } } } }),
    ]),
  )
  // A visible session's RENDERED fact change still flips the signature.
  assert.notEqual(
    serversProjectionSignature(a),
    serversProjectionSignature([
      server('local'),
      server('ssh-r1', { runtime: { sessions: { s1: { completed: true } } } }),
    ]),
  )
  // Connection / phase / workspaces / runtime changes all flip it.
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local', { connected: false }), server('ssh-r1')]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local', { phase: 'starting' }), server('ssh-r1')]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([
    server('local'),
    server('ssh-r1', { workspaces: [{ id: 'w1', title: 'Work', sessions: [{ id: 's1', title: 'One', displayTitle: 'One', running: true, updatedAt: 1 }] }] }),
  ]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([
    server('local'),
    server('ssh-r1', { runtime: { current: 's1', sessions: { s1: { completed: true } } } }),
  ]))
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('local', { aggregateError: 'boom' }), server('ssh-r1')]))
  // Order of servers matters (source groups are ordered).
  assert.notEqual(serversProjectionSignature(a), serversProjectionSignature([server('ssh-r1'), server('local')]))
})

test('serversProjectionSignature JSON-encodes titles: user-controlled separators cannot forge equality', () => {
  // Two DISTINCT projections whose titles contain the delimiters a joined
  // encoding would have used — JSON escaping keeps them apart (a collision
  // here would make the publish gate silently skip a real change).
  const twoRows = [server('local', {
    workspaces: [{
      id: 'w1',
      title: 'Work',
      sessions: [
        { id: 's1', title: 'a', displayTitle: 'a', running: false },
        { id: 's2', title: 'b', displayTitle: 'b', running: false },
      ],
    }],
  })]
  const forgedSingleRow = [server('local', {
    workspaces: [{
      id: 'w1',
      title: 'Work',
      sessions: [{ id: 's1', title: 'a,0:0,0,s2:b', displayTitle: 'a,0:0,0,s2:b', running: false }],
    }],
  })]
  assert.notEqual(serversProjectionSignature(twoRows), serversProjectionSignature(forgedSingleRow))
  // Identical content on fresh objects still yields identical signatures.
  assert.equal(
    serversProjectionSignature(twoRows),
    serversProjectionSignature([server('local', {
      workspaces: [{
        id: 'w1',
        title: 'Work',
        sessions: [
          { id: 's1', title: 'a', displayTitle: 'a', running: false },
          { id: 's2', title: 'b', displayTitle: 'b', running: false },
        ],
      }],
    })]),
  )
})

