/**
 * Per-source registry (B2/P4 core) - behavior contract.
 *
 * The registry's job is the FENCE, so these tests are about identity and epochs:
 * a reclaim/re-mount is the same generation (rules keep their meaning), a
 * fingerprint change is a new epoch (no inherited penalties), and a stale event is
 * dropped. The projections are tested as the exact shapes the App's refs have
 * today, because they are the migration's compatibility surface.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  dispatchSource,
  epochOf,
  reincarnate,
  retainSourceIds,
  projectAutoPrewarmed,
  projectDegradedRetried,
  projectHiddenSince,
  projectPrewarmSuppressed,
} from '../../src/index.ts'
import type { SourceEnv, SourceIncarnation, SourceRegistry } from '../../src/index.ts'

const ENV: SourceEnv = { reclaimGraceMs: 60_000, retryableGap: () => true }
const V1: SourceIncarnation = { sourceId: 'remote-1', fingerprint: 'fp-A' }

/** Omit that distributes over the SourceEvent union (plain Omit collapses it). */
type WithoutEpoch<T> = T extends unknown ? Omit<T, 'epoch'> : never
type Event = WithoutEpoch<Parameters<typeof dispatchSource>[2]>

/** Register the incarnation and replay events under its captured epoch. */
function run(registry: SourceRegistry, incarnation: SourceIncarnation, events: Event[]): SourceRegistry {
  let next = reincarnate(registry, incarnation)
  const epoch = epochOf(next, incarnation.sourceId)
  assert.ok(epoch !== undefined)
  for (const event of events) {
    next = dispatchSource(next, incarnation.sourceId, { ...event, epoch }, ENV).registry
  }
  return next
}

test('the key is the source id, and a new fingerprint bumps the epoch', () => {
  const first = reincarnate({}, V1)
  assert.equal(epochOf(first, 'remote-1'), 1)
  const second = reincarnate(first, { sourceId: 'remote-1', fingerprint: 'fp-B' })
  assert.equal(Object.keys(second).length, 1, 'one source id has exactly one live generation')
  assert.equal(second['remote-1']?.incarnation.fingerprint, 'fp-B')
  assert.equal(epochOf(second, 'remote-1'), 2)
  assert.equal(reincarnate(second, { sourceId: 'remote-1', fingerprint: 'fp-B' }), second, 'same fingerprint = same generation')
})

test('a reclaim/re-mount cycle stays ONE record (the rules keep their meaning)', () => {
  const registry = run({}, V1, [
    { kind: 'mounted', at: 0 },
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'unmounted', at: 200 },
    { kind: 'reclaimed', at: 100_000 },
    { kind: 'mounted', at: 200_000 },
  ])
  assert.equal(Object.keys(registry).length, 1, 'no second record for the same generation')
  const state = registry['remote-1']?.state
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
  assert.equal(first['remote-1']?.state.prewarmSuppressed, true)
  const second = run(first, { sourceId: 'remote-1', fingerprint: 'fp-B' }, [{ kind: 'mounted', at: 300_000 }])
  const fresh = second['remote-1']?.state
  assert.equal(fresh?.prewarmSuppressed, false, 'the new incarnation inherits nothing')
  assert.equal(fresh?.mounted, true)
})

test('the projections are the EXACT shapes the App refs have today', () => {
  const registry = run({}, V1, [
    { kind: 'mounted', at: 0 },
    // The self-heal arm needs the source to be READY when a retryable degraded
    // settle lands (a degraded boot on a source that is still connecting must not
    // earn an automatic re-boot), so the phase comes first here on purpose.
    { kind: 'phaseChanged', phase: 'ready' },
    { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' },
    { kind: 'hidden', at: 7_000 },
  ])
  assert.deepEqual(projectHiddenSince(registry), { 'remote-1': 7_000 })
  assert.deepEqual(projectDegradedRetried(registry), { 'remote-1': true })
  assert.deepEqual([...projectAutoPrewarmed(registry)], [])
  assert.deepEqual([...projectPrewarmSuppressed(registry)], [])
})

test('a view that is on screen has no hidden projection entry', () => {
  const registry = run({}, V1, [
    { kind: 'mounted', at: 0 },
    { kind: 'hidden', at: 7_000 },
    { kind: 'windowReset' },
  ])
  assert.deepEqual(projectHiddenSince(registry), {}, 'cleared window must not project a key')
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

test('retainSourceIds drops unregistered sources and keeps identity when nothing changed', () => {
  const registry = run({}, V1, [{ kind: 'mounted', at: 0 }])
  assert.equal(retainSourceIds(registry, new Set(['remote-1'])), registry, 'no change = same reference')
  const pruned = retainSourceIds(registry, new Set())
  assert.deepEqual(pruned, {})
})

test('effects are returned with their source attached', () => {
  const registry = reincarnate({}, V1)
  const epoch = epochOf(registry, 'remote-1')
  assert.ok(epoch !== undefined)
  const reduction = dispatchSource(registry, 'remote-1', { kind: 'userSelected', at: 1, epoch }, ENV)
  assert.deepEqual(reduction.effects, [{ sourceId: 'remote-1', effect: { e: 'mount', reason: 'user' } }])
  assert.equal(reduction.accepted, true)
})
