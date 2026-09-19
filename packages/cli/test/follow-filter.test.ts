import assert from 'node:assert/strict'
import test from 'node:test'
import { followNewLines } from '../src/follow-filter.ts'

/** Build a fixture timestamp `at(n)` for test date 2026-08-28T00:00:00.00nZ. */
const at = (millis: number): string => `2026-08-28T00:00:00.${String(millis).padStart(3, '0')}Z`
const line = (ts: string, text: string, stream = 'stdout') => ({ ts, stream, line: text })

test('first snapshot is emitted and an unchanged snapshot is quiet', () => {
  const lines = [line(at(0), 'a'), line(at(1), 'b')]
  const first = followNewLines(lines, [])
  assert.deepEqual(first.newLines, lines)
  assert.deepEqual(followNewLines(lines, first.nextKeys).newLines, [])
})

test('a later line with the same millisecond timestamp is emitted', () => {
  const first = followNewLines([line(at(0), 'a')], [])
  assert.deepEqual(followNewLines([line(at(0), 'a'), line(at(0), 'b')], first.nextKeys).newLines.map(row => row.line), ['b'])
})

test('identical repeated lines are counted by position', () => {
  const repeated = line(at(0), 'same')
  const first = followNewLines([repeated], [])
  assert.equal(followNewLines([repeated, repeated], first.nextKeys).newLines.length, 1)
})

test('a shifted tail window emits only the appended suffix', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((text, index) => line(at(index), text))
  const previous = followNewLines([a, b, c], []).nextKeys
  assert.deepEqual(followNewLines([b, c, d], previous).newLines, [d])
})

test('a replaced log with no overlap is emitted from its new start', () => {
  const previous = followNewLines([line(at(0), 'old')], []).nextKeys
  const replacement = [line('2026-08-28T00:01:00.000Z', 'replacement')]
  assert.deepEqual(followNewLines(replacement, previous).newLines, replacement)
})

test('empty snapshots are safe and become the next baseline', () => {
  const previous = followNewLines([line(at(0), 'old')], []).nextKeys
  assert.deepEqual(followNewLines(undefined, previous), { newLines: [], nextKeys: [] })
})
