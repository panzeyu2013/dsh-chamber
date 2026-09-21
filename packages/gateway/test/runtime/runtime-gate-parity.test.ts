/**
 * F3 parity (2026-12 audit): the gate formulas were moved to runtime-gate.ts.
 * This suite is the characterisation lock — it keeps a verbatim copy of the
 * PRE-refactor logic (legacyRecoveryGateRefusal / legacyWriterBusyRefusal) and
 * asserts the new single source answers every cell with the same null / code /
 * message bytes, over the full state matrix.
 *
 * The legacy copies are frozen references, NOT the production path: if the
 * production semantics ever change intentionally, both the module and this
 * reference must be updated together (that is the point of the lock).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recoveryGateRefusal, writerBusyRefusal, type RuntimeMutationAction, type RuntimeWriterFlags } from '../../src/runtime-gate.ts'
import {
  RECOVERABLE_METADATA_BLOCKS,
  RETRY_APPLY_REASONS,
  RETRY_RESTORE_REASONS,
  pendingOnlyRefusal,
  profileWriteBusyRefusal,
} from '../../src/runtime-refusals.ts'

// ---------------------------------------------------------------------------
// Frozen pre-refactor references
// ---------------------------------------------------------------------------

function legacyRecoveryGateRefusal(
  status: { phase?: unknown; pending?: unknown; startupBlockedReason?: unknown; canRecoverMetadata?: unknown },
  action: RuntimeMutationAction,
): { error: string; code: string } | null {
  const phase = typeof status.phase === 'string' ? status.phase : 'unknown'
  const retryAction = RETRY_APPLY_REASONS.has(phase)
    ? 'retry-apply'
    : phase === 'restore-blocked'
      ? 'retry-restore'
      : null

  if (retryAction !== null) {
    if (action === retryAction) return null
    return {
      error: `runtime recovery ${phase} is required; only ${retryAction} is allowed`,
      code: 'runtime_recovery_required',
    }
  }

  const blockedReason = typeof status.startupBlockedReason === 'string'
    && status.startupBlockedReason !== ''
    ? status.startupBlockedReason
    : null
  const canRecoverMetadata = status.canRecoverMetadata === true
  if (blockedReason !== null) {
    const swapLike = RETRY_APPLY_REASONS.has(blockedReason)
    const restoreLike = RETRY_RESTORE_REASONS.has(blockedReason)
    const fatalLike = RECOVERABLE_METADATA_BLOCKS.has(blockedReason)
    const recoverOpen = fatalLike
      || (canRecoverMetadata && !swapLike && !restoreLike && blockedReason !== 'env-probe-failed')
    const allowed = (action === 'retry-apply' && swapLike)
      || (action === 'retry-restore' && restoreLike)
      || (action === 'recover-metadata' && recoverOpen)
    if (allowed) return null
    if (blockedReason === 'env-probe-failed') {
      return {
        error: 'runtime startup block env-probe-failed: the DSH_GATEWAY_DSH_PATH runtime failed activation probes; fix the target and restart the gateway (no recovery route applies)',
        code: 'runtime_recovery_required',
      }
    }
    return {
      error: canRecoverMetadata
        ? `runtime startup block ${blockedReason} requires recovery first; only recover-metadata is allowed`
        : `runtime startup block ${blockedReason} requires recovery first; no recovery route matches (restart the gateway if this persists)`,
      code: 'runtime_recovery_required',
    }
  }

  if (action === 'recover-metadata' && canRecoverMetadata) return null

  if (blockedReason === null
    && ((status.pending !== null && status.pending !== undefined) || phase === 'pending')) {
    if (action === 'restore-builtin') return null
    if (action === 'apply-now') return null
    const version = typeof status.pending === 'string' && status.pending !== ''
      ? status.pending
      : 'unknown'
    return pendingOnlyRefusal(version)
  }

  return null
}

/** The two pre-refactor inline matrices (assertMutationIdle / profileWriteRefusal
 * head), transcribed byte for byte. */
function legacyWriterBusyRefusal(flags: RuntimeWriterFlags, subject: 'runtime mutations' | 'managed profile write'): { error: string; code: string } | null {
  const suffix = subject === 'runtime mutations' ? 'runtime mutations are refused' : 'managed profile write refused'
  if (flags.disposed) {
    return subject === 'runtime mutations'
      ? { code: 'runtime_disposed', error: 'gateway runtime manager is disposing' }
      : { code: 'runtime_busy', error: 'gateway runtime manager is disposing; managed profile write refused' }
  }
  if (flags.activation) {
    return subject === 'runtime mutations'
      ? { code: 'runtime_busy', error: 'runtime activation in progress' }
      : { code: 'runtime_busy', error: 'runtime activation in progress; managed profile write refused' }
  }
  if (flags.install) return { code: 'runtime_busy', error: `a runtime install is in flight; ${suffix}` }
  if (flags.restart) return { code: 'runtime_busy', error: `a restart is in flight; ${suffix}` }
  if (flags.applyNow) return { code: 'runtime_busy', error: `an apply-now transaction is in flight; ${suffix}` }
  if (flags.restartExhaustedRollback) return { code: 'runtime_busy', error: `an automatic restart-exhausted rollback is in flight; ${suffix}` }
  if (flags.start) return { code: 'runtime_busy', error: `a start is in flight; ${suffix}` }
  // profileWriteRefusal never consults the profile-write lease (reentrant);
  // assertMutationIdle checks it last.
  if (subject === 'runtime mutations' && flags.profileWrite) return profileWriteBusyRefusal('runtime mutations')
  return null
}

// ---------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------

const ACTIONS: readonly RuntimeMutationAction[] = [
  'select', 'apply', 'apply-now', 'rollback', 'cleanup-version', 'restore-pre-rollback',
  'recover-metadata', 'retry-apply', 'retry-restore', 'restore-builtin', 'restart', 'start', 'registry',
]

const PHASES = ['idle', 'pending', 'installing', 'applying', 'snapshot-failed', 'swap-attempted', 'restore-blocked', 'fallback-builtin', '', 'unknown-drift']
const BLOCKED = [undefined, '', 'snapshot-failed', 'swap-attempted', 'restore-half', 'restore-incomplete', 'metadata-corrupt', 'metadata-probe-failed', 'env-probe-failed', 'free-text-drift']
const PENDING = [undefined, null, '1.2.3', '', 42] as const
const RECOVERABLE = [true, false, undefined]

test('recoveryGateRefusal parity: every phase × block × pending × canRecoverMetadata × action cell', () => {
  let cells = 0
  for (const phase of PHASES) {
    for (const startupBlockedReason of BLOCKED) {
      for (const pending of PENDING) {
        for (const canRecoverMetadata of RECOVERABLE) {
          for (const action of ACTIONS) {
            const status = { phase, pending, startupBlockedReason, canRecoverMetadata }
            assert.deepEqual(
              recoveryGateRefusal(status, action),
              legacyRecoveryGateRefusal(status, action),
              `gate parity broke for ${JSON.stringify({ phase, startupBlockedReason, pending, canRecoverMetadata, action })}`,
            )
            cells += 1
          }
        }
      }
    }
  }
  assert.equal(cells, PHASES.length * BLOCKED.length * PENDING.length * RECOVERABLE.length * ACTIONS.length)
})

test('writerBusyRefusal parity: every writer-flag combination on both manager surfaces', () => {
  const keys: ReadonlyArray<keyof RuntimeWriterFlags> = [
    'disposed', 'activation', 'install', 'restart', 'applyNow', 'restartExhaustedRollback', 'start', 'profileWrite',
  ]
  let cells = 0
  for (let mask = 0; mask < (1 << keys.length); mask += 1) {
    const flags = Object.fromEntries(keys.map((key, index) => [key, (mask & (1 << index)) !== 0])) as unknown as RuntimeWriterFlags
    for (const subject of ['runtime mutations', 'managed profile write'] as const) {
      // The two subjects select different overloads (the mutation surface may
      // answer runtime_disposed), so branch on the literal.
      const actual = subject === 'runtime mutations'
        ? writerBusyRefusal(flags, 'runtime mutations')
        : writerBusyRefusal(flags, 'managed profile write')
      assert.deepEqual(
        actual,
        legacyWriterBusyRefusal(flags, subject),
        `writer matrix parity broke for ${subject} at mask ${mask}`,
      )
      cells += 1
    }
  }
  assert.equal(cells, (1 << keys.length) * 2)
})

test('parity spot-checks pin the exact bytes (not just copy-vs-copy)', () => {
  assert.equal(writerBusyRefusal({ ...ALL_FALSE, disposed: true }, 'runtime mutations')?.code, 'runtime_disposed')
  assert.equal(writerBusyRefusal({ ...ALL_FALSE, disposed: true }, 'runtime mutations')?.error, 'gateway runtime manager is disposing')
  assert.equal(writerBusyRefusal({ ...ALL_FALSE, profileWrite: true }, 'runtime mutations')?.error, 'managed profile write in flight (plugin mutation); runtime mutations are refused')
  assert.equal(writerBusyRefusal({ ...ALL_FALSE, profileWrite: true }, 'managed profile write'), null, 'the lease must stay reentrant')
  assert.equal(recoveryGateRefusal({ phase: 'snapshot-failed' }, 'select')?.error, 'runtime recovery snapshot-failed is required; only retry-apply is allowed')
  assert.equal(recoveryGateRefusal({ startupBlockedReason: 'metadata-corrupt', canRecoverMetadata: false }, 'restart')?.error, 'runtime startup block metadata-corrupt requires recovery first; no recovery route matches (restart the gateway if this persists)')
  assert.deepEqual(recoveryGateRefusal({ phase: 'pending', pending: '9.9.9' }, 'select'), pendingOnlyRefusal('9.9.9'))
  assert.equal(recoveryGateRefusal({ phase: 'pending' }, 'restore-builtin'), null)
  assert.equal(recoveryGateRefusal({ phase: 'pending' }, 'apply-now'), null)
})

const ALL_FALSE: RuntimeWriterFlags = {
  disposed: false, activation: false, install: false, restart: false,
  applyNow: false, restartExhaustedRollback: false, start: false, profileWrite: false,
}
