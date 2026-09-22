/**
 * per-source 注册表收敛内核契约：live 外删除、保序、
 * identity-preserving（无变化必须返回 null，调用方据此避免重建引用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pruneSourceList, pruneSourceRecord, pruneSourceSet } from '../../src/source-registry.ts'

test('record: drops keys outside live and keeps entries when unchanged', () => {
  const table = { a: 1, b: 2, c: 3 }
  assert.deepEqual(pruneSourceRecord(table, new Set(['a', 'c'])), { a: 1, c: 3 })
  assert.equal(pruneSourceRecord(table, new Set(['a', 'b', 'c'])), null, '无变化必须 null（identity 保持）')
  assert.deepEqual(pruneSourceRecord(table, new Set()), {})
  assert.equal(pruneSourceRecord({}, new Set(['a'])), null)
})

test('record: extra live ids are not added and values are preserved by reference', () => {
  const value = { nested: true }
  const out = pruneSourceRecord({ a: value }, new Set(['a', 'ghost']))
  assert.equal(out, null)
  const dropped = pruneSourceRecord({ a: value, b: 2 }, new Set(['a']))
  assert.equal(dropped?.a, value)
})

test('set: drops members outside live, identity-preserving on no change', () => {
  const set = new Set(['a', 'b'])
  assert.deepEqual([...pruneSourceSet(set, new Set(['b']))!], ['b'])
  assert.equal(pruneSourceSet(set, new Set(['a', 'b'])), null)
  assert.deepEqual([...pruneSourceSet(set, new Set())!], [])
})

test('list: filters preserving order, identity-preserving on no change', () => {
  const list = ['a', 'b', 'c']
  assert.deepEqual(pruneSourceList(list, new Set(['c', 'a'])), ['a', 'c'])
  assert.equal(pruneSourceList(list, new Set(['a', 'b', 'c'])), null)
  assert.deepEqual(pruneSourceList(list, new Set()), [])
  assert.deepEqual(pruneSourceList(['a', 'a', 'b'], new Set(['a'])), ['a', 'a'], '重复项不折叠')
  assert.equal(pruneSourceList(['a', 'a'], new Set(['a'])), null, '全 live 仍是 identity-preserving')
})
