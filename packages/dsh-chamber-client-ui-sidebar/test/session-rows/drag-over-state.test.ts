/**
 * dragOverState：三处拖拽闭包（服务器分组 / 工作区 / 会话行）共用的「over 目标」
 * 推进（2026-12 单源化）。不变量：目标未变时返回**原对象**（避免无变化的 state churn）。
 *
 * Run directly: node packages/dsh-chamber-client-ui-sidebar/test/session-rows/drag-over-state.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dragOverState } from '../../src/client/server-section-model.ts'

type Carrier = { over: { id: string; half: 'before' | 'after' } | null; extra?: string }

test('目标未变时返回原对象（不制造 state churn）', () => {
  const current: Carrier = { over: { id: 'a', half: 'before' } }
  assert.equal(dragOverState(current, 'a', 'before'), current)
  assert.equal(dragOverState(current, 'a', 'before'), current)
})

test('id 或 half 变化时换新对象，其余字段保留', () => {
  const current: Carrier = { over: { id: 'a', half: 'before' }, extra: 'keep' }
  const flipped = dragOverState(current, 'a', 'after')
  assert.notEqual(flipped, current)
  assert.deepEqual(flipped, { over: { id: 'a', half: 'after' }, extra: 'keep' })
  assert.deepEqual(dragOverState(current, 'b', 'before'), { over: { id: 'b', half: 'before' }, extra: 'keep' })
})

test('null 当前态保持 null（未开始的拖拽是 no-op）', () => {
  assert.equal(dragOverState<Carrier>(null, 'a', 'before'), null)
})

test('over 为 null 的当前态被填充', () => {
  const current: Carrier = { over: null }
  assert.deepEqual(dragOverState(current, 'a', 'after'), { over: { id: 'a', half: 'after' } })
})
