/**
 * facts apply 纯机制契约（2026-09-30 R1/R2 复核要求补的**行为**测试；此前只有源文本锁，
 * 变异实测 7/8 静默通过）：
 *   - 最新载荷槽：take 即清、最新优先、能区分「登记 undefined」与「未登记」、撤回即作废；
 *   - 每来源闸池：异源独立、同源**步骤体内**发起的重入不嵌套且补跑恰好一次、撤回丢弃待补跑；
 *   - 与 hook 的接线不变式（reconcile 不经闸、写-清同栈）由
 *     `unread-prune-roster-gate.test.ts` 的静态锁守住。
 *
 * 注意：非重入请求（步骤体之外发起）按闸契约**同步**执行，因此每次都应用自己的载荷；
 * 「最新优先」只作用于重入路径（闸活跃期内登记、微任务补跑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLatestSlot, createStepPool } from '../../src/app-hooks/facts-apply-pool.ts'

test('latest slot: take returns the newest value and clears it; found distinguishes registered undefined', () => {
  const slot = createLatestSlot<number | undefined>()
  assert.deepEqual(slot.take('a'), { found: false })
  slot.set('a', 1)
  slot.set('a', 2)
  assert.deepEqual(slot.take('a'), { found: true, value: 2 }, '最新优先，绝不 first-wins')
  assert.deepEqual(slot.take('a'), { found: false }, 'take 即清：同一载荷不得重复应用')
  slot.set('a', undefined)
  assert.deepEqual(slot.take('a'), { found: true, value: undefined }, 'drop（undefined）与未登记必须可分')
  slot.set('b', 7)
  slot.forget('b')
  assert.deepEqual(slot.take('b'), { found: false }, '撤回即作废：待应用载荷不得在来源退役后被应用')
  assert.equal(slot.size(), 0)
})

test('step pool: ids are independent, and a re-entrant request for the same id never nests', () => {
  const runs: string[] = []
  const deferred: Array<() => void> = []
  let reentered = false
  const pool = createStepPool(id => {
    runs.push(id)
    if (id === 'a' && !reentered) {
      reentered = true
      // 步骤体内请求同一来源：必须去重成一次补跑，绝不嵌套
      pool.request('a')
    }
  }, run => { deferred.push(run) })
  pool.request('a')
  pool.request('b')
  assert.deepEqual(runs, ['a', 'b'], '非重入同步执行、异源互不延后')
  assert.equal(deferred.length, 1, '同源重入被排到 defer，绝不嵌套')
  deferred.shift()?.()
  assert.deepEqual(runs, ['a', 'b', 'a'], '补跑恰好一次')
  assert.equal(deferred.length, 0, '补跑本身不再制造请求（一次性重入模型）')
})

test('re-entrant latest wins (never first-wins), and withdraw cancels the pending drain', () => {
  const seen: number[] = []
  const deferred: Array<() => void> = []
  const slot = createLatestSlot<number>()
  const pool = createStepPool(() => {
    const taken = slot.take('a')
    if (!taken.found) return
    seen.push(taken.value)
    if (taken.value === 1) {
      // 步骤体内再投两份（模拟 store 写触发的同步渲染回调）：只应合并成一次补跑，且用最新一份
      slot.set('a', 2)
      pool.request('a')
      slot.set('a', 3)
      pool.request('a')
    }
  }, run => { deferred.push(run) })
  slot.set('a', 1)
  pool.request('a')
  assert.deepEqual(seen, [1], '首拍同步应用')
  assert.equal(deferred.length, 1, '重入两份合并成一次补跑')
  while (deferred.length > 0) deferred.shift()?.()
  assert.deepEqual(seen, [1, 3], '补跑只应用最新一份（2 被 3 覆盖）')
  // 撤回：待排空载荷与闸一起丢弃，绝不在来源退役后复活
  slot.set('a', 4)
  pool.forget('a')
  slot.forget('a')
  pool.request('a')
  while (deferred.length > 0) deferred.shift()?.()
  assert.deepEqual(seen, [1, 3], '撤回后不得再应用任何载荷')
})
