/**
 * Per-source container - behavior contract.
 *
 * The container's job is the KEYING, so these tests are about identity and fences:
 * a reclaim/re-mount is the same incarnation (rules keep their meaning), while a
 * fingerprint change is a new one (no inherited penalties). The projections are
 * tested as the exact shapes the App's refs have today.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  dispatchSource,
  incarnationKey,
  projectAutoPrewarmed,
  projectDegradedRetried,
  projectHiddenSince,
  projectPrewarmSuppressed,
  retainSources,
} from '../../src/index.ts'
import type { SourceEnv, SourceIncarnation, SourceLifecycleState } from '../../src/index.ts'

const ENV: SourceEnv = { reclaimGraceMs: 60_000, retryableGap: () => true }
const V1: SourceIncarnation = { sourceId: 'remote-1', fingerprint: 'fp-A' }

type States = Readonly<Record<string, SourceLifecycleState>>

type Event = Parameters<typeof dispatchSource>[2]

function run(states: States, incarnation: SourceIncarnation, events: Event[]): States {
  let next = states
  for (const event of events) next = dispatchSource(next, incarnation, event, ENV).states
  return next
}

test('the key is the pair, so one source with two fingerprints is two records', () => {
  assert.notEqual(
    incarnationKey({ sourceId: 'remote-1', fingerprint: 'fp-A' }),
    incarnationKey({ sourceId: 'remote-1', fingerprint: 'fp-B' }),
  )
})

test('a reclaim/re-mount cycle stays ONE record (the rules keep their meaning)', () => {
  const states = run({}, V1, [
    { kind: 'mounted', at: 0 },
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'unmounted', at: 200 },
    { kind: 'reclaimed', at: 100_000 },
    { kind: 'mounted', at: 200_000 },
  ])
  assert.equal(Object.keys(states).length, 1, 'no second record for the same pair')
  const state = states[incarnationKey(V1)]
  assert.equal(state?.mounted, true)
  assert.equal(state?.prewarmSuppressed, true, 'suppression survives the re-mount')
})

test('a NEW fingerprint starts clean (no inherited penalties)', () => {
  const first = run({}, V1, [
    { kind: 'mounted', at: 0 },
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'unmounted', at: 200 },
    { kind: 'reclaimed', at: 100_000 },
  ])
  assert.equal(first[incarnationKey(V1)]?.prewarmSuppressed, true)
  const second = run(first, { sourceId: 'remote-1', fingerprint: 'fp-B' }, [{ kind: 'mounted', at: 300_000 }])
  const fresh = second[incarnationKey({ sourceId: 'remote-1', fingerprint: 'fp-B' })]
  assert.equal(fresh?.prewarmSuppressed, false, 'the new incarnation inherits nothing')
  assert.equal(fresh?.mounted, true)
})

test('the projections are the EXACT shapes the App refs have today', () => {
  const states = run({}, V1, [
    { kind: 'mounted', at: 0 },
    // The self-heal arm needs the source to be READY when a retryable degraded
    // settle lands (a degraded boot on a source that is still connecting must not
    // earn an automatic re-boot), so the phase comes first here on purpose.
    { kind: 'phaseChanged', phase: 'ready' },
    { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' },
    { kind: 'hidden', at: 7_000 },
  ])
  assert.deepEqual(projectHiddenSince(states), { 'remote-1': 7_000 })
  assert.deepEqual(projectDegradedRetried(states), { 'remote-1': true })
  assert.deepEqual([...projectAutoPrewarmed(states)], [])
  assert.deepEqual([...projectPrewarmSuppressed(states)], [])
})

test('a view that is on screen has no hidden projection entry', () => {
  const states = run({}, V1, [
    { kind: 'mounted', at: 0 },
    { kind: 'hidden', at: 7_000 },
    { kind: 'windowReset' },
  ])
  assert.deepEqual(projectHiddenSince(states), {}, 'cleared window must not project a key')
})

test('suppressed/auto-prewarmed projections are Sets of source ids', () => {
  const suppressed = run({}, V1, [
    { kind: 'mounted', at: 0 },
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'unmounted', at: 100 },
    { kind: 'reclaimed', at: 100_000 },
  ])
  assert.deepEqual([...projectPrewarmSuppressed(suppressed)], ['remote-1'])
  const auto = run({}, V1, [{ kind: 'mounted', at: 0 }, { kind: 'phaseChanged', phase: 'ready' }])
  assert.equal(typeof projectAutoPrewarmed(auto).has, 'function')
})

test('retainSources drops unregistered sources and keeps identity when nothing changed', () => {
  const states = run({}, V1, [{ kind: 'mounted', at: 0 }])
  const key = incarnationKey(V1)
  assert.equal(retainSources(states, new Set([key])), states, 'no change = same reference')
  const pruned = retainSources(states, new Set())
  assert.deepEqual(pruned, {})
})

test('effects are returned with their source attached', () => {
  const reduction = dispatchSource({}, V1, { kind: 'userSelected', at: 1 }, ENV)
  assert.deepEqual(reduction.effects, [{ sourceId: 'remote-1', effect: { e: 'mount', reason: 'user' } }])
})
