/**
 * 有界集合内核契约：容量语义、同键替换裁决、
 * FIFO 淘汰与回调时机、容量 0 的负例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoundedList, createBoundedMap } from '../../src/bounded-ledger.ts'

test('bounded map: FIFO eviction reports each dropped key once', () => {
  const evicted: string[] = []
  const map = createBoundedMap<number>({ limit: 2, onEvict: key => evicted.push(key) })
  assert.equal(map.set('a', 1), true)
  assert.equal(map.set('b', 2), true)
  assert.equal(map.set('c', 3), true)
  assert.deepEqual([...map.keys()], ['b', 'c'])
  assert.deepEqual(evicted, ['a'])
  assert.equal(map.get('a'), undefined)
  assert.equal(map.size(), 2)
})

test('bounded map: a same-key write moves to the tail only when replace accepts', () => {
  const map = createBoundedMap<number>({ limit: 3, replace: (prev, next) => next > prev })
  map.set('a', 1)
  map.set('b', 2)
  assert.equal(map.set('a', 1), false, '同值被 replace 拒绝：不得触碰顺序')
  assert.deepEqual([...map.keys()], ['a', 'b'])
  assert.equal(map.set('a', 5), true)
  assert.deepEqual([...map.keys()], ['b', 'a'])
})

test('bounded map: a rejected write never evicts an older key', () => {
  const evicted: string[] = []
  const map = createBoundedMap<number>({ limit: 1, replace: () => false, onEvict: key => evicted.push(key) })
  map.set('a', 1)
  assert.equal(map.set('a', 2), false)
  assert.deepEqual([...map.keys()], ['a'])
  assert.deepEqual(evicted, [])
})

test('bounded map: explicit delete does not report eviction; clear empties', () => {
  const evicted: string[] = []
  const map = createBoundedMap<number>({ limit: 3, onEvict: key => evicted.push(key) })
  map.set('a', 1)
  assert.equal(map.delete('a'), true)
  assert.equal(map.has('a'), false)
  assert.deepEqual(evicted, [], '显式删除不是容量淘汰')
  map.set('b', 2)
  map.clear()
  assert.equal(map.size(), 0)
})

test('bounded map: limit 0 refuses every write (and never reports)', () => {
  const evicted: string[] = []
  const map = createBoundedMap<number>({ limit: 0, onEvict: key => evicted.push(key) })
  assert.equal(map.set('a', 1), false)
  assert.equal(map.size(), 0)
  assert.deepEqual(evicted, [])
})

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
