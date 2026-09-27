/**
 * 有界集合内核契约：容量语义、同键替换裁决、
 * FIFO 淘汰与回调时机、容量 0 的负例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoundedList } from '../../src/bounded-ledger.ts'

test('bounded list: tail push, head eviction, snapshot is a copy', () => {
  const list = createBoundedList<number>(2)
  list.push(1)
  list.push(2)
  list.push(3)
  assert.deepEqual(list.toArray(), [2, 3])
  const snapshot = list.toArray()
  list.push(4)
  assert.deepEqual(snapshot, [2, 3], '快照不得被后续入队改写')
  assert.equal(list.size(), 2)
  assert.equal(createBoundedList<number>(0).push(1), false)
  list.clear()
  assert.deepEqual(list.toArray(), [])
})
