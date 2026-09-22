/**
 * Bounded forensics ring (P5) - behavior contract.
 *
 * The ring is the resident tail buffer the export paths drain; its whole job is
 * that it is BOUNDED and that nothing it retains can leak a credential. The
 * negative control here is the eviction: the 1000-record case proves the buffer
 * cannot grow past its cap, and the redaction cases prove masking is applied at
 * record time (not at read time, where a second reader could forget it).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FORENSICS_DETAIL_MAX,
  FORENSICS_RING_CAP,
  createForensicsRing,
  redactForensicsDetail,
  sanitizeForensicsKind,
} from '../../src/forensics.ts'

test('the ring is bounded: 1000 records keep only the newest cap', () => {
  const ring = createForensicsRing()
  for (let index = 0; index < 1000; index += 1) {
    ring.record('socket-lost', 'entry ' + String(index), index)
  }
  assert.equal(ring.size(), FORENSICS_RING_CAP)
  const tail = ring.snapshot()
  assert.equal(tail.length, FORENSICS_RING_CAP)
  assert.equal(tail[0]?.seq, 1000 - FORENSICS_RING_CAP + 1, 'oldest retained entry')
  assert.equal(tail[tail.length - 1]?.seq, 1000, 'newest entry')
  assert.equal(tail[0]?.detail, 'entry ' + String(1000 - FORENSICS_RING_CAP))
})

test('the cap can only be overridden by a positive finite value', () => {
  const small = createForensicsRing({ cap: 2 })
  small.record('a', '1', 0)
  small.record('a', '2', 0)
  small.record('a', '3', 0)
  assert.deepEqual(small.snapshot().map((entry) => entry.detail), ['2', '3'])
  for (const cap of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const ring = createForensicsRing({ cap })
    for (let index = 0; index < FORENSICS_RING_CAP + 5; index += 1) ring.record('a', 'x', 0)
    assert.equal(ring.size(), FORENSICS_RING_CAP, 'cap ' + String(cap) + ' must fall back to the default bound')
  }
})

test('entries are FIFO and a non-finite stamp is conservatively 0', () => {
  const ring = createForensicsRing({ cap: 8 })
  ring.record('socket-lost', 'first', 10)
  ring.record('socket-reconnect', 'second', Number.NaN)
  assert.deepEqual(ring.snapshot(), [
    { seq: 1, at: 10, kind: 'socket-lost', detail: 'first' },
    { seq: 2, at: 0, kind: 'socket-reconnect', detail: 'second' },
  ])
})

test('redaction masks credential-shaped values and strips control characters', () => {
  assert.equal(redactForensicsDetail('Authorization: Bearer abc123'), 'Authorization=***')
  assert.equal(redactForensicsDetail('token=xyz cookie:zzz'), 'token=*** cookie=***')
  assert.equal(redactForensicsDetail('https://user:pass@host/api'), 'https://***@host/api')
  assert.equal(redactForensicsDetail('line\u0000break\nnext'), 'line break next')
  const long = redactForensicsDetail('x'.repeat(FORENSICS_DETAIL_MAX * 3))
  assert.equal(long.length, FORENSICS_DETAIL_MAX)
})

test('the kind is sanitized to lowercase [a-z0-9-]', () => {
  assert.equal(sanitizeForensicsKind('Opening Timeout!'), 'opening-timeout')
  assert.equal(sanitizeForensicsKind('--a__b--'), 'a-b')
  assert.equal(sanitizeForensicsKind('x'.repeat(200)).length, 48)
})

test('a snapshot is a copy: mutating it cannot corrupt the ring', () => {
  const ring = createForensicsRing()
  ring.record('socket-lost', 'one', 1)
  const snapshot = ring.snapshot() as unknown as Array<{ detail: string }>
  snapshot[0]!.detail = 'tampered'
  assert.equal(ring.snapshot()[0]?.detail, 'one')
})
