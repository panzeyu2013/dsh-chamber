import assert from 'node:assert/strict'
import test from 'node:test'
import { followNewLines } from '../src/follow-filter.ts'

const line = (ts: string, text: string, stream = 'stdout') => ({ ts, stream, line: text })

test('first snapshot is emitted and an unchanged snapshot is quiet', () => {
  const lines = [line('2026-08-28T00:00:00.000Z', 'a'), line('2026-08-28T00:00:00.001Z', 'b')]
  const first = followNewLines(lines, [])
  assert.deepEqual(first.newLines, lines)
  assert.deepEqual(followNewLines(lines, first.nextKeys).newLines, [])
})

test('a later line with the same millisecond timestamp is emitted', () => {
  const ts = '2026-08-28T00:00:00.000Z'
  const first = followNewLines([line(ts, 'a')], [])
  assert.deepEqual(followNewLines([line(ts, 'a'), line(ts, 'b')], first.nextKeys).newLines.map(row => row.line), ['b'])
})

test('identical repeated lines are counted by position', () => {
  const repeated = line('2026-08-28T00:00:00.000Z', 'same')
  const first = followNewLines([repeated], [])
  assert.equal(followNewLines([repeated, repeated], first.nextKeys).newLines.length, 1)
})

test('a shifted tail window emits only the appended suffix', () => {
  const a = line('2026-08-28T00:00:00.000Z', 'a')
  const b = line('2026-08-28T00:00:00.001Z', 'b')
  const c = line('2026-08-28T00:00:00.002Z', 'c')
  const d = line('2026-08-28T00:00:00.003Z', 'd')
  const previous = followNewLines([a, b, c], []).nextKeys
  assert.deepEqual(followNewLines([b, c, d], previous).newLines, [d])
})

test('a replaced log with no overlap is emitted from its new start', () => {
  const previous = followNewLines([line('2026-08-28T00:00:00.000Z', 'old')], []).nextKeys
  const replacement = [line('2026-08-28T00:01:00.000Z', 'replacement')]
  assert.deepEqual(followNewLines(replacement, previous).newLines, replacement)
})

test('empty snapshots are safe and become the next baseline', () => {
  const previous = followNewLines([line('2026-08-28T00:00:00.000Z', 'old')], []).nextKeys
  assert.deepEqual(followNewLines(undefined, previous), { newLines: [], nextKeys: [] })
})
