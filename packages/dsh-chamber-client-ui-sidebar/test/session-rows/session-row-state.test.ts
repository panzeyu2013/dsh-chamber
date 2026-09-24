/**
 * I1/I2/I13 仪表锁：
 * 行状态与待办条目的**机器可读标记**必须与用户看到的状态同源，且出处（wire /
 * channel / derived / stale）必须显式——验收判据据此区分「刚发生的事实」与
 * 「断连后残留的旧事实」。
 *
 * design 19 §3.2.1/§3.2.5（2026-12）：本文件同时锁住 goal 两个门与
 * 六面（点/文案/仪表/搜索/待办/徽标）的单源派生——goal 门在零依赖叶模块
 * session-row-state.ts，任何呈现面都不得各自重写优先级。
 *
 * Run directly: node test/session-rows/session-row-state.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  goalHoldsCompletion, goalSuppressesPresentation, sessionRowState, subagentActivityOf,
} from '@dsh-chamber/dsh-chamber-client-core/session-row-state'
import type { GoalFact } from '@dsh-chamber/dsh-chamber-client-core/session-row-state'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const SECTION = [
  read('../../src/client/ServerSection.tsx'),
  read('../../src/client/ServerSectionHeader.tsx'),
  read('../../src/client/ServerSectionRows.tsx'),
  read('../../src/client/ServerSectionSearch.tsx'),
  read('../../src/client/server-section-controls.tsx'),
  read('../../src/client/server-section-model.ts'),
  read('../../src/client/server-section-session-state.tsx'),
].join('\n')
const HOOK = read('../../src/client/server-section-session-state.tsx')
const TODO = read('../../src/client/SessionTodoArea.tsx')
const LOCALES = read('../../src/client/locales.ts')

test('the marker mirrors the dot priority exactly (pending > subagents > completed > running)', () => {
  assert.deepEqual(sessionRowState({ pending: 'approval', runningSubagents: 2, completed: true, running: true }).state, 'pending:approval')
  assert.deepEqual(sessionRowState({ runningSubagents: 2, completed: true, running: true }).state, 'subagents:2')
  assert.deepEqual(sessionRowState({ completed: true, running: true }).state, 'completed')
  assert.deepEqual(sessionRowState({ running: true }).state, 'running')
  assert.deepEqual(sessionRowState({}).state, 'none')
  assert.deepEqual(sessionRowState(undefined).state, 'none')
  // 一个显式的空子代理计数不覆盖 completed（稀疏契约：生产只写 >0）。
  assert.deepEqual(sessionRowState({ runningSubagents: 0, completed: true }).state, 'completed')
})

test('the source names where the displayed reading came from', () => {
  assert.equal(sessionRowState({ running: true }).source, 'wire')
  assert.equal(sessionRowState({ pending: 'question' }).source, 'channel')
  assert.equal(sessionRowState({ completed: true }).source, 'channel')
  assert.equal(sessionRowState({ runningSubagents: 1 }).source, 'derived')
  // stale 优先报出：同一读数在断连来源上可能已经过期。
  assert.equal(sessionRowState({ completed: true, stale: true }).source, 'stale')
  assert.equal(sessionRowState({ pending: 'approval', stale: true }).source, 'stale')
  assert.equal(sessionRowState({ running: true, stale: true }).source, 'stale')
})

test('P5: subagent activity is tri-state, and unknown never claims the subagent ring', () => {
  assert.equal(subagentActivityOf({ runningSubagents: 2 }), 'running')
  assert.equal(subagentActivityOf({ runningSubagents: 0 }), 'none')
  assert.equal(subagentActivityOf({ runningSubagents: 2, stale: true }), 'unknown')
  assert.equal(subagentActivityOf({ runningSubagents: 2 }, true), 'unknown', 'the report-level stale flag is the same guard')
  assert.equal(subagentActivityOf({ subagentActivity: 'running', runningSubagents: 2, stale: true }), 'unknown')
  assert.equal(subagentActivityOf({ subagentActivity: 'unknown', runningSubagents: 2 }), 'unknown')
  assert.equal(subagentActivityOf({ subagentActivity: 'none', runningSubagents: 2 }), 'none', 'the declared fact wins over the raw count')
  assert.equal(subagentActivityOf(undefined), 'none')
  // The marker: a stale subagent count never outranks completed/running, and the
  // source still reports stale (the user learns the reading may be old).
  assert.deepEqual(sessionRowState({ runningSubagents: 2, completed: true, stale: true }).state, 'completed')
  assert.deepEqual(sessionRowState({ runningSubagents: 2, completed: true, stale: true }).source, 'stale')
  assert.deepEqual(sessionRowState({ subagentActivity: 'unknown', running: true }).state, 'running')
})

test('goal gates: presentation suppresses on phase active (unknown activation included); hold needs armed', () => {
  const active = (over: Partial<GoalFact> = {}): GoalFact => ({ goalId: 'g1', revision: 2, phase: 'active', ...over })
  // 呈现门：相位 active 即压制，activation unknown 也压制（R2-J）。
  assert.equal(goalSuppressesPresentation(active()), true)
  assert.equal(goalSuppressesPresentation(active({ activation: 'armed' })), true)
  assert.equal(goalSuppressesPresentation(active({ activation: 'disarmed' })), true, 'disarmed 仍压制呈现（通知层才按 disarmed 出中性一次）')
  assert.equal(goalSuppressesPresentation({ goalId: 'g', revision: 1, phase: 'paused' }), false)
  assert.equal(goalSuppressesPresentation({ goalId: 'g', revision: 1, phase: 'complete' }), false)
  assert.equal(goalSuppressesPresentation({ goalId: 'g', revision: 1, phase: 'blocked' }), false)
  assert.equal(goalSuppressesPresentation(null), false)
  assert.equal(goalSuppressesPresentation(undefined), false)
  // 通知门：更窄，unknown 绝不冒充 armed（unknown 由通知层自己的分支 hold）。
  assert.equal(goalHoldsCompletion(active({ activation: 'armed' })), true)
  assert.equal(goalHoldsCompletion(active()), false)
  assert.equal(goalHoldsCompletion(active({ activation: 'disarmed' })), false)
  assert.equal(goalHoldsCompletion({ goalId: 'g', revision: 1, phase: 'complete', activation: 'armed' }), false)
  assert.equal(goalHoldsCompletion(null), false)
  assert.equal(goalHoldsCompletion(undefined), false)
})

test('goal-active suppression: the suppressed state never reports completed and falls to running/none', () => {
  const active: GoalFact = { goalId: 'g1', revision: 2, phase: 'active' }
  const suppressed = sessionRowState({ completed: true, goal: active })
  assert.equal(suppressed.state, 'none', 'R2-K: the marker never claims a completed the user cannot see')
  assert.equal(suppressed.source, 'channel')
  assert.equal(suppressed.completedVisible, false)
  assert.equal(suppressed.goalActive, true)
  assert.equal(suppressed.suppressedBy, 'unknown', 'active + activation unknown is the §2.2 silent window')
  // running 是压制后的落点；不允许报 completed。
  const running = sessionRowState({ completed: true, running: true, goal: active })
  assert.equal(running.state, 'running')
  assert.equal(running.suppressedBy, 'unknown')
  // activation 已知（armed 或 disarmed）→ 压制者标注为 goal。
  assert.equal(sessionRowState({ completed: true, goal: { ...active, activation: 'armed' } }).suppressedBy, 'goal')
  assert.equal(sessionRowState({ completed: true, goal: { ...active, activation: 'disarmed' } }).suppressedBy, 'goal')
  // 离开 active 即自愈：paused/complete/null/unknown 都不压制呈现。
  assert.equal(sessionRowState({ completed: true, goal: { ...active, phase: 'paused' } }).state, 'completed')
  assert.equal(sessionRowState({ completed: true, goal: { ...active, phase: 'complete' } }).state, 'completed')
  assert.equal(sessionRowState({ completed: true, goal: null }).state, 'completed')
  assert.equal(sessionRowState({ completed: true, goal: undefined }).state, 'completed')
  assert.equal(sessionRowState({ completed: true }).completedVisible, true)
  // 子代理压制与 pending 档（pending 不是「压制」语义，不编造 label）。
  const sub = sessionRowState({ completed: true, runningSubagents: 2 })
  assert.equal(sub.state, 'subagents:2')
  assert.equal(sub.subagents, 2)
  assert.equal(sub.completedVisible, false)
  assert.equal(sub.suppressedBy, 'subagents')
  const pending = sessionRowState({ completed: true, pending: 'approval' })
  assert.equal(pending.state, 'pending:approval')
  assert.equal(pending.pending, 'approval')
  assert.equal(pending.completedVisible, false)
  assert.equal(pending.suppressedBy, undefined)
  // pending 仍第一位；goal 门只报状态（goalActive），不抢 suppressedBy。
  const both = sessionRowState({ completed: true, pending: 'question', goal: active })
  assert.equal(both.state, 'pending:question')
  assert.equal(both.pending, 'question')
  assert.equal(both.goalActive, true)
  // 没有 completed 就不宣告压制。
  assert.equal(sessionRowState({ goal: active }).suppressedBy, undefined)
  assert.equal(sessionRowState({ goal: active }).completedVisible, false)
})

test('P5: the upstream completeness-signal ask is pinned until upstream lands it', () => {
  const proposals = read('../../../../docs/progress/todo/upstream-proposals.md')
  assert.match(proposals, /## 7\. 子代理生命周期\/计数与完整性信号/)
  // The local fallback this test retires: an ABSENT lineage index is unknown, never "none".
  assert.match(read('../../../dsh-chamber-client-core/src/derive.ts'), /subagentRunning === undefined\s*\n\s*\? 'unknown'/)
})

test('the row and the todo strip carry the markers (no copy/class-name dependence)', () => {
  assert.match(SECTION, /data-chamber-session-state=\{sessionStateMarker\(server, session\)\.state\}/)
  assert.match(SECTION, /data-chamber-state-source=\{sessionStateMarker\(server, session\)\.source\}/)
  assert.match(SECTION, /data-chamber-stale=\{server\.runtime\?\.stale === true \|\| undefined\}/)
  assert.match(TODO, /data-chamber-todo=\{`\$\{entry\.sourceId\}:\$\{entry\.sessionId\}:\$\{entry\.kind\}`\}/)
  assert.match(TODO, /data-chamber-stale=\{entry\.stale === true \|\| undefined\}/)
  // I5：事实时间戳落成可查询属性（缺席 = 无观察者事实，绝不写 0 假值）。
  assert.match(SECTION, /data-chamber-fact-at=\{server\.runtime\?\.sessions\[session\.id\]\?\.factAt\}/)
})

test('six faces derive from the single sessionRowState source (goal gate included)', () => {
  // 一个解析器喂所有读者：label/pending/marker/dot 全部经 sessionRowStateOf。
  assert.match(HOOK, /const sessionRowStateOf = /)
  assert.match(HOOK, /running: runningRingVisible\(facts\?\.running, session\.running\)/)
  assert.match(HOOK, /completed: facts\?\.completed/)
  assert.match(HOOK, /pending: facts\?\.pending/)
  assert.match(HOOK, /runningSubagents: facts\?\.runningSubagents/)
  assert.match(HOOK, /subagentActivity: facts\?\.subagentActivity/)
  assert.match(HOOK, /stale: server\.runtime\?\.stale/)
  assert.match(HOOK, /goal: facts\?\.goal/)
  assert.match(HOOK, /const sessionStateLabel = [\s\S]{0,240}?sessionRowStateOf\(server, session\)/)
  assert.match(HOOK, /const sessionStatePending = [\s\S]{0,240}?sessionRowStateOf\(server, session\)\.pending/)
  assert.match(HOOK, /const sessionStateMarker = [\s\S]{0,200}?sessionRowStateOf\(server, session\)/)
  assert.match(HOOK, /const sessionStateDot = [\s\S]{0,240}?sessionRowStateOf\(server, session\)/)
  // 旧的各写一遍优先级的 raw 分支必须消失——点与仪表不得再各自裁决。
  assert.doesNotMatch(HOOK, /facts\?\.completed === true/)
  // goal 门生效时行上出现可选验收属性（v5 §4）；搜索面消费同一批读者。
  assert.match(SECTION, /data-chamber-goal-active=\{sessionStateMarker\(server, session\)\.goalActive \? '' : undefined\}/)
  assert.match(SECTION, /sessionStateDot\(server, \{ id: item\.sessionId, running \}\)/)
  assert.match(SECTION, /sessionStateLabel\(server, \{ id: item\.sessionId, running \}\)/)
})

/**
 * 「全部已读」：入口必须在来源菜单里可达，且**只发意图**——读水位与落盘归 App，
 * 插件不自己写读数（同一份权威，两个载体不重复实现）。
 */
test('W4: the source menu offers 全部已读 and asks the App instead of writing read marks', () => {
  assert.match(SECTION, /\{ id: 'mark-all-read', label: t\('source\.markAllRead'\) \}/)
  assert.match(SECTION, /if \(id === 'mark-all-read'\) \{[\s\S]{0,160}?chamberBridge\.requestMarkAllRead\(server\.id\)/)
  // 两个语言都必须有这条文案（缺一条即运行时显示 key）。
  assert.equal((LOCALES.match(/'source\.markAllRead'/g) ?? []).length, 2)
})

/** 桥的行为：意图必须真的到达订阅者，且取消订阅后不再投递。 */
test('W4: requestMarkAllRead reaches App-layer subscribers and unsubscribes cleanly', async () => {
  const { chamberBridge } = await import('@dsh-chamber/dsh-chamber-client-core/aggregate-store')
  const seen: string[] = []
  const unsubscribe = chamberBridge.onMarkAllRead(({ sourceId }) => { seen.push(sourceId) })
  chamberBridge.requestMarkAllRead('local')
  chamberBridge.requestMarkAllRead('test')
  assert.deepEqual(seen, ['local', 'test'])
  unsubscribe()
  chamberBridge.requestMarkAllRead('local')
  assert.deepEqual(seen, ['local', 'test'], '取消订阅后不再投递')
})
