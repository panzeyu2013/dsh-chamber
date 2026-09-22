/**
 * B2 characterization: the shared source reducer must reproduce the App's
 * hidden-window ledger exactly before the ledger is migrated onto it.
 *
 * The ledger (App.tsx's hiddenSinceRef) has four write sites and one read, and its
 * semantics are NOT obvious from the reducer's field names: 'painted' must clear
 * the window, 'mounted' must start it empty, keys must die with the mount, and a
 * view that is merely off screen must keep its original start time (so a
 * one-frame disappearance cannot reset the hold). This test pins each one against
 * the legacy behaviour, so the migration is an equivalence, not a rewrite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { initialSourceLifecycle, reduceSource } from '../../../../packages/dsh-stream-state/src/index.ts'
import type { SourceEnv, SourceLifecycleState } from '../../../../packages/dsh-stream-state/src/index.ts'

const ENV: SourceEnv = {
  reclaimGraceMs: 60_000,
  retryableGap: () => true,
}

function dispatch(state: SourceLifecycleState, events: Array<Parameters<typeof reduceSource>[1]>): SourceLifecycleState {
  let next = state
  for (const event of events) next = reduceSource(next, event, ENV).state
  return next
}

test('a fresh mount starts with no hidden window', () => {
  const state = dispatch(initialSourceLifecycle({ sourceId: 'v1', fingerprint: 'fp1' }), [{ kind: 'mounted', at: 1000 }])
  assert.equal(state.hiddenSince, null)
})

test('leaving the screen starts the window at the moment it left', () => {
  // App.tsx: previousActiveViewRef -> hiddenSinceRef[previous] = Date.now()
  const state = dispatch(initialSourceLifecycle({ sourceId: 'v1', fingerprint: 'fp1' }), [
    { kind: 'mounted', at: 0 },
    { kind: 'hidden', at: 5_000 },
  ])
  assert.equal(state.hiddenSince, 5_000)
})

test('landing on screen clears the window', () => {
  const state = dispatch(initialSourceLifecycle({ sourceId: 'v1', fingerprint: 'fp1' }), [
    { kind: 'mounted', at: 0 },
    { kind: 'hidden', at: 5_000 },
    { kind: 'painted', at: 9_000 },
  ])
  assert.equal(state.hiddenSince, null)
})

test('a second hide re-starts the window from the new departure', () => {
  const state = dispatch(initialSourceLifecycle({ sourceId: 'v1', fingerprint: 'fp1' }), [
    { kind: 'mounted', at: 0 },
    { kind: 'hidden', at: 5_000 },
    { kind: 'painted', at: 9_000 },
    { kind: 'hidden', at: 20_000 },
  ])
  assert.equal(state.hiddenSince, 20_000)
})

test('a remount clears the window of the mount that ended', () => {
  const state = dispatch(initialSourceLifecycle({ sourceId: 'v1', fingerprint: 'fp1' }), [
    { kind: 'mounted', at: 0 },
    { kind: 'hidden', at: 5_000 },
    { kind: 'mounted', at: 30_000 },
  ])
  assert.equal(state.hiddenSince, null)
})

test('retryForgotten drops the self-heal mark and nothing else', () => {
  // The App's reclaimView calls forgetDegradedRetry on the mark. The container's
  // counterpart must be equally narrow: a view that is still settled-degraded keeps
  // its boot outcome, and a suppressed view stays suppressed.
  const marked = dispatch(initialSourceLifecycle({ sourceId: 'v1', fingerprint: 'fp1' }), [
    { kind: 'mounted', at: 0 },
    { kind: 'phaseChanged', phase: 'ready' },
    { kind: 'bootSettled', outcome: 'degraded', gapKind: 'graph-unavailable' },
  ])
  assert.equal(marked.degradedRetried, true, 'the ready + degraded settle sets the mark')
  const forgotten = reduceSource(marked, { kind: 'retryForgotten' }, ENV).state
  assert.equal(forgotten.degradedRetried, false, 'the mark is gone')
  assert.deepEqual(forgotten.boot, marked.boot, 'the boot outcome is untouched')
  assert.equal(forgotten.mounted, marked.mounted)
})

test('windowReset closes the window WITHOUT touching the suppression', () => {
  // The migration path: the App's paint write-point emits windowReset, because the
  // legacy ledger clears hiddenSinceRef on paint but keeps prewarmSuppressedRef
  // until an explicit user action / registry removal.
  const state = dispatch(initialSourceLifecycle({ sourceId: 'v1', fingerprint: 'fp1' }), [
    { kind: 'mounted', at: 0 },
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'unmounted', at: 200 },
    { kind: 'reclaimed', at: 100_000 },
    { kind: 'mounted', at: 200_000 },
    { kind: 'windowReset' },
  ])
  assert.equal(state.hiddenSince, null, 'the window closes on paint')
  // Suppression belongs to the INCARNATION, not the mount: a reclaim/re-mount cycle
  // of the same (sourceId, fingerprint) must stay suppressed or the next tick would
  // re-boot it in a loop. Only a user action lifts it - which is exactly the
  // separation 'windowReset' preserves.
  assert.equal(state.prewarmSuppressed, true, 'a plain remount must NOT lift suppression')
  const selected = reduceSource(state, { kind: 'userSelected', at: 300_000 }, ENV).state
  assert.equal(selected.prewarmSuppressed, false, 'the user action lifts it')
})

test('DIVERGENCE (measured): painted also clears the retention suppression', () => {
  // The legacy ledger splits these: hiddenSinceRef is cleared by `painted`, while
  // prewarmSuppressedRef is cleared ONLY by a user action / registry removal
  // (App.tsx's click path). The reducer couples them. Migrating hiddenSince today
  // would therefore also un-suppress a reclaimed view the moment it is painted -
  // a behavior change with no test covering it. Recorded here so the migration
  // either splits the event or the coupling is registered as BEHAVIOR_CHANGES.
  const reclaimedThenPainted = dispatch(initialSourceLifecycle({ sourceId: 'v1', fingerprint: 'fp1' }), [
    { kind: 'mounted', at: 0 },
    { kind: 'bootSettled', outcome: 'booted' },
    { kind: 'unmounted', at: 200 },
    { kind: 'reclaimed', at: 100_000 },
    { kind: 'mounted', at: 200_000 },
    { kind: 'painted', at: 200_001 },
  ])
  assert.equal(reclaimedThenPainted.prewarmSuppressed, false,
    'MEASURED: painted clears suppression; the legacy ledger would keep it until a user click')
})
