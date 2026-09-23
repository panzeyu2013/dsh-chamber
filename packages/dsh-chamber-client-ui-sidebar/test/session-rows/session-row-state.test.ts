/**
 * I1/I2/I13 仪表锁：
 * 行状态与待办条目的**机器可读标记**必须与用户看到的状态同源，且出处（wire /
 * channel / derived / stale）必须显式——验收判据据此区分「刚发生的事实」与
 * 「断连后残留的旧事实」。
 *
 * Run directly: node test/session-rows/session-row-state.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sessionRowState, subagentActivityOf } from '@dsh-chamber/dsh-chamber-client-core/session-row-state'

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

test('the row marker reads the same inputs as the dot (facts + resolved ring bit)', () => {
  assert.match(SECTION, /sessionStateMarker = \(server: ChamberServerAggregate, session: \{ id: string; running\?: boolean \}\)/)
  assert.match(SECTION, /running: runningRingVisible\(facts\?\.running, session\.running\)/)
  assert.match(SECTION, /completed: facts\?\.completed/)
  assert.match(SECTION, /pending: facts\?\.pending/)
  assert.match(SECTION, /runningSubagents: facts\?\.runningSubagents/)
  assert.match(SECTION, /subagentActivity: facts\?\.subagentActivity/)
  assert.match(SECTION, /stale: server\.runtime\?\.stale/)
  // 读数与圆点共用同一个三值守卫：unknown 不宣称在跑。
  assert.match(SECTION, /subagentActivityOf\(facts, server\.runtime\?\.stale\) === 'running'/)
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
