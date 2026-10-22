/**
 * The proxy ⇄ client budget contract (design 27 §3.4/§3.5, wire/net-budget.ts).
 *
 * The invariant the two owners must keep is an INEQUALITY: the page client's
 * mutation call budget has to outlive the proxy's worst case (upload flush
 * budget + header window) plus a cushion, or the client aborts before the
 * proxy's `details.phase='after-body'` classification can arrive. It broke once
 * when both sides hand-rolled the numbers (client floor 50s vs proxy 60s + 45s),
 * so the derivation is shared and this test pins the ordering over a size grid.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NET_BUDGET,
  mutationCallBudgetMs,
  proxyUploadBudgetMs,
  proxyWorstCaseMs,
} from '@dsh-chamber/dsh-chamber-wire'
import { LONG_RPC_UPSTREAM_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS } from '../../src/proxy-forward.ts'

const SIZES = [0, 1, 1024, 128 * 1024, 1024 * 1024, 20 * 1024 * 1024, 300 * 1024 * 1024]

test('the proxy header window IS the wire table (one source, not two literals)', () => {
  // The historical break was two hand-written copies. The helper-level ordering test
  // below is constructed from the same table, so it can never catch a literal on the
  // PROXY side; this lockstep assertion is what does.
  assert.equal(UPSTREAM_TIMEOUT_MS, NET_BUDGET.upstreamHeaderWindowMs)
  assert.equal(LONG_RPC_UPSTREAM_TIMEOUT_MS, 30 * 60_000, 'the long-RPC fuse is a separate, deliberate value')
})

test('the client mutation budget always outlives the proxy worst case by the cushion', () => {
  for (const bytes of SIZES) {
    const proxyWorst = proxyWorstCaseMs(bytes)
    assert.equal(mutationCallBudgetMs(bytes), proxyWorst + NET_BUDGET.outcomeCushionMs, `bytes=${String(bytes)}`)
    assert.ok(mutationCallBudgetMs(bytes) > proxyWorst, `bytes=${String(bytes)}: the client must never abort first`)
  }
  // Concrete pins, not just an internal identity: 20MiB is 160s flush + 45s window,
  // 300MiB is capped at 30min + 45s; the client adds the 5s cushion to both.
  assert.equal(mutationCallBudgetMs(20 * 1024 * 1024), 160_000 + 45_000 + 5_000)
  assert.equal(mutationCallBudgetMs(300 * 1024 * 1024), NET_BUDGET.uploadMaxMs + 45_000 + NET_BUDGET.outcomeCushionMs)
})

test('the upload budget floors at 60s, scales with the body and caps at 30min', () => {
  assert.equal(proxyUploadBudgetMs(0), NET_BUDGET.uploadFloorMs)
  assert.equal(proxyUploadBudgetMs(1), NET_BUDGET.uploadFloorMs, 'a tiny body still gets the floor')
  // 20MiB at 128KiB/s = 160s, above the floor and below the cap.
  assert.equal(proxyUploadBudgetMs(20 * 1024 * 1024), 160_000)
  // 300MiB at 128KiB/s = 2400s, clamped to the 30min cap.
  assert.equal(proxyUploadBudgetMs(300 * 1024 * 1024), NET_BUDGET.uploadMaxMs)
})

test('non-finite and negative sizes cannot produce a broken budget', () => {
  for (const bytes of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(proxyUploadBudgetMs(bytes), NET_BUDGET.uploadFloorMs, String(bytes))
  }
})

test('test seams shrink the scale without breaking the ordering', () => {
  const options = { minBytesPerSec: 1, maxMs: 40 }
  assert.equal(proxyUploadBudgetMs(5, options), 40)
  assert.equal(proxyWorstCaseMs(5, options), 40 + NET_BUDGET.upstreamHeaderWindowMs)
})
