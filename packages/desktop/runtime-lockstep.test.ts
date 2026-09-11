/**
 * Renderer ↔ main runtime action-matrix LOCKSTEP tests (P2 regression).
 *
 * The renderer's `runtimeAllowedActions` and the main process's matrices are
 * maintained by hand in two packages. The invariant that matters for
 * security/UX: the UI must never SHOW an action the main process will
 * REJECT. This test enumerates every phase × capability combination and
 * asserts renderer ⊆ main for the non-blocked, management-supported path
 * (main's authoritative non-blocked gate is `allowedActions` in
 * @dsh-chamber/dsh-runtime — the desktop runtime-state-machine.ts shim was
 * deleted 2026-09, dedupe audit N8).
 *
 * The reverse direction (main accepts an action the UI hides) is currently
 * masked by the publishing invariant "canRecoverMetadata=true ⟹
 * runtimeBlocked=true" — asserted explicitly at the bottom so a change to
 * that invariant fails loudly instead of silently stranding users.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allowedActions, RuntimeOperationFence } from '@dsh-chamber/dsh-runtime'
import {
  runtimeAllowedActions,
  type RuntimeAction,
  type RuntimePhase,
  type RuntimeState,
} from '../renderer/src/runtime-management.ts'
import type { RuntimeInstallProgress as MainRuntimeInstallProgress } from '@dsh-chamber/dsh-runtime'
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
    connectionState: 'ready',
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

test('renderer and main action matrices are EXACTLY equal on the non-blocked, managed, no-capability path', () => {
  // Review fix: subset-only guarding let a renderer silently DROP an action
  // (e.g. restart-dsh) pass. On the plain managed path (source 'user', no
  // capability bits, non-blocked) the two hand-maintained matrices must be
  // identical — a missing action is now a failure.
  for (const phase of PHASES) {
    const state = rendererState(phase, { source: 'user' })
    assert.deepEqual(
      [...runtimeAllowedActions(state)].sort(),
      [...mainActions(phase, state)].sort(),
      `${phase}: renderer and main matrices must be exactly equal (non-blocked, managed, no caps)`,
    )
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
  // (@dsh-chamber/dsh-runtime runtime-installer: `{stage:'download'; received; total}` | stage-only
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

test('renderer compareSemver stays lockstep with the shared compareRuntimeVersions (main)', async () => {
  const { compareSemver } = await import('../renderer/src/runtime-management.ts')
  const { compareRuntimeVersions } = await import('@dsh-chamber/dsh-runtime')
  const corpus: Array<[string, string]> = [
    ['1.0.0', '1.0.0'],
    ['1.0.0', '1.0.1'],
    ['1.10.0', '1.9.9'],
    ['2.0.0', '10.0.0'],
    ['1.0.0-beta.1', '1.0.0'],
    ['1.0.0-rc.1', '1.0.0-beta.2'],
    ['0.9.9', '1.0.0'],
    ['1.2.3', '1.2.3-beta.4'],
    // Adversarial pairs where hand-maintained SemVer implementations diverge:
    // numeric-vs-alphanumeric prerelease identifiers, same-prefix list length,
    // arbitrarily large numeric identifiers (no Number precision loss),
    // invalid/non-semver inputs (both must return null), build metadata
    // equality, and a bare prerelease-vs-release boundary.
    ['1.0.0-1', '1.0.0-alpha'],
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-rc.1', '1.0.0-rc.1.1'],
    ['99999999999999999999.0.0', '2.0.0'],
    ['not-a-semver', '1.0.0'],
    ['', '1.0.0'],
    ['1.0.0+one', '1.0.0+two'],
    ['1.0.0', '1.0.0+build'],
    ['1.0.0-alpha.1', '1.0.0'],
  ]
  for (const [a, b] of corpus) {
    assert.equal(compareSemver(a, b), compareRuntimeVersions(a, b), `${a} vs ${b}`)
    assert.equal(compareSemver(b, a), compareRuntimeVersions(b, a), `${b} vs ${a}`)
  }
})

// ===========================================================================
// main.ts `runtimeActionAllowed` — the three DESKTOP-ONLY guards in front of
// the shared core (P3).
//
// Every matrix above models only the shared core (`allowedActions`), while
// main.ts evaluates three further guards BEFORE it (main.ts:5220-5249):
//   1. `managementSupported === false && action !== 'retry-restore'` → reject:
//      a read-only platform keeps exactly ONE escape (finish a crash-
//      interrupted data restore). This is the desktop's one relaxation over the
//      shared core — the core has no notion of an unsupported platform, so on
//      its own it would still advertise the whole version-management matrix
//      there. No assertion covered that cell before this block.
//   2. `action === 'recover-metadata' && state.source === 'env'` → reject,
//      evaluated BEFORE the blocked branch, so an env-selected tree cannot
//      reach the terminal metadata escape even in the blocked cells main's own
//      matrix would open.
//   3. `runtimeWriterFence.busy && !applyingReset` → reject everything except
//      the applying-reset escape (reset-builtin while applying, non-env, with
//      an override).
//
// main.ts cannot be imported here (it pulls Electron), so the gate is
// TRANSCRIBED below and held to the real source by the structural pins at the
// bottom of this file — the transcription cannot silently outlive the code it
// mirrors, and each guard's behavioural cells are asserted. The writer fence is
// NOT transcribed: `RuntimeOperationFence` is the real shared class from
// @dsh-chamber/dsh-runtime, driven for real (only `busy` is read by main).
// `restart-dsh` does NOT ride this gate at all: it has its own IPC handler
// (main.ts:5161-5179) whose gate deliberately does not refuse read-only
// platforms or env sources — see the restart-gate assertions.
// ===========================================================================

/** Every action the desktop gate can be asked about, in the shared core's own
 *  declaration order. */
const RUNTIME_ACTIONS: readonly RuntimeAction[] = [
  'check', 'select-version', 'install', 'apply-now', 'reset-builtin', 'retry-apply',
  'retry-restore', 'cleanup-version', 'recover-metadata', 'restore-pre-rollback', 'restart-dsh',
]

/**
 * Transcription of main.ts's `runtimeActionAllowed` (main.ts:5220-5249):
 * the three desktop-only guards, then the blocked matrix, then the shared
 * `allowedActions` fall-through. Keep in step with the structural pins below.
 */
function desktopActionAllowed(
  action: RuntimeAction,
  state: RuntimeState,
  options: { writerFenceBusy?: boolean } = {},
): boolean {
  if (state.managementSupported === false && action !== 'retry-restore') return false
  if (action === 'recover-metadata' && state.source === 'env') return false
  const applyingReset = action === 'reset-builtin'
    && state.phase === 'applying'
    && state.source !== 'env'
    && state.hasOverride === true
  if ((options.writerFenceBusy ?? false) && !applyingReset) return false
  if (state.runtimeBlocked === true) {
    if (action === 'retry-restore') {
      return state.canRetryRestore === true && (state.phase === 'rollback' || state.phase === 'failed')
    }
    if (action === 'recover-metadata') {
      return (state.canRetryRestore !== true || state.restoreOutcome === 'incomplete')
        && state.canRecoverMetadata === true
        && (state.metadataHealth === 'selection-corrupt'
          || state.metadataHealth === 'recovery-in-progress'
          || state.metadataHealth === 'recovery-marker-corrupt')
        && (state.phase === 'idle' || state.phase === 'failed')
    }
    if (action === 'retry-apply') {
      return state.canRetryApply === true && (state.phase === 'snapshot-failed' || state.phase === 'failed')
    }
    return applyingReset
  }
  return allowedActions(state.phase, {
    canRetryApply: state.canRetryApply,
    canRetryRestore: state.canRetryRestore,
    canRecoverMetadata: state.canRecoverMetadata,
  }).includes(action)
}

/** Transcription of the RUNTIME_RESTART handler's own gate (main.ts:5171-5175)
 *  — the gate `restart-dsh` really rides, which never asks about
 *  `managementSupported` or `source`. */
function desktopRestartAllowed(
  state: RuntimeState,
  options: { writerFenceBusy?: boolean; runtimeOperation?: boolean } = {},
): boolean {
  const busyPhase = state.phase === 'checking' || state.phase === 'downloading'
    || state.phase === 'installing' || state.phase === 'applying' || state.phase === 'pending'
  return !((options.runtimeOperation ?? false)
    || (options.writerFenceBusy ?? false)
    || busyPhase
    || state.runtimeBlocked === true
    || state.phase === 'snapshot-failed')
}

/** The actions of RUNTIME_ACTIONS the desktop gate accepts (`restart-dsh`
 *  excluded — it never reaches this gate in main.ts). */
function desktopAcceptedActions(state: RuntimeState, options: { writerFenceBusy?: boolean } = {}): RuntimeAction[] {
  return RUNTIME_ACTIONS.filter(action => action !== 'restart-dsh' && desktopActionAllowed(action, state, options))
}

test('the unsupported-platform guard admits exactly the retry-restore escape, and only it (main.ts:5222)', () => {
  for (const phase of PHASES) {
    for (const caps of [{}, { canRetryRestore: true }] as Array<Partial<RuntimeState>>) {
      const state = rendererState(phase, { ...caps, source: 'user', managementSupported: false })
      const expected = caps.canRetryRestore === true && (phase === 'rollback' || phase === 'failed')
        ? ['retry-restore']
        : []
      assert.deepEqual(
        desktopAcceptedActions(state),
        expected,
        `${phase} ${JSON.stringify(caps)}: a read-only platform keeps exactly the recovery escape`,
      )
      // The narrowing is desktop-only and real: the shared core alone (what
      // `mainActions` models) has no notion of an unsupported platform and
      // still advertises the version-management matrix there. Every action it
      // additionally offers is refused by THIS guard alone — lifting the flag
      // accepts it again.
      for (const action of mainActions(phase, state)) {
        if (action === 'retry-restore' || expected.includes(action)) continue
        assert.equal(
          desktopActionAllowed(action, { ...state, managementSupported: true }),
          true,
          `${phase}: '${action}' must be refused by the unsupported-platform guard alone`,
        )
      }
      // UI ⊆ main on this branch, and the platform-independent restart button
      // is covered by its own gate (the renderer shows it here).
      const shown = runtimeAllowedActions(state)
      for (const action of shown) {
        assert.ok(
          action === 'restart-dsh' || expected.includes(action),
          `${phase}: renderer shows '${action}' but the desktop gate rejects it`,
        )
      }
      if (shown.includes('restart-dsh')) {
        assert.equal(
          desktopRestartAllowed(state),
          true,
          `${phase}: the renderer's restart button must ride main's RUNTIME_RESTART gate`,
        )
      }
    }
  }
})

test('the env guard refuses recover-metadata in exactly the blocked cells main would otherwise open (main.ts:5223)', () => {
  const blocked = (overrides: Partial<RuntimeState> = {}): RuntimeState => rendererState('idle', {
    runtimeBlocked: true,
    runtimeBlockedReason: 'journal corrupt',
    canRecoverMetadata: true,
    metadataHealth: 'selection-corrupt',
    ...overrides,
  })
  const envState = blocked({ source: 'env' })
  const userState = blocked({ source: 'user' })
  // The blocked matrix (and the shared `idle` + canRecoverMetadata cell) would
  // admit it: the env guard is the ONLY difference between these twins.
  assert.equal(mainActions('idle', userState).includes('recover-metadata'), true,
    'the shared core has no source notion — this cell is open without the desktop guard')
  assert.equal(desktopActionAllowed('recover-metadata', userState), true)
  assert.equal(desktopActionAllowed('recover-metadata', envState), false,
    'an env-selected tree must not reach the terminal metadata escape')
  assert.equal(runtimeAllowedActions(envState).includes('recover-metadata'), false,
    'the renderer hides it on the same state (both sides agree)')

  // Permanent-incomplete twin on a retryable phase: main's blocked matrix
  // opens BOTH the retry and the terminal escape; env keeps only the retry.
  const userIncomplete = blocked({ phase: 'failed', source: 'user', canRetryRestore: true, restoreOutcome: 'incomplete' })
  assert.deepEqual(desktopAcceptedActions(userIncomplete), ['retry-restore', 'recover-metadata'])
  const envIncomplete = blocked({ phase: 'failed', source: 'env', canRetryRestore: true, restoreOutcome: 'incomplete' })
  assert.deepEqual(desktopAcceptedActions(envIncomplete), ['retry-restore'],
    'env removes the terminal escape but keeps the half-restore retry')
  assert.deepEqual(runtimeAllowedActions(envIncomplete), ['retry-restore'],
    'the renderer matches the env guard on the same state')
})

test('the writer fence refuses every runtime action except the applying-reset escape (main.ts:5224-5228)', () => {
  // The REAL shared fence (main.ts holds one RuntimeOperationFence instance).
  const fence = new RuntimeOperationFence()
  const lease = fence.tryAcquire('runtime:check')
  assert.notEqual(lease, null, 'the fence must hand out an uncontended lease')
  try {
    assert.equal(fence.busy, true)
    const idle = rendererState('idle', { source: 'user' })
    // Without the fence the shared core accepts the whole idle matrix …
    assert.ok(mainActions('idle', idle).length > 0, 'the shared core accepts actions here')
    // … with the fence held, the desktop gate accepts NONE of them.
    assert.deepEqual(desktopAcceptedActions(idle, { writerFenceBusy: fence.busy }), [],
      'a held writer fence must refuse every runtime action')
    // The ONE escape: reset-builtin while applying, non-env, with an override
    // (the queued reset-builtin behind an in-flight apply transaction).
    const applying = rendererState('applying', { source: 'user', hasOverride: true })
    assert.equal(desktopActionAllowed('reset-builtin', applying, { writerFenceBusy: fence.busy }), true)
    // … and each of its three conditions is load-bearing.
    assert.equal(desktopActionAllowed('reset-builtin', { ...applying, source: 'env' }, { writerFenceBusy: fence.busy }), false)
    assert.equal(desktopActionAllowed('reset-builtin', { ...applying, hasOverride: false }, { writerFenceBusy: fence.busy }), false)
    assert.equal(desktopActionAllowed('reset-builtin', { ...applying, phase: 'idle' }, { writerFenceBusy: fence.busy }), false)
    // The renderer agrees about the escape's precondition (it hides
    // reset-builtin without an override, and on env).
    assert.equal(runtimeAllowedActions({ ...applying, hasOverride: false }).includes('reset-builtin'), false)
    assert.equal(runtimeAllowedActions({ ...applying, source: 'env', hasOverride: false }).includes('reset-builtin'), false)
    // Releasing the fence restores the shared matrix: the fence is the cause.
    lease?.release()
    assert.equal(fence.busy, false)
    assert.equal(desktopActionAllowed('check', idle, { writerFenceBusy: fence.busy }), true)
    assert.equal(desktopActionAllowed('reset-builtin', applying, { writerFenceBusy: fence.busy }), true)
  } finally {
    lease?.release()
  }
})

// ---- structural pins: the transcription above must keep matching main.ts ----

/** The balanced `{ … }` block that starts at `open`. */
function balancedBlock(source: string, open: number): string {
  assert.notEqual(open, -1, 'block start not found')
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  assert.fail('unbalanced block in main.ts')
}

/** The body of the `const <name> = (…) => { … }` arrow function. */
function arrowFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = `)
  assert.notEqual(start, -1, `${name} is gone from main.ts`)
  return balancedBlock(source, source.indexOf('{', start))
}

const desktopMain = readFileSync(join(import.meta.dirname, '..', '..', 'packages', 'desktop', 'main.ts'), 'utf8')

test('main.ts still orders the three desktop-only guards before the shared core, unchanged (P3)', () => {
  const body = arrowFunctionBody(desktopMain, 'runtimeActionAllowed')
  const unsupportedGuard = body.indexOf("state.managementSupported === false && action !== 'retry-restore'")
  const envGuard = body.indexOf("action === 'recover-metadata' && state.source === 'env'")
  const fenceGuard = body.indexOf('runtimeWriterFence.busy && !applyingReset')
  const applyingReset = body.indexOf("const applyingReset = action === 'reset-builtin'")
  const blockedBranch = body.indexOf('if (state.runtimeBlocked === true)')
  const sharedCall = body.indexOf('allowedActions(state.phase')
  for (const [label, index] of [
    ['the unsupported-platform guard', unsupportedGuard],
    ['the env guard', envGuard],
    ['the writer-fence guard', fenceGuard],
    ['the applying-reset escape', applyingReset],
    ['the blocked branch', blockedBranch],
    ['the shared allowedActions fall-through', sharedCall],
  ] as ReadonlyArray<readonly [string, number]>) {
    assert.notEqual(index, -1, `${label} is gone from main.ts runtimeActionAllowed — re-derive the transcription in this file`)
  }
  assert.ok(
    unsupportedGuard < envGuard && envGuard < applyingReset && applyingReset < fenceGuard
      && fenceGuard < blockedBranch && blockedBranch < sharedCall,
    'the guard order changed: the cells this file covers must be re-derived',
  )
})

test('main.ts keeps restart-dsh on its own gate, outside the unsupported-platform guard (P3)', () => {
  const handleStart = desktopMain.indexOf('ipcMain.handle(IPC_CHANNELS.RUNTIME_RESTART')
  assert.notEqual(handleStart, -1, 'the RUNTIME_RESTART handler is gone from main.ts')
  const handler = balancedBlock(desktopMain, desktopMain.indexOf('{', handleStart))
  assert.match(handler, /const busyPhase = state\.phase === 'checking'/,
    'the restart gate must keep refusing the busy phases')
  assert.match(handler, /runtimeWriterFence\.busy \|\| busyPhase/,
    'the restart gate must keep refusing a held writer fence')
  assert.equal(handler.includes("managementSupported === false && action !== 'retry-restore'"), false,
    'restart-dsh must not ride the unsupported-platform guard (it is a platform-independent process action)')
  // And the model agrees: the renderer's unsupported-platform restart button
  // is accepted by the restart gate.
  assert.equal(desktopRestartAllowed(rendererState('idle', { source: 'user', managementSupported: false })), true)
  assert.equal(desktopRestartAllowed(rendererState('applying', { source: 'user', managementSupported: false })), false)
})
