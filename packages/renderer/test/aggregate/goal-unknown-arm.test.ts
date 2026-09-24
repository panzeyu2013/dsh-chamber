/**
 * I2 回归（Wave6 收口）：#11 goal 未知的**直发**完成也必须 arm——否则该会话的
 * 延迟壳边沿（stale running 记忆恢复）会对同一次完成产生第二条 notification。
 *
 * 契约（design 19 §3.2.3 #11，notification-projection.ts 的 goal-unknown 分支）：
 * 直发在 consumeCompleteCandidate 之后显式 armSession。facts 水位证据不像壳证据
 * 那样由 consumeCompleteCandidate 自带武装，漏掉这一步时本用例先在 armed 断言、
 * 随后在「延迟壳边沿」断言处变红（临时副本红验证见 Wave7 收口记录）。
 *
 * Run directly: node test/aggregate/goal-unknown-arm.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reconcile, type CompletionObservation } from '../../src/notification-projection.ts'
import { createCompleteLedger } from '../../src/complete-ledger.ts'

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

test('I2/#11: a goal-unknown facts completion arms so a later shell edge cannot double-notify', () => {
  const ledger = createCompleteLedger()

  // 本代从未拿到 goal 键（goal unknown）：facts 水位直发中性「会话已完成」。
  const direct = reconcile(ledger.state(), observation({
    goal: 'unknown',
    candidate: { evidence: 'facts-watermark', watermark: 120 },
  }), 10)
  assert.equal(direct.notification?.kind, 'complete')
  assert.equal(direct.notification?.origin, 'goal-unknown')
  assert.equal(direct.notification?.watermark, 120)
  assert.equal(ledger.armed('src').has('s1'), true, '#11 直发必须 arm（facts 证据不自带武装）')

  // 同一次完成的延迟壳边沿（stale running 记忆恢复）：armed 挡下，不得产生第二条通知。
  const delayedShell = reconcile(ledger.state(), observation({
    goal: 'unknown',
    candidate: { evidence: 'shell-edge' },
  }), 20)
  assert.equal(delayedShell.notification, undefined, 'armed 后壳边沿不得再通知同一次完成')
  assert.equal(delayedShell.disposition, undefined)

  // 同水位 facts 重放：notified 单调 + armed ⇒ 零 emit（INV6）。
  const replay = reconcile(ledger.state(), observation({
    goal: 'unknown',
    candidate: { evidence: 'facts-watermark', watermark: 120 },
  }), 30)
  assert.equal(replay.notification, undefined)
  assert.equal(ledger.armed('src').has('s1'), true, 'armed 记忆保持到重新 running')
})
