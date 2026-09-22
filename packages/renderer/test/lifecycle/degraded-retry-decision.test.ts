/**
 * The self-heal DECISION lives in the container.
 *
 * These cases pin the planner's truth table (boot-degradation.test.ts's
 * planDegradedRetries suite) through the container. The App drives the container with
 * exactly the event sequence below (phaseChanged per source, then bootSettled for each
 * degraded shell), so this IS the production path, not a parallel one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dispatchSource, incarnationKey } from '../../../../packages/dsh-stream-state/src/index.ts'
import type { SourceEnv, SourceIncarnation, SourceLifecycleState } from '../../../../packages/dsh-stream-state/src/index.ts'

const V: SourceIncarnation = { sourceId: 'ssh-a', fingerprint: 'fp' }
// Retryability is the App's table (isRetryableBootGap); here only 'graph-unavailable'
// is retryable, which is what makes the 'kind a re-mount cannot fix' case testable.
const ENV: SourceEnv = { reclaimGraceMs: 60_000, retryableGap: (kind) => kind === 'graph-unavailable' }

function apply(states: Record<string, SourceLifecycleState>, phase: string | undefined, degraded: string | null) {
  let next = states
  next = dispatchSource(next, V, { kind: 'phaseChanged', phase }, ENV).states
  if (degraded !== null) {
    next = dispatchSource(next, V, { kind: 'bootSettled', outcome: 'degraded', gapKind: degraded }, ENV).states
  }
  return next
}

test('a degraded mount on a READY source earns exactly one re-boot', () => {
  const first = apply({}, 'ready', 'graph-unavailable')
  assert.equal(first[incarnationKey(V)]?.degradedRetried, true, 'the mark is set by the same reduction that decides')
  // Second pass: the same facts arrive again (the App re-renders), and the mark keeps
  // the container from re-firing - this is the planner's carry-forward.
  const second = apply(first, 'ready', 'graph-unavailable')
  assert.equal(second[incarnationKey(V)]?.degradedRetried, true)
  assert.equal(second[incarnationKey(V)]?.retryToken, first[incarnationKey(V)]?.retryToken,
    'no second attempt inside one ready epoch')
})

test('a source that is not ready is left alone and earns a later attempt', () => {
  const notReady = apply({}, 'starting', 'graph-unavailable')
  assert.equal(notReady[incarnationKey(V)]?.degradedRetried, false, 'not ready = no attempt')
  const ready = apply(notReady, 'ready', 'graph-unavailable')
  assert.equal(ready[incarnationKey(V)]?.degradedRetried, true, 'the later ready transition earns it')
})

test('a retired source (no phase) never earns a re-boot', () => {
  const retired = apply({}, undefined, 'graph-unavailable')
  assert.equal(retired[incarnationKey(V)]?.degradedRetried, false)
})

test('a kind a re-mount cannot fix never earns an attempt (and no mark)', () => {
  const unfixable = apply({}, 'ready', 'missing-required-service')
  assert.equal(unfixable[incarnationKey(V)]?.degradedRetried, false,
    'an unfixable kind must not consume the once-per-epoch attempt')
})

test('leaving ready re-arms the attempt (the mark dies with the ready epoch)', () => {
  const fired = apply({}, 'ready', 'graph-unavailable')
  const left = apply(fired, 'starting', null)
  assert.equal(left[incarnationKey(V)]?.degradedRetried, false)
  const again = apply(left, 'ready', 'graph-unavailable')
  assert.equal(again[incarnationKey(V)]?.retryToken, (fired[incarnationKey(V)]?.retryToken ?? 0) + 1,
    'the new ready epoch earns a fresh attempt')
})

test('a healthy mount never produces a retry (and the plan is stable)', () => {
  // The planner's "healthy mounts are ignored" case: a source that settled BOOTED
  // must not appear in the re-boot list no matter how ready it is.
  let state = apply({}, 'ready', null)
  state = dispatchSource(state, V, { kind: 'bootSettled', outcome: 'booted' }, ENV).states
  assert.equal(state[incarnationKey(V)]?.degradedRetried, false, 'nothing to re-boot')
})

test('the mark of a retired source is dropped, not carried', () => {
  // The planner prunes marks for sources the roster no longer lists; the container
  // does the same through an explicit forget, which is what the registry sweep
  // dispatches. (It matters because a carried mark would forbid the re-registered
  // source its automatic attempt.)
  const marked = apply({}, 'ready', 'graph-unavailable')
  assert.equal(marked[incarnationKey(V)]?.degradedRetried, true)
  const forgotten = dispatchSource(marked, V, { kind: 'retryForgotten' }, ENV).states
  assert.equal(forgotten[incarnationKey(V)]?.degradedRetried, false)
})

test('the mark survives the idle reset that the retry itself causes (no re-boot loop)', () => {
  // The App's re-boot makes the shell momentarily non-degraded; the fact then
  // disappears (degraded: null) and must NOT be read as "the source recovered".
  const fired = apply({}, 'ready', 'graph-unavailable')
  const idle = apply(fired, 'ready', null)
  assert.equal(idle[incarnationKey(V)]?.degradedRetried, true, 'the mark persists through the idle gap')
})
