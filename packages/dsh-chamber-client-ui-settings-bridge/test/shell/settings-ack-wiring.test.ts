/**
 * 设置导航 ack 的渲染期派生锁（design 05 §5）。
 *
 * 壳把「何时 ack / drop / wait」做成渲染期算出的 ackPlan，effect 只执行这个
 * 决策；对应地，effect 的依赖数组必须恰为 [ackPlan, pendingAck, navigation]，
 * 且 ackPlan 必须由 settingsAckPlan(pendingAck, open, activeId) 派生。锁这条
 * 不变量，是因为旧形态把决策写在 effect 体内、依赖 open/activeId 两个原始值：
 * 变异掉依赖数组里的一项就会静默回归，而行为测试不经过 React 壳。
 * 真值表在 test/navigation/settings-open-seat.test.ts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const shell = stripComments(readFileSync(new URL('../../src/client/SettingsShell.tsx', import.meta.url), 'utf8'))

/** ack effect 的依赖数组：恰好三项，容忍换行与空白。 */
const ACK_DEPS = /\},\s*\[ackPlan,\s*pendingAck,\s*navigation\]\s*\)/u

test('the ack effect executes a render-time plan under exactly [ackPlan, pendingAck, navigation]', () => {
  const planStart = shell.search(/const ackPlan =/u)
  assert.ok(planStart >= 0, 'ackPlan 必须在渲染期派生，而不是在 effect 体内再算决策')
  const deps = ACK_DEPS.exec(shell.slice(planStart))
  assert.ok(deps !== null, 'ack effect 的依赖数组必须恰为 [ackPlan, pendingAck, navigation]')
  const effect = shell.slice(planStart, planStart + deps.index + deps[0].length)
  assert.match(effect, /settingsAckPlan\(pendingAck, open, activeId\)/u, '决策必须由已提交的 open/activeId 算出')
  assert.match(effect, /useLayoutEffect\(\(\) => \{/u, '执行点必须仍是布局 effect')
  assert.match(effect, /ackPlan\.kind !== 'ack' && ackPlan\.kind !== 'drop'/u)
  assert.match(effect, /navigation\.acknowledge\(ackPlan\.seq\)/u)
  assert.match(effect, /setPendingAck\(undefined\)/u)
  // 旧形态不得回来：effect 体内直接调 settingsAckDecision，或依赖数组里再列原始值。
  assert.doesNotMatch(effect, /settingsAckDecision\(/u)
  assert.doesNotMatch(shell, /\[ackPlan,\s*pendingAck,\s*navigation\s*,/u, '依赖数组不得多出原始值')
  assert.doesNotMatch(shell, /\[open, activeId, pendingAck, navigation\]/u, '旧的字面依赖数组不得回来')
})
