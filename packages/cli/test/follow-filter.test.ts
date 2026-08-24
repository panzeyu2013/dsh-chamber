/**
 * follow-filter unit tests: the --follow incremental window must accept the
 * ISO-8601 ts the control-plane wire actually emits (regression: Number() of
 * an ISO string is NaN, which used to silently drop every line).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followNewLines, parseLogTs } from '../src/follow-filter.ts'

test('parseLogTs: numeric epoch ms passes through', () => {
  assert.equal(parseLogTs(1_725_000_000_000), 1_725_000_000_000)
})

test('parseLogTs: ISO-8601 string (the control-plane wire shape) parses', () => {
  const iso = '2026-08-14T00:00:40.000Z'
  assert.equal(parseLogTs(iso), Date.parse(iso))
})

test('parseLogTs: unparseable values yield NaN', () => {
  assert.ok(Number.isNaN(parseLogTs('not-a-date')))
  assert.ok(Number.isNaN(parseLogTs('')))
  assert.ok(Number.isNaN(parseLogTs(undefined)))
  assert.ok(Number.isNaN(parseLogTs(null)))
})

test('followNewLines: ISO-ts entries newer than the watermark are returned', () => {
  const lines = [
    { ts: '2026-08-14T00:00:40.000Z', stream: 'stdout', line: 'old' },
    { ts: '2026-08-14T00:00:42.000Z', stream: 'stderr', line: 'new' },
  ]
  const { newLines, nextTs } = followNewLines(lines, Date.parse('2026-08-14T00:00:41.000Z'))
  assert.deepEqual(newLines.map(e => e.line), ['new'])
  assert.equal(nextTs, Date.parse('2026-08-14T00:00:42.000Z'))
})

test('followNewLines: numeric ts is still supported', () => {
  const lines = [
    { ts: 100, stream: 'stdout', line: 'a' },
    { ts: 200, stream: 'stdout', line: 'b' },
  ]
  const first = followNewLines(lines, 0)
  assert.deepEqual(first.newLines.map(e => e.line), ['a', 'b'])
  assert.equal(first.nextTs, 200)
  const second = followNewLines(lines, first.nextTs)
  assert.deepEqual(second.newLines, [])
  assert.equal(second.nextTs, 200)
})

test('followNewLines: unparseable ts is always new (never silently dropped)', () => {
  const line = { ts: 'garbage', stream: 'stdout', line: 'x' }
  const { newLines, nextTs } = followNewLines([line], Date.parse('2026-08-14T00:00:41.000Z'))
  assert.deepEqual(newLines, [line])
  // The watermark must not move on unparseable entries.
  assert.equal(nextTs, Date.parse('2026-08-14T00:00:41.000Z'))
})

test('followNewLines: watermark never moves backwards', () => {
  const older = [{ ts: '2026-08-14T00:00:10.000Z', line: 'old' }]
  const { newLines, nextTs } = followNewLines(older, Date.parse('2026-08-14T00:00:41.000Z'))
  assert.deepEqual(newLines, [])
  assert.equal(nextTs, Date.parse('2026-08-14T00:00:41.000Z'))
})

test('followNewLines: null/undefined lines and empty arrays are safe no-ops', () => {
  assert.deepEqual(followNewLines(null, 0), { newLines: [], nextTs: 0 })
  assert.deepEqual(followNewLines(undefined, 5), { newLines: [], nextTs: 5 })
  assert.deepEqual(followNewLines([], 5), { newLines: [], nextTs: 5 })
})
