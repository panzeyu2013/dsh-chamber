/**
 * complete 通知账本内核契约：武装轨的「直到重新 running」
 * 规则、水位轨的单调与 kind 隔离、撤回只清武装轨、forget/prune 的两轨收敛。
 * 两轨的裁定规则本体在 watermark.ts / notification-projection.reconcile，这里钉的是账本容器。
 *
 * goal-aware v5 §3.1 增量：pending（被压制完成结算位）与 outcomes（标题一次性身份）
 * 两张 durable 表 + boot/年龄卫生 + 撤回清 pending（notified/outcomes 保留）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PENDING_MAX_AGE_MS,
  createCompleteLedger,
  type PendingCompletionTable,
} from '../../src/complete-ledger.ts'
import { reconcile, type CompletionObservation } from '../../src/notification-projection.ts'

test('the armed track drops a repeated complete until the session runs again', () => {
  // 规则本体在现役唯一入口 reconcile：壳候选首见放行并武装、重放被挡、
  // 重新 running 解除武装后再次放行；账本容器只用 state()/armed 读回。
  const ledger = createCompleteLedger()
  const shellEdge: CompletionObservation = {
    sourceId: 'src', sessionId: 's1', generation: 1, running: 'idle', subagents: 'idle',
    goal: 'unknown', candidate: { evidence: 'shell-edge' }, baseline: false, boot: 'same',
  }
  const first = reconcile(ledger.state(), shellEdge, 1)
  assert.equal(first.notification?.kind, 'complete', '首见放行并记账')
  assert.equal(ledger.armed('src').has('s1'), true)
  const replay = reconcile(ledger.state(), shellEdge, 2)
  assert.equal(replay.notification, undefined, '未重新 running 的重复边沿被丢弃')
  reconcile(ledger.state(), { ...shellEdge, running: 'running', candidate: undefined }, 3)
  assert.equal(ledger.armed('src').has('s1'), false, '重新 running 清记忆')
  const again = reconcile(ledger.state(), shellEdge, 4)
  assert.equal(again.notification?.kind, 'complete', '重新 running 清记忆后重新放行')
})

test('the identity track is keyed by (source, session) and survives a withdrawal', () => {
  const ledger = createCompleteLedger({ src: { s1: 'host:turn%2F7' } })
  assert.equal(ledger.notifiedRun('src', 's1'), 'host:turn%2F7')
  ledger.setNotifiedRun('src', 's1', 'host:turn%2F8')
  assert.equal(ledger.notifiedRun('src', 's1'), 'host:turn%2F8')
  assert.equal(ledger.notifiedRun('src', 's2'), undefined, 'sessions are isolated')
  ledger.setArmed('src', new Set(['s1']))
  ledger.forgetArmed('src')
  assert.equal(ledger.armed('src').size, 0, '撤回清武装轨')
  assert.equal(ledger.notifiedRun('src', 's1'), 'host:turn%2F8', '撤回不得清 durable 身份轨（R2）')
})

test('runtime settlement is distinct from arming and is consumed by an identity write', () => {
  const ledger = createCompleteLedger()
  ledger.setArmed('src', new Set(['s1']))
  assert.equal(ledger.runtimeSettled('src').has('s1'), false)
  ledger.markRuntimeSettled('src', 's1')
  assert.equal(ledger.runtimeSettled('src').has('s1'), true)
  ledger.setNotifiedRun('src', 's1', 'chamber:fp:0:s1:100')
  assert.equal(ledger.runtimeSettled('src').has('s1'), false)
  ledger.markRuntimeSettled('src', 's1')
  assert.equal(ledger.runtimeSettled('src').has('s1'), true, 'a re-settled run keeps its anchor')
})

test('runtime settlement carries the host anchor that keeps adoption run-scoped', () => {
  const ledger = createCompleteLedger()
  ledger.markRuntimeSettled('src', 's1', 1_700_000_000_000)
  assert.equal(ledger.runtimeSettled('src').get('s1'), 1_700_000_000_000)
  // A host-time-less edge is still a marker (legacy fallback), never an anchor.
  ledger.markRuntimeSettled('src', 's2')
  assert.equal(ledger.runtimeSettled('src').has('s2'), true)
  assert.equal(ledger.runtimeSettled('src').get('s2'), undefined)
  // A newer edge for the same session replaces the stale anchor.
  ledger.markRuntimeSettled('src', 's1', 1_700_000_060_000)
  assert.equal(ledger.runtimeSettled('src').get('s1'), 1_700_000_060_000)
})

test('forget drops every track; prune removes only absent sources and reports change', () => {
  const ledger = createCompleteLedger({ a: { s: 'host:turn%2F1' }, b: { s: 'host:turn%2F2' } })
  ledger.setArmed('a', new Set(['s']))
  ledger.setArmed('b', new Set(['s']))
  ledger.markRuntimeSettled('a', 's')
  ledger.markRuntimeSettled('b', 's')
  assert.equal(ledger.prune(new Set(['a'])), true)
  assert.equal(ledger.prune(new Set(['a'])), false, '无变化必须返回 false（App 据此避免重建引用）')
  assert.equal(ledger.notifiedRun('a', 's'), 'host:turn%2F1')
  assert.equal(ledger.notifiedRun('b', 's'), undefined)
  assert.equal(ledger.armed('b').size, 0)
  assert.equal(ledger.runtimeSettled('b').size, 0)
  ledger.forget('a')
  assert.equal(ledger.notifiedRun('a', 's'), undefined)
  assert.equal(ledger.armed('a').size, 0)
  assert.equal(ledger.runtimeSettled('a').size, 0)
})

test('notifiedRunTable is the persisted v4 shape and older snapshots are never mutated', () => {
  const ledger = createCompleteLedger()
  ledger.setNotifiedRun('src', 's1', 'host:turn%2F5')
  assert.deepEqual(ledger.notifiedRunTable(), { src: { s1: 'host:turn%2F5' } })
  const snapshot = ledger.notifiedRunTable()
  ledger.setNotifiedRun('src', 's1', 'host:turn%2F6')
  assert.equal(snapshot.src.s1, 'host:turn%2F5', '旧快照冻结在写入时刻')
  assert.equal(ledger.notifiedRunTable().src.s1, 'host:turn%2F6')
})

// ── goal-aware v5 §3.1：pending / outcomes 两表 ──────────────────────────────

test('pending is two-level, copy-on-write, and snapshots stay frozen', () => {
  const ledger = createCompleteLedger()
  ledger.setPending('src', 's1', { watermark: 5, goalId: 'g1', at: 100 })
  assert.deepEqual(ledger.pendingEntry('src', 's1'), { watermark: 5, goalId: 'g1', at: 100 })
  assert.deepEqual(ledger.pendingTable(), { src: { s1: { watermark: 5, goalId: 'g1', at: 100 } } })
  const snapshot = ledger.pendingTable()
  ledger.setPending('src', 's1', { at: 101 })
  ledger.setPending('src', 's2', { at: 102 })
  assert.equal(snapshot.src.s1.watermark, 5, '旧快照不被后续写入改写')
  assert.equal(snapshot.src.s2, undefined, '新会话不泄漏进旧快照')
  ledger.clearPending('src', 's1')
  ledger.clearPending('src', 's2')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)
  assert.deepEqual(ledger.pendingTable(), {}, '空表从两级键里收敛掉')
})

test('outcomes are a per-goal one-shot identity, monotonic per (source, goalId)', () => {
  const ledger = createCompleteLedger()
  assert.equal(ledger.outcomeWatermark('src', 'g1'), undefined)
  ledger.setOutcome('src', 'g1', 100)
  assert.equal(ledger.outcomeWatermark('src', 'g1'), 100)
  ledger.setOutcome('src', 'g1', 90)
  assert.equal(ledger.outcomeWatermark('src', 'g1'), 100, '只升不降')
  ledger.setOutcome('src', 'g1', 120)
  assert.equal(ledger.outcomeWatermark('src', 'g1'), 120)
  assert.equal(ledger.outcomeWatermark('src', 'g2'), undefined, 'goalId 隔离')
  assert.deepEqual(ledger.outcomesTable(), { src: { g1: 120 } })
})

test('withdrawal clears armed + pending but keeps durable notified/outcomes (R2-D)', () => {
  const ledger = createCompleteLedger({ src: { s1: { complete: 7 } } }, {
    pending: { src: { s1: { watermark: 9, goalId: 'g1', at: 5 } } },
    outcomes: { src: { g1: 9 } },
    now: 5,
  })
  ledger.setArmed('src', new Set(['s1']))
  ledger.forgetArmed('src') // 旧入口 = 撤回（use-bridge-subscriptions 当前调用点）
  assert.equal(ledger.armed('src').size, 0, '撤回清武装轨')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, '撤回清 pending：窗口内完成恢复后不补发')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 7, 'notified durable')
  assert.equal(ledger.outcomeWatermark('src', 'g1'), 9, 'outcomes durable')
  // 显式名与旧名同语义（新 API 并列加入）。
  ledger.setPending('src', 's1', { at: 6 })
  ledger.setArmed('src', new Set(['s1']))
  ledger.withdraw('src')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)
  assert.equal(ledger.armed('src').size, 0)
  // forgetPending 只清 pending。
  ledger.setPending('src', 's1', { at: 7 })
  ledger.setArmed('src', new Set(['s1']))
  ledger.forgetPending('src')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined)
  assert.equal(ledger.armed('src').has('s1'), true)
})

test('forgetSession clears armed + settleFence + pending for one session only (评审 A 重要项)', () => {
  const ledger = createCompleteLedger({ src: { s1: { complete: 7 }, s2: { complete: 9 } } }, {
    pending: {
      src: {
        s1: { at: 1, watermark: 7, deferred: 'subagent-busy' },
        s2: { at: 2 },
      },
    },
    now: 5,
  })
  ledger.setArmed('src', new Set(['s1', 's2']))
  ledger.state().settleFence.src = { s1: { boundary: 100 }, s2: { boundary: 200 } }

  ledger.forgetSession('src', 's1')
  assert.equal(ledger.pendingEntry('src', 's1'), undefined, '消失会话的 pending 清')
  assert.equal(ledger.armed('src').has('s1'), false, '消失会话的 armed 清')
  assert.equal(ledger.state().settleFence.src?.s1 ?? false, false, '消失会话的 settleFence 清')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 7, 'notified durable')
  assert.equal(ledger.pendingEntry('src', 's2')?.at, 2, '其它会话不受影响')
  assert.equal(ledger.armed('src').has('s2'), true)
  assert.equal(ledger.state().settleFence.src?.s2?.boundary, 200)

  // 空集收敛：全部会话遗忘后两级键不留空表。
  ledger.forgetSession('src', 's2')
  assert.equal(ledger.pendingTable().src, undefined)
  assert.equal(ledger.state().armed.src, undefined)
  assert.equal(ledger.state().settleFence.src, undefined)
  assert.equal(ledger.notifiedWatermark('src', 's2', 'complete'), 9, 'notified 仍 durable')
})

test('armedFloor (F5 阻断项 2) is volatile, cleared with armed, and pruned by forget/withdraw', () => {
  const ledger = createCompleteLedger()
  ledger.state().armedFloor.src = { s1: 300, s2: 400 }
  ledger.setArmed('src', new Set(['s1', 's2']))
  ledger.forgetSession('src', 's1')
  assert.equal(ledger.state().armedFloor.src?.s1, undefined, '会话遗忘同拍清水位界')
  assert.equal(ledger.state().armedFloor.src?.s2, 400, '其它会话不受影响')
  ledger.setArmed('src', new Set(['s1']))
  assert.equal(ledger.state().armedFloor.src?.s2, undefined, 'setArmed 写回集合时清掉出表会话的界')
  ledger.withdraw('src')
  assert.equal(ledger.state().armedFloor.src, undefined, '撤回与 armed 同拍清')
  ledger.state().armedFloor.src = { s1: 300 }
  ledger.forget('src')
  assert.equal(ledger.state().armedFloor.src, undefined, '来源退役连水位界一起删')
  assert.equal(ledger.prune(new Set()), false, '已空表无变化')
})

test('seedSettleFence (F5 重要项 3 + A2/A3-3/B3-1) clears above boundary, records seededSince otherwise', () => {
  const ledger = createCompleteLedger()
  ledger.state().settleFence.src = { s1: { boundary: 100 }, s2: { boundary: 100 } }
  // 播种到 > boundary ⇒ 播种已吸收被守卫的完成 ⇒ 清栏。
  ledger.seedSettleFence('src', 's1', 150)
  assert.equal(ledger.state().settleFence.src?.s1, undefined, 'seededWatermark > boundary ⇒ 清栏')
  // 播种只到 ≤ boundary ⇒ 记 seededSince（单调 max）并保留，其它会话不受影响。
  ledger.seedSettleFence('src', 's2', 100)
  assert.deepEqual(ledger.state().settleFence.src?.s2, { boundary: 100, seededSince: 100 })
  ledger.seedSettleFence('src', 's2', 80)
  assert.equal(ledger.state().settleFence.src?.s2?.seededSince, 100, 'seededSince 单调不回退')
  // 无栏会话是 no-op。
  ledger.seedSettleFence('src', 's9', 999)
  assert.deepEqual(Object.keys(ledger.state().settleFence.src ?? {}), ['s2'])
  ledger.seedSettleFence('src', 's2', 101)
  assert.equal(ledger.state().settleFence.src, undefined, '清空后收敛掉来源表项')
})

test('settleFence cleanup: withdraw / forget / forgetSession / prune drop the record table', () => {
  const make = () => {
    const ledger = createCompleteLedger()
    ledger.state().settleFence = {
      src: { s1: { boundary: 1 }, s2: { boundary: 2 } },
      other: { s3: { boundary: 3 } },
    }
    return ledger
  }
  const withdrawn = make()
  withdrawn.withdraw('src')
  assert.equal(withdrawn.state().settleFence.src, undefined, 'withdraw 来源级清')
  const forgotten = make()
  forgotten.forget('src')
  assert.equal(forgotten.state().settleFence.src, undefined, 'forget 来源级清')
  const session = make()
  session.forgetSession('src', 's1')
  assert.deepEqual(session.state().settleFence.src, { s2: { boundary: 2 } }, 'forgetSession 只清该会话')
  const pruned = make()
  assert.equal(pruned.prune(new Set(['src'])), true)
  assert.equal(pruned.state().settleFence.other, undefined, 'prune 剪掉不在场来源')
  assert.notEqual(pruned.state().settleFence.src, undefined, '在场来源保留')
})

test('a persisted pending entry round-trips its deferred origin; an invalid value drops only the field', () => {
  // 坏形状经 unknown 注入（与 same-page 卫生用例同法）。deferred 是字段级清洗
  // （A3-2）：非法值只丢字段，at 成立即保留整条——与 unread-store.sanitizeUnreadPayload
  // 同口径；整条丢弃会让水位结算位在离线/降级路径静默消失。
  const pending = {
    src: {
      delayed: { at: 1, watermark: 3, deferred: 'subagent-busy' },
      bad: { at: 1, deferred: 'nope' },
    },
  } as unknown as PendingCompletionTable
  const ledger = createCompleteLedger({}, { pending, now: 5 })
  assert.equal(ledger.pendingEntry('src', 'delayed')?.deferred, 'subagent-busy', '延迟来源可持久化')
  assert.deepEqual(ledger.pendingEntry('src', 'bad'), { at: 1 }, '未知 deferred 值只丢字段；条目保留')
})

test('forget and prune converge all four tables', () => {
  const pending: PendingCompletionTable = { a: { s: { at: 1 } }, b: { s: { at: 1 } } }
  const ledger = createCompleteLedger(
    { a: { s: { complete: 1 } }, b: { s: { complete: 2 } } },
    { pending, outcomes: { a: { g: 1 }, b: { g: 2 } }, now: 10 },
  )
  ledger.setArmed('a', new Set(['s']))
  ledger.setArmed('b', new Set(['s']))
  assert.equal(ledger.prune(new Set(['a'])), true)
  assert.equal(ledger.prune(new Set(['a'])), false, '无变化返回 false')
  assert.equal(ledger.pendingEntry('b', 's'), undefined)
  assert.equal(ledger.outcomeWatermark('b', 'g'), undefined)
  assert.equal(ledger.notifiedWatermark('b', 's', 'complete'), undefined)
  assert.equal(ledger.armed('b').size, 0)
  ledger.forget('a')
  assert.equal(ledger.pendingEntry('a', 's'), undefined)
  assert.equal(ledger.outcomeWatermark('a', 'g'), undefined)
})

// ── boot / 年龄卫生（v5 §3.5） ──────────────────────────────────────────────

test('a fresh boot drops every pending entry loudly and keeps outcomes', () => {
  const messages: string[] = []
  const ledger = createCompleteLedger({}, {
    pending: { a: { s1: { at: 1 }, s2: { watermark: 3, at: 2 } }, b: { s9: { at: 3 } } },
    outcomes: { a: { g1: 1 } },
    boot: 'fresh',
    now: 10,
    onDiagnostic: message => messages.push(message),
  })
  assert.deepEqual(ledger.pendingTable(), {}, '新进程/新窗口不得继承上一页会话的 pending')
  assert.equal(ledger.outcomeWatermark('a', 'g1'), 1, 'outcomes 与 notified 同为 durable')
  assert.ok(messages.some(message => message.includes('fresh boot') && message.includes('3')), messages.join(' | '))
})

test('a same-page boot keeps fresh pending and drops stale/malformed entries loudly', () => {
  const messages: string[] = []
  const now = 1_000_000_000
  const pending = {
    a: {
      fresh: { watermark: 1, goalId: 'g1', at: now - 5 },
      stale: { at: now - PENDING_MAX_AGE_MS - 1 },
      noWatermark: { goalId: 'g1', at: now - 10 },
      badWatermark: { watermark: 'x', at: now },
      badGoal: { watermark: 1, goalId: '', at: now },
      badAt: { watermark: 1, at: 'nope' },
      notAnObject: 7,
    },
  } as unknown as PendingCompletionTable
  const ledger = createCompleteLedger({}, {
    pending,
    boot: 'same',
    now,
    onDiagnostic: message => messages.push(message),
  })
  assert.deepEqual(Object.keys(ledger.pendingTable().a ?? {}).sort(), ['fresh', 'noWatermark'])
  assert.ok(messages.some(message => message.includes('malformed')), messages.join(' | '))
  assert.ok(messages.some(message => message.includes('older than')), messages.join(' | '))
  assert.equal(PENDING_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1_000, '卫生上界是钉住的常量')
})

test('REGRESSION(P2 dead state): the ledger keeps no bootToken copy (single source is boot-token.ts)', () => {
  // bootToken 生产零读：页代 token 的单源是 boot-token.ts（经 App 的
  // unreadBoot.boot.token 进观测层 identity）。兼容入参仍被接受（App 调用点不在本次
  // 改动范围），但账本状态面不再保留副本——回退该字段即红。
  const ledger = createCompleteLedger(undefined, { bootToken: 'page-token-1', boot: 'same' })
  assert.equal('bootToken' in ledger.state(), false, '状态面不再保留 bootToken 副本')
})

test('REGRESSION(B4-2): forgetSession / withdraw clear the settle-point memory (goalKnown leak)', () => {
  // 反例：会话在长活来源内 churn（消失→重现）时，forgetSession 只清 pending/armed/
  // settleFence，goalKnown 表项残留——会话级泄漏，且重现会话的首份已知 goal 事实
  // 不再被当作 §3.5 结算点。
  const ledger = createCompleteLedger()
  ledger.state().goalKnown.src = new Set(['s1', 's2'])
  ledger.state().goalKnown.other = new Set(['s9'])
  ledger.forgetSession('src', 's1')
  assert.deepEqual([...ledger.state().goalKnown.src ?? []], ['s2'], 'forgetSession 同步清该会话的结算点记忆（回退即红）')
  assert.deepEqual([...ledger.state().goalKnown.other ?? []], ['s9'], '其它来源不受影响')

  ledger.forgetSession('src', 's2')
  assert.equal(ledger.state().goalKnown.src, undefined, '空集收敛掉来源表项')

  // withdraw（来源级撤回）同拍清该来源的结算点记忆；notified/outcomes 不受影响。
  ledger.setNotifiedWatermark('src', 's1', 'complete', 7)
  ledger.setOutcome('src', 'g1', 7)
  ledger.state().goalKnown.src = new Set(['s3'])
  ledger.withdraw('src')
  assert.equal(ledger.state().goalKnown.src, undefined, 'withdraw 清该来源的结算点记忆（回退即红）')
  assert.deepEqual([...ledger.state().goalKnown.other ?? []], ['s9'], '撤回不得跨来源')
  assert.equal(ledger.notifiedWatermark('src', 's1', 'complete'), 7, 'notified 仍 durable')
  assert.equal(ledger.outcomeWatermark('src', 'g1'), 7, 'outcomes 仍 durable')
})
