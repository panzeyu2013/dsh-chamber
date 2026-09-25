/**
 * 运行位**唯一解析规则**的锁（design 06 §4.3）：官方 `dsh-client-ui-workspace` 的
 * `sessionNode` 读 `running: status?.running ?? s.running`——ui-session 的实时
 * `sessionStatus` 投影优先、会话列表行兜底。chamber 的每个运行位消费点（侧栏环、搜索行、
 * 运行时事实通道、运行身份、子代理谱系计数）都必须走 {@link resolveSessionRunning}。
 *
 * 本文件钉四件事：
 *  1. 真值表：status 的 `undefined` 才回落，`false` 是真实观测（`??` 承重；`||` 会假运行）；
 *  2. 四处消费者都被 status 覆盖：projectRuntimeFacts / projectInstanceSnapshot /
 *     indexSubagentDescendants / 运行身份 mint（runningIds）；
 *  3. 不增行不变量：只在 status 投影里存在、store 行里不存在的 id，绝不因本规则新增行；
 *  4. 分工作面：store 修复面（`readOfficialProjection`）保持读 store 自己的主张。
 *
 * Run directly: node test/session-rows/running-resolution.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectInstanceSnapshot,
  projectRuntimeFacts,
  runningRingVisible,
} from '@dsh-chamber/dsh-chamber-client-core/derive'
import { indexSubagentDescendants } from '@dsh-chamber/dsh-chamber-client-core/subagent-lineage'
import { resolveSessionRunning } from '@dsh-chamber/dsh-chamber-client-core/session-row-state'

test('resolveSessionRunning: only an UNKNOWN status observation falls back to the row', () => {
  const status = new Map<string, boolean | undefined>([
    ['live', true], ['idle', false], ['unknown', undefined],
  ])
  // 官方 status 有观测即胜出，且 false 是真实观测。
  assert.equal(resolveSessionRunning(status, 'live', false), true, 'status true wins over a stale row false')
  assert.equal(resolveSessionRunning(status, 'idle', true), false, 'status false wins over a stale row true (the ?? is load-bearing)')
  assert.equal(resolveSessionRunning(status, 'unknown', true), true, 'unknown falls back to the row')
  assert.equal(resolveSessionRunning(status, 'unknown', undefined), false, 'no observation anywhere reads as not-running')
  assert.equal(resolveSessionRunning(status, 'absent', false), false, 'an id absent from the projection falls back')
  assert.equal(resolveSessionRunning(undefined, 's1', true), true, 'no projection at all (unmounted source) keeps the row')
})

test('projectRuntimeFacts: the status projection resolves the report running bit', () => {
  const report = projectRuntimeFacts(
    { byId: {
      s1: { running: false, updatedAt: 1 },
      s2: { running: true, updatedAt: 1 },
    } },
    undefined,
    undefined,
    undefined,
    new Map([['s1', true], ['s2', false]]),
  )
  assert.equal(report.sessions.s1?.running, true, 'the ring/edge machine follows the live status into the report')
  assert.equal(report.sessions.s2?.running, false, 'a stale running row is corrected by a false observation')
})

test('projectInstanceSnapshot: the ring renders the status-resolved bit', () => {
  const snapshot = projectInstanceSnapshot(
    { items: [{ workspaceId: 'w1', path: '/w', title: 'W', sessionIds: ['s1'], createdAt: '', updatedAt: '' }], phase: 'ready', state: 'idle' },
    { ids: ['s1'], byId: { s1: { id: 's1', running: false, blank: false, updatedAt: 1 } }, phase: 'ready' },
    new Map([['s1', true]]),
  )
  assert.equal(snapshot?.sessions[0]?.running, true, 'the projected row carries the status resolution')
  assert.equal(runningRingVisible(false, snapshot?.sessions[0]?.running), true, 'the ring follows the projection, which now follows the vendor rule')
})

test('indexSubagentDescendants: a child resolved running by the status projection counts', () => {
  const rows = {
    child: { id: 'child', parentId: 'parent', origin: 'subagent' as const, running: false },
  }
  assert.equal(indexSubagentDescendants(rows).get('parent')?.runningCount, 0, 'the store row alone reads as idle')
  assert.equal(indexSubagentDescendants(rows, new Map([['child', true]])).get('parent')?.runningCount, 1,
    'the live status observation is what the official nav counts')
  assert.equal(indexSubagentDescendants(rows, new Map([['child', undefined]])).get('parent')?.runningCount, 0,
    'an unknown observation falls back to the row')
})

test('the rule never invents rows: status-only ids stay out of both projections', () => {
  const status = new Map<string, boolean | undefined>([['ghost', true]])
  const report = projectRuntimeFacts(
    { byId: { s1: { running: false, updatedAt: 1 } } },
    undefined, undefined, undefined, status,
  )
  assert.deepEqual(Object.keys(report.sessions), ['s1'], 'a status row with no store row is a pending/completion side branch, not a session')
  const snapshot = projectInstanceSnapshot(
    { items: [], phase: 'ready', state: 'idle' },
    { ids: ['s1'], byId: { s1: { id: 's1', running: false, blank: false, updatedAt: 1 } }, phase: 'ready' },
    status,
  )
  assert.deepEqual(snapshot?.sessions.map(row => row.sessionId), ['s1'])
})
