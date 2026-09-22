/**
 * B2-a: the self-heal DECISION lives in the registry now.
 *
 * These cases are the planner's truth table (boot-degradation.test.ts's
 * planDegradedRetries suite) re-expressed against the registry. They exist so the
 * planner is no longer the only thing pinning this behavior: when B7 deletes it, the
 * rules must still be covered here. The App drives the registry with exactly the
 * event sequence below (phaseChanged per source, then bootSettled for each degraded
 * shell), so this IS the production path, not a parallel one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dispatchSource, epochOf, reincarnate } from '../../../../packages/dsh-stream-state/src/index.ts'
import type { SourceEnv, SourceIncarnation, SourceRegistry } from '../../../../packages/dsh-stream-state/src/index.ts'

const V: SourceIncarnation = { sourceId: 'ssh-a', fingerprint: 'fp' }
// Retryability is the App's table (isRetryableBootGap); here only 'graph-unavailable'
// is retryable, which is what makes the 'kind a re-mount cannot fix' case testable.
const ENV: SourceEnv = { reclaimGraceMs: 60_000, retryableGap: (kind) => kind === 'graph-unavailable' }

function apply(registry: SourceRegistry, phase: string | undefined, degraded: string | null): SourceRegistry {
  const epoch = epochOf(registry, V.sourceId)
  assert.ok(epoch !== undefined)
  let next = registry
  next = dispatchSource(next, V.sourceId, { kind: 'phaseChanged', phase, epoch }, ENV).registry
  if (degraded !== null) {
    next = dispatchSource(next, V.sourceId, { kind: 'bootSettled', outcome: 'degraded', gapKind: degraded, epoch }, ENV).registry
  }
  return next
}

test('a degraded mount on a READY source earns exactly one re-boot', () => {
  const first = apply(reincarnate({}, V), 'ready', 'graph-unavailable')
  assert.equal(first[V.sourceId]?.state.degradedRetried, true, 'the mark is set by the same reduction that decides')
  // Second pass: the same facts arrive again (the App re-renders), and the mark keeps
  // the registry from re-firing - this is the planner's carry-forward.
  const second = apply(first, 'ready', 'graph-unavailable')
  assert.equal(second[V.sourceId]?.state.degradedRetried, true)
  assert.equal(second[V.sourceId]?.state.retryToken, first[V.sourceId]?.state.retryToken,
    'no second attempt inside one ready epoch')
})

test('a source that is not ready is left alone and earns a later attempt', () => {
  const notReady = apply(reincarnate({}, V), 'starting', 'graph-unavailable')
  assert.equal(notReady[V.sourceId]?.state.degradedRetried, false, 'not ready = no attempt')
  const ready = apply(notReady, 'ready', 'graph-unavailable')
  assert.equal(ready[V.sourceId]?.state.degradedRetried, true, 'the later ready transition earns it')
})

test('a retired source (no phase) never earns a re-boot', () => {
  const retired = apply(reincarnate({}, V), undefined, 'graph-unavailable')
  assert.equal(retired[V.sourceId]?.state.degradedRetried, false)
})

test('a kind a re-mount cannot fix never earns an attempt (and no mark)', () => {
  const unfixable = apply(reincarnate({}, V), 'ready', 'missing-required-service')
  assert.equal(unfixable[V.sourceId]?.state.degradedRetried, false,
    'an unfixable kind must not consume the once-per-epoch attempt')
})

test('leaving ready re-arms the attempt (the mark dies with the ready epoch)', () => {
  const fired = apply(reincarnate({}, V), 'ready', 'graph-unavailable')
  const left = apply(fired, 'starting', null)
  assert.equal(left[V.sourceId]?.state.degradedRetried, false)
  const again = apply(left, 'ready', 'graph-unavailable')
  assert.equal(again[V.sourceId]?.state.retryToken, (fired[V.sourceId]?.state.retryToken ?? 0) + 1,
    'the new ready epoch earns a fresh attempt')
})

test('a healthy mount never produces a retry (and the plan is stable)', () => {
  // The planner's "healthy mounts are ignored" case: a source that settled BOOTED
  // must not appear in the re-boot list no matter how ready it is.
  const ready = apply(reincarnate({}, V), 'ready', null)
  const epoch = epochOf(ready, V.sourceId)
  assert.ok(epoch !== undefined)
  const state = dispatchSource(ready, V.sourceId, { kind: 'bootSettled', outcome: 'booted', epoch }, ENV).registry
  assert.equal(state[V.sourceId]?.state.degradedRetried, false, 'nothing to re-boot')
})

test('the mark of a retired source is dropped, not carried', () => {
  // The planner pruned marks for sources the roster no longer lists; the registry
  // does the same through an explicit forget, which is what the registry sweep
  // dispatches. (It matters because a carried mark would forbid the re-registered
  // source its automatic attempt.)
  const marked = apply(reincarnate({}, V), 'ready', 'graph-unavailable')
  assert.equal(marked[V.sourceId]?.state.degradedRetried, true)
  const epoch = epochOf(marked, V.sourceId)
  assert.ok(epoch !== undefined)
  const forgotten = dispatchSource(marked, V.sourceId, { kind: 'retryForgotten', epoch }, ENV).registry
  assert.equal(forgotten[V.sourceId]?.state.degradedRetried, false)
})

test('the mark survives the idle reset that the retry itself causes (no re-boot loop)', () => {
  // The App's re-boot makes the shell momentarily non-degraded; the fact then
  // disappears (degraded: null) and must NOT be read as "the source recovered".
  const fired = apply(reincarnate({}, V), 'ready', 'graph-unavailable')
  const idle = apply(fired, 'ready', null)
  assert.equal(idle[V.sourceId]?.state.degradedRetried, true, 'the mark persists through the idle gap')
})
