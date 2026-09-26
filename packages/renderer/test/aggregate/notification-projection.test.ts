/**
 * 通知收敛器与运行身份边界的契约（design 19 §3.2/§3.5）。
 *
 * 旧 planner 导出面与只被它调用的纯函数边沿检测/去重实现已删除：现役唯一入口是
 * reconcile（经 completion-observation 的 observeSource/applyObservationBatch）；边沿
 * 语义的现役覆盖在 completion-observation.test.ts，投递身份/跨通道认领在
 * notification-outbox.test.ts。本文件保留收敛器裁决与 isSessionRunId 恢复边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  reconcile,
  type CompletionObservation,
  type GoalFact,
} from '../../src/notification-projection.ts'
import { chamberRunId } from '@dsh-chamber/dsh-stream-state'
import { LEGACY_NOTIFIED_RUN_ID, isSessionRunId } from '../../src/notification-identity.ts'
import { createCompleteLedger } from '../../src/complete-ledger.ts'

test('isSessionRunId: the restore boundary accepts real identities only', () => {
  assert.equal(isSessionRunId('host:turn%2F7'), true)
  assert.equal(isSessionRunId(chamberRunId({ sourceFingerprint: 'fp', generation: 12_000, sessionId: 's1', episode: 1 })), true)
  assert.equal(isSessionRunId(LEGACY_NOTIFIED_RUN_ID), true)
  const bad: unknown[] = [
    'host:%', 'host:', 'host:turn%2f7', 'chamber:fp:0:s1', 'chamber:fp:x:s1:1',
    // Non-canonical components parse equal to a live id; negatives are not ids.
    'chamber:fp:1:s%31:5', 'chamber:fp:1:s1:-1', 'chamber:fp:1:s1:1.5',
    '', 'garbage', 'x'.repeat(257), 42, null,
  ]
  for (const value of bad) assert.equal(isSessionRunId(value), false, String(value))
})

// ── goal-aware v5 P1：水平收敛器 reconcile（G1–G5 + 12 条裁决） ─────────────

const goal = (over: Partial<GoalFact> = {}): GoalFact => ({
  goalId: 'g1',
  revision: 1,
  phase: 'active',
  activation: 'armed',
  updatedAt: 100,
  ...over,
})

const observation = (over: Partial<CompletionObservation> = {}): CompletionObservation => ({
  sourceId: 'src',
  sessionId: 's1',
  generation: 1,
  running: 'idle',
  subagents: 'idle',
  goal: 'unknown',
  baseline: false,
  boot: 'same',
  ...over,
})

const shell = (over: { watermark?: number } = {}) => ({ evidence: 'shell-edge' as const, ...over })
const facts = (watermark: number) => ({ evidence: 'facts-watermark' as const, watermark })

test('INV1/#7: an armed goal holds the candidate with zero notification and absorbs later watermarks', () => {
  const ledger = createCompleteLedger()
  const held = reconcile(ledger.state(), observation({ goal: goal(), candidate: shell() }), 10)
  assert.equal(held.disposition, 'held')
  assert.equal(held.origin, 'goal-armed')
  assert.equal(held.notification, undefined, 'active+armed 期间零 complete 通知')
  assert.equal(ledger.pendingEntry('src', 's1')?.goalId, 'g1')
  assert.equal(ledger.pendingEntry('src', 's1')?.at, 10)
  assert.equal(ledger.armed('src').has('s1'), true, 'hold 同时武装（同一次完成的延迟边沿不得再出）')

  // 同一次压制的第二次完成：水位吸收进 pending，仍不出通知。
  const absorbed = reconcile(ledger.state(), observation({ goal: goal(), candidate: facts(60) }), 20)
  assert.equal(absorbed.notification, undefined)
  assert.equal(ledger.pendingEntry('src', 's1')?.watermark, 60, '候选水位吸收 = max')
  assert.equal(ledger.pendingEntry('src', 's1')?.at, 10, '入场时刻不被刷新（pendingAge 语义）')

  // #6：active+armed、无候选的观测只 keep。
  const kept = reconcile(ledger.state(), observation({ goal: goal() }), 30)
  assert.equal(kept.notification, undefined)
  assert.equal(kept.disposition, undefined)
  assert.equal(kept.origin, 'goal-keep')
  assert.notEqual(ledger.pendingEntry('src', 's1'), undefined)
})

test('W2 身份：completionSeq 进 durable pending，随释放进入通知；已有 pending 身份不被改写', () => {
  const ledger = createCompleteLedger()
  const held = reconcile(ledger.state(), observation({
    goal: goal(),
    candidate: { evidence: 'facts-watermark', watermark: 40, completionSeq: 4242 },
  }), 10)
  assert.equal(held.disposition, 'held')
  assert.equal(ledger.pendingEntry('src', 's1')?.completionSeq, 4242, 'seq 进 pending——否则延迟释放时身份就丢了')

  // 同一 pending 的后续候选（无 seq）不得抹掉已有身份。
  const absorbed = reconcile(ledger.state(), observation({ goal: goal(), candidate: facts(60) }), 15)
  assert.equal(absorbed.notification, undefined)
  assert.equal(ledger.pendingEntry('src', 's1')?.completionSeq, 4242, '已有 pending 保持自己的身份（与 goalId 同规）')

  const flush = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete', updatedAt: 700 }) }), 20)
  assert.equal(flush.disposition, 'flushed')
  assert.equal(flush.notification?.completionSeq, 4242, '释放出的通知带同一身份')

  // 直接路径（goal 未知）：候选的 seq 直达通知。
  const direct = reconcile(createCompleteLedger().state(), observation({
    candidate: { evidence: 'facts-watermark', watermark: 50, completionSeq: 7 },
  }), 10)
  assert.equal(direct.notification?.completionSeq, 7)
})

test('#2/TL1: the goal title fires once per goal identity, later completions fall back to generic', () => {
  const ledger = createCompleteLedger()
  reconcile(ledger.state(), observation({ goal: goal(), candidate: shell() }), 10)
  const flush = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete', updatedAt: 700 }) }), 20)
  assert.equal(flush.disposition, 'flushed')
  assert.equal(flush.notification?.title, 'goal-completed')
  assert.equal(flush.notification?.watermark, 700, 'flush 水位 = max(pending.watermark, goal.updatedAt)')
  assert.equal(flush.pendingAge, 10)
  assert.equal(ledger.outcomeWatermark('src', 'g1'), 700)
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, 'flush 消费 pending')

  // 相同观测重放（TL1 的「重放」）：水位/武装/outcomes 都已消费 ⇒ 零 emit（INV6）。
  const replay = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete', updatedAt: 700 }) }), 20)
  assert.equal(replay.notification, undefined)

  // 新回合：running 解除武装；再次 hold；第二次完成回落「会话已完成」。
  reconcile(ledger.state(), observation({ running: 'running', goal: goal() }), 30)
  assert.equal(ledger.armed('src').size, 0)
  reconcile(ledger.state(), observation({ goal: goal(), candidate: shell() }), 40)
  const second = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete', updatedAt: 900 }) }), 50)
  assert.equal(second.notification?.title, 'session-completed', '目标标题每个 goalId 至多一次')
})

test('INV3/#1: running voids the pending and settles notified; unknown running never voids', () => {
  const ledger = createCompleteLedger()
  reconcile(ledger.state(), observation({ goal: goal(), candidate: facts(50) }), 10)
  const voided = reconcile(ledger.state(), observation({ running: 'running', goal: goal() }), 20)
  assert.equal(voided.disposition, 'voided')
  assert.equal(voided.pendingAge, 10)
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 50, '结清 notified 到 pending.watermark')
  assert.equal(ledger.armed('src').size, 0, 'armed 解除')
  const after = reconcile(ledger.state(), observation({ running: 'running', goal: goal() }), 30)
  assert.equal(after.disposition, undefined, '重复的 running 观测无第二次处置')

  // unknown running 不作废（#5/#6 与 G3）。
  const ledger2 = createCompleteLedger()
  reconcile(ledger2.state(), observation({ goal: goal(), candidate: shell() }), 10)
  const unknownRunning = reconcile(ledger2.state(), observation({ running: 'unknown', goal: goal() }), 20)
  assert.equal(unknownRunning.disposition, undefined)
  assert.notEqual(ledger2.pendingEntry('src', 's1'), undefined, 'running unknown 不得作废 pending')
})

test('#3: paused / null / changed goal drops the pending and settles without notifying', () => {
  // origin 表值逐项钉住：三者覆盖 #3 的全部条件，也是 goalDropOrigin 仅有的三个
  // 可达命名（旧 'goal-drop' 兜底不可达，F14 已删除；若将来出现第四个命名，这里
  // 必须失败）。
  for (const [changed, expectedOrigin] of [
    [goal({ phase: 'paused' }), 'goal-paused'],
    [null, 'goal-none'],
    [goal({ goalId: 'g2' }), 'goal-changed'],
  ] as const) {
    const ledger = createCompleteLedger()
    reconcile(ledger.state(), observation({ goal: goal(), candidate: facts(70) }), 10)
    const dropped = reconcile(ledger.state(), observation({ goal: changed }), 20)
    assert.equal(dropped.disposition, 'dropped')
    assert.equal(dropped.origin, expectedOrigin, 'origin 与 drop 条件一一对应')
    assert.equal(dropped.notification, undefined)
    assert.equal(ledger.pendingEntry('src', 's1'), undefined)
    assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 70, 'drop 也结清水位')
  }
})

test('#4: active+disarmed emits the neutral title exactly once with the pending consumed', () => {
  const ledger = createCompleteLedger()
  reconcile(ledger.state(), observation({ goal: goal(), candidate: shell() }), 10)
  const neutral = reconcile(ledger.state(), observation({ goal: goal({ activation: 'disarmed' }) }), 20)
  assert.equal(neutral.disposition, 'flushed')
  assert.equal(neutral.notification?.title, 'goal-stopped')
  assert.equal(ledger.outcomeWatermark('src', 'g1'), 100)

  // 同一 goalId 的后续完成：中性位已消费 ⇒ 即使 pending 再被消费也回落「会话已完成」。
  reconcile(ledger.state(), observation({ running: 'running', goal: goal({ activation: 'disarmed' }) }), 30)
  reconcile(ledger.state(), observation({ goal: goal(), candidate: shell() }), 40)
  const again = reconcile(ledger.state(), observation({ goal: goal({ activation: 'disarmed' }) }), 50)
  assert.equal(again.disposition, 'flushed')
  assert.equal(again.notification?.title, 'session-completed', '中性标题每个 goalId 至多一次')
})

test('#5/#6/#8: an unknown activation holds, the activation event decides (never auto-downgrades)', () => {
  const ledger = createCompleteLedger()
  const held = reconcile(ledger.state(), observation({ goal: goal({ activation: undefined }), candidate: shell() }), 10)
  assert.equal(held.disposition, 'held')
  assert.equal(held.origin, 'goal-activation-unknown')
  // armed 事件到达：继续 keep（#6），不是 emit。
  const armed = reconcile(ledger.state(), observation({ goal: goal({ activation: 'armed' }) }), 20)
  assert.equal(armed.disposition, undefined)
  assert.equal(armed.notification, undefined)
  assert.equal(armed.origin, 'goal-keep')
  // disarmed 事件到达：中性一次（#4）。
  const disarmed = reconcile(ledger.state(), observation({ goal: goal({ activation: 'disarmed' }) }), 30)
  assert.equal(disarmed.notification?.title, 'goal-stopped')
})

test('#9: complete/blocked with no pending emits the goal title on the first observed outcome', () => {
  const ledger = createCompleteLedger()
  const first = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete' }), candidate: facts(300) }), 10)
  assert.equal(first.notification?.title, 'goal-completed')
  assert.equal(first.notification?.watermark, 300)
  assert.equal(ledger.outcomeWatermark('src', 'g1'), 300)
  // 相同输入重放：水位未严格前进 ⇒ 零 emit。
  const replay = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete' }), candidate: facts(300) }), 20)
  assert.equal(replay.notification, undefined)
  // 已 armed 的壳边沿同样被 G5 挡下。
  const shellReplay = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete' }), candidate: shell() }), 30)
  assert.equal(shellReplay.notification, undefined)
})

test('#10/#11: disarmed/paused goals and unknown goal facts fall back to the generic title', () => {
  const disarmed = createCompleteLedger()
  const generic = reconcile(disarmed.state(), observation({ goal: goal({ activation: 'disarmed' }), candidate: shell() }), 10)
  assert.equal(generic.notification?.title, 'session-completed')
  assert.equal(generic.notification?.origin, 'session-completed')
  assert.equal(disarmed.armed('src').has('s1'), true, '#10 直发必须 arm（延迟壳边沿不得双发）')
  assert.equal(disarmed.pendingEntry('src', 's1'), undefined, '#10 不经 pending')

  const paused = createCompleteLedger()
  const pausedResult = reconcile(paused.state(), observation({ goal: goal({ phase: 'paused' }), candidate: shell() }), 10)
  assert.equal(pausedResult.notification?.title, 'session-completed')
  assert.equal(paused.armed('src').has('s1'), true)
  assert.equal(paused.pendingEntry('src', 's1'), undefined)

  const unknown = createCompleteLedger()
  const failOpen = reconcile(unknown.state(), observation({ goal: 'unknown', candidate: shell() }), 10)
  assert.equal(failOpen.notification?.title, 'session-completed')
  assert.equal(failOpen.origin, 'goal-unknown')
  assert.equal(unknown.armed('src').has('s1'), true, '#11 fail-open 直发同样 arm（I2）')
  assert.equal(unknown.pendingEntry('src', 's1'), undefined)

  const noGoal = createCompleteLedger()
  const noGoalResult = reconcile(noGoal.state(), observation({ goal: null, candidate: shell() }), 10)
  assert.equal(noGoalResult.notification?.title, 'session-completed')
  assert.equal(noGoal.armed('src').has('s1'), true)
  assert.equal(noGoal.pendingEntry('src', 's1'), undefined)
  const noGoalReplay = reconcile(noGoal.state(), observation({ goal: null, candidate: shell() }), 20)
  assert.equal(noGoalReplay.notification, undefined, '#10 重放零 emit')
})

test('#12/INV4: ask and request pass through, only the baseline fences them', () => {
  const ledger = createCompleteLedger()
  const ask = reconcile(ledger.state(), observation({
    goal: goal(),
    candidate: { kind: 'ask', evidence: 'shell-edge' },
  }), 10)
  assert.equal(ask.notification?.kind, 'ask', 'ask 不受 goal 状态影响')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, 'ask 不进 pending')
  const request = reconcile(ledger.state(), observation({
    goal: goal(),
    candidate: { kind: 'request', evidence: 'shell-edge' },
  }), 20)
  assert.equal(request.notification?.kind, 'request')

  // running 权威仍作废 pending，但问题/审批直通。
  const running = createCompleteLedger()
  reconcile(running.state(), observation({ goal: goal(), candidate: shell() }), 10)
  const askWhileRunning = reconcile(running.state(), observation({
    running: 'running',
    goal: goal(),
    candidate: { kind: 'ask', evidence: 'shell-edge' },
  }), 20)
  assert.equal(askWhileRunning.notification?.kind, 'ask')
  assert.equal(askWhileRunning.disposition, 'voided', '同一份观测里 running 仍结清 pending')

  // G2 播种约束：基线观测一律不 emit。
  const baseline = reconcile(ledger.state(), observation({
    baseline: true,
    goal: goal(),
    candidate: { kind: 'ask', evidence: 'shell-edge' },
  }), 30)
  assert.equal(baseline.notification, undefined)
})

test('G1: an observation from another generation is discarded entirely', () => {
  const ledger = createCompleteLedger()
  reconcile(ledger.state(), observation({ generation: 3, goal: goal(), candidate: shell() }), 10)
  const stale = reconcile(ledger.state(), observation({ generation: 2, goal: goal({ phase: 'complete' }) }), 20)
  assert.equal(stale.notification, undefined)
  assert.equal(stale.disposition, undefined)
  assert.notEqual(ledger.pendingEntry('src', 's1'), undefined, '旧代观测不得结算新代的 pending')
})

test('G2/INV5: a baseline observation never emits and settles pending per §3.5', () => {
  const fresh = createCompleteLedger()
  const baseline = reconcile(fresh.state(), observation({ baseline: true, goal: goal(), candidate: shell() }), 10)
  assert.equal(baseline.notification, undefined)
  assert.equal(fresh.pendingEntry('src', 's1'), undefined, '基线候选只播种不压制')

  const base = createCompleteLedger(undefined, {
    pending: { src: { s1: { watermark: 40, goalId: 'g1', at: 1 } } },
    now: 10,
  })
  const settled = reconcile(base.state(), observation({ baseline: true, goal: goal({ phase: 'complete', updatedAt: 80 }) }), 20)
  assert.equal(settled.notification, undefined, '基线不 emit')
  assert.equal(settled.origin, 'silent-settle')
  assert.equal(base.notifiedWatermark('src', 's1', 'complete'), 80)
  assert.equal(base.pendingEntry('src', 's1'), undefined)

  const kept = createCompleteLedger(undefined, {
    pending: { src: { s1: { watermark: 40, goalId: 'g1', at: 1 } } },
    now: 10,
  })
  const active = reconcile(kept.state(), observation({ baseline: true, goal: goal() }), 20)
  assert.equal(active.notification, undefined)
  assert.notEqual(kept.pendingEntry('src', 's1'), undefined, '基线 + active ⇒ 保留 pending，等 outcome')
})

test('INV5/§3.5: an offline outcome settles silently at the first known goal fact; an online one still flushes', () => {
  // 离线「完成 + outcome 均已发生」：首份已知 goal 事实即 complete ⇒ 静默结清，不补发。
  const offline = createCompleteLedger(undefined, {
    pending: { src: { s1: { watermark: 40, at: 1 } } },
    now: 10,
  })
  const beforeKnown = reconcile(offline.state(), observation({ goal: 'unknown' }), 15)
  assert.equal(beforeKnown.notification, undefined)
  assert.notEqual(offline.pendingEntry('src', 's1'), undefined, 'goal 字段缺失不结算（等已知事实）')
  const settled = reconcile(offline.state(), observation({ goal: goal({ phase: 'complete', updatedAt: 90 }) }), 20)
  assert.equal(settled.notification, undefined, '离线完成不得补发')
  assert.equal(settled.disposition, 'dropped')
  assert.equal(offline.outcomeWatermark('src', 'g1'), 90, 'outcome 身份仍记（防目标标题重放）')

  // 重载后目标仍在跑（首份已知事实 = active）：pending 存活，outcome 到达时正常 flush 一次。
  const reloaded = createCompleteLedger(undefined, {
    pending: { src: { s1: { at: 1 } } },
    now: 10,
  })
  const active = reconcile(reloaded.state(), observation({ goal: goal() }), 20)
  assert.equal(active.notification, undefined)
  assert.notEqual(reloaded.pendingEntry('src', 's1'), undefined)
  const flushed = reconcile(reloaded.state(), observation({ goal: goal({ phase: 'complete' }) }), 30)
  assert.equal(flushed.notification?.title, 'goal-completed')
  assert.equal(flushed.notification?.watermark, 100)

  // 冷启动（fresh）：pending 在加载期丢弃 ⇒ 离线完成无任何通知，但后续在线完成照常。
  const cold = createCompleteLedger(undefined, {
    pending: { src: { s1: { watermark: 40, at: 1 } } },
    boot: 'fresh',
    now: 10,
  })
  assert.equal(cold.pendingEntry('src', 's1'), undefined)
  const coldObs = reconcile(cold.state(), observation({ goal: goal({ phase: 'complete' }) }), 20)
  assert.equal(coldObs.notification, undefined)
  const online = reconcile(cold.state(), observation({ goal: goal({ activation: 'disarmed' }), candidate: shell() }), 30)
  assert.equal(online.notification?.title, 'session-completed', '冷启后在线观察到的完成仍通知')
})

test('§3.5 defensive boot=fresh: a surviving pending is dropped and the settle-point memory forgotten', () => {
  // 正常路径下 pending 已在账本构造期随 boot='fresh' 丢弃；这里构造「账本里已有
  // durable pending、本代观测却宣告页代 fresh」的防御分支（§3.5 兜底），覆盖
  // dropPending + forgetGoalKnown（该函数唯一调用点）。
  const ledger = createCompleteLedger(undefined, {
    pending: { src: { s1: { watermark: 40, goalId: 'g1', at: 1 } } },
    now: 10,
  })
  // 第一份已知 goal 事实：pending 保留（keep），并记住结算点（goalKnown）。
  const keep = reconcile(ledger.state(), observation({ goal: goal() }), 15)
  assert.equal(keep.origin, 'goal-keep')
  assert.equal(ledger.state().goalKnown.src?.has('s1'), true, '已知 goal 事实标记结算点')
  assert.notEqual(ledger.pendingEntry('src', 's1'), undefined)
  // 防御分支：boot=fresh 且仍有 pending ⇒ 丢弃 pending + forgetGoalKnown。观测带
  // goal unknown，确保本次调用不会再 markGoalKnown（否则同一份已知事实会立刻把
  // 结算点写回，掩盖 forgetGoalKnown 的清理）。
  const fresh = reconcile(ledger.state(), observation({ boot: 'fresh', goal: 'unknown' }), 20)
  assert.equal(fresh.notification, undefined, '防御丢弃不 emit')
  assert.equal(fresh.disposition, undefined)
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, 'boot=fresh 兜底丢弃 pending')
  assert.equal(ledger.state().goalKnown.src ?? false, false, '结算点记忆同拍清（forgetGoalKnown）')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), undefined, '丢弃不推水位（离线不补发）')
  // 下一条已知 goal 事实重新成为结算点（forgetGoalKnown 只清记忆，不阻断后续）。
  const keepAgain = reconcile(ledger.state(), observation({ goal: goal() }), 25)
  assert.equal(keepAgain.notification, undefined)
  assert.equal(ledger.state().goalKnown.src?.has('s1'), true, '已知事实重新标记结算点')
})

test('G4/INV8: a busy subagent defers the candidate; unknown never suppresses', () => {
  const ledger = createCompleteLedger()
  const deferred = reconcile(ledger.state(), observation({ subagents: 'busy', goal: goal(), candidate: facts(10) }), 10)
  assert.equal(deferred.disposition, 'deferred')
  assert.equal(deferred.origin, 'subagent-busy')
  assert.equal(deferred.notification, undefined)
  assert.equal(ledger.pendingEntry('src', 's1')?.watermark, 10)
  const stillBusy = reconcile(ledger.state(), observation({ subagents: 'busy', goal: goal({ phase: 'complete' }) }), 20)
  assert.equal(stillBusy.notification, undefined, 'busy 期间不 flush')
  assert.notEqual(ledger.pendingEntry('src', 's1'), undefined)
  const idle = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete' }) }), 30)
  assert.equal(idle.disposition, 'flushed', 'busy 结束后继续结算')
  assert.equal(idle.notification?.title, 'goal-completed')

  const unknown = createCompleteLedger()
  const emitted = reconcile(unknown.state(), observation({
    subagents: 'unknown',
    goal: goal({ activation: 'disarmed' }),
    candidate: shell(),
  }), 10)
  assert.equal(emitted.notification?.title, 'session-completed', 'subagents unknown 不压制')
})

test('G5: facts watermarks must strictly advance; armed fences the shell track', () => {
  const ledger = createCompleteLedger()
  ledger.setNotifiedWatermark('src', 's1', 'complete', 100)
  const notAdvancing = reconcile(ledger.state(), observation({
    goal: goal({ activation: 'disarmed' }),
    candidate: facts(100),
  }), 10)
  assert.equal(notAdvancing.notification, undefined)
  assert.equal(notAdvancing.disposition, undefined)

  // 壳已 armed ⇒ 壳候选无候选（不产生第二条同完成通知）。
  const armed = createCompleteLedger()
  reconcile(armed.state(), observation({ goal: goal(), candidate: shell() }), 10)
  const suppressedShell = reconcile(armed.state(), observation({ goal: goal(), candidate: shell() }), 20)
  assert.equal(suppressedShell.disposition, undefined)
  assert.equal(suppressedShell.notification, undefined)

  // 无 pending 且 armed 的 facts 候选：水位 ≤ arm 时记录的界（= 上次消费水位）视为
  // 同一完成的重复上报（不补发，水位单调照记）；水位严格更高 = 新完成，必须放行
  // （F5 阻断项 2：无 running=true 帧的 facts-only 来源不得被武装门永久吞发）。
  const direct = createCompleteLedger()
  reconcile(direct.state(), observation({ goal: goal({ phase: 'complete' }), candidate: facts(300) }), 10)
  assert.equal(direct.notifiedWatermark('src', 's1', 'complete'), 300)
  const replay = reconcile(direct.state(), observation({ goal: goal({ phase: 'complete' }), candidate: facts(300) }), 20)
  assert.equal(replay.notification, undefined, '同水位重复上报不得由 facts 轨补发')
  const beyond = reconcile(direct.state(), observation({ goal: goal({ phase: 'complete' }), candidate: facts(400) }), 30)
  assert.equal(beyond.notification?.watermark, 400, '水位高于 arm 界 = 新完成，必须通知')
  assert.equal(direct.notifiedWatermark('src', 's1', 'complete'), 400, '水位仍单调前进')
})

test('REGRESSION(F5 阻断项 2): 200 consecutive facts-only completions each notify after the arm', () => {
  // 无 running=true 帧（poll 30s / 重连跳变）的来源：种子 100 → 完成 200 emit+arm。
  // 无界 armed 门会把其后每个完成都「单调记水位但不通知」（探针连续 200 个完成只发 1 条）。
  const ledger = createCompleteLedger()
  ledger.setNotifiedWatermark('src', 's1', 'complete', 100) // facts 首快照只播种（种子 100）
  const emitted: number[] = []
  for (let index = 2; index <= 201; index += 1) {
    const watermark = index * 100
    const result = reconcile(ledger.state(), observation({ candidate: facts(watermark) }), index)
    if (result.notification !== undefined) emitted.push(result.notification.watermark ?? -1)
  }
  assert.equal(emitted.length, 200, '连续 200 个严格前进的完成必须逐个通知（armed 界只吞同一次完成的重复上报）')
  assert.deepEqual(emitted.slice(0, 3), [200, 300, 400])
  assert.equal(emitted.at(-1), 20_100)
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 20_100)
})

test('T1/A2 settleFence: the fence eats only what the absorbed boundary can prove', () => {
  const ledger = createCompleteLedger()
  reconcile(ledger.state(), observation({ goal: goal(), candidate: shell(), factsMemory: 100 }), 10)
  const flush = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete' }), factsMemory: 100 }), 20)
  assert.equal(flush.disposition, 'flushed')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 100 }, '无 facts 水位的 flush 置栏（boundary=已吸收水位）')

  // W <= boundary：不高于置栏时已吸收的水位 ⇒ 视为同一完成吞一次，水位照记（INV6）。
  const eaten = reconcile(ledger.state(), observation({
    goal: goal({ phase: 'complete' }),
    candidate: facts(100),
    factsMemory: 100,
  }), 30)
  assert.equal(eaten.notification, undefined, '围栏吞掉 ≤ boundary 的候选（视为同一完成）')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '消费即清')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 100, '围栏消费同样消费候选身份（水位照记）')
  const replayEaten = reconcile(ledger.state(), observation({
    goal: goal({ phase: 'complete' }),
    candidate: facts(100),
    factsMemory: 100,
  }), 35)
  assert.equal(replayEaten.notification, undefined, '相同候选重放零 emit（INV6）')

  // A2：W > boundary 且无播种补偿（seededSince）⇒ 真正的新完成，清栏放行。
  const shell2 = createCompleteLedger()
  reconcile(shell2.state(), observation({ goal: goal(), candidate: shell(), factsMemory: 100 }), 10)
  reconcile(shell2.state(), observation({ goal: goal({ phase: 'complete' }), factsMemory: 100 }), 20)
  const beyond = reconcile(shell2.state(), observation({
    goal: goal({ phase: 'complete' }),
    candidate: facts(999),
    factsMemory: 100,
  }), 30)
  assert.equal(beyond.notification?.watermark, 999, 'W > boundary 不得被盲吞（A2 不得回归）')
  assert.equal(shell2.state().settleFence.src?.s1 ?? false, false, '放行也清栏（一次性）')

  // running 也清围栏。
  const ledger2 = createCompleteLedger()
  reconcile(ledger2.state(), observation({ goal: goal(), candidate: shell(), factsMemory: 100 }), 10)
  reconcile(ledger2.state(), observation({ goal: goal({ phase: 'complete' }), factsMemory: 100 }), 20)
  assert.notEqual(ledger2.state().settleFence.src?.s1, undefined)
  reconcile(ledger2.state(), observation({ running: 'running', goal: goal(), factsMemory: 100 }), 30)
  assert.equal(ledger2.state().settleFence.src?.s1 ?? false, false)
  const afterRun = reconcile(ledger2.state(), observation({
    goal: goal({ phase: 'complete' }),
    candidate: facts(1_000),
    factsMemory: 100,
  }), 40)
  assert.equal(afterRun.notification?.title, 'session-completed', 'running 清围栏后新完成照常通知')
})

test('§3.3 settle guard / TL3: a replayed pending whose watermark is already notified drops', () => {
  const ledger = createCompleteLedger({}, {
    pending: { src: { s1: { watermark: 100, at: 1 } } },
    now: 10,
  })
  ledger.setNotifiedWatermark('src', 's1', 'complete', 100)
  const dropped = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete' }) }), 20)
  assert.equal(dropped.disposition, 'dropped')
  assert.equal(dropped.origin, 'settle-guard')
  assert.equal(dropped.notification, undefined, 'flush 后崩溃重放不得双发（TL3）')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)
})

test('§3.3/TL3 releaseDeferred settle-guard: an already-notified deferred pending drops without re-emitting', () => {
  // 崩溃/同页重放场景：busy 延迟的 pending 已 durable 且 notified 已推进到同水位
  // （释放后崩溃，pending 尚未落盘即重放）⇒ releaseDeferred 只清不重发。该守卫是
  // goal-unknown 释放入口专属：goal 已已知（null/paused）时，主分支的 #3 类结算
  // 守卫（reconcileCore 的 settle-guard）更早短路，不会到达 releaseDeferred。
  const ledger = createCompleteLedger(undefined, {
    pending: { src: { s1: { watermark: 100, at: 1, deferred: 'subagent-busy' } } },
    now: 10,
  })
  ledger.setNotifiedWatermark('src', 's1', 'complete', 100)
  const released = reconcile(ledger.state(), observation({ goal: 'unknown' }), 20)
  assert.equal(released.disposition, 'dropped', 'settle-guard 走 dropped 而非 flushed')
  assert.equal(released.origin, 'settle-guard')
  assert.equal(released.notification, undefined, 'settle-guard 只清不重发')
  assert.equal(released.pendingAge, 19)
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, 'settle-guard 消费 pending')
  assert.equal(ledger.armed('src').has('s1'), true, '释放路径仍 arm（延迟壳边沿不得再出）')
  assert.equal(ledger.state().armedFloor.src?.s1, 100, 'arm 界 = 已通知水位')
  // 表值单调不动：notified 保持 100（不得被清成 0 / 下调）。
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 100)
  // 之后同水位的 facts 候选重放仍零 emit（身份/水位表值都在）。
  const replay = reconcile(ledger.state(), observation({ goal: 'unknown', candidate: facts(100) }), 30)
  assert.equal(replay.notification, undefined, 'notified 水位挡住同水位重放')
})

test('INV6: identical observations never emit a second notification', () => {
  // hold 幂等
  const held = createCompleteLedger()
  const holdObs = observation({ goal: goal(), candidate: shell() })
  assert.equal(reconcile(held.state(), holdObs, 10).notification, undefined)
  assert.equal(reconcile(held.state(), holdObs, 10).notification, undefined)
  // flush 幂等
  const flushObs = observation({ goal: goal({ phase: 'complete' }) })
  const firstFlush = reconcile(held.state(), flushObs, 20)
  assert.equal(firstFlush.notification?.title, 'goal-completed')
  assert.equal(reconcile(held.state(), flushObs, 20).notification, undefined)
  // 直接 emit 幂等（facts 水位严格前进 + 壳 armed 两条消费路径）
  const direct = createCompleteLedger()
  const directObs = observation({ goal: goal({ phase: 'blocked' }), candidate: facts(500) })
  assert.equal(reconcile(direct.state(), directObs, 10).notification?.title, 'goal-blocked')
  assert.equal(reconcile(direct.state(), directObs, 10).notification, undefined)
})

test('INV2/TL2: a goal outcome observed online yields exactly one notification across a reload window', () => {
  // reload：bootToken same ⇒ pending 保留；第二次完成在 reload 后结算，只发一条。
  const same = createCompleteLedger({}, {
    pending: { src: { s1: { watermark: 200, goalId: 'g1', at: 1 } } },
    outcomes: {},
    boot: 'same',
    now: 10,
  })
  const keep = reconcile(same.state(), observation({ goal: goal() }), 20)
  assert.equal(keep.notification, undefined)
  const first = reconcile(same.state(), observation({ goal: goal({ phase: 'complete', updatedAt: 300 }) }), 30)
  assert.equal(first.notification?.title, 'goal-completed')
  const replay = reconcile(same.state(), observation({ goal: goal({ phase: 'complete', updatedAt: 300 }) }), 30)
  assert.equal(replay.notification, undefined)
})

// ── 评审 A 修复回归（Wave7）：G4 延迟释放 / ask 直通不短路结算 ───────────────

test('G4 release (阻断项): a busy-deferred completion under goal null releases neutral exactly once', () => {
  const ledger = createCompleteLedger()
  const deferred = reconcile(ledger.state(), observation({ subagents: 'busy', goal: null, candidate: shell() }), 10)
  assert.equal(deferred.disposition, 'deferred')
  assert.equal(deferred.origin, 'subagent-busy')
  assert.equal(ledger.pendingEntry('src', 's1')?.deferred, 'subagent-busy', '延迟来源必须入账')
  assert.equal(ledger.armed('src').has('s1'), false, 'busy 期间不 arm')

  // busy 结束（无候选）：必须中性释放一次，而不是 #3 静默 drop + 结清水位。
  const released = reconcile(ledger.state(), observation({ goal: null }), 20)
  assert.equal(released.disposition, 'flushed')
  assert.equal(released.origin, 'subagent-busy-release')
  assert.equal(released.notification?.kind, 'complete')
  assert.equal(released.notification?.title, 'session-completed')
  assert.equal(released.pendingAge, 10)
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, '释放消费 pending')
  assert.equal(ledger.armed('src').has('s1'), true, '释放后 arm（同一完成的延迟边沿不得再出）')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 0 }, '无 facts 水位的释放置栏（boundary=0）')

  // 重放/后续无候选观测：零 emit（只发一次）。
  const replay = reconcile(ledger.state(), observation({ goal: null }), 30)
  assert.equal(replay.notification, undefined)
  assert.equal(replay.disposition, undefined)

  // A2：boundary=0 的栏无法证明任何水位属于被守卫的完成 ⇒ W=900 清栏放行，不得盲吞。
  const beyond = reconcile(ledger.state(), observation({ goal: null, candidate: facts(900), factsMemory: 0 }), 40)
  assert.equal(beyond.notification?.watermark, 900, 'boundary=0 的栏不得吞掉真正的新完成（A2 不得回归）')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '放行即清栏')
})

test('G4 release (阻断项): goal unknown releases fail-open and consumes the facts watermark once', () => {
  const ledger = createCompleteLedger()
  const deferred = reconcile(ledger.state(), observation({ subagents: 'busy', goal: 'unknown', candidate: facts(120) }), 10)
  assert.equal(deferred.disposition, 'deferred')
  assert.equal(ledger.pendingEntry('src', 's1')?.watermark, 120)
  assert.equal(ledger.pendingEntry('src', 's1')?.deferred, 'subagent-busy')

  // 仍 busy：不释放（G4 期间不 flush/不推进水位）。
  const stillBusy = reconcile(ledger.state(), observation({ subagents: 'busy', goal: 'unknown' }), 15)
  assert.equal(stillBusy.notification, undefined)
  assert.notEqual(ledger.pendingEntry('src', 's1'), undefined)
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), undefined)

  // busy 结束、goal 仍 unknown：fail-open 中性直发一次并推进水位（#11 语义）。
  const released = reconcile(ledger.state(), observation({ goal: 'unknown' }), 20)
  assert.equal(released.origin, 'subagent-busy-release')
  assert.equal(released.notification?.title, 'session-completed')
  assert.equal(released.notification?.watermark, 120)
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 120)
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)

  // 同水位重放：notified 已推进 ⇒ 零 emit（只发一次）。
  const replay = reconcile(ledger.state(), observation({ goal: 'unknown', candidate: facts(120) }), 30)
  assert.equal(replay.notification, undefined)
})

test('G4 release: paused releases neutral; active/complete keep their own branches', () => {
  // paused：延迟 ≠ 压制（#10 语义），释放中性一次。
  const paused = createCompleteLedger()
  reconcile(paused.state(), observation({ subagents: 'busy', goal: goal({ phase: 'paused' }), candidate: shell() }), 10)
  assert.equal(paused.pendingEntry('src', 's1')?.deferred, 'subagent-busy')
  const released = reconcile(paused.state(), observation({ goal: goal({ phase: 'paused' }) }), 20)
  assert.equal(released.notification?.title, 'session-completed')
  assert.equal(released.disposition, 'flushed')

  // active+armed：pending 是目标压制位（不标延迟），继续 keep，outcome 到达才 flush。
  const active = createCompleteLedger()
  reconcile(active.state(), observation({ subagents: 'busy', goal: goal(), candidate: shell() }), 10)
  assert.equal(active.pendingEntry('src', 's1')?.deferred, undefined, 'active 语境不标延迟')
  const kept = reconcile(active.state(), observation({ goal: goal() }), 20)
  assert.equal(kept.notification, undefined)
  assert.equal(kept.origin, 'goal-keep')
  const flushed = reconcile(active.state(), observation({ goal: goal({ phase: 'complete', updatedAt: 700 }) }), 30)
  assert.equal(flushed.disposition, 'flushed')
  assert.equal(flushed.notification?.title, 'goal-completed')

  // active+disarmed：既有 #4 分支照走。
  const disarmed = createCompleteLedger()
  reconcile(disarmed.state(), observation({ subagents: 'busy', goal: goal(), candidate: shell() }), 10)
  const stopped = reconcile(disarmed.state(), observation({ goal: goal({ activation: 'disarmed' }) }), 20)
  assert.equal(stopped.notification?.title, 'goal-stopped')
})

test('G4 release (A1): a baseline observation still releases a busy-deferred pending; non-deferred settles per §3.5', () => {
  // goal null + 基线 + 延迟 pending：延迟位是 durable 身份（busy 只延迟不压制），
  // 基线也必须释放一次——否则 pending 落回 #3 静默 drop，完成永久丢失。
  const nullBase = createCompleteLedger(undefined, {
    pending: { src: { s1: { at: 1, deferred: 'subagent-busy' } } },
    now: 5,
  })
  const nullBaseline = reconcile(nullBase.state(), observation({ baseline: true, goal: null }), 10)
  assert.equal(nullBaseline.notification?.title, 'session-completed', 'A1：基线释放中性通知')
  assert.equal(nullBaseline.disposition, 'flushed')
  assert.equal(nullBase.pendingEntry('src', 's1'), undefined)

  // goal unknown + 基线 + 延迟 pending：G3 fail-open 同样释放并消费水位。
  const unknownBase = createCompleteLedger(undefined, {
    pending: { src: { s1: { at: 1, watermark: 90, deferred: 'subagent-busy' } } },
    now: 5,
  })
  const unknownBaseline = reconcile(unknownBase.state(), observation({ baseline: true, goal: 'unknown' }), 10)
  assert.equal(unknownBaseline.notification?.watermark, 90, 'A1：G3 基线释放且水位照记')
  assert.equal(unknownBase.pendingEntry('src', 's1'), undefined, '释放消费 pending')

  // 非延迟的基线 pending：仍按 #2 静默结清（G2 的「不补发」语义不变）。
  const basePending = createCompleteLedger(undefined, {
    pending: { src: { s1: { at: 1, watermark: 40, goalId: 'g1' } } },
    now: 5,
  })
  const base = reconcile(basePending.state(), observation({ baseline: true, goal: goal({ phase: 'complete', updatedAt: 80 }) }), 10)
  assert.equal(base.notification, undefined, 'G2 基线非延迟 pending 不补发')
  assert.equal(base.origin, 'silent-settle')
})

test('G4 release: an already-held goal pending keeps its identity even if busy follows', () => {
  const ledger = createCompleteLedger()
  // 先 hold（active+armed，目标压制位），随后 busy 到达：只能吸收水位，不得改写为延迟。
  reconcile(ledger.state(), observation({ goal: goal(), candidate: facts(50) }), 10)
  reconcile(ledger.state(), observation({ subagents: 'busy', goal: goal(), candidate: facts(80) }), 20)
  assert.equal(ledger.pendingEntry('src', 's1')?.deferred, undefined, '已有 pending 不得被 busy 改写身份')
  assert.equal(ledger.pendingEntry('src', 's1')?.watermark, 80)
  // 目标转 paused：目标压制位的 #3 drop（不是延迟释放）。
  const dropped = reconcile(ledger.state(), observation({ goal: goal({ phase: 'paused' }) }), 30)
  assert.equal(dropped.disposition, 'dropped')
  assert.equal(dropped.notification, undefined)
})

test('#12/§3.3 (评审 A): ask/request no longer short-circuits the pending settlement', () => {
  const ledger = createCompleteLedger()
  reconcile(ledger.state(), observation({ goal: goal(), candidate: shell() }), 10) // hold(g1)
  const combined = reconcile(ledger.state(), observation({
    goal: goal({ phase: 'complete', updatedAt: 700 }),
    candidate: { kind: 'ask', evidence: 'shell-edge' },
  }), 20)
  assert.equal(combined.disposition, 'flushed', '同一份观测必须跑 pending 结算')
  assert.equal(combined.notification?.kind, 'complete', '结算通知为主通知')
  assert.equal(combined.notification?.title, 'goal-completed')
  assert.deepEqual(combined.notifications?.map(n => n.kind), ['complete', 'ask'], '两条通知都产出')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, 'pending 已消费，不再等下一份观测')

  // 结算已发生：complete 幂等（重放不再发第二条 complete），ask 照直发。
  const replay = reconcile(ledger.state(), observation({
    goal: goal({ phase: 'complete' }),
    candidate: { kind: 'ask', evidence: 'shell-edge' },
  }), 30)
  assert.equal(replay.notification?.kind, 'ask')
  assert.deepEqual(replay.notifications?.map(n => n.kind), ['ask'])

  // active+armed：结算照跑但只 keep，pending 保留，ask 照发。
  const keep = createCompleteLedger()
  reconcile(keep.state(), observation({ goal: goal(), candidate: shell() }), 10)
  const askKeep = reconcile(keep.state(), observation({
    goal: goal(),
    candidate: { kind: 'request', evidence: 'shell-edge' },
  }), 20)
  assert.equal(askKeep.notification?.kind, 'request')
  assert.equal(askKeep.origin, 'goal-keep')
  assert.notEqual(keep.pendingEntry('src', 's1'), undefined)

  // 基线：ask 不 emit（G2），但结算照跑（静默）。
  const base = createCompleteLedger(undefined, {
    pending: { src: { s1: { watermark: 40, goalId: 'g1', at: 1 } } },
    now: 10,
  })
  const baseline = reconcile(base.state(), observation({
    baseline: true,
    goal: goal({ phase: 'complete', updatedAt: 80 }),
    candidate: { kind: 'request', evidence: 'shell-edge' },
  }), 20)
  assert.equal(baseline.notification, undefined, '基线不 emit ask')
  assert.equal(base.pendingEntry('src', 's1'), undefined, '基线仍静默结清 pending')
  assert.equal(base.notifiedWatermark('src', 's1', 'complete'), 80)
})

// ── 围栏边界重构（A2/A3-3/B3-1）：R2/R4 直测收敛器；R1/R3 见 completion-observation ──

test('R2【A3-3】: boundary-100 fence + seededSince 100 eats the first higher report once (2 notifications / 2 completions)', () => {
  const ledger = createCompleteLedger()
  ledger.setNotifiedWatermark('src', 's1', 'complete', 50) // 模拟 facts 已播种到 50
  // C0(100)：facts 首次真正前进的完成 ⇒ 通知 #1。
  const c0 = reconcile(ledger.state(), observation({ goal: 'unknown', candidate: facts(100), factsMemory: 50 }), 5)
  assert.equal(c0.notification?.watermark, 100)
  // 新回合 running 清武装（无栏）。
  reconcile(ledger.state(), observation({ running: 'running', goal: 'unknown', factsMemory: 100 }), 7)

  // C1：busy 延迟的壳候选（无水位）→ goal unknown fail-open 释放 ⇒ 通知 #2 + 置栏
  // {boundary:100}。
  reconcile(ledger.state(), observation({ subagents: 'busy', goal: 'unknown', candidate: shell(), factsMemory: 100 }), 10)
  const release = reconcile(ledger.state(), observation({ goal: 'unknown', factsMemory: 100 }), 20)
  assert.equal(release.notification?.title, 'session-completed')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 100 }, 'C1 释放置栏（boundary=100）')

  // running 再次清栏（新回合）。
  reconcile(ledger.state(), observation({ running: 'running', goal: 'unknown', factsMemory: 100 }), 30)
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, 'running #1 清栏')

  // C1 再置栏（离线结算点，零 emit）：busy 延迟 pending + 首份已知 goal 事实 = outcome
  // ⇒ #2 静默结清并置栏 {boundary:100}。
  reconcile(ledger.state(), observation({ subagents: 'busy', goal: 'unknown', candidate: shell(), factsMemory: 100 }), 40)
  const silent = reconcile(ledger.state(), observation({ goal: goal({ phase: 'complete', updatedAt: 100 }), factsMemory: 100 }), 50)
  assert.equal(silent.disposition, 'dropped')
  assert.equal(silent.origin, 'silent-settle')
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 100 }, 'C1 再置栏（boundary=100）')

  // 播种只到 100：seededSince=100，栏保留。
  ledger.seedSettleFence('src', 's1', 100)
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 100, seededSince: 100 })
  // facts 到 200：只吞一次、不双发；总数 2 条 / 2 个完成。
  const swallowed = reconcile(ledger.state(), observation({ goal: 'unknown', candidate: facts(200), factsMemory: 100 }), 60)
  assert.equal(swallowed.notification, undefined, '播种后的首条更高报告是被守卫完成的首次上报，吞一次')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '吞一次即清')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 200, '吞掉也消费候选身份')
  const replay = reconcile(ledger.state(), observation({ goal: 'unknown', candidate: facts(200), factsMemory: 100 }), 65)
  assert.equal(replay.notification, undefined, '吞掉后相同 200 重放零 emit（身份已消费，不得被 armed 界放行）')
  const emitted = [c0, release, silent, swallowed, replay].flatMap(result =>
    result.notifications ?? (result.notification === undefined ? [] : [result.notification]))
  assert.equal(emitted.length, 2, '总数 2 条通知 / 2 个完成（全部阶段合计，不只 c0/release）')
  assert.deepEqual(emitted.map(notification => notification.watermark), [100, undefined], '通知水位表值：facts 100 + 无水位释放')
})

test('settleFence: #9/#10/#11 shell direct emits all set the boundary; facts consumption never does', () => {
  // #9：goal outcome + 壳候选直发。
  const outcome = createCompleteLedger()
  reconcile(outcome.state(), observation({ goal: goal({ phase: 'complete' }), candidate: shell(), factsMemory: 42 }), 10)
  assert.deepEqual(outcome.state().settleFence.src?.s1, { boundary: 42 }, '#9 直发置栏')
  // #10：goal null / paused / active+disarmed 中性直发。
  const neutral = createCompleteLedger()
  reconcile(neutral.state(), observation({ goal: null, candidate: shell(), factsMemory: 42 }), 10)
  assert.deepEqual(neutral.state().settleFence.src?.s1, { boundary: 42 }, '#10 直发置栏')
  // #11：goal unknown fail-open 直发。
  const failOpen = createCompleteLedger()
  reconcile(failOpen.state(), observation({ goal: 'unknown', candidate: shell(), factsMemory: 42 }), 10)
  assert.deepEqual(failOpen.state().settleFence.src?.s1, { boundary: 42 }, '#11 直发置栏')
  // 有水位消费（facts 候选）不置栏。
  const factsConsumed = createCompleteLedger()
  reconcile(factsConsumed.state(), observation({ goal: null, candidate: facts(7), factsMemory: 0 }), 10)
  assert.equal(factsConsumed.state().settleFence.src?.s1 ?? false, false, '有水位消费不置栏')
})

test('settleFence: a shell candidate arriving under a fence is swallowed and clears it', () => {
  const ledger = createCompleteLedger()
  reconcile(ledger.state(), observation({ goal: null, candidate: shell(), factsMemory: 100 }), 10)
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 100 })
  // 模拟壳轨写回解除武装（旧 planner 路径）但保留围栏：同一壳完成不得双发。
  ledger.setArmed('src', new Set())
  const suppressed = reconcile(ledger.state(), observation({ goal: null, candidate: shell(), factsMemory: 100 }), 20)
  assert.equal(suppressed.notification, undefined, '壳候选到达时已有栏 ⇒ 吞')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '吞并清栏')
})

test('R4: a fence with W > boundary and no seeding compensation emits the new completion exactly once', () => {
  // 栏存在但 W > boundary 且无 seededSince ⇒ 清栏正常裁决（emit 一次）。
  const ledger = createCompleteLedger()
  reconcile(ledger.state(), observation({ goal: null, candidate: shell(), factsMemory: 100 }), 10)
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 100 })
  const fresh = reconcile(ledger.state(), observation({ goal: null, candidate: facts(200), factsMemory: 100 }), 20)
  assert.equal(fresh.notification?.watermark, 200, 'W > boundary 且无 seededSince ⇒ 新完成 emit 一次')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '放行即清栏')

  // 有 seededSince：首条更高候选吞一次，其后又有新完成照常 emit。
  const seeded = createCompleteLedger()
  reconcile(seeded.state(), observation({ goal: null, candidate: shell(), factsMemory: 100 }), 10)
  seeded.seedSettleFence('src', 's1', 100)
  const eaten = reconcile(seeded.state(), observation({ goal: null, candidate: facts(200), factsMemory: 100 }), 20)
  assert.equal(eaten.notification, undefined, 'seededSince 之下首条更高候选吞一次')
  assert.equal(seeded.notifiedWatermark('src', 's1', 'complete'), 200, '吞掉也消费候选身份（水位表值）')
  const replayed = reconcile(seeded.state(), observation({ goal: null, candidate: facts(200), factsMemory: 100 }), 25)
  assert.equal(replayed.notification, undefined, '吞后相同 200 重放零 emit（回退身份消费即红）')
  const next = reconcile(seeded.state(), observation({ goal: null, candidate: facts(300), factsMemory: 200 }), 30)
  assert.equal(next.notification?.watermark, 300, '其后又有新完成 ⇒ emit 一次')
  assert.equal(seeded.state().settleFence.src?.s1 ?? false, false)
})

test('R5【B4-3】: a boundary-100 fence eats an exactly-equal facts watermark 100 (<=, not <)', () => {
  // 直接钉住 swallowFactsCandidateByFence 的第一条判定是「W <= boundary」：notified 尚未
  // 推进（置栏的壳直发没有水位消费）、栏 boundary=100、候选 W=100 ⇒ 必为同一完成，必须吞。
  // 变异为 W < boundary 时该候选穿过栏走正常裁决（goal null ⇒ 中性 emit），本用例即红。
  const ledger = createCompleteLedger()
  reconcile(ledger.state(), observation({ goal: null, candidate: shell(), factsMemory: 100 }), 10)
  assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 100 }, '壳直发置栏 boundary=100')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), undefined, 'notified 未推进（无水位消费）')

  const eaten = reconcile(ledger.state(), observation({ goal: null, candidate: facts(100), factsMemory: 100 }), 20)
  assert.equal(eaten.notification, undefined, 'W=100 <= boundary=100 必须吞（变异为 < 即红）')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '吞一次即清栏')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 100, '吞掉也消费候选身份（水位照记）')

  // 反向对照：同一栏下 W=101（严格更高且无 seededSince）必须放行 emit 一次。
  const higher = createCompleteLedger()
  reconcile(higher.state(), observation({ goal: null, candidate: shell(), factsMemory: 100 }), 10)
  const emitted = reconcile(higher.state(), observation({ goal: null, candidate: facts(101), factsMemory: 100 }), 20)
  assert.equal(emitted.notification?.watermark, 101, 'W > boundary 且无 seededSince ⇒ 正常放行')
  assert.equal(higher.state().settleFence.src?.s1 ?? false, false, '放行即清栏')
})

test('ReconcileOptions.keepFence: the same-batch seeding exemption skips ONLY the fence clear (#1 semantics unchanged)', () => {
  // V5-B/F22 的同批时序修复在收敛器层的契约面：调用方（applyObservationBatch）只在
  // 同一批已为该会话登记 fenceSeed 时传 keepFence。它必须只豁免 settleFence 清除，
  // #1 的解除武装语义原样保留；缺省（undefined）仍按原 #1 清栏。
  const setup = (): ReturnType<typeof createCompleteLedger> => {
    const ledger = createCompleteLedger()
    // #10 壳直发：置栏 boundary=100 + arm（无水位消费）。
    reconcile(ledger.state(), observation({ goal: null, candidate: shell(), factsMemory: 100 }), 10)
    assert.deepEqual(ledger.state().settleFence.src?.s1, { boundary: 100 })
    assert.equal(ledger.armed('src').has('s1'), true)
    return ledger
  }

  const kept = setup()
  const receipt = reconcile(kept.state(), observation({ running: 'running', goal: null }), 30, { keepFence: true })
  assert.equal(receipt.notification, undefined, 'keepFence 的 #1 早退不产通知')
  assert.deepEqual(kept.state().settleFence.src?.s1, { boundary: 100 }, 'keepFence 保留栏（同批播种补偿的前提）')
  assert.equal(kept.armed('src').has('s1'), false, 'keepFence 不得阻止 #1 解除武装')

  const cleared = setup()
  reconcile(cleared.state(), observation({ running: 'running', goal: null }), 30)
  assert.equal(cleared.state().settleFence.src?.s1 ?? false, false, '缺省仍清栏（#1 原语义不变）')
  assert.equal(cleared.armed('src').has('s1'), false, '缺省同样解除武装')
})
