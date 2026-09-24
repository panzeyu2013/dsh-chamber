/**
 * 观测组装（design 19 §3.2.1–§3.2.5，Wave3-B2 单点接线）的直测：
 *  - observeSource 的权威合并（running / goal 三值 / 子代理 R2-G / 归属过滤 /
 *    基线播种 / 会话遗忘 / 页代）；
 *  - applyObservationBatch 的落盘纪律与代际门（本次 Wave4 修复的两条回归：
 *    freshState 必须清掉账本里上一份代际记录；无 disposition 的 durable 写也必须落盘）。
 *
 * Run directly: node test/session-state/completion-observation.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FORGOTTEN_SESSION_LIMIT,
  applyObservationBatch,
  completionIdentity,
  factsChannelOf,
  observeSource,
  withdrawObservationState,
  type CompletionSink,
  type FactsObservationRow,
  type ObservationBatch,
} from '../../src/completion-observation.ts'
import {
  reconcile,
  type CompletionObservation,
  type GoalFact,
  type PlannedNotification,
} from '../../src/notification-projection.ts'
import { createCompleteLedger } from '../../src/complete-ledger.ts'
import {
  UNREAD_V2_KEY,
  loadUnread,
  saveUnread,
  unreadOutcomeTable,
  unreadPendingTable,
  type UnreadStorageLike,
  type UnreadV2Payload,
} from '../../src/unread-store.ts'
import type { SessionFactsRow, SessionFactsSnapshot } from '../../src/session-facts-source.ts'

function factsRow(extra: Partial<FactsObservationRow> = {}): FactsObservationRow {
  return {
    sessionId: 's1',
    running: false,
    completedAt: null,
    completedAtSource: null,
    updatedAt: 0,
    subagentCount: 0,
    ...extra,
  }
}

/** facts 通道的完整行形（snapshot.rows 需要 SessionFactsRow，不只是判定子集）。 */
function factsSourceRow(extra: Partial<SessionFactsRow> = {}): SessionFactsRow {
  return {
    sessionId: 's1',
    running: false,
    pendingKind: null,
    subagentCount: 0,
    updatedAt: 0,
    completedAt: null,
    completedAtSource: null,
    lastTurnEnd: null,
    factAt: 0,
    ...extra,
  }
}

function snapshot(extra: Partial<SessionFactsSnapshot> = {}): SessionFactsSnapshot {
  return {
    verdict: 'ok',
    degradation: null,
    mode: null,
    hostState: 'ready',
    serviceable: true,
    stale: false,
    cursor: 0,
    rows: {},
    read: null,
    lastEventAt: null,
    ...extra,
  }
}

function obs(extra: Partial<CompletionObservation> = {}): CompletionObservation {
  return {
    sourceId: 'src',
    sessionId: 's1',
    generation: 1,
    running: 'idle',
    subagents: 'unknown',
    goal: 'unknown',
    baseline: false,
    boot: 'same',
    ...extra,
  }
}

/** applyObservationBatch 只读 batch 的元数据/观测；state 由调用方持有。 */
function batchOf(observations: CompletionObservation[], extra: Partial<ObservationBatch> = {}): ObservationBatch {
  return {
    state: undefined as unknown as ObservationBatch['state'],
    generation: 1,
    generationChanged: false,
    freshState: false,
    observations,
    forgotten: [],
    fenceSeeds: [],
    ...extra,
  }
}

/** 未读 v2 的假 storage（App reload 路径的直测形）。 */
function fakeStorage(initial: Record<string, string> = {}): { storage: UnreadStorageLike; data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial))
  return {
    data,
    storage: {
      getItem: key => (data.has(key) ? data.get(key)! : null),
      setItem: (key, value) => { data.set(key, value) },
      removeItem: key => { data.delete(key) },
    },
  }
}

function makeSink(): { calls: { notifications: PlannedNotification[]; dispositions: string[]; persists: boolean[] }; sink: CompletionSink } {
  const calls = { notifications: [] as PlannedNotification[], dispositions: [] as string[], persists: [] as boolean[] }
  return {
    calls,
    sink: {
      emitNotification: notification => { calls.notifications.push(notification) },
      countDisposition: outcome => { calls.dispositions.push(outcome) },
      persist: immediate => { calls.persists.push(immediate) },
    },
  }
}

// ── observeSource：权威合并与播种 ────────────────────────────────────────────

test('observeSource: the first shell report only seeds (G2); the next true→idle is one shell candidate', () => {
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true } } },
  })
  assert.equal(first.freshState, true)
  assert.equal(first.generationChanged, false)
  assert.equal(first.observations.length, 1)
  assert.equal(first.observations[0].baseline, true)
  assert.equal(first.observations[0].running, 'running')
  assert.equal(first.observations[0].candidate, undefined, 'the seeding report never carries a candidate')
  assert.equal(first.state.shellSeeded, true)
  assert.equal(first.state.baselineDone, true)

  const second = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false } } },
  })
  assert.equal(second.observations[0].baseline, false)
  assert.deepEqual(second.observations[0].candidate, { evidence: 'shell-edge' })

  // 同一份「已 idle」报告不重放边沿（记忆推进）。
  const third = observeSource({
    state: second.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false } } },
  })
  assert.equal(third.observations[0].candidate, undefined)
})

test('observeSource: an empty first report still establishes the baseline; a later first-seen online completion is not suppressed', () => {
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: {} },
  })
  assert.equal(first.observations.length, 0)
  assert.equal(first.state.baselineDone, true, 'the baseline is the first batch, rows or not')

  const second = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s9: { running: false, completed: true } } },
  })
  assert.equal(second.observations.length, 1)
  assert.equal(second.observations[0].baseline, false)
  assert.deepEqual(second.observations[0].candidate, { evidence: 'shell-edge' })

  // 断言强度（评审 D）：候选层断言不够——经 applyObservationBatch+reconcile 证明
  // 「最终确实发出一通知」。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: first })
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: second })
  assert.equal(calls.notifications.length, 1, '空首帧之后的在线完成必须最终发出一通知')
  assert.equal(calls.notifications[0].kind, 'complete')
})

test('observeSource: facts-first skew keeps the completion eligible while the shell still reports running (I1)', () => {
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true } } },
    facts: { usable: true, rows: {} },
  })
  const running = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 1000, completedAtSource: 'observed', updatedAt: 1000 }) } },
  })
  assert.equal(running.observations[0].running, 'running')
  assert.equal(running.observations[0].candidate?.evidence, 'facts-watermark', 'the candidate is proposed')

  const idle = observeSource({
    state: running.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 1000, completedAtSource: 'observed', updatedAt: 1000 }) } },
  })
  assert.equal(idle.observations[0].running, 'idle')
  assert.equal(idle.observations[0].candidate?.watermark, 1000, 'the same completion is re-proposed once the shell catches up')

  // 断言强度（评审 D）：候选层断言不够——经 applyObservationBatch+reconcile 证明
  // 候选在 running 权威观测上不被消费、壳追平后最终发出一通知。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: first })
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: running })
  assert.equal(calls.notifications.length, 0, 'running 权威下不得提前发')
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: idle })
  assert.equal(calls.notifications.length, 1, '壳追平后同一完成必须最终发出一通知')
  assert.equal(calls.notifications[0].kind, 'complete')
  assert.equal(calls.notifications[0].watermark, 1000)
})

test('observeSource: facts candidates require seeding plus a strictly advancing observed watermark', () => {
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 1000, completedAtSource: 'observed', updatedAt: 1000 }) } },
  })
  assert.equal(first.observations[0].candidate, undefined, 'the first usable facts snapshot only seeds')
  assert.equal(first.state.factsSeeded, true)

  const second = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 2000, completedAtSource: 'observed', updatedAt: 2000 }) } },
  })
  assert.deepEqual(second.observations[0].candidate, { kind: 'complete', watermark: 2000, evidence: 'facts-watermark' })

  const third = observeSource({
    state: second.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 2000, completedAtSource: 'observed', updatedAt: 2000 }) } },
  })
  assert.equal(third.observations[0].candidate, undefined, 'the same watermark never re-fires')

  const fourth = observeSource({
    state: third.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 3000, completedAtSource: 'reconstructed', updatedAt: 3000 }) } },
  })
  assert.equal(fourth.observations[0].candidate, undefined, 'reconstructed completions only arm unread')
})

test('observeSource: a stale shell row cannot outrank usable facts (running authority + R2-G)', () => {
  const batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    shell: { rows: { s1: { running: true, runningSubagents: 2 } }, stale: true },
    facts: { usable: true, rows: { s1: factsRow({ running: false }) } },
  })
  const observation = batch.observations[0]
  assert.equal(observation.running, 'idle', 'a stale shell row is not running evidence')
  assert.equal(observation.subagents, 'unknown', 'a stale residual subagent count is never busy')
})

test('observeSource: facts-only subagentCount is presence, not busy (R2-G)', () => {
  const batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ subagentCount: 3, running: true }) } },
  })
  assert.equal(batch.observations[0].running, 'running')
  assert.equal(batch.observations[0].subagents, 'unknown', 'facts-only presence never suppresses')
})

test('observeSource: goal precedence is shell → facts → unknown and null never folds into unknown', () => {
  const shellGoal: GoalFact = { goalId: 'shell', revision: 1, phase: 'active' }
  const factsGoal: GoalFact = { goalId: 'facts', revision: 2, phase: 'paused' }
  const withShell = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    shell: { rows: { s1: { goal: shellGoal } } },
    facts: { usable: true, rows: { s1: factsRow({ goal: factsGoal }) } },
  })
  assert.deepEqual(withShell.observations[0].goal, shellGoal, 'the shell channel owns its row')

  const factsOnly = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ goal: null }) } },
  })
  assert.equal(factsOnly.observations[0].goal, null, 'explicit no-goal stays null (P2a fallback path)')

  const neither = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    shell: { rows: { s1: { running: false } } },
  })
  assert.equal(neither.observations[0].goal, 'unknown')
})

test('observeSource: usable facts own the completion; ask/request still pass through (ownership filter/INV4)', () => {
  const facts = { usable: true, rows: { s1: factsRow({ updatedAt: 100 }) } }
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true } } }, facts,
  })
  const second = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, pending: 'question' } } }, facts,
  })
  assert.deepEqual(second.observations.map(o => o.candidate), [{ kind: 'ask', evidence: 'shell-edge' }],
    'the shell complete is suppressed while the question passes')
})

test('observeSource: a session leaving both channels is forgotten; pageBoot only reaches the first batch', () => {
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'fresh', shellReport: true,
    shell: { rows: { s1: { running: false }, s2: { running: false } } },
  })
  assert.equal(first.observations[0].boot, 'fresh')
  const second = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'fresh', shellReport: true,
    shell: { rows: { s2: { running: false } } },
  })
  assert.deepEqual(second.forgotten, ['s1'])
  assert.equal(second.observations[0].boot, 'same', 'the page-boot verdict is a first-batch fact')
})

test('observeSource: an identity change bumps the generation and reports generationChanged', () => {
  const first = observeSource({ sourceId: 'src', identity: completionIdentity('fp-a', 'boot'), pageBoot: 'same' })
  assert.equal(first.generation, 1)
  assert.equal(first.generationChanged, false)
  const second = observeSource({ state: first.state, sourceId: 'src', identity: completionIdentity('fp-b', 'boot'), pageBoot: 'same' })
  assert.equal(second.generationChanged, true)
  assert.equal(second.generation, 2)
  assert.equal(second.freshState, false)
})

test('factsChannelOf: usable = verdict ok && serviceable && !stale', () => {
  assert.equal(factsChannelOf(snapshot())?.usable, true)
  assert.equal(factsChannelOf(snapshot({ stale: true }))?.usable, false)
  assert.equal(factsChannelOf(snapshot({ serviceable: false }))?.usable, false)
  assert.equal(factsChannelOf(snapshot({ verdict: 'degraded' }))?.usable, false)
  assert.equal(factsChannelOf(undefined), undefined)
})

test('REGRESSION(P2 dead state): observations carry no prev* transition fields and session memory keeps no dead phase', () => {
  // prevRunning / prevGoalPhase（CompletionObservation）与 memory.running / memory.goalPhase
  // 在生产零消费（reconcile 的结算点记忆以 state.goalKnown 为准）：删除后行为不变，
  // 由本用例钉住「不再回来」（回退任一字段即红）。
  const batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    shell: { rows: { s1: { running: false, goal: { goalId: 'g1', revision: 1, phase: 'active' } } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  const observation = batch.observations[0]
  assert.equal('prevRunning' in observation, false, 'prevRunning 生产零消费：字段已删')
  assert.equal('prevGoalPhase' in observation, false, 'prevGoalPhase 生产零消费：字段已删')
  const memory = batch.state.sessions.s1
  assert.equal('running' in memory, false, 'memory.running 仅供 prevRunning 赋值：字段已删')
  assert.equal('goalPhase' in memory, false, 'memory.goalPhase 仅供 prevGoalPhase 赋值：字段已删')
})

// ── applyObservationBatch：代际门、撤回与落盘 ────────────────────────────────

test('applyObservationBatch: an identity change withdraws pending/armed and persists immediately', () => {
  const ledger = createCompleteLedger()
  ledger.setPending('src', 's1', { at: 1, watermark: 10 })
  ledger.setArmed('src', new Set(['s1']))
  const { calls, sink } = makeSink()
  const first = observeSource({
    sourceId: 'src', identity: 'A', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch: first, sink })
  const second = observeSource({
    state: first.state, sourceId: 'src', identity: 'B', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false } } },
  })
  assert.equal(second.generationChanged, true)
  applyObservationBatch({ ledger, sourceId: 'src', batch: second, sink })
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)
  assert.equal(ledger.armed('src').has('s1'), false)
  assert.equal(calls.persists.at(-1), true, 'withdrawal must flush immediately (§3.5)')
})

test('REGRESSION(G1): a fresh observation state clears the ledger generation recorded for the source', () => {
  // 场景：来源曾换过身份（observation state 的代际到 2），随后壳通道撤回删掉了
  // observation state；恢复后的 freshState 代际从 1 重新起算。账本若保留旧记录
  // （2），reconcile 的 G1 门会把此后**所有**观测当成旧代迟到而整批丢弃。
  const ledger = createCompleteLedger()
  ledger.state().generation.src = 3
  const { calls, sink } = makeSink()

  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true } } },
  })
  assert.equal(first.freshState, true)
  applyObservationBatch({ ledger, sourceId: 'src', batch: first, sink })
  assert.equal(ledger.state().generation.src, first.generation, 'the stale ledger generation must be released')

  const second = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false } } },
  })
  assert.deepEqual(second.observations[0].candidate, { evidence: 'shell-edge' })
  applyObservationBatch({ ledger, sourceId: 'src', batch: second, sink })
  assert.equal(calls.notifications.length, 1, 'the completion after recovery must still notify')
})

test('REGRESSION(§3.5/TL3): a watermark-only absorption persists without a disposition', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const goal: GoalFact = { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' }

  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ goal, candidate: { evidence: 'shell-edge' } })]),
  })
  assert.equal(ledger.pendingEntry('src', 's1')?.watermark, undefined)
  assert.deepEqual(calls.dispositions, ['held'])
  const afterHold = calls.persists.length
  assert.equal(afterHold, 1)

  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ goal, candidate: { kind: 'complete', watermark: 500, evidence: 'facts-watermark' } })]),
  })
  assert.equal(ledger.pendingEntry('src', 's1')?.watermark, 500, 'the later facts watermark is absorbed')
  assert.equal(calls.dispositions.length, 1, 'absorption is not a disposition (independent counters stay put)')
  assert.equal(calls.persists.length, afterHold + 1, 'the absorbed watermark is durable and must be persisted')
})

test('REGRESSION(§3.5): the G5 armed gate records its monotonic watermark and persists it', () => {
  const ledger = createCompleteLedger()
  ledger.setArmed('src', new Set(['s1']))
  const { calls, sink } = makeSink()
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ candidate: { kind: 'complete', watermark: 700, evidence: 'facts-watermark' } })]),
  })
  assert.equal(calls.notifications.length, 0, 'an already-armed session must not re-notify')
  assert.equal(ledger.state().notified.src?.s1?.complete, 700, 'the watermark is still recorded monotonically')
  assert.equal(calls.persists.length, 1, 'the durable notified table changed and must persist')
})

test('REGRESSION(withdraw/fence): a channel withdrawal clears the settleFence so it cannot eat the next real completion', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const active: GoalFact = { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' }
  // 目标已认识 → shell 边沿 hold（无 facts 水位 pending）→ 目标 outcome flush 置围栏。
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: batchOf([obs({ goal: active })]) })
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ goal: active, candidate: { evidence: 'shell-edge' } })]),
  })
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ goal: { goalId: 'g1', revision: 2, phase: 'complete' } })]),
  })
  assert.notEqual(ledger.state().settleFence.src?.s1, undefined, 'a facts-less flush sets the one-shot fence')
  assert.equal(calls.notifications.length, 1)
  ledger.withdraw('src')
  assert.equal(ledger.state().settleFence.src, undefined, 'withdrawal clears the fence with its pending')
  // 恢复后到来的是一条**新完成**的 facts 候选：不得被旧围栏吞掉。
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ goal: { goalId: 'g1', revision: 2, phase: 'complete' }, candidate: { kind: 'complete', watermark: 500, evidence: 'facts-watermark' } })]),
  })
  assert.equal(calls.notifications.length, 2, 'the post-recovery candidate is a completion, not the withdrawn one')
})

test('applyObservationBatch: forgotten sessions clear pending and flush immediately', () => {
  const ledger = createCompleteLedger()
  ledger.setPending('src', 's1', { at: 1 })
  const { calls, sink } = makeSink()
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([], { forgotten: ['s1'] }),
  })
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)
  assert.equal(calls.persists.at(-1), true)
})

test('applyObservationBatch: a flush disposition is persisted immediately (TL3)', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const active: GoalFact = { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' }
  // 先让账本认识这个 goal（首份已知事实是静默结算点，不在此处 flush）。
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: batchOf([obs({ goal: active })]) })
  ledger.setPending('src', 's1', { at: 1, watermark: 900 })
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ goal: { goalId: 'g1', revision: 2, phase: 'complete' } })]),
  })
  assert.deepEqual(calls.dispositions, ['flushed'])
  assert.equal(calls.notifications.length, 1)
  assert.equal(calls.notifications[0].title, 'goal-completed')
  assert.equal(calls.persists.at(-1), true, 'a flush flushes immediately')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, 'the pending is consumed')
})

// ── 评审 A 修复回归：G4 延迟释放 / forgotten 全纪律 / facts 不可用 / 直通不短路 ──

test('REGRESSION(G4 阻断项): a busy-deferred completion releases through the observation layer under goal null', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, subagentActivity: 'none', goal: null } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch: first, sink })
  assert.equal(calls.notifications.length, 0, '首份观测只播种')

  // 子代理 busy：完成候选被延迟进 pending（goal null 是常态会话，不能在此丢完成）。
  const busy = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, subagentActivity: 'running', goal: null } } },
  })
  assert.deepEqual(busy.observations[0].candidate, { evidence: 'shell-edge' })
  assert.equal(busy.observations[0].subagents, 'busy')
  applyObservationBatch({ ledger, sourceId: 'src', batch: busy, sink })
  assert.deepEqual(calls.dispositions, ['deferred'])
  assert.equal(calls.notifications.length, 0, 'busy 期间零通知')
  assert.equal(ledger.pendingEntry('src', 's1')?.deferred, 'subagent-busy')

  // busy 结束（该观测本身没有候选）：延迟的完成必须中性发出一通知。
  const idle = observeSource({
    state: busy.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, subagentActivity: 'none', goal: null } } },
  })
  assert.equal(idle.observations[0].candidate, undefined, '忙碌结束本身不再是候选')
  applyObservationBatch({ ledger, sourceId: 'src', batch: idle, sink })
  assert.equal(calls.notifications.length, 1, 'busy 结束后延迟的完成必须中性发出一通知')
  assert.equal(calls.notifications[0].kind, 'complete')
  assert.equal(calls.notifications[0].title, 'session-completed')
  assert.equal(calls.dispositions.at(-1), 'flushed')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)
})

test('REGRESSION(A1): a baseline observation still releases a busy-deferred pending (no G2 swallowing)', () => {
  // 反例：busy 延迟的 pending 跨页保留（boot same），恢复后第一份观测是基线
  // （goal null / subagents idle）：旧口径 !baseline 让释放分支不可达，pending 落回
  // #3 静默 drop（goal null）或被永久留存（goal unknown）——busy 只延迟不压制，
  // 基线也不得吞掉一条已经延迟过的完成。
  const ledger = createCompleteLedger(undefined, {
    pending: { src: { s1: { at: 1, deferred: 'subagent-busy' } } },
    now: 5,
  })
  const { calls, sink } = makeSink()
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ baseline: true, goal: null, subagents: 'idle' })]),
  })
  assert.equal(calls.notifications.length, 1, '基线 + 延迟 pending ⇒ 必须 emit 一条中性通知')
  assert.equal(calls.notifications[0].kind, 'complete')
  assert.equal(calls.notifications[0].title, 'session-completed')
  assert.equal(calls.dispositions.at(-1), 'flushed')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, '释放消费 pending')
})

test('REGRESSION(forgotten 方向 A): a reappearing session seeds its first observation (no double-notify)', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch: first, sink })
  const completed = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch: completed, sink })
  assert.equal(calls.notifications.length, 1, '在线完成发一次')
  assert.equal(ledger.armed('src').has('s1'), true)

  // 会话从两条通道消失：forgotten 清 armed/fence/pending。
  const gone = observeSource({
    state: completed.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: {} },
  })
  assert.deepEqual(gone.forgotten, ['s1'])
  applyObservationBatch({ ledger, sourceId: 'src', batch: gone, sink })
  assert.equal(ledger.armed('src').has('s1'), false, '遗忘清 armed')

  // 重现（同一 completed 状态）：首观测只播种 ⇒ 同一完成不得双发。
  const back = observeSource({
    state: gone.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
  })
  assert.equal(back.observations[0].candidate, undefined, '重现首观测只播种')
  applyObservationBatch({ ledger, sourceId: 'src', batch: back, sink })
  assert.equal(calls.notifications.length, 1, '消失前已通知的同一完成不得双发')

  // 方向 B：之后的新完成（重新 running 再完成）照常通知。
  const again = observeSource({
    state: back.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch: again, sink })
  const second = observeSource({
    state: again.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, goal: null } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch: second, sink })
  assert.equal(calls.notifications.length, 2, '重现后的新完成必须能发')
})

test('REGRESSION(forgotten 方向 B): vanishing clears settleFence+armed so a later new facts completion notifies', () => {
  const ledger = createCompleteLedger()
  const active: GoalFact = { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' }
  // 预置：一次无 facts 水位的 shell flush 已通知并置 fence+arm（§3.3/T1）。
  reconcile(ledger.state(), obs({ goal: active, candidate: { evidence: 'shell-edge' } }), 10)
  reconcile(ledger.state(), obs({ goal: { goalId: 'g1', revision: 2, phase: 'complete', updatedAt: 100 } }), 20)
  assert.equal(ledger.armed('src').has('s1'), true)
  assert.notEqual(ledger.state().settleFence.src?.s1, undefined)

  const { calls, sink } = makeSink()
  // 观察者先看见 s1（建立转移记忆）。
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ goal: null }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })

  // s1 从两条通道消失：armed+fence+pending 同拍清并立即落盘。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: {} },
  })
  assert.deepEqual(batch.forgotten, ['s1'])
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.armed('src').has('s1'), false, '遗忘清 armed')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '遗忘清 settleFence')
  assert.equal(calls.persists.at(-1), true)

  // 重现（窗口内完成 1000）：首观测只播种，不补发。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 1000, completedAtSource: 'observed', updatedAt: 1000, goal: null }) } },
  })
  assert.equal(batch.observations[0].candidate, undefined, '重现首观测只播种')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 0)

  // 之后的新完成（水位严格前进）：不得被消失前的 fence/arm 静默吞掉。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 2000, completedAtSource: 'observed', updatedAt: 2000, goal: null }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '重现后的新完成必须发出')
  assert.equal(calls.notifications[0].kind, 'complete')
})

test('forgottenSessions FIFO: >limit churn evicts the oldest key, whose reappearance loses the seed gate (accepted duplicate)', () => {
  // design 19 §3.2.4「已知边界（有界优先）」：同一来源在记忆窗口内遗忘超过
  // FORGOTTEN_SESSION_LIMIT 个会话时最旧键被淘汰，被淘汰会话重现不再播种。用例把
  // 「极端 churn 一次重复」的实际行为钉住（不要求消除；有界性优先，不做无界水位缓存）。
  const total = FORGOTTEN_SESSION_LIMIT + 1
  const ids = Array.from({ length: total }, (_, index) => 's' + String(index).padStart(4, '0'))
  const shellRows = Object.fromEntries(ids.map(id => [id, { running: false, completed: true, goal: null }]))
  const factsRows = Object.fromEntries(ids.map(id => [id, factsRow()]))
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: shellRows },
    facts: { usable: true, rows: factsRows },
  })
  assert.equal(Object.keys(first.state.sessions).length, total)

  const gone = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: {} },
    facts: { usable: true, rows: {} },
  })
  assert.equal(gone.forgotten.length, total, '两条通道都缺席 ⇒ 全部遗忘')
  assert.equal(gone.state.forgottenSessions.size, FORGOTTEN_SESSION_LIMIT, 'FIFO 上界生效')
  assert.equal(gone.state.forgottenSessions.has(ids[0]), false, '最旧键被淘汰')
  assert.equal(gone.state.forgottenSessions.has(ids[total - 1]), true, '最新键保留')

  // 保留键重现：首观测只播种（不产候选）——消失前已通知的同一完成不得双发。
  const retained = observeSource({
    state: gone.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { [ids[total - 1]]: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { [ids[total - 1]]: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.equal(retained.observations[0].candidate, undefined, '保留键重现只播种')

  // 淘汰键重现：没有播种门 ⇒ 同一完成重新成为 facts 候选（已登记的极端取舍）。
  const evicted = observeSource({
    state: retained.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { [ids[0]]: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { [ids[0]]: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.deepEqual(
    evicted.observations[0].candidate,
    { kind: 'complete', watermark: 100, evidence: 'facts-watermark' },
    '淘汰键重现无播种门 ⇒ 同一完成二次成为候选（design 19 §3.2.4 已登记边界）',
  )
})

test('REGRESSION(B2): unusable facts (stale/degraded/serviceable=false) are presence, never absence', () => {
  const row = factsRow()
  for (const unusable of [
    snapshot({ stale: true, rows: { s1: factsSourceRow() } }),
    snapshot({ verdict: 'degraded', rows: { s1: factsSourceRow() } }),
    snapshot({ serviceable: false, rows: { s1: factsSourceRow() } }),
  ]) {
    const channel = factsChannelOf(unusable)
    assert.equal(channel?.usable, false)
    const first = observeSource({
      sourceId: 'src', identity: 'fp', pageBoot: 'same',
      facts: { usable: true, rows: { s1: row } },
    })
    const degraded = observeSource({
      state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
      facts: channel,
    })
    assert.deepEqual(degraded.forgotten, [], '不可用 ≠ 缺席')
    assert.equal(degraded.observations.length, 1, '行键仍在场（只作 unknown 维度）')
    assert.equal(degraded.observations[0].running, 'unknown')
    assert.equal(degraded.observations[0].goal, 'unknown')
    assert.equal(degraded.observations[0].candidate, undefined)
  }
})

test('REGRESSION(B2): a held goal completion survives a stale facts tick on a shell-less source', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const active: GoalFact = { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' }
  // 无壳来源（gateway/远端）：facts 是唯一通道，active 目标的完成先 hold。
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ goal: active }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch: first, sink })
  const completion = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 500, completedAtSource: 'observed', updatedAt: 500, goal: active }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch: completion, sink })
  assert.deepEqual(calls.dispositions, ['held'])
  assert.notEqual(ledger.pendingEntry('src', 's1'), undefined)

  // 断连/降级：快照仍带行但不可用 ⇒ 会话仍在场，held 的目标完成不得被静默清掉。
  const stale = observeSource({
    state: completion.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: factsChannelOf(snapshot({ stale: true, serviceable: false, rows: { s1: factsSourceRow({ goal: active }) } })),
  })
  assert.deepEqual(stale.forgotten, [])
  applyObservationBatch({ ledger, sourceId: 'src', batch: stale, sink })
  assert.notEqual(ledger.pendingEntry('src', 's1'), undefined, 'stale 不得静默清掉 held 完成')
  assert.equal(ledger.armed('src').has('s1'), true, '武装位同样保留')
})

test('REGRESSION(#12/§3.3): an ask observation also settles pending and both notifications reach the sink', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const active: GoalFact = { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' }
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: batchOf([obs({ goal: active, candidate: { evidence: 'shell-edge' } })]) })
  // hold(g1) 后同一份观测带 goal outcome + ask：结算与直通必须都产出一通知（不再短路）。
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({
      goal: { goalId: 'g1', revision: 2, phase: 'complete', updatedAt: 700 },
      candidate: { kind: 'ask', evidence: 'shell-edge' },
    })]),
  })
  assert.deepEqual(calls.notifications.map(notification => notification.kind), ['complete', 'ask'], '两条通知都 emit')
  assert.deepEqual(calls.dispositions, ['held', 'flushed'])
  assert.equal(calls.persists.at(-1), true, 'flush 立即落盘')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, 'pending 已消费（不再等下一份观测）')
})

test('REGRESSION(TL3): a voided pending is persisted immediately (no 1s crash-replay window)', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const active: GoalFact = { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' }
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: batchOf([obs({ goal: active, candidate: { evidence: 'shell-edge' } })]) })
  const persistsAfterHold = calls.persists.length
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: batchOf([obs({ running: 'running', goal: active })]) })
  assert.deepEqual(calls.dispositions, ['held', 'voided'])
  assert.equal(calls.persists.at(-1), true, 'voided（#1 作废）必须立即落盘')
  assert.equal(calls.persists.length, persistsAfterHold + 1)
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)
})

test('REGRESSION(TL3): a #3/silent drop is persisted immediately too', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const active: GoalFact = { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' }
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ goal: active, candidate: { kind: 'complete', watermark: 42, evidence: 'facts-watermark' } })]),
  })
  applyObservationBatch({ ledger, sourceId: 'src', sink, batch: batchOf([obs({ goal: null })]) })
  assert.deepEqual(calls.dispositions, ['held', 'dropped'])
  assert.equal(calls.persists.at(-1), true, 'dropped（静默结清）必须立即落盘')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 42)
})

// ── F5 修复回归（阻断 1/2 + 重要 3/4；每条都有临时回退即红的用例） ──────────

test('REGRESSION(F5 阻断项 1): a busy-deferred pending survives the v2 round-trip and releases after a same-page reload', () => {
  // 反例：goal unknown + busy 完成 → pending{deferred} 落盘 → 同页 reload（boot same）
  // → 标记丢 → busy 结束后零 emit、pending 永久留存（goal null/paused 则 #3 静默 drop）。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  applyObservationBatch({
    ledger, sourceId: 'src', sink,
    batch: batchOf([obs({ subagents: 'busy', candidate: { kind: 'complete', watermark: 120, evidence: 'facts-watermark' } })]),
  })
  assert.deepEqual(calls.dispositions, ['deferred'])
  assert.equal(ledger.pendingEntry('src', 's1')?.deferred, 'subagent-busy')
  assert.equal(ledger.pendingEntry('src', 's1')?.watermark, 120)

  // App 落盘/回读路径：pendingTable() → saveUnread → loadUnread → unreadPendingTable。
  const { storage, data } = fakeStorage()
  const payload: UnreadV2Payload = {
    v: 2,
    read: {},
    edge: {},
    notified: ledger.notifiedTable(),
    pending: ledger.pendingTable(),
    outcomes: ledger.outcomesTable(),
  }
  assert.equal(saveUnread(storage, payload), true)
  assert.ok(data.get(UNREAD_V2_KEY)?.includes('"deferred":"subagent-busy"'), '落盘载荷必须带延迟标记')
  const loaded = loadUnread(storage)
  const restored = createCompleteLedger({}, {
    pending: unreadPendingTable(loaded),
    outcomes: unreadOutcomeTable(loaded),
    boot: 'same',
  })
  assert.equal(restored.pendingEntry('src', 's1')?.deferred, 'subagent-busy', '同页 reload 后延迟身份仍在')

  // 重载后 busy 结束 + goal null：必须中性释放一次（丢标记则 #3 静默 drop，零 emit）。
  const { calls: reloadedCalls, sink: reloadedSink } = makeSink()
  applyObservationBatch({ ledger: restored, sourceId: 'src', sink: reloadedSink, batch: batchOf([obs({ goal: null })]) })
  assert.equal(reloadedCalls.notifications.length, 1, '重载后 busy 延迟的完成仍必须释放')
  assert.equal(reloadedCalls.notifications[0].title, 'session-completed')
  assert.equal(restored.pendingEntry('src', 's1'), undefined, '释放消费 pending')
})

test('REGRESSION(F5 阻断项 2): 200 consecutive facts-only completions all notify through the observation layer', () => {
  // 无 running=true 帧（poll 30s / 重连跳变）：种子 100 → 200..20100 每个完成都必须通知；
  // 无界 armed 门只会在 200 emit+arm 后把其余 199 个「单调记水位但不通知」。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 0, '首份可用 facts 快照只播种')
  for (let watermark = 200; watermark <= 20_100; watermark += 100) {
    batch = observeSource({
      state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
      facts: { usable: true, rows: { s1: factsRow({ completedAt: watermark, completedAtSource: 'observed', updatedAt: watermark }) } },
    })
    applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  }
  assert.equal(calls.notifications.length, 200, '严格前进的连续完成一个都不能被吞')
  assert.equal(calls.notifications[0].watermark, 200)
  assert.equal(calls.notifications.at(-1)?.watermark, 20_100)
})

test('REGRESSION(F5 重要项 3): facts seeding consumes the settleFence so the next real completion notifies', () => {
  // 反例：busy 延迟（无水位）释放置 fence → facts 首次可用只播种（同一完成被播种吸收）
  // → 新完成 200 被 fence 吞且自清 ⇒ 永久漏发。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, subagentActivity: 'none', goal: null } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, subagentActivity: 'running', goal: null } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.pendingEntry('src', 's1')?.deferred, 'subagent-busy', 'busy 延迟无水位 pending')
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, subagentActivity: 'none', goal: null } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'busy 结束后延迟完成中性释放一次')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 0 }, '无水位释放置一次性围栏（boundary = 置栏时已吸收的 facts 水位）')

  // facts 首次可用：同一完成被播种吸收 ⇒ 围栏必须随播种清除（播种 = 等价消费）。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '首份可用 facts 快照只播种')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '播种吸收 100 > boundary 0 ⇒ 播种消耗围栏（回退即红）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, '播种之后的新完成不得被旧围栏吞掉')
  assert.equal(calls.notifications[1].watermark, 200)
})

/** F5 重要项 4 的公共前缀：facts 已播种 → 壳边沿通知完成 → 两通道消失 → 壳先重现（无 facts 行）。 */
function forgetAndReappearWithoutFactsRow(): {
  ledger: ReturnType<typeof createCompleteLedger>
  calls: { notifications: PlannedNotification[]; dispositions: string[]; persists: boolean[] }
  sink: CompletionSink
  batch: ObservationBatch
} {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'facts 不可用时壳边沿通知完成')
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: {} },
    facts: { usable: false, rows: {} },
  })
  assert.deepEqual(batch.forgotten, ['s1'])
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.armed('src').has('s1'), false, '遗忘清 armed')
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: {} },
  })
  assert.equal(batch.state.sessions.s1.factsSeedPending, true, '重现无可用 facts 水位行 ⇒ 挂播种待决位')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  return { ledger, calls, sink, batch }
}

test('REGRESSION(F5 重要项 4 方向 A): the deferred facts seeding absorbs the same completion (no second notify)', () => {
  const { ledger, calls, sink, batch } = forgetAndReappearWithoutFactsRow()
  const seeded = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: { ...factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }), goal: null } } },
  })
  assert.deepEqual(seeded.observations[0].candidate, undefined, '首个可用 facts 行只播种，不产候选')
  assert.equal(seeded.state.sessions.s1.factsSeedPending, false, '播种后清除待决位')
  applyObservationBatch({ ledger, sourceId: 'src', batch: seeded, sink })
  assert.equal(calls.notifications.length, 1, '消失前已通知的同一完成不得二次通知（回退即红）')
})

test('REGRESSION(F5 重要项 4 方向 B): after the deferred seeding, a strictly advancing completion still notifies', () => {
  const { ledger, calls, sink, batch } = forgetAndReappearWithoutFactsRow()
  let next = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: { ...factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }), goal: null } } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch: next, sink })
  assert.equal(calls.notifications.length, 1)
  next = observeSource({
    state: next.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: { ...factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }), goal: null } } },
  })
  assert.deepEqual(next.observations[0].candidate, { kind: 'complete', watermark: 200, evidence: 'facts-watermark' })
  applyObservationBatch({ ledger, sourceId: 'src', batch: next, sink })
  assert.equal(calls.notifications.length, 2, '播种后严格前进的新完成必须通知')
  assert.equal(calls.notifications[1].watermark, 200)
})

test('REGRESSION(A3-1): a usable facts row without an observed watermark never clears factsSeedPending', () => {
  // 反例：待决位挂起 → 首个可用行 completedAt=null（无 observed 水位）就把待决位清掉
  // → 同一完成的水位 100 到达时被当作严格前进的新完成 ⇒ 二次通知。
  const { ledger, calls, sink, batch } = forgetAndReappearWithoutFactsRow()
  const nullRow = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: { ...factsRow(), goal: null } } },
  })
  assert.equal(nullRow.state.sessions.s1.factsSeedPending, true, '无 observed 水位不得清待决位')
  assert.equal(nullRow.observations[0].candidate, undefined, '待决位期间不产候选')
  applyObservationBatch({ ledger, sourceId: 'src', batch: nullRow, sink })
  assert.equal(calls.notifications.length, 1, '首个可用行无水位 ⇒ 仍只播种')

  const seeded = observeSource({
    state: nullRow.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: { ...factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }), goal: null } } },
  })
  assert.equal(seeded.state.sessions.s1.factsSeedPending, false, '真正吸收 observed 水位后才清待决位')
  applyObservationBatch({ ledger, sourceId: 'src', batch: seeded, sink })
  assert.equal(calls.notifications.length, 1, '水位 100 到达仍只播种（不得双发）')
  assert.equal(seeded.observations[0].candidate, undefined)
})

test('REGRESSION(B3-2): an unusable facts batch re-seeds the next usable snapshot (no double notify)', () => {
  // 反例：来源本来已播种（factsSeeded=true）→ facts 转不可用，壳边沿通知完成一次
  // → facts 恢复并报同一完成 200：不重播种时 factsSeeded 仍为 true 且 memory 水位 0
  // ⇒ 200 被视为严格前进的新完成，同一完成二次通知。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(batch.state.factsSeeded, true, '可用批播种该来源')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '不可用期间壳边沿通知完成')
  assert.equal(batch.state.factsSeeded, false, '显式不可用 facts 批必须复位播种位（恢复批重新播种）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.equal(batch.observations[0].candidate, undefined, '恢复批只播种，不产候选')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '恢复批报同一完成 200 不得二次通知（回退即红）')
})

// ── COR-1：无壳 facts-only 的 stale→恢复不得吞掉从未通知过的完成 ──────────────
//
// 旧口径对**任何**显式不可用的 facts 批复位 factsSeeded（B3-2 的恢复批重播种）。
// 无壳轨（App 在 runtime report 缺席时不传 shell：首个壳 report 之前，或壳通道
// 撤回后观测状态已随撤回删除）时没有任何壳通知可吞，复位会把恢复批降级成播种批、
// 吸收掉不可用窗口内唯一的事实——从未通知过的 observed 水位 ⇒ 永久丢发。
// 修复把复位条件收窄为「显式不可用 facts 批 + 来源级易失旗标 shellCompleteSinceFacts」
// （自上次可用 facts 批以来壳轨确实 emit 过无水位 complete，由 reconcile 置栏结果置位、
// 任何可用批清位）；恢复批再按 per-session shellNotifiedSinceFacts 只重播种确实通知过的
// 会话，其余 facts-only 会话照常按水位严格前进通知。有壳对照的 B3-2 吞发语义不变
// （上方 REGRESSION(B3-2) 继续钉住，回退 COR-1 收窄即本组变红）。

test('REGRESSION(COR-1): facts-only before the first shell report notifies the stale-window completion exactly once', () => {
  // 首个壳 report 之前：App 只走 facts 轨（runtimeFactsRef 尚无该来源，绝不传 shell）。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  // 1) 首份可用 facts 批播种 100（无候选）。
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.equal(batch.observations[0].candidate, undefined, '首份可用 facts 批只播种')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  // 2) facts 转 stale（行保留、不可用）：没有任何壳通知可吞，播种位必须保留。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.equal(batch.state.factsSeeded, true, '无壳轨时不可用 facts 批不得复位播种位（COR-1 收窄）')
  assert.equal(batch.observations[0].candidate, undefined, '不可用窗口不产候选')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  // 3) 恢复批复用 200：水位严格前进 ⇒ 候选 + 恰 1 条通知（旧口径吞发 ⇒ 0 条）。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.deepEqual(batch.observations[0].candidate, { kind: 'complete', watermark: 200, evidence: 'facts-watermark' })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '从未通知过的完成必须恰 1 条（回退即 0 条：丢发）')
  assert.equal(calls.notifications[0].watermark, 200)
})

test('REGRESSION(COR-1): after a shell withdrawal the restarted facts-only track still notifies the stale-window completion once', () => {
  // 壳轨已播种并通知过 C1（撤回前）→ App 撤回（onRuntimeReport(undefined)：删观测状态 +
  // withdraw 账本易失轨）→ facts-only 以全新无壳状态重启；stale 窗口内出现的 C2(200)
  // 必须在恢复批通知一次，且 C1 不得因此补发/双发。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  // 1) 壳轨播种 + 不可用窗口内壳边沿通知 C1。
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '壳边沿通知 C1')
  // 2) 撤回：删观测状态（下次 observeSource 为 freshState）+ withdraw 账本易失轨。
  ledger.withdraw('src')
  let fresh = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  assert.equal(fresh.freshState, true, '撤回后以全新状态重启（App 删除观测状态）')
  assert.equal(fresh.state.shellSeeded, false, '全新状态没有壳轨标记')
  applyObservationBatch({ ledger, sourceId: 'src', batch: fresh, sink })
  // 3) stale 窗口内出现 C2(200)：无壳轨 ⇒ 播种位保留。
  fresh = observeSource({
    state: fresh.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.equal(fresh.state.factsSeeded, true, '无壳轨时不可用 facts 批不得复位播种位（COR-1 收窄）')
  applyObservationBatch({ ledger, sourceId: 'src', batch: fresh, sink })
  // 4) 恢复批：C2(200) 恰通知一次（总数 2 = C1 + C2；旧口径吞 C2 ⇒ 1 条）。
  fresh = observeSource({
    state: fresh.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.deepEqual(fresh.observations[0].candidate, { kind: 'complete', watermark: 200, evidence: 'facts-watermark' })
  applyObservationBatch({ ledger, sourceId: 'src', batch: fresh, sink })
  assert.equal(calls.notifications.length, 2, 'C1 一条 + 撤回后的 C2 一条（回退即 1 条：C2 丢发）')
  assert.equal(calls.notifications[1].watermark, 200)
})

// ── COR-1 复位精度（末轮 FINAL-A）：复位只看「壳轨确实 emit 过」，不看壳轨在场 ──
//
// 旧口径（input.shell !== undefined || state.shellSeeded）把「壳轨在场」当「壳轨
// 可能已通知」。三种形态壳轨不可能通知：①首报落在 stale 窗口与恢复之间（首报只
// 播种）；②仅 stale（C4-X3 关闭 complete/ask 边沿）；③会话只在 facts 行、不在壳行。
// 复位会把恢复批降级成播种批，吞掉从未通知过的 observed 水位（同水位重放永不补发）。
// 修复后复位旗标（state.shellCompleteSinceFacts）由 applyObservationBatch 依
// reconcile 结果置位（确实 emit 了无水位 complete），任何可用 facts 批清位；
// 不可用批且旗标为真才复位 factsSeeded，B3-2 吞发语义由上方 REGRESSION(B3-2)
// 继续钉住。恢复批里仅**确实通知过**的会话重新播种（per-session 旗标）。

test('REGRESSION(COR-1 精度①): the shell first report landing between stale and recovery must not swallow the window completion', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  // 1) facts-only 播种 100（无壳轨）。
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 0, '首份可用 facts 批只播种')
  // 2) facts 转 stale：窗口内完成 200。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  // 3) 壳轨首报恰落在 stale 窗口与恢复之间：首报只播种，绝不 emit。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.equal(batch.state.factsSeeded, true, '首报只播种壳位：不得把壳轨在场当通知证据（回退即复位吞发）')
  assert.equal(batch.observations[0].candidate, undefined, '首份壳 report 只播种')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 0, '壳轨从未通知')
  // 4) 恢复批：200 是窗口内唯一事实，必须恰 1 条。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.deepEqual(
    batch.observations[0].candidate,
    { kind: 'complete', watermark: 200, evidence: 'facts-watermark' },
    '恢复批照常按水位严格前进产候选',
  )
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '从未通知过的 200 恰 1 条（回退即 0 条：永久丢发）')
  assert.equal(calls.notifications[0].watermark, 200)
  // 5) 同水位重放 0；严格更高的新完成照常。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '同水位重放 0')
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 300, completedAtSource: 'observed', updatedAt: 300 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, '其后的新完成 300 照常通知')
  assert.equal(calls.notifications[1].watermark, 300)
})

test('REGRESSION(COR-1 精度②): a stale-only shell track cannot swallow the stale-window completion', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  // 壳轨只有 stale 输入（C4-X3：complete/ask 边沿整体关闭）＋ facts 不可用。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { stale: true, rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.equal(batch.state.factsSeeded, true, '仅 stale 的壳轨没有通知可吞（回退即复位吞发）')
  assert.equal(batch.observations[0].candidate, undefined, 'stale 壳行不产边沿')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 0)
  // 恢复（壳仍 stale）：200 恰 1 条。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { stale: true, rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.deepEqual(
    batch.observations[0].candidate,
    { kind: 'complete', watermark: 200, evidence: 'facts-watermark' },
    'stale 壳轨不拦 facts 候选',
  )
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '从未通知过的 200 恰 1 条')
  // 同水位重放 0；stale→fresh 的同一行不得伪造边沿（factsUsable 下壳 complete 本就不作候选）。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '同水位重放 0；stale→fresh 不补发')
})

test('REGRESSION(COR-1 精度③): a session present only in the facts rows is not swallowed by a shell track listing others', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  // 壳轨只列 other；s1 只在 facts 行（播种 100）。
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { other: { running: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  // facts 不可用窗口：壳轨在场但从未携带 s1，也没有任何 emit。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { other: { running: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.equal(batch.state.factsSeeded, true, '壳轨不在场于 s1 ⇒ 不得复位（回退即吞 200）')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 0)
  // 恢复：s1 的 200 恰 1 条。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { other: { running: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  assert.deepEqual(
    batch.observations.find(observation => observation.sessionId === 's1')?.candidate,
    { kind: 'complete', watermark: 200, evidence: 'facts-watermark' },
    'facts-only 会话照常产候选',
  )
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '从未通知过的 200 恰 1 条')
  // 同水位重放 0。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { other: { running: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '同水位重放 0')
})

test('REGRESSION(COR-1 精度③b): another shell session notifying must not swallow the facts-only session completion', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { other: { running: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  // 不可用窗口内 other 确实 emit（壳边沿）：来源级复位会发生，但 s1 从未通知。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { other: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'other 的壳边沿恰 1 条')
  assert.equal(batch.state.factsSeeded, false, '确实 emit ⇒ 复位播种位（B3-2 语义保持）')
  // 恢复批：other 重新播种（per-session 旗标），s1 从未通知 ⇒ 照常产候选。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { other: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, 's1 的 200 必须恰 1 条（源级复位不得株连从未通知的会话）')
  assert.equal(calls.notifications[1].watermark, 200)
  // 同水位重放 0。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { other: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, '同水位重放 0')
})

test('REGRESSION(COR-1 精度④): a never-seeded source keeps the first usable facts batch as a G2 seed for every session', () => {
  // 壳侧 emit 与不可用 facts 同窗，但来源从未播种（factsSeeded 本为 false）：恢复批是
  // 本代首份可用批次，G2 对全体会话播种（per-session 候选资格不得越过——否则离线旧完成
  // 会被当窗口内新完成补发）。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: false, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '壳边沿通知（来源尚未播种）')
  assert.equal(batch.state.factsSeeded, false, '未播种来源不得挂恢复播种位')
  assert.equal(batch.state.factsReseedPending, false, 'factsSeeded 本为 false ⇒ 没有「复位」可记')
  // 首份可用 facts 批：s1 与从未见过壳的 s2 都必须只播种（G2）。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: {
      usable: true,
      rows: {
        s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }),
        s2: factsRow({ sessionId: 's2', completedAt: 500, completedAtSource: 'observed', updatedAt: 500 }),
      },
    },
  })
  assert.deepEqual(
    batch.observations.map(observation => observation.candidate),
    [undefined, undefined],
    '首份可用批次对全体会话播种（不得把 s2 的离线完成补发）',
  )
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '播种批零通知')
  // 播种之后 s2 的新完成照常通知。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: {
      usable: true,
      rows: {
        s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }),
        s2: factsRow({ sessionId: 's2', completedAt: 600, completedAtSource: 'observed', updatedAt: 600 }),
      },
    },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, '播种后的新完成 600 照常通知')
  assert.equal(calls.notifications[1].watermark, 600)
})

test('REGRESSION(FINAL-C): deleting the observation state withdraws the old generation pending + four volatile tables', () => {
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  const active: GoalFact = { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' }
  // 旧代：基线认识 s1（goal active）与 s2（goal null）。
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: active }, s2: { running: true, goal: null } } },
    facts: { usable: true, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  // 不可用窗口内 s2 壳边沿 emit：armed + armedFloor + settleFence（s2）。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: active }, s2: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '旧代 s2 壳边沿通知')
  // facts 恢复批：s1 的 observed 700 在 active armed 目标下进 pending（armedFloor/goalKnown 就位）。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, goal: active }, s2: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 700, completedAtSource: 'observed', updatedAt: 700 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.pendingEntry('src', 's1')?.watermark, 700, '旧代 pending 就位')
  assert.notEqual(ledger.state().armed.src, undefined, 'armed 就位')
  assert.notEqual(ledger.state().armedFloor.src, undefined, 'armedFloor 就位')
  assert.notEqual(ledger.state().settleFence.src, undefined, 'settleFence 就位')
  assert.notEqual(ledger.state().goalKnown.src, undefined, 'goalKnown 就位')
  ledger.setNotifiedWatermark('src', 's3', 'complete', 4242)
  ledger.setOutcome('src', 'g-keep', 4243)
  // 观测状态删除路径（App 剪枝 effect 的同拍收敛）：scoped withdraw + 落盘信号。
  assert.equal(withdrawObservationState(ledger, 'src'), true, 'pending 存在 ⇒ 必须排一次落盘')
  assert.equal(ledger.state().armed.src, undefined, 'armed 无残留')
  assert.equal(ledger.state().armedFloor.src, undefined, 'armedFloor 无残留')
  assert.equal(ledger.state().settleFence.src, undefined, 'settleFence 无残留')
  assert.equal(ledger.state().goalKnown.src, undefined, 'goalKnown 无残留')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, '旧代 pending 无残留')
  assert.equal(ledger.notifiedWatermark('src', 's3', 'complete'), 4242, 'notified 保持 durable')
  assert.equal(ledger.outcomeWatermark('src', 'g-keep'), 4243, 'outcomes 保持 durable')
  // 重建：freshState 新代；首份批次只含 other（烧掉 baseline），第二份带 g1 outcome。
  let fresh = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { other: { running: true, goal: null } } },
    facts: { usable: true, rows: {} },
  })
  assert.equal(fresh.freshState, true, '重建 = 全新观测状态')
  applyObservationBatch({ ledger, sourceId: 'src', batch: fresh, sink })
  fresh = observeSource({
    state: fresh.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, goal: { goalId: 'g1', revision: 2, phase: 'complete' } } } },
    facts: { usable: true, rows: {} },
  })
  const before = calls.notifications.length
  applyObservationBatch({ ledger, sourceId: 'src', batch: fresh, sink })
  assert.equal(
    calls.notifications.length,
    before,
    '新代首个 outcome 不得以旧 watermark flush 旧 pending（回退即多一条 700）',
  )
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, '新代不得继承旧 pending')
})

// ── 围栏边界重构（A2/A3-3/B3-1）四条反例：R1/R3 走观测层，R2/R4 见 aggregate 直测 ──

test('R1【A2 不得回归】: a boundary-0 release fence is cleared by the facts seeding, so the next completion emits', () => {
  // 无水位释放置栏（boundary = 置栏时已吸收的 facts 水位 = 0）→ facts 首次播种吸收
  // 同一完成 1000（1000 > boundary ⇒ 播种已吸收被守卫的完成 ⇒ 清栏）→ 新完成 2000
  // 必须 emit。若播种把 1000 记成 seededSince 而不是清栏，2000 会被栏吞掉（回退即红）。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, subagentActivity: 'running', goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.pendingEntry('src', 's1')?.deferred, 'subagent-busy', 'busy 延迟无水位 pending')
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, subagentActivity: 'none', goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'busy 结束后延迟完成中性释放一次')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 0 }, '无水位释放置栏（boundary=0）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, subagentActivity: 'none', goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 1000, completedAtSource: 'observed', updatedAt: 1000 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'facts 首次播种只吸收水位')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '播种 1000 > boundary 0 ⇒ 清栏（A2）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, subagentActivity: 'none', goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 2000, completedAtSource: 'observed', updatedAt: 2000 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, '播种之后的新完成 2000 必须 emit')
  assert.equal(calls.notifications[1].watermark, 2000)
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 2000, '新完成消费候选身份（水位表值）')
  assert.equal(calls.notifications[0].title, 'session-completed')
  assert.equal(calls.notifications[0].watermark, undefined, '释放通知是壳证据（无 facts 水位）')
})

test('R3【B3-1】: seeding only to the boundary keeps the fence and eats the next higher report once (1 notification total)', () => {
  // facts 已播种（memory=100）→ 不可用期间壳边沿发 1 条（置栏 boundary=100）→ 恢复
  // 播种只到 100（100 > boundary 为假 ⇒ seededSince=100，栏保留）→ 候选 200 被栏吞
  // 一次 ⇒ 总数 1 条。回退第 2 步（恢复不重播种）或吞栏的 seededSince 分支 ⇒ 200 漏发。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 0, '首份可用 facts 快照只播种')
  assert.equal(batch.state.sessions.s1.factsWatermark, 100, '播种吸收水位（running 权威为 idle）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '不可用期间壳边沿通知完成一次')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 100 }, '壳 emit 置栏（boundary=已吸收的 100）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.equal(batch.observations[0].candidate, undefined, '恢复批重新播种，不产候选')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.deepEqual(
    ledger.state().settleFence.src?.s1,
    { boundary: 100, seededSince: 100 },
    '播种只到 boundary ⇒ seededSince=100，栏保留',
  )

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '候选 200 被栏吞一次 ⇒ 总数仍 1 条（不得双发）')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '吞一次即清')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 200, '吞掉也消费候选身份（水位照记）')
})

test('REGRESSION(B3-2): a shell-only batch (no facts input) never resets factsSeeded', () => {
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: {} }, facts: { usable: true, rows: {} },
  })
  assert.equal(first.state.factsSeeded, true)
  const shellOnly = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: {} },
  })
  assert.equal(shellOnly.state.factsSeeded, true, '未携带 facts 输入的批不得重置播种位')
  const advance = observeSource({
    state: shellOnly.state, sourceId: 'src', identity: 'fp', pageBoot: 'same',
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.equal(advance.observations[0].candidate?.watermark, 100, '未重置 ⇒ 水位前进即候选（不是播种批）')
})

test('REGRESSION(C4-X2): a facts recovery batch with the row but no observed watermark also seeds the fence (1 notification total)', () => {
  // 反例：facts 已播种 → facts 不可用期间壳边沿通知完成（置栏 boundary = 已吸收水位 0）
  // → 恢复批含该会话行但 completedAt 仍为 null（在途快照）→ 不登记播种时，同一完成的
  // observed 水位 100 到达会被围栏按「W > boundary 且无 seededSince」判成新完成
  // （rule ③）⇒ 第二条通知。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 0, '首份可用 facts 快照只播种')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'facts 不可用期间壳边沿通知完成一次')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 0 }, '壳 emit 置栏 boundary=0')

  // 恢复批：行在场但 completedAt 仍 null ⇒ 无 observed 水位可吸收，但必须把播种水位
  // （本批之前的 memory.factsWatermark = 0）登记给围栏。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  assert.equal(batch.observations[0].candidate, undefined, '恢复批无 observed 水位 ⇒ 不产候选')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.deepEqual(
    ledger.state().settleFence.src?.s1,
    { boundary: 0, seededSince: 0 },
    '恢复批行在场但无 observed 水位也必须登记播种（回退即红）',
  )

  // 同一完成的水位 100 到达：候选照常提出，但必须被围栏 seededSince 规则吞一次。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.deepEqual(
    batch.observations[0].candidate,
    { kind: 'complete', watermark: 100, evidence: 'facts-watermark' },
    '候选照常提出，由围栏裁决',
  )
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '同一完成的水位 100 必须被围栏吞一次（回退即红：第二条通知）')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 100, '吞掉也消费候选身份（水位照记）')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '吞一次即清')
})

test('CONTROL(C4-X2): the recovery-batch seeding is a no-op without a fence, so a normal new completion still notifies', () => {
  // 对照：同样的「恢复批行在场但无 observed 水位」时序，但 facts 不可用窗口内没有无水位
  // 壳 emit（无围栏）⇒ 播种登记无栏即 no-op，水位 100 到达必须照常通知。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '没有无水位 emit ⇒ 无围栏')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  assert.equal(batch.state.factsSeeded, true, '恢复批重新播种')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '无栏会话的播种登记是 no-op')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '无围栏的恢复播种不得吞正常新完成')
  assert.equal(calls.notifications[0].watermark, 100)
})

test('REGRESSION(C4-X3): a stale shell snapshot produces no complete/ask/request edge, including on stale true→false', () => {
  // 反例：stale 快照的 running false / vendor completed / pending 变化此前仍会被当成
  // 壳边沿证据产候选。stale = 断连来源上附加的只读事实，不得作运行证据。
  const first = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  assert.equal(first.state.shellSeeded, true)

  const stale = observeSource({
    state: first.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: {
      rows: { s1: { running: false, completed: true, pending: 'approval', goal: null } },
      stale: true,
    },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  assert.equal(stale.observations.length, 1)
  assert.equal(
    stale.observations[0].candidate,
    undefined,
    'stale 壳行不得产出 complete（running 边沿 / completed）或 ask/request（pending）边沿（回退即红）',
  )
  assert.equal(stale.observations[0].running, 'unknown', 'stale 行也不是 running 权威')

  // stale true→false：同一行状态原样恢复非 stale —— 行记忆已在 stale 批推进，
  // 不得借旧位补发一次边沿。
  const fresh = observeSource({
    state: stale.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, pending: 'approval', goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  assert.equal(fresh.observations[0].candidate, undefined, 'stale true→false 不得补发边沿')

  // 非 stale 行为不变：pending 值真正变化照常产 ask/request 边沿，新回合照常产 complete。
  const pendingChange = observeSource({
    state: fresh.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, pending: 'question', goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  assert.deepEqual(pendingChange.observations[0].candidate, { kind: 'ask', evidence: 'shell-edge' })

  const runningAgain = observeSource({
    state: pendingChange.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, completed: false, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  assert.equal(runningAgain.observations[0].candidate, undefined, '重新 running 本身不是完成边沿')
  const idleAgain = observeSource({
    state: runningAgain.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: false, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  assert.deepEqual(idleAgain.observations[0].candidate, { evidence: 'shell-edge' }, '非 stale 的 true→idle 完成边沿不变')
})

// ── V5-B（F22）：同批恢复播种的 keepFence 时序修复 + 跨批已知边界 ───────────────────

test('REGRESSION(I1 same-batch fence): the held old observed watermark keeps the same-batch fence so it is eaten once (guarded sequence: 1 notification total)', () => {
  // 反例（probe-i1-fence 的同批压缩形）：facts 不可用期间壳边沿通知 C1（置栏 boundary=0）
  // → facts 恢复批与「新回合 running」同批到达，行里带 C1 的旧 observed 水位 100：
  //   (a) observeSource 按 I1 契约不吸收该水位（候选保持可重提），并登记 fenceSeed
  //       （播种水位 = 本批之前的 memory.factsWatermark = 0）；
  //   (b) applyObservationBatch 必须让同批的 #1 running 清栏跳过该会话（keepFence），否则
  //       刚登记的播种补偿被同一批清掉 ⇒ 壳追平 idle 后 W=100 按 rule ③ 二次通知。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 50, completedAtSource: 'observed', updatedAt: 50 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 0, '首份可用 facts 快照只播种')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 50, completedAtSource: 'observed', updatedAt: 50 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'facts 不可用期间壳边沿通知 C1')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 0 }, 'C1 无水位 emit 置栏 boundary=0')

  // 恢复批 + 新回合 running 同批：水位 100 被 I1 挡下（不吸收），播种补偿必须落账，
  // 且必须活过同一批的 #1 running 清栏。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.deepEqual(batch.fenceSeeds, [{ sessionId: 's1', watermark: 0 }], 'I1 挡下的水位也登记播种补偿')
  assert.equal(batch.state.sessions.s1.factsWatermark, 0, 'I1 契约：running 权威下不吸收 facts 水位')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.deepEqual(
    ledger.state().settleFence.src?.s1,
    { boundary: 0, seededSince: 0 },
    '同批 #1 running 不得清掉本批刚登记播种的栏（回退即红）',
  )

  // 壳追平 idle：同一完成的水位 100 是候选，但必须被栏吞一次；至此总数仍 1 条
  // （1 个物理完成 C1：壳边沿 1 条，facts 侧首次上报被吞）。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.deepEqual(
    batch.observations[0].candidate,
    { kind: 'complete', watermark: 100, evidence: 'facts-watermark' },
    '壳追平后候选取自 I1 未吸收的水位',
  )
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '被守卫完成的 facts 首次上报被栏吞一次（总数 1）')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 100, '吞掉也消费候选身份（水位照记）')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '吞一次即清栏')

  // 反吞对照：栏只吞一次，其后严格更高的新完成照常通知（不得把真实新完成吞掉）。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, '后续新完成 200 照常通知（只吞一次）')
  assert.equal(calls.notifications[1].watermark, 200)
})

test('REGRESSION(C4-X2 same-batch): a recovery batch that also reports a new running round keeps the fence it just seeded (2 completions / 2 notifications)', () => {
  // 同批形态 (a)：恢复批的 facts 行 completedAt 仍 null，但同一批壳行已报新回合
  // running=true。C4-X2 播种块本就登记 fenceSeed；修复点是 keepFence 让同批 #1 不清栏。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'C1 在 facts 不可用期间由壳边沿通知')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 0 }, 'C1 置栏')

  // 恢复批（行 null）+ 新回合 running 同批。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  assert.deepEqual(batch.fenceSeeds, [{ sessionId: 's1', watermark: 0 }], 'C4-X2 播种登记')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.deepEqual(
    ledger.state().settleFence.src?.s1,
    { boundary: 0, seededSince: 0 },
    '同批 #1 running 不得清掉刚登记播种的栏（回退即红）',
  )

  // 回合结束（壳 idle，facts 行仍 null）→ 水位 100 到达被吞一次，200 照常通知：2 完成 2 条。
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '行仍无水位 ⇒ 无候选')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'C1 的 facts 首次上报被栏吞（不重复通知）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, 'C2 的 facts 水位照常通知（2 完成 / 2 条）')
  assert.equal(calls.notifications[1].watermark, 200)
})

test('KNOWN-BOUNDARY(C4-X2 cross-batch): a running round in a SEPARATE earlier batch clears the fence first (3 notifications / 2 completions)', () => {
  // 触发条件（V5-B probe-c4x2-running）：facts 不可用期间壳边沿通知 C1（置栏 boundary=0）
  // → 新回合 running=true 在**另一批**先到：该批没有 fenceSeed，#1 按原语义清栏 →
  // facts 恢复批（行 completedAt=null）的播种登记无栏可依（seedSettleFence 无栏即 no-op）
  // → C1 的 facts 水位 100 到达时按 rule ③ 判成新完成 ⇒ 重复通知。
  // 闭合它需要让围栏跨 running 批存活，但 boundary 只有水位、没有完成身份：facts 恢复后
  // 若直接报出 C2 的水位（C1 从未在 facts 侧出现），同一栏会吞掉真实新完成 C2（丢发）。
  // 消除需要完成身份（上游只读）；design 19 §3.2.7 第 ⑥ 条已登记该边界与取舍。
  // 本用例**钉住当前行为**（3 条通知 / 2 个物理完成）：谁改跨批时序/吞栏判定，这里必红。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'C1 壳边沿通知（facts 不可用）')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 0 }, 'C1 置栏')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, completed: false, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '另一批的 #1 running 清栏（已知边界起点）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  assert.deepEqual(batch.fenceSeeds, [{ sessionId: 's1', watermark: 0 }], '恢复批仍登记播种，但栏已被上一批清掉')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '无栏 ⇒ seedSettleFence no-op')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '行仍无水位 ⇒ 无候选（C2 壳边沿被 factsUsable 抑制）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, 'C1 的 facts 水位 100 无栏可吞 ⇒ 重复通知（已知边界）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 3, 'C2 的 facts 水位 200 照常通知')
  assert.deepEqual(
    calls.notifications.map(notification => notification.watermark),
    [undefined, 100, 200],
    '当前行为：2 个物理完成（C1/C2）/ 3 条通知（100 是 C1 的重复）',
  )
})

test('KNOWN-BOUNDARY(I1 fence cross-batch): a held old observed watermark re-emits after an earlier running batch cleared the fence (3 notifications / 2 completions)', () => {
  // 与 KNOWN-BOUNDARY(C4-X2 cross-batch) 同因、行带旧 observed 水位：facts 恢复批在
  // **另一批** running=true 之后到达，I1 不吸收水位而栏已被上一批 #1 清掉 ⇒ 壳追平 idle
  // 后 W=100（C1 的重复）照常 emit。消除同样需要完成身份（上游只读），
  // design 19 §3.2.7 第 ⑥ 条已登记；本用例钉住当前行为。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 50, completedAtSource: 'observed', updatedAt: 50 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow({ completedAt: 50, completedAtSource: 'observed', updatedAt: 50 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'C1 壳边沿通知')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 0 }, 'C1 置栏 boundary=0')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, completed: false, goal: null } } },
    facts: { usable: false, rows: { s1: factsRow() } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '另一批的 #1 running 清栏（已知边界起点）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.equal(batch.observations[0].candidate, undefined, '恢复批水位被 I1 挡下（不吸收、不产候选）')
  assert.equal(batch.state.sessions.s1.factsWatermark, 0)
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1)

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, '壳追平 idle 后 W=100（C1 重复）无栏可吞（已知边界）')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 3, 'C2 的 facts 水位 200 照常通知')
  assert.deepEqual(
    calls.notifications.map(notification => notification.watermark),
    [undefined, 100, 200],
    '当前行为：2 个物理完成（C1/C2）/ 3 条通知（100 是 C1 的重复）',
  )
})

test('REGRESSION(C4-X2 行缺席): a shell-only session also seeds the recovery fence, so the first higher observed watermark is eaten once', () => {
  // 实现边界（F22 要求 4）：恢复批里 facts **行完全缺席**（会话仅经壳行在场，present 由
  // 壳行键给出）同样落到 rowWatermark === undefined，按 C4-X2 登记播种补偿。文档 §3.2.3
  // 的措辞「恢复批里没有可吸收 observed 水位的在场会话（行在场但 completedAt 非 observed
  // / 无水位行）」按「该会话本批无可用水位」读，包含行缺席这一形态——本用例按实现钉住。
  // 有栏 ⇒ 其后首个严格更高的 observed 水位（100）被栏吞一次；无栏对照见下一个 CONTROL。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: false, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, 'C1 壳边沿通知（facts 行缺席，facts 不可用）')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 0 }, 'C1 置栏')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: {} },
  })
  assert.deepEqual(batch.fenceSeeds, [{ sessionId: 's1', watermark: 0 }], '行完全缺席也登记播种（实现口径）')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.deepEqual(
    ledger.state().settleFence.src?.s1,
    { boundary: 0, seededSince: 0 },
    '行缺席 ⇒ 无 observed 水位 ⇒ seededSince=0，栏保留',
  )

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  assert.deepEqual(
    batch.observations[0].candidate,
    { kind: 'complete', watermark: 100, evidence: 'facts-watermark' },
    '会话首次出现在 facts 行 ⇒ 水位 100 是候选',
  )
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '首个更高 observed 水位被栏吞一次（总数 1）')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '吞一次即清栏')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: true, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 200, completedAtSource: 'observed', updatedAt: 200 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 2, '其后新完成 200 照常通知')
  assert.equal(calls.notifications[1].watermark, 200)
})

test('CONTROL(C4-X2 行缺席): without a fence the shell-only recovery seeding stays a no-op and the first watermark notifies', () => {
  // 负例：同样的「facts 行完全缺席 + 恢复批」时序，但 facts 不可用窗口内没有无水位壳
  // emit（无栏）⇒ 播种登记无栏即 no-op，水位 100 到达必须照常通知。
  const ledger = createCompleteLedger()
  const { calls, sink } = makeSink()
  let batch = observeSource({
    sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, goal: null } } },
    facts: { usable: true, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, completed: false, goal: null } } },
    facts: { usable: false, rows: {} },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '没有无水位 emit ⇒ 无围栏')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: true, completed: false, goal: null } } },
    facts: { usable: true, rows: {} },
  })
  // COR-1 精度：不可用窗口内壳轨从未 emit（只有 running=true 的在场行）⇒ 不复位
  // factsSeeded，恢复批不是播种批，也没有播种补偿要登记（旧的「壳轨在场即复位」
  // 口径才在这里登记）；无栏语义不变——首个水位照常通知。
  assert.equal(batch.state.factsSeeded, true, '无壳通知 ⇒ 不复位播种位（COR-1）')
  assert.deepEqual(batch.fenceSeeds, [], '不是播种批 ⇒ 无播种补偿登记')
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '无栏会话的播种登记是 no-op')

  batch = observeSource({
    state: batch.state, sourceId: 'src', identity: 'fp', pageBoot: 'same', shellReport: true,
    shell: { rows: { s1: { running: false, completed: false, goal: null } } },
    facts: { usable: true, rows: { s1: factsRow({ completedAt: 100, completedAtSource: 'observed', updatedAt: 100 }) } },
  })
  applyObservationBatch({ ledger, sourceId: 'src', batch, sink })
  assert.equal(calls.notifications.length, 1, '无围栏的恢复播种不得吞首个水位')
  assert.equal(calls.notifications[0].watermark, 100)
})
