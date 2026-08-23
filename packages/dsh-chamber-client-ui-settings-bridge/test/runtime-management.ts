/**
 * Design 17 runtime renderer policy tests: full state/action/copy matrix,
 * SemVer 2.0 precedence, local-spawn applying gate, and the page-wide bridge
 * subscription/hydration race.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeStateStore,
  compareSemver,
  formatRuntimeBytes,
  preferredRuntimeVersion,
  projectRuntimeSnapshot,
  projectRuntimeStatus,
  runtimeAllowedActions,
  runtimeBlocksLocalStart,
  runtimeSelectionDirection,
  type RuntimePhase,
  type RuntimeState,
  type RuntimeSurface,
} from '../../renderer/src/runtime-management.ts'

function runtimeState(phase: RuntimePhase, overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    active: '1.0.0',
    bundled: '1.0.0',
    source: 'bundled',
    latest: '1.1.0',
    versions: [{ version: '1.1.0', latest: true, cached: false, belowBaseline: false }],
    pending: null,
    phase,
    error: null,
    ...overrides,
  }
}

test('runtime action matrix covers every design-18 phase and keeps busy/terminal gates strict', () => {
  const expected: Record<RuntimePhase, readonly string[]> = {
    idle: ['check', 'select-version', 'install', 'cleanup-version'],
    checking: [],
    available: ['check', 'select-version', 'install', 'cleanup-version'],
    downloading: [],
    installing: [],
    pending: ['reset-builtin'],
    applying: ['reset-builtin'],
    applied: ['check', 'select-version', 'install', 'cleanup-version'],
    rollback: ['check', 'select-version', 'install', 'cleanup-version'],
    'snapshot-failed': ['reset-builtin'],
    failed: ['check', 'select-version', 'install', 'cleanup-version'],
    error: ['check', 'select-version', 'install', 'cleanup-version'],
  }
  for (const [phase, actions] of Object.entries(expected) as [RuntimePhase, readonly string[]][]) {
    assert.deepEqual(runtimeAllowedActions(runtimeState(phase)), actions, phase)
  }
})

test('reset-builtin stays visible on error/failed/rollback/applied only when an override exists', () => {
  const withOverride = (phase: RuntimePhase, overrides: Partial<RuntimeState> = {}) =>
    runtimeAllowedActions(runtimeState(phase, { hasOverride: true, source: 'user', ...overrides }))
  assert.deepEqual(withOverride('error'), ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'])
  assert.deepEqual(withOverride('failed'), ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'])
  assert.deepEqual(withOverride('rollback'), ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'])
  assert.deepEqual(withOverride('applied'), ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'])
  // A clean bundled install without any override must not show a no-op reset
  // (main rejects reset-builtin unless hasOverride — the button would be dead).
  assert.deepEqual(runtimeAllowedActions(runtimeState('error', { hasOverride: false })), ['check', 'select-version', 'install', 'cleanup-version'])
  assert.deepEqual(runtimeAllowedActions(runtimeState('failed', { hasOverride: false })), ['check', 'select-version', 'install', 'cleanup-version'])
  assert.deepEqual(runtimeAllowedActions(runtimeState('applied', { hasOverride: false })), ['check', 'select-version', 'install', 'cleanup-version'])
})

test('retry actions require explicit capabilities and never pierce pending/applying gates', () => {
  assert.deepEqual(
    runtimeAllowedActions(runtimeState('snapshot-failed', { canRetryApply: true })),
    ['retry-apply', 'reset-builtin'],
  )
  assert.deepEqual(
    runtimeAllowedActions(runtimeState('failed', { canRetryRestore: true, restoreOutcome: 'incomplete', hasOverride: true, source: 'user' })),
    ['retry-restore', 'check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'],
  )
  assert.deepEqual(
    runtimeAllowedActions(runtimeState('failed', { canRetryApply: true, hasOverride: true, source: 'user' })),
    ['retry-apply', 'check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'],
  )
  assert.deepEqual(
    runtimeAllowedActions(runtimeState('applying', { canRetryApply: true, canRetryRestore: true })),
    ['reset-builtin'],
  )
  assert.deepEqual(runtimeAllowedActions(runtimeState('idle', { source: 'env' })), ['check'])
  assert.deepEqual(
    runtimeAllowedActions(runtimeState('failed', { source: 'env', canRetryRestore: true })),
    ['retry-restore', 'check'],
    'env source still exposes the mandatory interrupted-data recovery action',
  )
  assert.equal(
    runtimeAllowedActions(runtimeState('idle', { canRetryRestore: true })).includes('retry-restore'),
    false,
    'a stale capability bit cannot expose restore outside rollback/failed',
  )
})

test('authoritative runtimeBlocked state hides actions main will reject', () => {
  assert.deepEqual(runtimeAllowedActions(runtimeState('failed', {
    runtimeBlocked: true,
    runtimeBlockedReason: 'journal corrupt',
  })), [])
  assert.deepEqual(runtimeAllowedActions(runtimeState('failed', {
    runtimeBlocked: true,
    canRetryRestore: true,
  })), ['retry-restore'])
  assert.deepEqual(runtimeAllowedActions(runtimeState('applying', {
    source: 'user', hasOverride: true, runtimeBlocked: true,
  })), ['reset-builtin'])
})

test('metadata recovery is the sole blocked action and restore retry has priority', () => {
  const corrupt = runtimeState('failed', {
    runtimeBlocked: true,
    metadataHealth: 'selection-corrupt',
    metadataComponents: ['current', 'retained-evidence'],
    canRecoverMetadata: true,
  })
  assert.deepEqual(runtimeAllowedActions(corrupt), ['recover-metadata'])
  assert.deepEqual(runtimeAllowedActions({
    ...corrupt,
    canRetryRestore: true,
    restoreOutcome: 'half',
  }), ['retry-restore'], 'restore-half must finish before metadata archival')
  assert.deepEqual(runtimeAllowedActions({
    ...corrupt,
    metadataHealth: 'healthy',
  }), [], 'a forged capability bit cannot manufacture corrupt metadata')
  assert.deepEqual(runtimeAllowedActions({
    ...corrupt,
    source: 'env',
  }), [], 'env-selected runtime never exposes managed metadata mutation')
  assert.deepEqual(runtimeAllowedActions({
    ...corrupt,
    managementSupported: false,
  }), [], 'unsupported platforms remain read-only')
  assert.deepEqual(runtimeAllowedActions({
    ...corrupt,
    metadataHealth: 'recovery-in-progress',
  }), ['recover-metadata'], 'probe failure keeps the durable transaction retryable')
  assert.deepEqual(runtimeAllowedActions({
    ...corrupt,
    metadataHealth: 'recovery-marker-corrupt',
  }), ['recover-metadata'], 'a safely inspectable corrupt marker exposes only explicit second-order recovery')
  assert.equal(runtimeAllowedActions(runtimeState('idle', {
    runtimeBlocked: false,
    metadataHealth: 'recovery-finalized',
    canRecoverMetadata: false,
  })).includes('recover-metadata'), false, 'probe success/finalization removes the recovery action')
})

test('unsupported platform is read-only except for mandatory interrupted restore recovery', () => {
  assert.deepEqual(
    runtimeAllowedActions(runtimeState('available', { managementSupported: false })),
    [],
  )
  assert.deepEqual(
    runtimeAllowedActions(runtimeState('failed', {
      source: 'env',
      managementSupported: false,
      canRetryApply: true,
      canRetryRestore: true,
      restoreOutcome: 'incomplete',
    })),
    ['retry-restore'],
  )
})

test('version selection prefers latest initially and preserves an explicit choice', () => {
  const versions = [
    { version: '1.0.0', latest: false, cached: true, belowBaseline: false },
    { version: '1.2.0', latest: true, cached: false, belowBaseline: false },
    { version: '0.9.0', latest: false, cached: true, belowBaseline: true },
  ]
  assert.equal(preferredRuntimeVersion(null, versions, '1.2.0', '1.0.0'), '1.2.0')
  assert.equal(preferredRuntimeVersion('0.9.0', versions, '1.2.0', '1.0.0'), '0.9.0')
  assert.equal(preferredRuntimeVersion('gone', versions, '1.2.0', '1.0.0'), '1.2.0')
  assert.equal(preferredRuntimeVersion(null, versions, null, '1.0.0'), '1.0.0')
  assert.equal(preferredRuntimeVersion(null, versions, null, null), '1.0.0')
})

test('an unknown active runtime is labeled as a forward install, never rollback', () => {
  assert.equal(runtimeSelectionDirection('1.2.0', null), 'upgrade')
  assert.equal(runtimeSelectionDirection('1.2.0', '1.2.0'), 'current')
  assert.equal(runtimeSelectionDirection('1.1.0', '1.2.0'), 'rollback')
})

test('active user override keeps the restore-builtin exit after periodic checks settle', () => {
  assert.deepEqual(
    runtimeAllowedActions(runtimeState('idle', { source: 'user', hasOverride: true })),
    ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'],
  )
  assert.deepEqual(
    runtimeAllowedActions(runtimeState('available', { source: 'user', hasOverride: true })),
    ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin'],
  )
})

test('status and snapshot projections distinguish complete, half and incomplete restore outcomes', () => {
  const complete = runtimeState('rollback', { rollbackTarget: '0.9.0', restoreOutcome: 'complete' })
  assert.deepEqual(projectRuntimeStatus(complete), {
    kind: 'rollback-complete', version: '0.9.0', detail: null,
  })

  const half = runtimeState('rollback', { rollbackTarget: '0.9.0', restoreOutcome: 'half', error: 'copy failed' })
  assert.deepEqual(projectRuntimeStatus(half), {
    kind: 'rollback-half', version: '0.9.0', detail: 'copy failed',
  })
  assert.equal(projectRuntimeSnapshot(half).kind, 'restore-half')

  const incomplete = runtimeState('failed', { restoreOutcome: 'incomplete', error: 'snapshot missing' })
  assert.equal(projectRuntimeStatus(incomplete).kind, 'restore-incomplete')
  assert.equal(projectRuntimeSnapshot(incomplete).kind, 'restore-incomplete')

  const snapshotFailed = runtimeState('snapshot-failed', {
    targetVersion: '1.1.0', snapshotError: 'ENOSPC', canRetryApply: true,
  })
  assert.deepEqual(projectRuntimeStatus(snapshotFailed), {
    kind: 'snapshot-failed', version: '1.1.0', detail: 'ENOSPC',
  })
  assert.equal(projectRuntimeSnapshot(snapshotFailed).kind, 'failed')

  const swapAttempted = runtimeState('failed', {
    targetVersion: '1.1.0', swapAttempted: true, error: 'pointer rename denied',
  })
  assert.deepEqual(projectRuntimeStatus(swapAttempted), {
    kind: 'swap-attempted', version: '1.1.0', detail: 'pointer rename denied',
  })
  assert.equal(
    projectRuntimeStatus(runtimeState('checking', { swapAttempted: true })).kind,
    'checking',
    'historical swap state must not mask a later live operation',
  )
})

test('status projection covers all phases without silently calling an unknown phase idle', () => {
  const expected: Record<RuntimePhase, string> = {
    idle: 'idle',
    checking: 'checking',
    available: 'available',
    downloading: 'downloading',
    installing: 'installing',
    pending: 'pending',
    applying: 'applying',
    applied: 'applied',
    rollback: 'rollback',
    'snapshot-failed': 'snapshot-failed',
    failed: 'failed',
    error: 'error',
  }
  for (const [phase, kind] of Object.entries(expected) as [RuntimePhase, string][]) {
    assert.equal(projectRuntimeStatus(runtimeState(phase)).kind, kind, phase)
  }
  assert.equal(
    projectRuntimeStatus(runtimeState('idle', { latest: null })).kind,
    'not-checked',
    'cached versions before a successful registry read do not mean up to date',
  )
})

test('SemVer comparison follows numeric/alphanumeric prerelease rules and ignores build metadata', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1, 'numeric prerelease sorts before text')
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1)
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.99'), 0)
  assert.equal(compareSemver('999999999999999999999.0.0', '2.0.0'), 1, 'no Number precision loss')
  assert.equal(compareSemver('01.0.0', '1.0.0'), null)
})

test('runtime byte formatter is bounded and uses binary units', () => {
  assert.equal(formatRuntimeBytes(0), '0 B')
  assert.equal(formatRuntimeBytes(1024), '1.0 KiB')
  assert.equal(formatRuntimeBytes(10 * 1024 ** 3), '10 GiB')
  assert.equal(formatRuntimeBytes(-1), '—')
})

test('local start follows the authoritative runtime gate plus unsafe restore phases', () => {
  assert.equal(runtimeBlocksLocalStart(null, false), false, 'web/no-runtime surface stays usable')
  assert.equal(runtimeBlocksLocalStart(null, true), true, 'desktop bridge hydration is fail-closed')
  assert.equal(runtimeBlocksLocalStart(runtimeState('applying'), true), true)
  assert.equal(runtimeBlocksLocalStart(runtimeState('pending'), true), false)
  assert.equal(runtimeBlocksLocalStart(runtimeState('failed'), true), false)
  assert.equal(runtimeBlocksLocalStart(runtimeState('failed', { runtimeBlocked: true }), true), true)
  assert.equal(runtimeBlocksLocalStart(runtimeState('failed', { canRetryRestore: true }), true), true)
  assert.equal(runtimeBlocksLocalStart(runtimeState('rollback', { restoreOutcome: 'half' }), true), true)
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function surfaceHarness(initial: Promise<RuntimeState>) {
  let push: ((state: RuntimeState) => void) | null = null
  let subscriptions = 0
  let unsubscriptions = 0
  const surface: RuntimeSurface = {
    state: () => initial,
    check: async () => runtimeState('idle'),
    install: async () => runtimeState('pending'),
    resetBuiltin: async () => runtimeState('idle'),
    retryApply: async () => runtimeState('applying'),
    retryRestore: async () => runtimeState('rollback'),
    recoverMetadata: async () => runtimeState('applying'),
    cleanupVersion: async () => runtimeState('idle'),
    onChanged: (callback) => {
      subscriptions += 1
      push = callback
      return () => {
        unsubscriptions += 1
        push = null
      }
    },
  }
  return {
    surface,
    push: (state: RuntimeState) => push?.(state),
    counts: () => ({ subscriptions, unsubscriptions }),
  }
}

test('runtime store subscribes once, push wins a stale hydration query, and last unsubscribe detaches', async () => {
  const initial = deferred<RuntimeState>()
  const harness = surfaceHarness(initial.promise)
  const store = new RuntimeStateStore({ resolveSurface: () => harness.surface })
  let notifications = 0
  const offA = store.subscribe(() => { notifications += 1 })
  const offB = store.subscribe(() => { notifications += 1 })
  assert.deepEqual(harness.counts(), { subscriptions: 1, unsubscriptions: 0 })

  const pushed = runtimeState('applying', { targetVersion: '1.1.0' })
  harness.push(pushed)
  initial.resolve(runtimeState('idle'))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.getSnapshot(), pushed, 'late state() result must not overwrite a newer push')
  assert.equal(notifications, 2, 'one push notifies both React subscribers once')

  offA()
  assert.deepEqual(harness.counts(), { subscriptions: 1, unsubscriptions: 0 })
  offB()
  assert.deepEqual(harness.counts(), { subscriptions: 1, unsubscriptions: 1 })
  assert.equal(store.getSnapshot(), null, 'remount cannot render a stale terminal snapshot')
})

test('runtime store ignores hydration that resolves after its subscriber unmounts', async () => {
  const initial = deferred<RuntimeState>()
  const harness = surfaceHarness(initial.promise)
  const store = new RuntimeStateStore({ resolveSurface: () => harness.surface })
  let notifications = 0
  const off = store.subscribe(() => { notifications += 1 })
  off()
  initial.resolve(runtimeState('applied'))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.getSnapshot(), null)
  assert.equal(notifications, 0)
  assert.deepEqual(harness.counts(), { subscriptions: 1, unsubscriptions: 1 })
})

test('runtime store tears down and retries after a transient hydration failure', async () => {
  const scheduled: Array<() => void> = []
  let stateCalls = 0
  let subscriptions = 0
  let unsubscriptions = 0
  const surface: RuntimeSurface = {
    state: () => {
      stateCalls += 1
      return stateCalls === 1
        ? Promise.reject(new Error('transient IPC failure'))
        : Promise.resolve(runtimeState('idle'))
    },
    check: async () => runtimeState('idle'),
    install: async () => runtimeState('pending'),
    resetBuiltin: async () => runtimeState('idle'),
    retryApply: async () => runtimeState('applying'),
    retryRestore: async () => runtimeState('rollback'),
    recoverMetadata: async () => runtimeState('applying'),
    cleanupVersion: async () => runtimeState('idle'),
    onChanged: () => {
      subscriptions += 1
      return () => { unsubscriptions += 1 }
    },
  }
  const store = new RuntimeStateStore({
    resolveSurface: () => surface,
    schedule: (callback) => {
      scheduled.push(callback)
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    cancel: () => {},
    retryAttempts: 2,
  })
  const off = store.subscribe(() => {})
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(scheduled.length, 1)
  assert.deepEqual({ subscriptions, unsubscriptions }, { subscriptions: 1, unsubscriptions: 1 })

  scheduled.shift()?.()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(store.getSnapshot()?.phase, 'idle')
  assert.deepEqual({ subscriptions, unsubscriptions }, { subscriptions: 2, unsubscriptions: 1 })
  off()
  assert.equal(unsubscriptions, 2)
})
