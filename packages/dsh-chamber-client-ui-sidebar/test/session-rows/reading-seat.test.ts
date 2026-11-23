/**
 * Page-level reading seats (design 06 §4.1; alpha.1 session-status).
 *
 * The seat is a pure page-level map: publish on shell mount, refresh on every
 * readingReady change, retire on teardown. Only the OWN source's seat gates that
 * source's row menu (a foreign shell renders the row but must not lend its ctx).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  publishReadingSeat, readingReadyOf, readingSeatOf, subscribeReadingSeats,
} from '../../src/client/reading-seat.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

test('reading seats: publish/refresh/retire with subscriber notifications', () => {
  let notifications = 0
  const unsubscribe = subscribeReadingSeats(() => { notifications += 1 })
  try {
    assert.equal(readingReadyOf('dsh-a'), false, 'unmounted source has no seat and is not ready')
    assert.equal(readingSeatOf('dsh-a'), undefined)
    const retire = publishReadingSeat('dsh-a', { ready: false })
    assert.equal(notifications, 1)
    const pending = readingSeatOf('dsh-a')
    assert.deepEqual(pending, { ready: false })
    assert.equal(readingReadyOf('dsh-a'), false, 'published-but-not-ready still gates the mark off')
    // A refresh replaces the seat and notifies; the OLD disposer must not retire it.
    const retireReady = publishReadingSeat('dsh-a', { ready: true })
    assert.equal(notifications, 2)
    assert.equal(readingReadyOf('dsh-a'), true)
    retire()
    assert.equal(readingReadyOf('dsh-a'), true, 'a stale publication cannot retire the live seat')
    retireReady()
    assert.equal(readingReadyOf('dsh-a'), false, 'the current publication retires the seat')
    const afterRetire = notifications
    retireReady()
    assert.equal(notifications, afterRetire, 'retiring twice is a no-op')
  } finally {
    unsubscribe()
    publishReadingSeat('dsh-a', { ready: false })()
  }
})

test("reading seats are per-source: one source readiness never lends another its mark gate", () => {
  const retireA = publishReadingSeat('dsh-a', { ready: true })
  const retireB = publishReadingSeat('dsh-b', { ready: false })
  try {
    assert.equal(readingReadyOf('dsh-a'), true)
    assert.equal(readingReadyOf('dsh-b'), false)
    assert.equal(readingReadyOf('local'), false)
  } finally {
    retireA()
    retireB()
  }
})

test("wiring: the row hook reads the seat of the row own source only", () => {
  const hook = stripComments(readFileSync(new URL('../../src/client/use-reading-seat.ts', import.meta.url), 'utf8'))
  assert.match(hook, /readingReadyOf\(sourceId\)/u, 'one seat lookup per rendered source id')
  assert.match(hook, /subscribeReadingSeats/u, 'seat publication/retirement drives the external store')
})
