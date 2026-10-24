/**
 * Per-ctx settings-navigation seat (design 05 §5): request sequencing, acknowledgement
 * and the shell-side command. Pure module — no React, no vendor imports.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSettingsNavigationSeat,
  settingsAckDecision,
  settingsAckPlan,
  settingsOpenCommand,
} from '../../src/client/settings-navigation.ts'

test('open queues a request and notifies; ack clears only the matching sequence', () => {
  const seat = createSettingsNavigationSeat()
  let notifications = 0
  const unsubscribe = seat.subscribe(() => { notifications += 1 })
  assert.equal(seat.getRequest(), undefined)
  seat.open('plugin-manager')
  assert.deepEqual(seat.getRequest(), { seq: 1, sectionId: 'plugin-manager' })
  assert.equal(notifications, 1)
  seat.acknowledge(0)
  assert.notEqual(seat.getRequest(), undefined, 'a stale ack never clears a live request')
  seat.acknowledge(1)
  assert.equal(seat.getRequest(), undefined)
  seat.open('models')
  assert.deepEqual(seat.getRequest(), { seq: 2, sectionId: 'models' })
  unsubscribe()
  seat.open('general')
  assert.equal(notifications, 2, 'unsubscribed listeners are not called')
})

test('a newer request replaces an unconsumed one and a stale ack cannot clear it', () => {
  const seat = createSettingsNavigationSeat()
  seat.open('plugin-manager')
  seat.open('models')
  assert.deepEqual(seat.getRequest(), { seq: 2, sectionId: 'models' })
  seat.acknowledge(1)
  assert.deepEqual(seat.getRequest(), { seq: 2, sectionId: 'models' })
  seat.acknowledge(2)
  assert.equal(seat.getRequest(), undefined)
})

test('settingsOpenCommand: absent/old → undefined; new → the section only', () => {
  assert.equal(settingsOpenCommand(undefined, 0), undefined)
  assert.equal(settingsOpenCommand({ seq: 1, sectionId: 'x' }, 1), undefined)
  assert.deepEqual(
    settingsOpenCommand({ seq: 2, sectionId: 'plugin-manager' }, 1),
    { seq: 2, sectionId: 'plugin-manager' },
    'the shell forces its own instance on consumption; the command carries no constant id',
  )
})

test('settingsAckDecision: ack on the target, wait on another section, drop when closed', () => {
  assert.equal(settingsAckDecision(undefined, true, 'x'), undefined)
  const request = { seq: 1, sectionId: 'plugin-manager' }
  assert.equal(settingsAckDecision(request, false, undefined), 'drop', 'a close before the target commit dismisses the intent')
  assert.equal(settingsAckDecision(request, true, 'models'), 'wait', 'a manual visit to another section must not consume it')
  assert.equal(settingsAckDecision(request, true, 'plugin-manager'), 'ack')
  assert.equal(settingsAckDecision(request, true, undefined), 'wait')
})

test('settingsAckPlan: wait on another section, ack only when the target section is shown', () => {
  const request = { seq: 4, sectionId: 'plugin-manager' }
  // 已打开但停在别的分节 = wait：这次提交不消费，等用户再次访问目标分节。
  assert.deepEqual(settingsAckPlan(request, true, 'models'), { kind: 'wait', seq: 4 })
  // 切到目标分节的那次提交才 ack。
  assert.deepEqual(settingsAckPlan(request, true, 'plugin-manager'), { kind: 'ack', seq: 4 })
  // 目标分节提交前关闭 = drop：关闭动作丢弃这次意图。
  assert.deepEqual(settingsAckPlan(request, false, undefined), { kind: 'drop', seq: 4 })
  assert.equal(settingsAckPlan(undefined, true, 'plugin-manager'), undefined)
})

test('a close before the target commits drops the request; the acked seq never replays', () => {
  const seat = createSettingsNavigationSeat()
  seat.open('plugin-manager')
  const plan = settingsAckPlan(settingsOpenCommand(seat.getRequest(), 0), false, 'models')
  assert.deepEqual(plan, { kind: 'drop', seq: 1 })
  if (plan === undefined) assert.fail('a closed panel must yield a drop plan')
  seat.acknowledge(plan.seq)
  assert.equal(seat.getRequest(), undefined, 'drop 也消费请求：显式关闭不等于“稍后再打开”')
  // 重挂载（lastSeq 归零）也不得重放已 ack 的 seq。
  assert.equal(settingsOpenCommand(seat.getRequest(), 0), undefined)
})

test('an unacknowledged request is still consumed after a remount (design 05: the seat outlives the shell)', () => {
  const seat = createSettingsNavigationSeat()
  seat.open('plugin-manager')
  // 第一次挂载消费了请求但停在别的分节（wait），随后壳被卸载：请求仍留在座席上。
  assert.equal(settingsAckPlan(settingsOpenCommand(seat.getRequest(), 0), true, 'models')?.kind, 'wait')
  assert.deepEqual(seat.getRequest(), { seq: 1, sectionId: 'plugin-manager' })
  // 重挂载的壳 lastSeq 从 0 开始，重新消费同一个请求；目标分节提交后才 ack。
  const remounted = settingsOpenCommand(seat.getRequest(), 0)
  assert.deepEqual(remounted, { seq: 1, sectionId: 'plugin-manager' })
  const plan = settingsAckPlan(remounted, true, 'plugin-manager')
  assert.equal(plan?.kind, 'ack')
  if (plan === undefined) assert.fail('the target section render must acknowledge the request')
  seat.acknowledge(plan.seq)
  assert.equal(seat.getRequest(), undefined, 'ack 后同一个 seq 不再出现')
  assert.equal(settingsOpenCommand(seat.getRequest(), 0), undefined)
})

test('open ignores an empty section id', () => {
  const seat = createSettingsNavigationSeat()
  seat.open('')
  assert.equal(seat.getRequest(), undefined)
  seat.open('plugin-manager')
  assert.equal(seat.getRequest()?.sectionId, 'plugin-manager')
})
