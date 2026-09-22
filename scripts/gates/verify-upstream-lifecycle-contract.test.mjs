/**
 * Negative control for the upstream lifecycle-contract gate (P6): the detector must
 * flag a fabricated first-frame bound and stay quiet without one, and `evaluate`
 * must name the retirement when the vendor half flips.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FIRST_FRAME_BOUND,
  clientOpenContract,
  evaluate,
  forkRetirementPins,
  hostFirstFrameContract,
} from './verify-upstream-lifecycle-contract.mjs'

test('the bound detector flags the shapes upstream would land', () => {
  assert.equal(FIRST_FRAME_BOUND.test('AbortSignal.timeout(30_000)'), true)
  assert.equal(FIRST_FRAME_BOUND.test('const firstFrameDeadline = now + 30_000'), true)
  assert.equal(FIRST_FRAME_BOUND.test("async *follow() { yield { type: 'snapshot' } }"), false)
})

test('the host half requires an opening snapshot and no bound', () => {
  const clean = hostFirstFrameContract("async *follow(request, signal) { yield { type: 'snapshot' } }")
  assert.deepEqual(clean, { hasFollow: true, hasSnapshot: true, hasBound: false })
  assert.equal(hostFirstFrameContract('const x = 1').hasFollow, false)
  assert.equal(hostFirstFrameContract("async *follow() { yield { type: 'snapshot' }; AbortSignal.timeout(1) }").hasBound, true)
})

test('the client half requires the unbounded await', () => {
  const clean = clientOpenContract('private async doOpen(g) { await events.open({ maxMessages: 40 }) }\n  /** Apply one contiguous journal update')
  assert.equal(clean.awaitsOpen, true)
  assert.equal(clean.hasBound, false)
  assert.equal(clientOpenContract('private async doOpen(g) { await Promise.race([events.open(), AbortSignal.timeout(1)]) }').hasBound, true)
})

test('evaluate names the retirement when the vendor half lands a bound', () => {
  const sources = {
    host: "async *follow() { yield { type: 'snapshot' } }",
    client: 'private async doOpen(g) { await events.open({}) }\n  /** Apply one contiguous journal update',
    fork: "kind: 'openingSent' ... armOpeningDeadline",
    proposals: '首帧期限 ... 退役',
  }
  const read = (path) => {
    if (path.includes('history.ts')) return sources.host
    if (path.includes('session.ts')) return sources.client
    if (path.includes('stream-client.ts')) return sources.fork
    return sources.proposals
  }
  assert.deepEqual(evaluate(read).failures, [])
  const flips = evaluate((path) => path.includes('history.ts') ? "async *follow() { yield { type: 'snapshot' }; AbortSignal.timeout(1) }" : read(path))
  assert.equal(flips.failures.length, 1)
  assert.match(flips.failures[0] ?? '', /UPSTREAM LANDED A FIRST-FRAME BOUND/u)
})

test('the fork half pins the arming and the documented retirement', () => {
  assert.deepEqual(
    forkRetirementPins("kind: 'openingSent' armOpeningDeadline", '首帧期限 退役'),
    { armsDeadline: true, documentsRetirement: true },
  )
  assert.equal(forkRetirementPins('nothing', 'nothing').armsDeadline, false)
})
