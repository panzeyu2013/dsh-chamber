/**
 * Renderer ↔ main runtime action-matrix LOCKSTEP tests (P2 regression).
 *
 * The renderer's `runtimeAllowedActions` and the main process's matrices are
 * maintained by hand in two packages. The invariant that matters for
 * security/UX: the UI must never SHOW an action the main process will
 * REJECT. This test enumerates every phase × capability combination and
 * asserts renderer ⊆ main for the non-blocked, management-supported path
 * (main's authoritative non-blocked gate is `allowedActions` in
 * packages/desktop/runtime-state-machine.ts).
 *
 * The reverse direction (main accepts an action the UI hides) is currently
 * masked by the publishing invariant "canRecoverMetadata=true ⟹
 * runtimeBlocked=true" — asserted explicitly at the bottom so a change to
 * that invariant fails loudly instead of silently stranding users.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedActions } from './runtime-state-machine.ts'
import {
  runtimeAllowedActions,
  type RuntimeAction,
  type RuntimePhase,
  type RuntimeState,
} from '../renderer/src/runtime-management.ts'
import type { RuntimeInstallProgress as MainRuntimeInstallProgress } from './runtime-installer.ts'
import type { RuntimeInstallProgress as RendererRuntimeInstallProgress } from '../renderer/src/runtime-management.ts'

const PHASES: readonly RuntimePhase[] = [
  'idle', 'checking', 'available', 'downloading', 'installing', 'pending',
  'applying', 'applied', 'rollback', 'snapshot-failed', 'failed', 'error',
]

function rendererState(phase: RuntimePhase, overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    phase,
    source: 'user',
    managementSupported: true,
    runtimeBlocked: false,
    canRetryRestore: false,
    canRetryApply: false,
    canRecoverMetadata: false,
    hasOverride: true,
    restoreOutcome: 'none',
    metadataHealth: 'healthy',
    active: null,
    bundled: null,
    latest: null,
    versions: [],
    pending: null,
    error: null,
    ...overrides,
  }
}

function mainActions(phase: RuntimePhase, state: RuntimeState): RuntimeAction[] {
  return allowedActions(phase, {
    canRetryRestore: state.canRetryRestore,
    canRetryApply: state.canRetryApply,
    canRecoverMetadata: state.canRecoverMetadata,
  })
}

test('renderer actions are always a subset of the main-process matrix (non-blocked, managed path)', () => {
  const capMatrix: Array<Partial<RuntimeState>> = [
    {},
    { canRetryRestore: true },
    { canRetryApply: true },
    { canRecoverMetadata: true },
    { canRetryRestore: true, canRetryApply: true, canRecoverMetadata: true },
    { canRetryRestore: true, restoreOutcome: 'incomplete', canRecoverMetadata: true },
  ]
  const sourceMatrix: Array<Partial<RuntimeState>> = [
    { source: 'user' },
    { source: 'user', hasOverride: false },
    { source: 'env' },
    { hasOverride: false },
  ]
  for (const phase of PHASES) {
    for (const caps of capMatrix) {
      for (const source of sourceMatrix) {
        const state = rendererState(phase, { ...caps, ...source })
        const shown = runtimeAllowedActions(state)
        const accepted = mainActions(phase, state)
        for (const action of shown) {
          assert.ok(
            accepted.includes(action),
            `${phase} ${JSON.stringify({ caps, source })}: renderer shows '${action}' but main rejects it`,
          )
        }
      }
    }
  }
})

test('the recover-metadata masking invariant is explicit (canRecoverMetadata ⟹ blocked publishing)', () => {
  // The renderer's NON-blocked path never emits recover-metadata, while the
  // main non-blocked matrix does for idle/failed + canRecoverMetadata +
  // !canRetryRestore. Today every canRecoverMetadata=true publication path
  // forces runtimeBlocked=true (main.ts publishBlockedStartup), so the UI is
  // never wrong. If that invariant ever changes, THIS test fails first.
  for (const phase of ['idle', 'failed'] as const) {
    const state = rendererState(phase, { canRecoverMetadata: true })
    assert.ok(
      !runtimeAllowedActions(state).includes('recover-metadata'),
      `${phase} non-blocked renderer must not show recover-metadata (blocked-only action)`,
    )
    assert.ok(
      mainActions(phase, state).includes('recover-metadata'),
      `${phase} main non-blocked matrix advertises recover-metadata — the renderer hides it unless the blocked invariant holds`,
    )
  }
})

test('renderer blocked branch matches the main blocked gate', () => {
  // Main's blocked gate (main.ts runtimeActionAllowed): retry-restore needs
  // canRetryRestore + rollback/failed; recover-metadata needs
  // (canRetryRestore !== true || restoreOutcome === 'incomplete') +
  // canRecoverMetadata + corrupt-health + idle/failed; retry-apply needs
  // canRetryApply + snapshot-failed/failed; everything else is hidden. The
  // renderer encodes exactly this.
  const blocked = (overrides: Partial<RuntimeState> = {}): RuntimeState =>
    rendererState('failed', { runtimeBlocked: true, runtimeBlockedReason: 'journal corrupt', ...overrides })

  assert.deepEqual(
    runtimeAllowedActions(blocked({ canRetryRestore: true })),
    ['retry-restore'],
  )
  assert.deepEqual(
    runtimeAllowedActions(blocked({ canRecoverMetadata: true, metadataHealth: 'selection-corrupt' })),
    ['recover-metadata'],
  )
  // incomplete restore keeps BOTH the retry button and the terminal escape.
  assert.deepEqual(
    runtimeAllowedActions(blocked({
      canRetryRestore: true,
      restoreOutcome: 'incomplete',
      canRecoverMetadata: true,
      metadataHealth: 'recovery-marker-corrupt',
    })),
    ['retry-restore', 'recover-metadata'],
  )
  assert.deepEqual(
    runtimeAllowedActions(blocked({ canRetryApply: true })),
    ['retry-apply'],
  )
  assert.deepEqual(
    runtimeAllowedActions(blocked({ phase: 'idle', canRecoverMetadata: true, metadataHealth: 'selection-corrupt' })),
    ['recover-metadata'],
  )
  // Env source never exposes metadata recovery; a retryable half restore
  // with canRetryRestore keeps retry-restore as the sole escape (main's
  // gate: recover-metadata needs canRetryRestore !== true || incomplete).
  assert.deepEqual(
    runtimeAllowedActions(blocked({ canRecoverMetadata: true, metadataHealth: 'selection-corrupt', source: 'env' })),
    [],
  )
  assert.deepEqual(
    runtimeAllowedActions(blocked({ canRecoverMetadata: true, metadataHealth: 'selection-corrupt', restoreOutcome: 'half', canRetryRestore: true })),
    ['retry-restore'],
  )
})

test('the renderer RuntimeInstallProgress flat mirror projects from the main-process union without drift', () => {
  // The main process emits a DISCRIMINATED UNION
  // (runtime-installer.ts: `{stage:'download'; received; total}` | stage-only
  // milestones) while the renderer's mirror (runtime-management.ts) is a FLAT
  // interface with optional received/total. The invariant that matters: every
  // union member must project losslessly into the flat mirror — the line
  // `const flat: RendererRuntimeInstallProgress = progress` below is a
  // COMPILE-TIME assignability check (the root typecheck fails on drift), and
  // this test pins the runtime shape: received/total ride 'download' only,
  // and every milestone stage the renderer declares exists on the main side.
  const samples: MainRuntimeInstallProgress[] = [
    { stage: 'download', received: 0, total: null },
    { stage: 'download', received: 1024, total: 2048 },
    { stage: 'install' },
    { stage: 'prune' },
    { stage: 'smoke' },
    { stage: 'publish' },
    { stage: 'done' },
  ]
  const rendererStages: ReadonlyArray<RendererRuntimeInstallProgress['stage']> = ['download', 'install', 'prune', 'smoke', 'publish', 'done']
  for (const progress of samples) {
    // Compile-time: the main union member is assignable to the flat mirror.
    const flat: RendererRuntimeInstallProgress = progress
    assert.equal(flat.stage, progress.stage)
    if (progress.stage === 'download') {
      assert.equal(typeof progress.received, 'number', 'download always carries received bytes')
      assert.ok(progress.total === null || typeof progress.total === 'number', 'download total is a number or null (content-length unknown)')
    } else {
      // The renderer's optional fields must never be fabricated: a milestone
      // stage carries neither received nor total on the wire.
      assert.equal('received' in progress, false, `${progress.stage} carries no received`)
      assert.equal('total' in progress, false, `${progress.stage} carries no total`)
    }
  }
  // Every renderer-declared stage exists on the main side (the union's stage
  // set is the single source of truth for the bar UI).
  const mainStages = new Set<MainRuntimeInstallProgress['stage']>(samples.map(sample => sample.stage))
  for (const stage of rendererStages) {
    assert.ok(mainStages.has(stage), `renderer stage '${stage}' is produced by the main-process union`)
  }
})
