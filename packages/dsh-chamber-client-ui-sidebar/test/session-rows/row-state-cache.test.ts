/**
 * session-row-state-cache 的纯行为测。一行渲染会调用 sessionRowStateOf 9-12 次
 * （marker / label / pending / dot + 悬停卡），缓存必须让同一
 * (facts 对象身份, session.running, stale) 只派生一次。无 DOM：这里锁叶子契约，
 * React 侧接线由 row-render-cost.test.ts 的源码锁覆盖。
 *
 * Run directly: node test/session-rows/row-state-cache.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionRowStateCache } from '../../src/client/session-row-state-cache.ts'

test('the same (facts, running, stale) triple maps to one slot', () => {
  const cache = createSessionRowStateCache<{ state: string }>()
  const facts = {}
  assert.equal(cache.slot(facts, true, false), cache.slot(facts, true, false))
  assert.equal(cache.slot(facts, undefined, undefined), cache.slot(facts, undefined, undefined))
})

test('running and stale are keyed in all three raw values', () => {
  const cache = createSessionRowStateCache<{ state: string }>()
  const facts = {}
  const slots = new Set<object>()
  for (const running of [true, false, undefined]) {
    for (const stale of [true, false, undefined]) slots.add(cache.slot(facts, running, stale))
  }
  // true / false / undefined 是三个不同输入（runningRingVisible 读得出来）；
  // stale 的 false 与 undefined 同样不得折叠。
  assert.equal(slots.size, 9)
})

test('a new facts object is a new key, absent facts share one sentinel', () => {
  const cache = createSessionRowStateCache<number>()
  assert.notEqual(cache.slot({}, true, undefined), cache.slot({}, true, undefined))
  assert.equal(cache.slot(undefined, true, undefined), cache.slot(undefined, true, undefined))
  assert.notEqual(cache.slot(undefined, true, undefined), cache.slot(undefined, false, undefined))
})

test('derive-once: the first reader fills the slot, the other eleven reuse it', () => {
  const cache = createSessionRowStateCache<string>()
  const facts = { id: 's1' }
  const slot = cache.slot(facts, undefined, undefined)
  let derivations = 0
  const read = (): string => {
    if (slot.result !== undefined) return slot.result
    derivations += 1
    slot.result = 'row-' + derivations
    return slot.result
  }
  // 模拟一行的 12 次读数（四个 reader 都经同一个 sessionRowStateOf）：
  for (let i = 0; i < 12; i += 1) assert.equal(read(), 'row-1')
  assert.equal(derivations, 1, '12 reader calls → 1 sessionRowState derivation')
  // 另一个变体（running 变化）必须重新派生。
  const next = cache.slot(facts, true, undefined)
  next.result = 'row-2'
  assert.equal(read(), 'row-1', 'the other variant keeps its own slot')
})
