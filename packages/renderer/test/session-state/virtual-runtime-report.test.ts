/**
 * 无 ctx 来源的判定侧投影（读回退）。
 *
 * 钉死四件事：① 不可判快照不投影（verdict/serviceable）；② stale 快照仍投影但标 stale
 * （臂要冻结输入，边沿自行关闭）；③ listComplete 只认 baselines（缺席 = false，绝不由
 * 行数推断）；④ 行白名单（running/pending/beforeBaseline，其余一律不投影）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { virtualRuntimeReport } from '../../src/virtual-runtime-report.ts'
import { applySessionFactsDelta, type SessionFactsSnapshot } from '../../src/session-facts-source.ts'
import {
  completionIdentity, factsChannelOf, observeSource, type SourceObservationState,
} from '../../src/completion-observation.ts'
import { stepCompletionArm } from '@dsh-chamber/dsh-chamber-client-core'

function snapshot(over: Partial<SessionFactsSnapshot> = {}): SessionFactsSnapshot {
  return {
    verdict: 'ok',
    degradation: null,
    mode: 'sse',
    hostState: 'ready',
    serviceable: true,
    stale: false,
    cursor: 1,
    lastEventAt: null,
    baselines: 1,
    rows: {
      s1: {
        sessionId: 's1',
        running: false,
        pendingKind: 'approval',
        subagentCount: 0,
        updatedAt: 5,
        completedAt: null,
        completedAtSource: null,
        lastTurnEnd: null,
        factAt: 5,
      },
    },
    ...over,
  }
}

test('no snapshot / non-ok verdict / unserviceable host never projects', () => {
  assert.equal(virtualRuntimeReport(undefined), undefined)
  assert.equal(virtualRuntimeReport(snapshot({ verdict: 'degraded', degradation: 'forward-skew' })), undefined)
  assert.equal(virtualRuntimeReport(snapshot({ serviceable: false })), undefined)
})

test('a stale-but-renderable snapshot still projects, flagged stale (arm freeze input)', () => {
  const report = virtualRuntimeReport(snapshot({ stale: true }))
  assert.ok(report)
  assert.equal(report.stale, true)
  assert.equal(report.sessions.s1?.running, false)
})

test('listComplete/listKnown come only from the baselines counter', () => {
  assert.equal(virtualRuntimeReport(snapshot())?.listComplete, true)
  assert.equal(virtualRuntimeReport(snapshot({ baselines: 2 }))?.listComplete, true)
  assert.equal(virtualRuntimeReport(snapshot({ baselines: undefined }))?.listComplete, false)
  assert.equal(virtualRuntimeReport(snapshot({ baselines: 0 }))?.listComplete, false)
  // listKnown = 计数器在场（未知 ≠ 未就绪）：缺席 = false，0 是"已知未就绪"。
  assert.equal(virtualRuntimeReport(snapshot({ baselines: undefined }))?.listKnown, false)
  assert.equal(virtualRuntimeReport(snapshot({ baselines: 0 }))?.listKnown, true)
  assert.equal(virtualRuntimeReport(snapshot({ baselines: 2 }))?.listKnown, true)
})

test('the projected row is a white-listed shell subset (pending / beforeBaseline)', () => {
  const report = virtualRuntimeReport(snapshot({
    rows: {
      s1: { ...snapshot().rows.s1!, pendingKind: null, firstSeenByDelta: true },
    },
  }))
  assert.deepEqual(Object.keys(report!.sessions.s1!).sort(), ['beforeBaseline', 'running'])
  assert.equal(report!.sessions.s1!.pending, undefined)
  assert.equal(report!.sessions.s1!.beforeBaseline, true)
  const withPending = virtualRuntimeReport(snapshot())
  assert.deepEqual(Object.keys(withPending!.sessions.s1!).sort(), ['pending', 'running'])
  assert.equal(withPending!.sessions.s1!.pending, 'approval')
})

test('S4/T2 composition: a poll-mode snapshot with baselines>=1 gives listComplete=true and clears the arm on removal', () => {
  // T2 修的是 poll 档：旧实现 wire diagnostics.baselines 只认 mux reconcile 计数（poll 恒 0），
  // listComplete 永假 ⇒ 已完成且随后离表的行残留蓝点。这里用真实 delta + 臂模块钉住组合语义。
  const seeded = snapshot({
    mode: 'poll',
    baselines: 1,
    cursor: 10,
    rows: { s1: { ...snapshot().rows.s1!, pendingKind: null, running: true } },
  })
  const seedReport = virtualRuntimeReport(seeded)!
  assert.equal(seedReport.listComplete, true, 'poll 档 baselines≥1 必须给出 listComplete')
  const seed = stepCompletionArm({}, {}, {
    current: undefined, rows: seedReport.sessions, painted: false,
    listComplete: seedReport.listComplete, listKnown: seedReport.listKnown, stale: seedReport.stale, factsOnly: true,
  })
  assert.deepEqual(seed.arms, {}, 'a running row arms nothing')
  // true→false → 武装（离表清臂的前置）。
  const stopped = applySessionFactsDelta(seeded, { cursor: 11, sessions: [{ sessionId: 's1', running: false, updatedAt: 5 }] })
  const stoppedReport = virtualRuntimeReport(stopped.next!)!
  const armed = stepCompletionArm(seed.arms, seed.running, {
    current: undefined, rows: stoppedReport.sessions, painted: false,
    listComplete: stoppedReport.listComplete, listKnown: stoppedReport.listKnown, stale: stoppedReport.stale, factsOnly: true,
  })
  assert.deepEqual(armed.arms, { s1: true })
  // 离表：poll 档同样清臂（同一闩锁）。
  const gone = applySessionFactsDelta(stopped.next!, { cursor: 12, sessions: [], removedSessionIds: ['s1'] })
  const goneReport = virtualRuntimeReport(gone.next!)!
  const cleared = stepCompletionArm(armed.arms, armed.running, {
    current: undefined, rows: goneReport.sessions, painted: false,
    listComplete: goneReport.listComplete, listKnown: goneReport.listKnown, stale: goneReport.stale, factsOnly: true,
  })
  assert.deepEqual(cleared.arms, {}, 'poll 档离表清臂生效（T2 的验收点）')
})

test('projection gate: a row the list never confirmed (identityConfirmed === false) is never projected', () => {
  const report = virtualRuntimeReport(snapshot({
    rows: { ghost: { ...snapshot().rows.s1!, sessionId: 'ghost', running: false, identityConfirmed: false } },
  }))!
  assert.deepEqual(report.sessions, {}, '未确认身份的行不得进入判定面（子代理绝不通知，S1 等价门）')
  // 负控制：只有显式 false 被挡；缺席 = 已确认（网关平面与列表播种的行都不带该位）。
  const confirmed = virtualRuntimeReport(snapshot())
  assert.equal(confirmed?.sessions.s1 !== undefined, true)
})

test('projection → arm: a facts-only completion arms its row (G3 composition)', () => {
  const report = virtualRuntimeReport(snapshot())!
  const next = stepCompletionArm({}, { s1: true }, {
    current: undefined,
    rows: report.sessions,
    painted: false,
    listComplete: report.listComplete,
    listKnown: report.listKnown,
    stale: report.stale,
    factsOnly: true,
  })
  assert.deepEqual(next.arms, { s1: true })
})

test('projection → arm: an unlatched baselines counter never clears an arm (absence ≠ empty list)', () => {
  const report = virtualRuntimeReport(snapshot({ baselines: undefined, rows: {} }))!
  const next = stepCompletionArm({ s1: true }, { s1: false }, {
    current: undefined,
    rows: report.sessions,
    painted: false,
    listComplete: report.listComplete,
    listKnown: report.listKnown,
    stale: report.stale,
    factsOnly: true,
  })
  assert.deepEqual(next.arms, { s1: true }, 'without a complete list an absent row is not a deletion')
})

test('composition: virtualRuntimeReport → observeSource yields ask and complete candidates', () => {
  const identity = completionIdentity('fingerprint', 'boot')
  const run = (state: SourceObservationState | undefined, snap: SessionFactsSnapshot) => observeSource({
    ...(state === undefined ? {} : { state }),
    sourceId: 'gw-facts-only',
    identity,
    pageBoot: 'same',
    shell: { rows: virtualRuntimeReport(snap)!.sessions },
    shellReport: true,
    facts: factsChannelOf(snap),
  })
  const quiet = snapshot({ rows: { s1: { ...snapshot().rows.s1!, pendingKind: null } } })
  const first = run(undefined, quiet)
  assert.deepEqual(first.observations.map(o => o.candidate).filter(c => c !== undefined), [],
    '首份壳 report 只播种：没有候选')

  // ① pending 变化（question）产 ask 候选，证据是壳边沿。
  const pending = snapshot({ rows: { s1: { ...snapshot().rows.s1!, pendingKind: 'question' } } })
  const ask = run(first.state, pending)
  assert.deepEqual(ask.observations.map(o => o.candidate).filter(c => c !== undefined),
    [{ kind: 'ask', evidence: 'shell-edge' }])

  // ② host 域 observed 完成（运行位仍 idle）产 complete 候选，证据是 facts 水位。
  const completed = snapshot({
    rows: {
      s1: {
        ...snapshot().rows.s1!,
        pendingKind: null,
        completedAt: 1_700_000_000_200,
        completedAtSource: 'observed',
        lastTurnEnd: { kind: 'completed', at: 1_700_000_000_200, seq: 9 },
      },
    },
  })
  const complete = run(ask.state, completed)
  const candidates = complete.observations.map(o => o.candidate).filter(c => c !== undefined)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.kind, 'complete')
  assert.equal(candidates[0]?.evidence, 'facts-watermark')
  assert.equal(candidates[0]?.watermark, 1_700_000_000_200)
})

/**
 * 网关单阶段删除 × 无壳判定臂（R1 行级回归）：缺席行绝不能以 running:false 投递——
 * wire 行没有 absent 位，那会被读成 host running→idle 的完成边沿（假蓝点）。网关侧
 * （一次成功且完整的 baseline 缺席 ⇒ 立即 removedSessionIds 且从 store 删除）由
 * packages/gateway/test/session-state/session-state-store.test.ts 钉住；本文件用真实
 * 客户端模块（applySessionFactsDelta → virtualRuntimeReport → stepCompletionArm）钉住
 * 客户端侧的消费语义。
 */
test('R1: a gateway removal clears the client row, its arm and its edge memory, and a re-listed row does not light up', () => {
  const runningRow = { ...snapshot().rows.s1!, pendingKind: null, running: true }
  const seeded = snapshot({ baselines: 1, cursor: 10, rows: { s1: runningRow } })
  const seed = stepCompletionArm({}, { s1: true }, {
    current: undefined,
    rows: virtualRuntimeReport(seeded)!.sessions,
    painted: false,
    listComplete: true,
    listKnown: true,
    stale: false,
    factsOnly: true,
  })
  assert.deepEqual(seed.arms, {}, 'a running row arms nothing')

  // ① 缺席即删除：网关在**一次**成功且完整的 baseline 缺席时发 removedSessionIds（单阶段，
  // design 17 §10.7 / design 06 §4.2）；客户端清行，离表清臂 + 边沿记忆随行退役，不产生新边沿。
  const removed = applySessionFactsDelta(seeded, {
    cursor: 11, sessions: [], removedSessionIds: ['s1'], host: { state: 'ready', serviceable: true },
  })
  assert.ok(removed.next)
  assert.equal(removed.next.rows.s1, undefined, '缺席即删除（不再有首次隐藏窗口）')
  assert.equal(removed.hint, 'removed', '删除帧产生一次行刷新提示')
  const removedReport = virtualRuntimeReport(removed.next)!
  assert.equal(removedReport.sessions.s1, undefined)
  const afterRemoval = stepCompletionArm({ s1: true }, seed.running, {
    current: undefined,
    rows: removedReport.sessions,
    painted: false,
    listComplete: removedReport.listComplete,
    listKnown: removedReport.listKnown,
    stale: removedReport.stale,
    factsOnly: true,
  })
  assert.deepEqual(afterRemoval.arms, {}, '离表清臂；删除不是完成')
  assert.deepEqual(afterRemoval.running, {}, '边沿记忆随缺席行退役')

  // ② 再上架：全新行（running:true）不点亮旧点，也不继承任何旧记忆。
  const relisted = applySessionFactsDelta(removed.next, {
    cursor: 12, sessions: [{ sessionId: 's1', running: true, updatedAt: 7 }],
  })
  assert.ok(relisted.next)
  assert.equal(relisted.hint, 'added')
  const relistedReport = virtualRuntimeReport(relisted.next)!
  assert.equal(relistedReport.sessions.s1?.running, true)
  const afterRelist = stepCompletionArm({}, afterRemoval.running, {
    current: undefined,
    rows: relistedReport.sessions,
    painted: false,
    listComplete: relistedReport.listComplete,
    listKnown: relistedReport.listKnown,
    stale: relistedReport.stale,
    factsOnly: true,
  })
  assert.deepEqual(afterRelist.arms, {}, '再上架的 running 行不点亮（首见即 running 不产边沿）')
  assert.deepEqual(afterRelist.running, { s1: true }, '记忆从新观察重新播种')
})

test('R1 counterfactual: a fabricated running:false row (no stop edge in the client) DID arm — the source-side gate is what removes the false dot', () => {
  const seeded = snapshot({
    baselines: 1, cursor: 10,
    rows: { s1: { ...snapshot().rows.s1!, pendingKind: null, running: true } },
  })
  // The shape the gateway must NEVER project for an absent row: running:false with no
  // absent bit anywhere in the frozen wire contract (S3 replaced it with an immediate
  // removal; the old two-phase first-miss hide is gone).
  const buggy = applySessionFactsDelta(seeded, {
    cursor: 11, sessions: [{ sessionId: 's1', running: false }], removedSessionIds: [],
  })
  assert.ok(buggy.next)
  const report = virtualRuntimeReport(buggy.next)!
  const armed = stepCompletionArm({}, { s1: true }, {
    current: undefined,
    rows: report.sessions,
    painted: false,
    listComplete: report.listComplete,
    listKnown: report.listKnown,
    stale: report.stale,
    factsOnly: true,
  })
  assert.deepEqual(armed.arms, { s1: true },
    'documents the false blue dot this shape produced; gateway/src/session-state.ts commitDelta must never emit it')
})

test('projection → arm: an UNKNOWN baselines counter closes the first-seen-idle arm (P1 false dot)', () => {
  const report = virtualRuntimeReport(snapshot({
    baselines: undefined,
    rows: { s1: { ...snapshot().rows.s1!, running: false, pendingKind: null, firstSeenByDelta: true } },
  }))!
  assert.equal(report.listKnown, false)
  const next = stepCompletionArm({}, {}, {
    current: undefined,
    rows: report.sessions,
    painted: false,
    listComplete: report.listComplete,
    listKnown: report.listKnown,
    stale: report.stale,
    factsOnly: true,
  })
  assert.deepEqual(next.arms, {}, '未知基数不得当"未就绪"而武装（不凭空造点）')
})
